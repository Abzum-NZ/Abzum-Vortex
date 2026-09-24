-- #754 (part A): Operations alert-signal sink.
--
-- #753 provides `alertRecordSchema` and `createAppTelemetryCollector`, but every
-- collector call site passes no downstream, so every alert is dropped. This
-- migration installs the database half of the system-written, deduplicated
-- alert-signal feed the Operations application reads:
--
--   * one protected table `vortex_operations.alert_signals` keyed by the
--     producer's stable `deduplicationKey`, carrying the bounded alert identity
--     plus an occurrence count and first/last-seen instants; and
--   * one protected write function `record_alert_signal` that validates the
--     exact contract shape and upserts by deduplication key, so repeated
--     signals update one row instead of creating duplicates; and
--   * one narrow read `read_open_alert_signals` that lists the still-open
--     signals, most recently seen first.
--
-- The signal feed is content-free operational data: it carries no customer
-- content and no request identity, so the write never depends on a request
-- context and can never change the measured operation's outcome. The runtime
-- half is `runtime/app/src/operations-alert-sink.ts`, which applies the same
-- contract validation before calling the writer granted below. Incidents,
-- operator actions and runbook content belong to #960/#961 and are not created
-- here.

begin;

create schema if not exists vortex_operations authorization postgres;

revoke all on schema vortex_operations
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant usage on schema vortex_operations to vortex_runtime;

alter default privileges for role postgres in schema vortex_operations
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_operations
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_operations
  revoke execute on functions from public, anon, authenticated, service_role;

-- A builder key is one lower-case word run, exactly the `builderKeySchema`
-- shape in `contracts/src/identifiers.ts`.
create function vortex_operations.alert_signal_builder_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and pg_catalog.length(p_key) between 1 and 40
    and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
$function$;

