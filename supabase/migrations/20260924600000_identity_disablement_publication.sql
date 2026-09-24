-- #963 (part B of #755): publish environment-wide identity disablement to the
-- cluster-local identity projections and refuse a disabled identity at named
-- sensitive operations.
--
-- The recorded `disabled` outcome in vortex_identity.identity_disablement_commands
-- (written only after the Identity Authority ban succeeded) is the environment
-- fact. Every cluster runtime that shares the environment authority reads that
-- one fact, so no per-cluster copy of it is kept and no new state, read model
-- or approval record is introduced:
--
--   * completing a disablement suspends the subject's existing cluster-local
--     identity projection in the same transaction as the record;
--   * a projection created later for a disabled identity is created suspended;
--   * a projection of a disabled identity cannot be reactivated, so the
--     cluster reactivation command cannot undo a disablement;
--   * sensitive operations call require_identity_not_disabled /
--     require_request_identity_not_disabled and refuse the identity at once.
--
-- Ordinary reads keep the documented access-token-expiry policy. There is no
-- re-enable operation here: re-enabling an identity is a separate, protected
-- decision that is not part of #755 or #963.

begin;

set local role postgres;

-- The environment-wide disabled fact. True only after a completed disablement.
create function vortex_identity.identity_is_disabled(p_identity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.identity_disablement_commands as command
    where command.subject_identity_id = p_identity_id
      and command.outcome = 'disabled'
  )
$function$;

-- Live check for an explicit identity (the acting identity of a runtime command).
create function vortex_identity.require_identity_not_disabled(p_identity_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or vortex_identity.identity_is_disabled(p_identity_id)
  then
    raise exception using errcode = '42501', message = 'Identity is unavailable';
  end if;
end
$function$;

-- Live check for the identity of the current protected request context.
create function vortex_identity.require_request_identity_not_disabled()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform vortex_identity.require_identity_not_disabled(
    vortex_context.identity_authority_id(true)
  );
end
$function$;

-- Publishes a completed disablement to this cluster's projection. Private: only
-- complete_identity_disablement calls it. An absent projection is created
-- suspended by ensure_identity_projection; a closed one stays closed.
create function vortex_identity.publish_identity_disablement(
  p_subject_identity_id uuid,
  p_actor_identity_id uuid,
  p_correlation_id uuid,
  p_published_at timestamptz
)
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  update vortex_identity.identity_projections as projection
  set state = 'suspended',
    state_changed_at = greatest(p_published_at, projection.state_changed_at),
    state_changed_by = p_actor_identity_id,
    state_change_correlation_id = p_correlation_id,
    revision = projection.revision + 1
  where projection.identity_id = p_subject_identity_id
    and projection.state = 'active'
$function$;

create or replace function vortex_identity.protect_identity_projection()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.identity_id is distinct from old.identity_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'Identity projection identity is permanent';
  end if;

  if old.state = 'closed' and new.state <> 'closed' then
    raise exception using errcode = '23514', message = 'A closed identity projection cannot be reactivated';
  end if;

  if new.state = 'active' and old.state <> 'active'
    and vortex_identity.identity_is_disabled(new.identity_id) then
    raise exception using errcode = '23514', message = 'A disabled identity projection cannot be reactivated';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Identity projection revision is stale or invalid';
  end if;

  return new;
end
$function$;

create or replace function vortex_identity.ensure_identity_projection(
  p_identity_id uuid,
  p_correlation_id uuid
)
returns table (
  identity_id uuid,
  state text,
  created_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Identity projection input is invalid';
  end if;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_identity_id,
    case when vortex_identity.identity_is_disabled(p_identity_id)
      then 'suspended' else 'active' end,
    operation_at, operation_at, p_identity_id, p_correlation_id, 1
  ) on conflict on constraint identity_projections_pk do nothing;

  return query
  select projection.identity_id, projection.state, projection.created_at,
    projection.state_changed_at, projection.state_changed_by,
    projection.state_change_correlation_id, projection.revision
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id;
end
$function$;

create or replace function vortex_identity.complete_identity_disablement(
  p_command_id uuid,
  p_correlation_id uuid,
  p_outcome text
)
returns table (
  outcome text,
  sessions_revoked integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
  revoked integer;
begin
  if p_command_id is null
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_outcome is null
    or p_outcome not in ('disabled', 'subject_not_found', 'provider_unavailable')
  then
    raise exception 'invalid identity disablement outcome' using errcode = '22023';
  end if;

  select * into existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;

  if not found then
    raise exception 'unknown identity disablement command' using errcode = 'P0002';
  end if;

  if existing.outcome = 'disabled' then
    -- A concurrent attempt of the same command already completed it.
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, existing.actor_identity_id, existing.subject_identity_id,
      p_correlation_id, 'replayed', operation_at
    );
    return query select existing.outcome, existing.sessions_revoked;
    return;
  end if;

  if p_outcome = 'disabled' then
    delete from auth.sessions as provider_session
    where provider_session.user_id = existing.subject_identity_id;
    get diagnostics revoked = row_count;

    update vortex_identity.identity_disablement_commands as recorded
    set outcome = 'disabled', sessions_revoked = revoked, completed_at = operation_at
    where recorded.command_id = p_command_id;

    -- Publish to the cluster-local projection in the same transaction.
    perform vortex_identity.publish_identity_disablement(
      existing.subject_identity_id, existing.actor_identity_id,
      p_correlation_id, operation_at
    );
  else
    revoked := null;
    update vortex_identity.identity_disablement_commands as recorded
    set outcome = p_outcome, sessions_revoked = null, completed_at = operation_at
    where recorded.command_id = p_command_id;
  end if;

  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event,
    sessions_revoked, recorded_at
  ) values (
    p_command_id, existing.actor_identity_id, existing.subject_identity_id,
    p_correlation_id, p_outcome, revoked, operation_at
  );
  return query select p_outcome, revoked;
end
$function$;

revoke all on function vortex_identity.identity_is_disabled(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.require_identity_not_disabled(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.require_request_identity_not_disabled()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.require_identity_not_disabled(uuid)
  to vortex_runtime, vortex_request;
grant execute on function vortex_identity.require_request_identity_not_disabled()
  to vortex_request;

comment on function vortex_identity.identity_is_disabled(uuid) is
  'Private environment-wide disabled fact: true only after a completed identity disablement.';
comment on function vortex_identity.require_identity_not_disabled(uuid) is
  'Live check at named sensitive operations: refuses (42501) an identity whose disablement completed.';
comment on function vortex_identity.require_request_identity_not_disabled() is
  'Live check for the identity of the current protected request context.';
comment on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) is
  'Private step of complete_identity_disablement: suspends the subject''s existing cluster-local identity projection.';

commit;
