-- #755 part A: attributable environment identity disablement audit.
--
-- The Identity Authority (Supabase Auth) is the environment-wide owner of an
-- identity. Disabling it is a protected server operation: the App coordination
-- operation verifies the operator's `platform.security.identities.disable`
-- permission in the environment root organisation through Access, then the
-- server-only Identity adapter bans the identity through the Auth Admin API and
-- calls these functions to record the command and revoke the provider sessions.
--
-- The command record holds the acting identity, the subject identity, the
-- command identity, a fingerprint of those three values and the current
-- outcome. Every attempt and every recorded outcome is also appended to an
-- immutable event log, so a failed attempt, a retry, a replay and a conflicting
-- reuse of a command identity stay attributable after the command completes.
-- Neither table holds a credential, token, address or profile. An exact retry
-- (same command identity and same fingerprint) of a completed disablement
-- replays the recorded result without calling the provider again; the same command
-- identity with a different actor or subject is a conflict. A failed or
-- interrupted attempt is retried by the same command because the provider
-- operations are idempotent.
--
-- Session revocation deletes the subject's rows from Supabase Auth's
-- `auth.sessions` (their refresh tokens and authentication-method claims
-- cascade), because the Auth Admin API can revoke sessions only with the
-- subject's own access token. The delete runs inside the security-definer
-- completion function owned by `postgres`, in the same transaction as the
-- `disabled` record: if the owner cannot delete, the whole completion rolls
-- back and the adapter reports the authority unavailable instead of claiming a
-- revocation. The provider ban has already refused new sign-ins and refreshes,
-- and a retry of the same command completes the revocation once the delete succeeds.
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

-- Append-only attributable history: one row per attempt and per outcome.
create table vortex_identity.identity_disablement_events (
  event_id bigint generated always as identity primary key,
  command_id uuid not null
    references vortex_identity.identity_disablement_commands (command_id),
  actor_identity_id uuid not null,
  subject_identity_id uuid not null,
  correlation_id uuid not null,
  event text not null,
  sessions_revoked integer,
  recorded_at timestamptz not null,
  constraint identity_disablement_events_ids_non_nil check (
    vortex_context.is_non_nil_uuid(command_id::text)
    and vortex_context.is_non_nil_uuid(actor_identity_id::text)
    and vortex_context.is_non_nil_uuid(subject_identity_id::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint identity_disablement_events_event_valid check (
    event in (
      'started', 'replayed', 'conflict',
      'disabled', 'subject_not_found', 'provider_unavailable'
    )
  ),
  constraint identity_disablement_events_sessions_shape check (
    (event = 'disabled' and sessions_revoked >= 0)
    or (event <> 'disabled' and sessions_revoked is null)
  ),
  constraint identity_disablement_events_time_valid check (
    recorded_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

create index identity_disablement_events_command_idx
  on vortex_identity.identity_disablement_events (command_id, event_id);
create index identity_disablement_events_subject_idx
  on vortex_identity.identity_disablement_events (subject_identity_id, recorded_at);

create function vortex_identity.refuse_identity_disablement_record_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'identity disablement history is append-only'
    using errcode = '55000';
end
$function$;

create trigger identity_disablement_events_immutable
  before update or delete on vortex_identity.identity_disablement_events
  for each row execute function vortex_identity.refuse_identity_disablement_record_change();
create trigger identity_disablement_events_not_truncated
  before truncate on vortex_identity.identity_disablement_events
  for each statement execute function vortex_identity.refuse_identity_disablement_record_change();
create trigger identity_disablement_commands_not_truncated
  before truncate on vortex_identity.identity_disablement_commands
  for each statement execute function vortex_identity.refuse_identity_disablement_record_change();

alter table vortex_identity.identity_disablement_commands enable row level security;
alter table vortex_identity.identity_disablement_commands force row level security;
alter table vortex_identity.identity_disablement_events enable row level security;
alter table vortex_identity.identity_disablement_events force row level security;

revoke all on table vortex_identity.identity_disablement_commands
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on table vortex_identity.identity_disablement_events
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.protect_identity_disablement_command()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.refuse_identity_disablement_record_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- Records (or re-opens) one command before the provider is called and appends
-- the attempt to the event log. Outcomes: started (the caller must call the
-- provider), replayed (already disabled; the recorded result is returned) and
-- conflict (the command identity was recorded for different values).
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
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'started', operation_at
    );
    return query select 'started'::text, null::integer, p_correlation_id;
    return;
  end if;

  select * into strict existing
  from vortex_identity.identity_disablement_commands as recorded
  where recorded.command_id = p_command_id
  for update;

  if existing.command_fingerprint is distinct from p_command_fingerprint
    or existing.actor_identity_id is distinct from p_actor_identity_id
    or existing.subject_identity_id is distinct from p_subject_identity_id
  then
    -- The attempted (not the recorded) actor and subject are attributed.
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'conflict', operation_at
    );
    return query select 'conflict'::text, null::integer, existing.correlation_id;
    return;
  end if;

  if existing.outcome = 'disabled' then
    insert into vortex_identity.identity_disablement_events (
      command_id, actor_identity_id, subject_identity_id, correlation_id, event,
      recorded_at
    ) values (
      p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
      'replayed', operation_at
    );
    return query select 'replayed'::text, existing.sessions_revoked, existing.correlation_id;
    return;
  end if;

  update vortex_identity.identity_disablement_commands as recorded
  set outcome = 'started',
      completed_at = null,
      sessions_revoked = null,
      attempt_count = recorded.attempt_count + 1
  where recorded.command_id = p_command_id;

  insert into vortex_identity.identity_disablement_events (
    command_id, actor_identity_id, subject_identity_id, correlation_id, event,
    recorded_at
  ) values (
    p_command_id, p_actor_identity_id, p_subject_identity_id, p_correlation_id,
    'started', operation_at
  );
  return query select 'started'::text, null::integer, existing.correlation_id;
end
$function$;

-- Records the provider outcome of one attempt. A `disabled` outcome is recorded
-- only after the Auth Admin API has banned the identity; this function then
-- revokes every provider session of the subject in the same transaction as the
-- record and its event, so the record cannot claim a revocation that did not
-- happen.
create function vortex_identity.complete_identity_disablement(
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

revoke execute on function vortex_identity.begin_identity_disablement(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke execute on function vortex_identity.complete_identity_disablement(uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.begin_identity_disablement(
  uuid, uuid, uuid, text, uuid
) to vortex_runtime;
grant execute on function vortex_identity.complete_identity_disablement(uuid, uuid, text)
  to vortex_runtime;

comment on table vortex_identity.identity_disablement_commands is
  'Private attributable record of environment-wide identity disablement commands: actor, subject, command identity, fingerprint and current outcome only; it contains no credential, token, address or profile.';
comment on table vortex_identity.identity_disablement_events is
  'Private append-only history of every identity disablement attempt and outcome: command identity, attempted actor and subject, correlation and outcome only; it contains no credential, token, address or profile.';
comment on function vortex_identity.begin_identity_disablement(uuid, uuid, uuid, text, uuid)
  is 'Server-only Identity Authority adapter step: records or re-opens one identity disablement command and replays a completed exact retry.';
comment on function vortex_identity.complete_identity_disablement(uuid, uuid, text)
  is 'Server-only Identity Authority adapter step: records the provider outcome and revokes the subject''s provider sessions with the record.';

commit;