-- A namespaced key is one or more dot-separated builder-key segments, each at
-- most 40 characters, exactly the `namespacedKeySchema` shape in
-- `contracts/src/identifiers.ts`.
create function vortex_operations.alert_signal_namespaced_key_is_valid(p_key text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_key is not null
    and pg_catalog.length(p_key) between 3 and 120
    and p_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$'
    and not exists (
      select 1
      from pg_catalog.unnest(pg_catalog.string_to_array(p_key, '.')) as part(value)
      where pg_catalog.length(part.value) > 40
    )
$function$;

-- One row per producer deduplication key. The alert identity is bounded to the
-- contract's closed shape; `occurrence_count`, `first_seen_at` and
-- `last_seen_at` are owned by the protected writer, not the producer.
create table vortex_operations.alert_signals (
  signal_id uuid not null primary key,
  code text not null,
  severity text not null,
  affected_service text not null,
  deduplication_key text not null,
  owning_role text not null,
  runbook_reference text not null,
  occurrence_count bigint not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  state text not null,
  constraint alert_signals_deduplication_key_unique unique (deduplication_key),
  constraint alert_signals_identity_non_nil check (
    vortex_context.is_non_nil_uuid(signal_id::text)
  ),
  constraint alert_signals_code_valid check (
    vortex_operations.alert_signal_namespaced_key_is_valid(code)
  ),
  constraint alert_signals_severity_valid check (
    severity in ('warning', 'error', 'critical')
  ),
  constraint alert_signals_affected_service_valid check (
    vortex_operations.alert_signal_builder_key_is_valid(affected_service)
  ),
  constraint alert_signals_deduplication_key_valid check (
    pg_catalog.length(deduplication_key) between 16 and 200
    and deduplication_key ~ '^[a-z0-9][a-z0-9._:-]*$'
  ),
  constraint alert_signals_owning_role_valid check (
    vortex_operations.alert_signal_builder_key_is_valid(owning_role)
  ),
  constraint alert_signals_runbook_reference_valid check (
    vortex_operations.alert_signal_namespaced_key_is_valid(runbook_reference)
  ),
  constraint alert_signals_occurrence_count_valid check (
    occurrence_count between 1 and 9007199254740991
  ),
  constraint alert_signals_state_valid check (
    state in ('open', 'resolved')
  ),
  constraint alert_signals_times_valid check (
    first_seen_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and last_seen_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and last_seen_at >= first_seen_at
  )
);

comment on table vortex_operations.alert_signals is
  'Protected, content-free Operations alert signals, deduplicated by the producer key with an occurrence count and first/last-seen instants. Written only by the protected signal writer and read by the narrow open-signal read.';
comment on column vortex_operations.alert_signals.deduplication_key is
  'The producer-supplied stable alert identity; one row exists per key.';
comment on column vortex_operations.alert_signals.occurrence_count is
  'How many times the same deduplication key has been observed; owned by the protected writer.';
comment on column vortex_operations.alert_signals.first_seen_at is
  'When the deduplication key was first observed; preserved across later occurrences.';
comment on column vortex_operations.alert_signals.last_seen_at is
  'When the deduplication key was most recently observed; drives open-signal recency ordering.';
comment on column vortex_operations.alert_signals.state is
  'Open signals are listed by the narrow read; resolution belongs to the later Operations incident actions, and a recurrence reopens a resolved signal.';

-- The narrow read always filters on `state = 'open'` and orders by recency, so
-- one partial index serves it without indexing resolved history.
create index alert_signals_open_last_seen_idx
  on vortex_operations.alert_signals (last_seen_at desc, signal_id)
  where state = 'open';

alter table vortex_operations.alert_signals enable row level security;
alter table vortex_operations.alert_signals force row level security;

revoke all on table vortex_operations.alert_signals
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- Records one alert signal for a validated contract shape. A first occurrence
-- creates the row; a repeated deduplication key refreshes the bounded identity,
-- increments the occurrence count (saturating at the contract's safe-integer
-- bound), advances `last_seen_at` monotonically and reopens a resolved signal,
-- so a recurrence is never hidden from the open-signal read. The original
-- `first_seen_at` is preserved. The caller never supplies the signal identity,
-- the times, the count or the state, so one producer cannot forge another
-- producer's cadence.
create function vortex_operations.record_alert_signal(
  p_code text,
  p_severity text,
  p_affected_service text,
  p_deduplication_key text,
  p_owning_role text,
  p_runbook_reference text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  observed_at timestamptz := pg_catalog.clock_timestamp();
  stored vortex_operations.alert_signals%rowtype;
begin
  if p_code is null or not vortex_operations.alert_signal_namespaced_key_is_valid(p_code)
    or p_severity is null
    or p_severity not in ('warning', 'error', 'critical')
    or p_affected_service is null
    or not vortex_operations.alert_signal_builder_key_is_valid(p_affected_service)
    or p_deduplication_key is null
    or pg_catalog.length(p_deduplication_key) not between 16 and 200
    or p_deduplication_key !~ '^[a-z0-9][a-z0-9._:-]*$'
    or p_owning_role is null
    or not vortex_operations.alert_signal_builder_key_is_valid(p_owning_role)
    or p_runbook_reference is null
    or not vortex_operations.alert_signal_namespaced_key_is_valid(p_runbook_reference) then
    raise exception using errcode = '22023',
      message = 'Operations alert signal is invalid';
  end if;

  insert into vortex_operations.alert_signals (
    signal_id, code, severity, affected_service, deduplication_key,
    owning_role, runbook_reference, occurrence_count, first_seen_at, last_seen_at, state
  ) values (
    pg_catalog.gen_random_uuid(), p_code, p_severity, p_affected_service,
    p_deduplication_key, p_owning_role, p_runbook_reference, 1, observed_at, observed_at,
    'open'
  )
  on conflict (deduplication_key) do update set
    code = excluded.code,
    severity = excluded.severity,
    affected_service = excluded.affected_service,
    owning_role = excluded.owning_role,
    runbook_reference = excluded.runbook_reference,
    occurrence_count = least(
      vortex_operations.alert_signals.occurrence_count + 1, 9007199254740991
    ),
    last_seen_at = greatest(
      vortex_operations.alert_signals.last_seen_at, excluded.last_seen_at
    ),
    state = 'open'
  returning * into stored;

  return pg_catalog.jsonb_build_object(
    'signalId', stored.signal_id,
    'code', stored.code,
    'severity', stored.severity,
    'affectedService', stored.affected_service,
    'deduplicationKey', stored.deduplication_key,
    'owningRole', stored.owning_role,
    'runbookReference', stored.runbook_reference,
    'occurrenceCount', stored.occurrence_count,
    'firstSeenAt', pg_catalog.to_char(stored.first_seen_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lastSeenAt', pg_catalog.to_char(stored.last_seen_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'state', stored.state
  );
end
$function$;

-- The narrow Operations read: at most one bounded page of open signals, most
-- recently seen first, with stable ordering by signal identity. Resolved rows
-- are never returned. The signal feed is content-free, so no request context is
-- required and no customer scope is consulted.
create function vortex_operations.read_open_alert_signals(
  p_limit integer default 100
)
returns table (
  signal_id uuid,
  code text,
  severity text,
  affected_service text,
  deduplication_key text,
  owning_role text,
  runbook_reference text,
  occurrence_count bigint,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = '22023',
      message = 'Operations alert signal read is invalid';
  end if;

  return query
    select signal.signal_id, signal.code, signal.severity, signal.affected_service,
      signal.deduplication_key, signal.owning_role, signal.runbook_reference,
      signal.occurrence_count, signal.first_seen_at, signal.last_seen_at, signal.state
    from vortex_operations.alert_signals as signal
    where signal.state = 'open'
    order by signal.last_seen_at desc, signal.signal_id
    limit p_limit;
end
$function$;

alter function vortex_operations.alert_signal_builder_key_is_valid(text)
  owner to postgres;
alter function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  owner to postgres;
alter function vortex_operations.record_alert_signal(text, text, text, text, text, text)
  owner to postgres;
alter function vortex_operations.read_open_alert_signals(integer)
  owner to postgres;

revoke all on function vortex_operations.alert_signal_builder_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_operations.alert_signal_namespaced_key_is_valid(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_operations.read_open_alert_signals(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- The runtime is the only writer of the feed and the only reader of the narrow
-- open-signal view. No request, adapter or module role receives either.
grant execute on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) to vortex_runtime;
grant execute on function vortex_operations.read_open_alert_signals(integer)
  to vortex_runtime;

comment on function vortex_operations.alert_signal_builder_key_is_valid(text) is
  'Private check for the contract builder-key shape used by alert service and owning-role fields.';
comment on function vortex_operations.alert_signal_namespaced_key_is_valid(text) is
  'Private check for the contract namespaced-key shape used by alert code and runbook-reference fields.';
comment on function vortex_operations.record_alert_signal(
  text, text, text, text, text, text
) is
  'Validates one contract alert record and upserts it by deduplication key, incrementing the occurrence count, refreshing last-seen and reopening a resolved signal.';
comment on function vortex_operations.read_open_alert_signals(integer) is
  'Returns one bounded page of open Operations alert signals, most recently seen first.';

commit;
