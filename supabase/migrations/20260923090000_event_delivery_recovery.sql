-- #640: Bounded retry budget and explicit operator recovery for a failed or
-- expired #639 consumer claim.
--
-- This never claims fresh work and never touches the immutable event_outbox
-- row. It only extends the existing per-consumer claim/lease/acknowledgement
-- row with safe, content-free failure bookkeeping, reusing the same
-- lease_expires_at reclaim barrier #639 already established: pushing the
-- lease far into the future withholds a terminally failed claim from
-- ordinary automatic reclaim without rewriting #639's claim function, and an
-- explicit operator recovery clears that hold for exactly the same
-- consumer/occurrence identity.

begin;

set local role postgres;

alter table vortex_event.consumer_occurrence_progress
  add column failure_count integer not null default 0,
  add column last_failure_code text,
  add column last_failed_at timestamptz,
  add column terminally_failed_at timestamptz,
  add column recovered_at timestamptz,
  add column recovered_by uuid,
  add column recovery_count integer not null default 0;

alter table vortex_event.consumer_occurrence_progress
  add constraint consumer_occurrence_progress_failure_count_range check (
    failure_count between 0 and 1000000
  ),
  add constraint consumer_occurrence_progress_recovery_count_range check (
    recovery_count between 0 and 1000000
  ),
  add constraint consumer_occurrence_progress_failure_code_valid check (
    last_failure_code is null or last_failure_code in (
      'transient_dependency_unavailable',
      'transient_timeout',
      'validation_rejected',
      'authorization_denied',
      'conflict_or_duplicate',
      'unclassified'
    )
  ),
  add constraint consumer_occurrence_progress_last_failed_at_shape check (
    last_failed_at is null
    or (
      last_failed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      and last_failed_at >= claimed_at
      and last_failure_code is not null
    )
  ),
  add constraint consumer_occurrence_progress_terminally_failed_at_shape check (
    terminally_failed_at is null
    or (
      terminally_failed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      and last_failed_at is not null
      and terminally_failed_at >= last_failed_at
    )
  ),
  add constraint consumer_occurrence_progress_recovered_at_shape check (
    recovered_at is null
    or (
      recovered_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      and recovered_at >= claimed_at
      and recovered_by is not null
      and recovered_by <> '00000000-0000-0000-0000-000000000000'::uuid
    )
  ),
  add constraint consumer_occurrence_progress_recovery_count_shape check (
    (recovery_count = 0) = (recovered_at is null)
  );

create index consumer_occurrence_progress_terminal
  on vortex_event.consumer_occurrence_progress (consumer_key, terminally_failed_at)
  where terminally_failed_at is not null;

