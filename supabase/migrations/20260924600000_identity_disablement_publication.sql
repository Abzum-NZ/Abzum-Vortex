-- #963 (part B of #755): publish environment-wide identity disablement to the
-- cluster-local identity projections and refuse a disabled identity at named
-- sensitive operations.
--
-- The recorded `disabled` outcome in vortex_identity.identity_disablement_commands
-- (written only after the Identity Authority ban succeeded) is the environment
-- fact. Every cluster runtime served by this database reads that one fact, so
-- no per-cluster copy of it is kept and no new state, read model or approval
-- record is introduced:
--
--   * completing a disablement suspends the subject's existing cluster-local
--     identity projection in the same transaction as the record;
--   * every projection inserted later for a disabled identity (sign-in
--     bootstrap, invitation acceptance, tenant provisioning or any other
--     writer) starts suspended;
--   * a projection of a disabled identity cannot be reactivated, so the
--     cluster reactivation command cannot undo a disablement;
--   * sensitive operations call require_identity_not_disabled /
--     require_request_identity_not_disabled and refuse the identity at once.
--
-- Publication and projection inserts serialise on one per-identity transaction
-- lock, and publication also locks the projection row whatever its state, so a
-- concurrent sign-in, invitation acceptance or reactivation either waits for
-- the committed disablement and observes it, or commits first and is then
-- suspended by the publication.
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

-- Live check for the acting person of the current protected request context.
-- Only a human or federated context names a person (`identityId`); any other
-- caller kind has no identity to check and is refused.
create function vortex_identity.require_request_identity_not_disabled()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is null
    or checked ->> 'callerKind' not in ('human', 'federated')
    or not vortex_context.is_non_nil_uuid(checked ->> 'identityId')
  then
    raise exception using errcode = '42501', message = 'Identity is unavailable';
  end if;

  perform vortex_identity.require_identity_not_disabled(
    (checked ->> 'identityId')::uuid
  );
end
$function$;

-- Publishes a completed disablement to this cluster's projection. Private: only
-- complete_identity_disablement calls it. It takes the per-identity projection
-- lock and the projection row lock (whatever its state) before suspending an
-- active projection. An absent projection is created suspended later by the
-- insert trigger below; a suspended or closed one keeps its state.
create function vortex_identity.publish_identity_disablement(
  p_subject_identity_id uuid,
  p_actor_identity_id uuid,
  p_correlation_id uuid,
  p_published_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_identity.projection:' || p_subject_identity_id::text, 0
    )
  );

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_subject_identity_id
  for update;

  update vortex_identity.identity_projections as projection
  set state = 'suspended',
    state_changed_at = greatest(p_published_at, projection.state_changed_at),
    state_changed_by = p_actor_identity_id,
    state_change_correlation_id = p_correlation_id,
    revision = projection.revision + 1
  where projection.identity_id = p_subject_identity_id
    and projection.state = 'active';
end
$function$;

-- Every writer inserts projections directly with state `active`; a disabled
-- identity's new projection starts suspended instead. The per-identity lock
-- orders this check against a concurrent publication.
create function vortex_identity.start_disabled_identity_projection_suspended()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_identity.projection:' || new.identity_id::text, 0
    )
  );

  if new.state = 'active' and vortex_identity.identity_is_disabled(new.identity_id) then
    new.state := 'suspended';
  end if;

  return new;
end
$function$;

create trigger identity_projections_start_disabled_suspended
before insert on vortex_identity.identity_projections
for each row execute function vortex_identity.start_disabled_identity_projection_suspended();

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
revoke all on function vortex_identity.start_disabled_identity_projection_suspended()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- The explicit-identity check is for trusted runtime commands only; a request
-- transaction checks only the person its own verified context names.
grant execute on function vortex_identity.require_identity_not_disabled(uuid)
  to vortex_runtime;
grant execute on function vortex_identity.require_request_identity_not_disabled()
  to vortex_request;

comment on function vortex_identity.identity_is_disabled(uuid) is
  'Private environment-wide disabled fact: true only after a completed identity disablement.';
comment on function vortex_identity.require_identity_not_disabled(uuid) is
  'Runtime live check at named sensitive operations: refuses (42501) an identity whose disablement completed.';
comment on function vortex_identity.require_request_identity_not_disabled() is
  'Request live check: refuses (42501) unless the current context names a human or federated person whose disablement has not completed.';
comment on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) is
  'Private step of complete_identity_disablement: suspends the subject''s existing cluster-local identity projection.';
comment on function vortex_identity.start_disabled_identity_projection_suspended() is
  'Private insert trigger: a new cluster-local projection of a disabled identity starts suspended.';

commit;
