-- #755 part A: attributable environment identity disablement audit.
--
-- The Identity Authority (Supabase Auth) is the environment-wide owner of an
-- identity. Disabling it is a protected server operation: the App coordination
-- operation verifies the operator's `platform.security.identities.disable`
-- permission in the environment root organisation through Access, then the
-- server-only Identity adapter bans the identity through the Auth Admin API and
-- calls these functions to record the command and revoke the provider sessions.
--
-- The record holds the acting identity, the subject identity, the command
-- identity, a fingerprint of those three values and the outcome. It holds no
-- credential, token, address or profile data. An exact retry (same command
-- identity and same fingerprint) of a completed disablement replays the
-- recorded result without another mutation; the same command identity with a
-- different actor or subject is a conflict. A failed or interrupted attempt is
-- retried by the same command because the provider operations are idempotent.
--
-- The cluster identity projection is not changed here: cluster rows never act
-- as the global authority, and publishing the disabled state to clusters is
-- part B (#963).

begin;

set local role postgres;

create table vortex_identity.identity_disablement_commands (
  command_id uuid primary key,
  actor_identity_id uuid not null,
  subject_identity_id uuid not null,
  command_fingerprint text not null,
  correlation_id uuid not null,
  outcome text not null,
  sessions_revoked integer,
  attempt_count integer not null default 1,
  requested_at timestamptz not null,
  completed_at timestamptz,
  constraint identity_disablement_commands_ids_non_nil check (
    vortex_context.is_non_nil_uuid(command_id::text)
    and vortex_context.is_non_nil_uuid(actor_identity_id::text)
    and vortex_context.is_non_nil_uuid(subject_identity_id::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint identity_disablement_commands_not_self check (
    actor_identity_id <> subject_identity_id
  ),
  constraint identity_disablement_commands_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint identity_disablement_commands_outcome_valid check (
    outcome in ('started', 'disabled', 'subject_not_found', 'provider_unavailable')
  ),
  constraint identity_disablement_commands_attempts_valid check (
    attempt_count between 1 and 1000000
  ),
  constraint identity_disablement_commands_terminal_shape check (
    (outcome = 'started' and completed_at is null and sessions_revoked is null)
    or (outcome = 'disabled' and completed_at is not null and sessions_revoked >= 0)
    or (
      outcome in ('subject_not_found', 'provider_unavailable')
      and completed_at is not null
      and sessions_revoked is null
    )
  ),
  constraint identity_disablement_commands_times_valid check (
    requested_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (completed_at is null or completed_at >= requested_at)
  )
);

create index identity_disablement_commands_subject_idx
  on vortex_identity.identity_disablement_commands (subject_identity_id, requested_at);

create function vortex_identity.protect_identity_disablement_command()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'identity disablement records are append-only'
      using errcode = '55000';
  end if;
  if new.command_id is distinct from old.command_id
    or new.actor_identity_id is distinct from old.actor_identity_id
    or new.subject_identity_id is distinct from old.subject_identity_id
    or new.command_fingerprint is distinct from old.command_fingerprint
    or new.correlation_id is distinct from old.correlation_id
    or new.requested_at is distinct from old.requested_at
    or old.outcome = 'disabled'
  then
    raise exception 'a recorded identity disablement command identity and result are immutable'
      using errcode = '55000';
  end if;
  return new;
end
$function$;

create trigger identity_disablement_commands_protect
  before update or delete on vortex_identity.identity_disablement_commands
  for each row execute function vortex_identity.protect_identity_disablement_command();

alter table vortex_identity.identity_disablement_commands enable row level security;
alter table vortex_identity.identity_disablement_commands force row level security;

revoke all on table vortex_identity.identity_disablement_commands
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.protect_identity_disablement_command()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- Records (or re-opens) one command before the provider is called.
-- Outcomes: started (the caller must call the provider), replayed (already
-- disabled; the recorded result is returned) and conflict (the command identity
-- was recorded for different values).
create function vortex_identity.begin_identity_disablement(
  p_actor_identity_id uuid,
  p_subject_identity_id uuid,
  p_command_id uuid,
  p_command_fingerprint text,
  p_correlation_id uuid
)
returns table (
  outcome text,
  sessions_revoked integer,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  existing vortex_identity.identity_disablement_commands%rowtype;
begin
  if p_actor_identity_id is null
    or p_subject_identity_id is null
    or p_command_id is null
    or p_correlation_id is null
    or p_command_fingerprint is null
    or p_actor_identity_id = p_subject_identity_id
    or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_subject_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_command_id::text)
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
  then
    raise exception 'invalid identity disablement command' using errcode = '22023';
  end if;

  insert into vortex_identity.identity_disablement_commands (
    command_id, actor_identity_id, subject_identity_id, command_fingerprint,
    correlation_id, outcome, requested_at
  ) values (
    p_command_id, p_actor_identity_id, p_subject_identity_id, p_command_fingerprint,
    p_correlation_id, 'started', operation_at
  )
  on conflict (command_id) do nothing;

  if found then
    return query select 'started'::text, null::integer, p_correlation_id;
    return;
  end if;

  select * into existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;

  if existing.command_fingerprint is distinct from p_command_fingerprint
    or existing.actor_identity_id is distinct from p_actor_identity_id
    or existing.subject_identity_id is distinct from p_subject_identity_id
  then
    return query select 'conflict'::text, null::integer, existing.correlation_id;
    return;
  end if;

  if existing.outcome = 'disabled' then
    return query select 'replayed'::text, existing.sessions_revoked, existing.correlation_id;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = 'started',
      completed_at = null,
      sessions_revoked = null,
      attempt_count = recorded.attempt_count + 1
  where recorded.command_id = p_command_id;

  return query select 'started'::text, null::integer, existing.correlation_id;
end
$function$;

-- Records the provider outcome. A `disabled` outcome is recorded only after the
-- Auth Admin API has banned the identity; this function then revokes every
-- provider session of the subject in the same transaction as the record, so the
-- record cannot claim a revocation that did not happen.
create function vortex_identity.complete_identity_disablement(
  p_command_id uuid,
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
    return query select 'disabled'::text, revoked;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = p_outcome, sessions_revoked = null, completed_at = operation_at
  where recorded.command_id = p_command_id;
  return query select p_outcome, null::integer;
end
$function$;

revoke execute on function vortex_identity.begin_identity_disablement(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke execute on function vortex_identity.complete_identity_disablement(uuid, text)
  from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.begin_identity_disablement(
  uuid, uuid, uuid, text, uuid
) to vortex_runtime;
grant execute on function vortex_identity.complete_identity_disablement(uuid, text)
  to vortex_runtime;

comment on table vortex_identity.identity_disablement_commands is
  'Private attributable record of environment-wide identity disablement commands: actor, subject, command identity, fingerprint and outcome only; it contains no credential, token, address or profile.';
comment on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, text, uuid)
  is 'Server-only Identity Authority adapter step: records or re-opens one identity disablement command and replays a completed exact retry.';
comment on function vortex_identity.complete_identity_disablement(uuid, text)
  is 'Server-only Identity Authority adapter step: records the provider outcome and revokes the subject''s provider sessions with the record.';

commit;