-- Records one failed delivery attempt for a claim the caller still
-- authenticates with its exact claim cursor. Schedules a bounded retry by
-- pushing the reclaim lease forward, or marks the claim terminally failed
-- once the caller-supplied attempt budget is exhausted. A failure report
-- against an already terminal claim is idempotent and never re-counts.
create function vortex_event.record_consumer_occurrence_delivery_failure(
  p_consumer_key text,
  p_occurrence_id uuid,
  p_claim_cursor uuid,
  p_failure_code text,
  p_max_attempts integer,
  p_retry_backoff_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_retry_attempts constant integer := 20;
  maximum_retry_backoff_seconds constant integer := 86400;
  terminal_hold_until constant timestamptz := timestamptz '9999-12-31 00:00:00+00';
  failure_time timestamptz := pg_catalog.statement_timestamp();
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
  next_failure_count integer;
  next_lease_expires_at timestamptz;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_claim_cursor is null or p_claim_cursor = nil_uuid
    or p_failure_code is null
    or p_failure_code not in (
      'transient_dependency_unavailable', 'transient_timeout', 'validation_rejected',
      'authorization_denied', 'conflict_or_duplicate', 'unclassified'
    )
    or p_max_attempts is null or p_max_attempts not between 1 and maximum_retry_attempts
    or p_retry_backoff_seconds is null
      or p_retry_backoff_seconds not between 1 and maximum_retry_backoff_seconds then
    raise exception using errcode = '22023',
      message = 'Event delivery failure input is invalid';
  end if;

  select progress.* into progress_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  if progress_row.claim_cursor <> p_claim_cursor then
    return pg_catalog.jsonb_build_object('outcome', 'mismatched');
  end if;
  if progress_row.acknowledged_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  if progress_row.terminally_failed_at is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'terminal_failure',
      'failureCount', progress_row.failure_count,
      'failureCode', progress_row.last_failure_code
    );
  end if;

  next_failure_count := progress_row.failure_count + 1;

  if next_failure_count >= p_max_attempts then
    update vortex_event.consumer_occurrence_progress
    set failure_count = next_failure_count,
        last_failure_code = p_failure_code,
        last_failed_at = failure_time,
        terminally_failed_at = failure_time,
        lease_expires_at = terminal_hold_until
    where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'terminal_failure',
      'failureCount', next_failure_count,
      'failureCode', p_failure_code
    );
  end if;

  next_lease_expires_at := failure_time + pg_catalog.make_interval(secs => p_retry_backoff_seconds);
  update vortex_event.consumer_occurrence_progress
  set failure_count = next_failure_count,
      last_failure_code = p_failure_code,
      last_failed_at = failure_time,
      lease_expires_at = next_lease_expires_at
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'retry_scheduled',
    'failureCount', next_failure_count,
    'retryNotBefore', pg_catalog.to_char(
      pg_catalog.timezone('UTC', next_lease_expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

-- Explicit authorised operator recovery of one exhausted claim, identified by
-- the same exact consumer and occurrence identity as the original #639
-- claim. Never available for a live (non-terminal, non-expired) claim or an
-- already acknowledged one, and requires the caller's current view of the
-- failure count to match so a stale recovery decision is refused rather than
-- silently applied.
create function vortex_event.recover_consumer_occurrence_claim(
  p_consumer_key text,
  p_occurrence_id uuid,
  p_operator_actor_id uuid,
  p_expected_failure_count integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  recovery_time timestamptz := pg_catalog.statement_timestamp();
  next_lease_expires_at timestamptz;
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_operator_actor_id is null or p_operator_actor_id = nil_uuid
    or p_expected_failure_count is null or p_expected_failure_count < 0 then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery input is invalid';
  end if;

  select progress.* into progress_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  if progress_row.acknowledged_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  if progress_row.terminally_failed_at is null then
    if progress_row.lease_expires_at > recovery_time then
      return pg_catalog.jsonb_build_object('outcome', 'active');
    end if;
    -- Lapsed but never exhausted: ordinary reclaim already covers it, so the
    -- privileged override is not the authorised path for this claim.
    return pg_catalog.jsonb_build_object('outcome', 'unauthorised');
  end if;
  if progress_row.failure_count <> p_expected_failure_count then
    return pg_catalog.jsonb_build_object(
      'outcome', 'stale',
      'failureCount', progress_row.failure_count
    );
  end if;

  next_lease_expires_at := recovery_time + pg_catalog.make_interval(secs => 1);
  update vortex_event.consumer_occurrence_progress
  set terminally_failed_at = null,
      failure_count = 0,
      recovered_at = recovery_time,
      recovered_by = p_operator_actor_id,
      recovery_count = recovery_count + 1,
      lease_expires_at = next_lease_expires_at
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recovered',
    'leaseExpiresAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', next_lease_expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

-- Bounded read of currently exhausted, still-inspectable claims for one
-- consumer. Returns only safe bookkeeping fields, never occurrence payload
-- content or raw failure detail.
create function vortex_event.list_terminally_failed_consumer_occurrences(
  p_consumer_key text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  maximum_limit constant integer := 100;
  results jsonb;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_limit is null or p_limit not between 1 and maximum_limit then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery listing input is invalid';
  end if;

  select pg_catalog.coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'occurrenceId', bounded.occurrence_id,
      'failureCount', bounded.failure_count,
      'lastFailureCode', bounded.last_failure_code,
      'lastFailedAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', bounded.last_failed_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'terminallyFailedAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', bounded.terminally_failed_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'claimedAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', bounded.claimed_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ) order by bounded.terminally_failed_at, bounded.occurrence_id
  ), '[]'::jsonb) into results
  from (
    select progress.occurrence_id, progress.failure_count, progress.last_failure_code,
      progress.last_failed_at, progress.terminally_failed_at, progress.claimed_at
    from vortex_event.consumer_occurrence_progress as progress
    where progress.consumer_key = p_consumer_key
      and progress.terminally_failed_at is not null
    order by progress.terminally_failed_at, progress.occurrence_id
    limit p_limit
  ) as bounded;

  return results;
end
$function$;

alter function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) owner to postgres;
alter function vortex_event.recover_consumer_occurrence_claim(text, uuid, uuid, integer)
  owner to postgres;
alter function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  owner to postgres;

revoke all on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
revoke all on function vortex_event.recover_consumer_occurrence_claim(text, uuid, uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
revoke all on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;

grant execute on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) to vortex_runtime;
grant execute on function vortex_event.recover_consumer_occurrence_claim(text, uuid, uuid, integer)
  to vortex_runtime;
grant execute on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  to vortex_runtime;

comment on column vortex_event.consumer_occurrence_progress.failure_count is
  'Count of reported delivery failures for this claim; reset only by explicit operator recovery.';
comment on column vortex_event.consumer_occurrence_progress.last_failure_code is
  'Safe, content-free failure classification; never raw exception text or payload content.';
comment on column vortex_event.consumer_occurrence_progress.terminally_failed_at is
  'Set once the caller-supplied retry budget is exhausted; withholds this claim from ordinary reclaim until explicit operator recovery.';
comment on column vortex_event.consumer_occurrence_progress.recovered_by is
  'Attribution identifier for the authorised operator who last recovered this claim; never a credential.';
comment on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) is
  'Records one failed delivery attempt against an existing claim, scheduling a bounded retry or marking it terminally failed.';
comment on function vortex_event.recover_consumer_occurrence_claim(text, uuid, uuid, integer) is
  'Explicit authorised operator recovery of one exhausted claim for the same consumer and occurrence identity.';
comment on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer) is
  'Bounded inspection of currently exhausted, replayable claims for one consumer.';

reset role;
commit;
