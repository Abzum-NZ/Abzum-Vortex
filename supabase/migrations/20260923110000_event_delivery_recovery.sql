-- #640: Bounded retry budget, safe failure evidence and authorised operator
-- recovery for a failed or interrupted #639 consumer claim.
--
-- This never claims fresh work and never touches the immutable event_outbox
-- row. It extends the existing per-consumer claim/lease/acknowledgement row
-- with content-free failure bookkeeping and one terminal state.
--
-- Terminal state is expressed only by terminally_failed_at, never by a
-- sentinel lease value, so #639's lease field keeps its honest meaning. The
-- three #639 claim functions are replaced in place to honour that state:
-- a terminally failed claim is neither reclaimable, renewable nor
-- acknowledgeable, and only an authorised operator recovery reopens it.
-- Their signatures, outcome vocabulary and ordering semantics are unchanged,
-- so the #639 consumer contract and its runtime parsers still hold. Because a
-- failed claim is never acknowledged, #639's predecessor barrier keeps
-- blocking later work for the same record.
--
-- Recovery authority is database-resolved, never caller-asserted. The private
-- registry installed here ships empty, so recovery refuses closed until a
-- later, separately reviewed owner step registers the consumer's operator
-- identity and its execution session role.

begin;

set local role postgres;

alter table vortex_event.consumer_occurrence_progress
  add column attempt_count integer not null default 1,
  add column failure_count integer not null default 0,
  add column last_failure_code text,
  add column last_failed_at timestamptz,
  add column terminally_failed_at timestamptz,
  add column recovered_at timestamptz,
  add column recovered_by uuid,
  add column recovery_count integer not null default 0;

alter table vortex_event.consumer_occurrence_progress
  add constraint consumer_occurrence_progress_attempt_count_range check (
    attempt_count between 0 and 1000000
  ),
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
  -- Deliberately not anchored to claimed_at: #639's reclaim advances
  -- claimed_at on the same row, so failure evidence recorded under an earlier
  -- attempt legitimately predates the current claim.
  add constraint consumer_occurrence_progress_last_failure_shape check (
    (last_failed_at is null) = (last_failure_code is null)
    and (
      last_failed_at is null
      or last_failed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
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
    (recovered_at is null) = (recovered_by is null)
    and (recovery_count = 0) = (recovered_at is null)
    and (
      recovered_at is null
      or (
        recovered_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
        and recovered_by <> '00000000-0000-0000-0000-000000000000'::uuid
      )
    )
  );

create index consumer_occurrence_progress_terminal
  on vortex_event.consumer_occurrence_progress (consumer_key, terminally_failed_at)
  where terminally_failed_at is not null;

-- Private, owner-only registry of the fixed-purpose operator identity allowed
-- to recover exhausted claims for one consumer. It installs no row, login,
-- session role or runtime caller: every consumer is therefore unauthorised for
-- recovery until a later, separately reviewed owner step registers it. The
-- execution session role is compared against session_user, which SET LOCAL
-- ROLE cannot change, so holding the runtime capability is not authority.
create table vortex_event.consumer_recovery_authority (
  consumer_key text primary key check (
    pg_catalog.octet_length(consumer_key) between 1 and 128
    and consumer_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  operation text not null default 'recover_consumer_occurrence_claim' check (
    operation = 'recover_consumer_occurrence_claim'
  ),
  operator_actor_id uuid check (
    operator_actor_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  execution_session_role_oid oid,
  state text not null default 'disabled' check (
    state in ('disabled', 'active', 'revoked')
  ),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint consumer_recovery_authority_active_ready check (
    state <> 'active'
    or (operator_actor_id is not null and execution_session_role_oid is not null)
  ),
  constraint consumer_recovery_authority_revoked_shape check (
    state <> 'revoked'
    or (operator_actor_id is null and execution_session_role_oid is null)
  )
);

alter table vortex_event.consumer_recovery_authority enable row level security;
alter table vortex_event.consumer_recovery_authority force row level security;

-- Replaces #639's claim so it honours #640's terminal state. Signature,
-- ordering, causal bounds, per-record predecessor barrier and result shape are
-- unchanged. Two additions: an interrupted claim that never reported a failure
-- still consumes the platform delivery-attempt ceiling and becomes an
-- operator-visible terminal failure instead of looping forever, and a
-- terminally failed claim is withheld from reclaim until authorised recovery.
create or replace function vortex_event.claim_consumer_occurrences(
  p_consumer_key text,
  p_batch_size integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  maximum_batch_size constant integer := 100;
  maximum_lease_seconds constant integer := 300;
  maximum_causal_depth constant integer := 16;
  maximum_delivery_attempts constant integer := 20;
  maximum_terminal_sweep constant integer := 400;
  claim_time timestamptz := pg_catalog.statement_timestamp();
  claim_cursor uuid := pg_catalog.gen_random_uuid();
  claimed jsonb;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_batch_size is null
    or p_batch_size not between 1 and maximum_batch_size
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and maximum_lease_seconds then
    raise exception using errcode = '22023', message = 'Event consumer claim input is invalid';
  end if;

  -- A worker that dies mid-delivery reports nothing, so the lease simply
  -- lapses.  Counting the lapsed attempt here is what makes the retry budget
  -- bounded for interrupted work as well as for reported failures, and moves
  -- a blocked sequence to an operator-visible failure state rather than
  -- retrying it forever.  This must be its own statement: a data-modifying CTE
  -- in the claim query below would still read the pre-update snapshot.
  update vortex_event.consumer_occurrence_progress as progress
  set last_failed_at = pg_catalog.coalesce(progress.last_failed_at, claim_time),
      last_failure_code = pg_catalog.coalesce(progress.last_failure_code, 'unclassified'),
      terminally_failed_at = case
        when progress.last_failed_at is not null and progress.last_failed_at > claim_time
          then progress.last_failed_at
        else claim_time
      end
  where (progress.consumer_key, progress.occurrence_id) in (
    select exhausted.consumer_key, exhausted.occurrence_id
    from vortex_event.consumer_occurrence_progress as exhausted
    where exhausted.consumer_key = p_consumer_key
      and exhausted.acknowledged_at is null
      and exhausted.terminally_failed_at is null
      and exhausted.lease_expires_at <= claim_time
      and exhausted.attempt_count >= maximum_delivery_attempts
    order by exhausted.lease_expires_at, exhausted.occurrence_id
    limit maximum_terminal_sweep
    for update skip locked
  );

  -- There is no mutable delivery state on an outbox occurrence.  Missing
  -- progress for an earlier sequence is therefore also an unacknowledged
  -- predecessor, which makes the barrier correct for a newly registered
  -- consumer as well as for a consumer recovering an expired lease.
  with candidate_window as materialized (
    select occurrence.*
    from vortex_event.event_outbox as occurrence
    left join vortex_event.consumer_occurrence_progress as progress
      on progress.consumer_key = p_consumer_key
      and progress.occurrence_id = occurrence.occurrence_id
    where progress.acknowledged_at is null
      and progress.terminally_failed_at is null
      and (progress.lease_expires_at is null or progress.lease_expires_at <= claim_time)
      and not exists (
        select 1
        from vortex_event.event_outbox as predecessor
        left join vortex_event.consumer_occurrence_progress as predecessor_progress
          on predecessor_progress.consumer_key = p_consumer_key
          and predecessor_progress.occurrence_id = predecessor.occurrence_id
        where predecessor.organization_id = occurrence.organization_id
          and predecessor.storage_contract_id = occurrence.storage_contract_id
          and predecessor.sequence_application_root_id is not distinct from
            occurrence.sequence_application_root_id
          and predecessor.record_id = occurrence.record_id
          and predecessor.record_sequence < occurrence.record_sequence
          and predecessor_progress.acknowledged_at is null
      )
    order by occurrence.occurred_at, occurrence.occurrence_id
    limit 400
  ), candidate as materialized (
    select occurrence.*, causal.depth as causal_depth
    from candidate_window as occurrence
    cross join lateral (
      select pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'vortex_event.consumer:' || p_consumer_key || ':' || occurrence.occurrence_id::text,
          0
        )
      ) as acquired
    ) as claim_lock
    cross join lateral (
      with recursive causal_chain(occurrence_id, causation_id, depth, path) as (
        select occurrence.occurrence_id,
          case
            when occurrence.envelope ->> 'causationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (occurrence.envelope ->> 'causationId')::uuid
            else null::uuid
          end,
          0,
          array[occurrence.occurrence_id]
        union all
        select parent.occurrence_id,
          case
            when parent.envelope ->> 'causationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (parent.envelope ->> 'causationId')::uuid
            else null::uuid
          end,
          causal_chain.depth + 1,
          causal_chain.path || parent.occurrence_id
        from causal_chain
        join vortex_event.event_outbox as parent
          on parent.occurrence_id = causal_chain.causation_id
          and parent.organization_id = occurrence.organization_id
        where causal_chain.depth < maximum_causal_depth
          and not parent.occurrence_id = any (causal_chain.path)
      )
      select pg_catalog.max(depth)::integer as depth,
        pg_catalog.coalesce(pg_catalog.bool_or(
          depth = maximum_causal_depth
          and causation_id is not null
          and exists (
            select 1 from vortex_event.event_outbox as deeper
            where deeper.occurrence_id = causal_chain.causation_id
              and deeper.organization_id = occurrence.organization_id
          )
        ), false) as exceeds_limit,
        pg_catalog.coalesce(pg_catalog.bool_or(
          causation_id is not null
          and exists (
            select 1 from vortex_event.event_outbox as repeated
            where repeated.occurrence_id = causal_chain.causation_id
              and repeated.organization_id = occurrence.organization_id
              and repeated.occurrence_id = any (causal_chain.path)
          )
        ), false) as has_cycle
      from causal_chain
    ) as causal
    where claim_lock.acquired
      and not causal.exceeds_limit
      and not causal.has_cycle
    order by occurrence.occurred_at, occurrence.occurrence_id
    limit p_batch_size
  ), claimed as (
    insert into vortex_event.consumer_occurrence_progress (
      consumer_key, occurrence_id, claim_cursor, claimed_at, lease_expires_at, attempt_count
    )
    select p_consumer_key, occurrence_id, claim_cursor, claim_time,
      claim_time + pg_catalog.make_interval(secs => p_lease_seconds), 1
    from candidate
    on conflict (consumer_key, occurrence_id) do update
      set claim_cursor = excluded.claim_cursor,
          claimed_at = excluded.claimed_at,
          lease_expires_at = excluded.lease_expires_at,
          attempt_count = consumer_occurrence_progress.attempt_count + 1
      where consumer_occurrence_progress.acknowledged_at is null
        and consumer_occurrence_progress.terminally_failed_at is null
        and consumer_occurrence_progress.lease_expires_at <= claim_time
    returning occurrence_id, lease_expires_at
  )
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'occurrence', candidate.envelope,
      'causalDepth', candidate.causal_depth,
      'leaseExpiresAt', pg_catalog.to_char(
        pg_catalog.timezone('UTC', claimed.lease_expires_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ) order by candidate.occurred_at, candidate.occurrence_id
  ) into claimed
  from claimed
  join candidate using (occurrence_id);

  return pg_catalog.jsonb_build_object(
    'ackCursor', case when claimed is null then null else claim_cursor end,
    'occurrences', pg_catalog.coalesce(claimed, '[]'::jsonb)
  );
end
$function$;

-- Replaces #639's renewal so a terminally failed claim cannot be kept alive.
-- Without this guard the worker that exhausted the budget still holds the
-- matching cursor and could renew its way straight back into ordinary
-- delivery, bypassing operator recovery entirely.
create or replace function vortex_event.renew_consumer_occurrence_lease(
  p_consumer_key text,
  p_ack_cursor uuid,
  p_occurrence_id uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_lease_seconds constant integer := 300;
  renewal_time timestamptz := pg_catalog.statement_timestamp();
  renewed_until timestamptz;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_ack_cursor is null or p_ack_cursor = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and maximum_lease_seconds then
    raise exception using errcode = '22023', message = 'Event consumer lease renewal input is invalid';
  end if;

  update vortex_event.consumer_occurrence_progress
  set lease_expires_at = renewal_time + pg_catalog.make_interval(secs => p_lease_seconds)
  where consumer_key = p_consumer_key
    and occurrence_id = p_occurrence_id
    and claim_cursor = p_ack_cursor
    and acknowledged_at is null
    and terminally_failed_at is null
    and lease_expires_at > renewal_time
  returning lease_expires_at into renewed_until;

  if renewed_until is null then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'renewed',
    'leaseExpiresAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', renewed_until), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

-- Replaces #639's acknowledgement so an exhausted claim cannot be signed off
-- as delivered.  A terminal row is unacknowledged, so it falls through to the
-- existing claim_unavailable answer and the outcome vocabulary is unchanged.
create or replace function vortex_event.acknowledge_consumer_occurrence(
  p_consumer_key text,
  p_ack_cursor uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  acknowledgement_time timestamptz := pg_catalog.statement_timestamp();
  already_acknowledged timestamptz;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_ack_cursor is null or p_ack_cursor = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Event consumer acknowledgement input is invalid';
  end if;

  update vortex_event.consumer_occurrence_progress
  set acknowledged_at = acknowledgement_time
  where consumer_key = p_consumer_key
    and occurrence_id = p_occurrence_id
    and claim_cursor = p_ack_cursor
    and acknowledged_at is null
    and terminally_failed_at is null
    and lease_expires_at > acknowledgement_time;
  if found then
    return pg_catalog.jsonb_build_object('outcome', 'acknowledged');
  end if;

  select progress.acknowledged_at into already_acknowledged
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
    and progress.claim_cursor = p_ack_cursor
  for update;
  if already_acknowledged is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
end
$function$;

-- Records one failed delivery attempt for a claim the caller still
-- authenticates with its exact claim cursor. Schedules a bounded retry by
-- releasing the reclaim lease after a backoff, or marks the claim terminally
-- failed once the caller-supplied attempt budget is exhausted. A failure
-- report against an already terminal claim is idempotent and never re-counts.
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
        terminally_failed_at = failure_time
    where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

    return pg_catalog.jsonb_build_object(
      'outcome', 'terminal_failure',
      'failureCount', next_failure_count,
      'failureCode', p_failure_code
    );
  end if;

  -- Releasing the lease at the backoff instant is what schedules the retry:
  -- #639's claim reclaims exactly this consumer/occurrence row once the lease
  -- has lapsed, so no fresh work is claimed and no ordering is skipped.
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
-- the same exact consumer and occurrence identity as the original #639 claim.
--
-- Authority is resolved here, from the private registry and the immutable
-- session user, and is checked before anything about the claim is revealed or
-- touched. The caller cannot name the operator: attribution is taken from the
-- registered identity, so this API cannot be presented as authorised recovery
-- by supplying a UUID. Recovery is never available for a live or already
-- acknowledged claim, nor for one that merely lapsed without exhausting its
-- budget, and the caller's view of the failure count must still match so a
-- stale decision is refused rather than silently applied.
create function vortex_event.recover_consumer_occurrence_claim(
  p_consumer_key text,
  p_occurrence_id uuid,
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
  caller_session_role_oid oid := pg_catalog.to_regrole(session_user)::oid;
  recovery_time timestamptz := pg_catalog.statement_timestamp();
  authority_row vortex_event.consumer_recovery_authority%rowtype;
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_failure_count is null or p_expected_failure_count < 0 then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery input is invalid';
  end if;

  select authority.* into authority_row
  from vortex_event.consumer_recovery_authority as authority
  where authority.consumer_key = p_consumer_key
    and authority.operation = 'recover_consumer_occurrence_claim'
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_not_configured'
    );
  end if;
  if authority_row.state = 'revoked' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_revoked'
    );
  end if;
  if authority_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_disabled'
    );
  end if;
  if authority_row.operator_actor_id is null
    or authority_row.execution_session_role_oid is null
    or authority_row.execution_session_role_oid is distinct from caller_session_role_oid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_session_unauthorised'
    );
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
    -- privileged override is not the right path for this claim.
    return pg_catalog.jsonb_build_object('outcome', 'not_exhausted');
  end if;
  if progress_row.failure_count <> p_expected_failure_count then
    return pg_catalog.jsonb_build_object(
      'outcome', 'stale',
      'failureCount', progress_row.failure_count
    );
  end if;

  -- Clearing the terminal hold and both budgets hands the claim back to
  -- #639's ordinary reclaim for exactly this consumer and occurrence. Failure
  -- evidence and the recovery attribution stay on the row.
  update vortex_event.consumer_occurrence_progress
  set terminally_failed_at = null,
      failure_count = 0,
      attempt_count = 0,
      recovered_at = recovery_time,
      recovered_by = authority_row.operator_actor_id,
      recovery_count = recovery_count + 1,
      lease_expires_at = recovery_time
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recovered',
    'recoveredBy', authority_row.operator_actor_id,
    'leaseExpiresAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', recovery_time), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

-- Bounded read of currently exhausted, still-inspectable claims for one
-- consumer. Returns only safe bookkeeping fields, never occurrence payload
-- content or raw failure detail. Investigation is deliberately not gated on
-- the recovery authority: exhausted work must remain inspectable even where no
-- operator identity has been registered yet.
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
      'attemptCount', bounded.attempt_count,
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
    select progress.occurrence_id, progress.attempt_count, progress.failure_count,
      progress.last_failure_code, progress.last_failed_at, progress.terminally_failed_at,
      progress.claimed_at
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
alter function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer)
  owner to postgres;
alter function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  owner to postgres;

revoke all on table vortex_event.consumer_recovery_authority
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
revoke all on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
revoke all on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;

grant execute on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) to vortex_runtime;
grant execute on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer)
  to vortex_runtime;
grant execute on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  to vortex_runtime;

comment on table vortex_event.consumer_recovery_authority is
  'Private registry of the fixed-purpose operator identity and execution session role allowed to recover exhausted claims for one consumer; ships empty so recovery fails closed.';
comment on column vortex_event.consumer_recovery_authority.execution_session_role_oid is
  'Execution session role required for recovery; compared against session_user, which SET LOCAL ROLE cannot change.';
comment on column vortex_event.consumer_occurrence_progress.attempt_count is
  'Count of delivery claims issued for this occurrence, including interrupted attempts that never reported a failure; reset only by authorised operator recovery.';
comment on column vortex_event.consumer_occurrence_progress.failure_count is
  'Count of reported delivery failures for this claim; reset only by authorised operator recovery.';
comment on column vortex_event.consumer_occurrence_progress.last_failure_code is
  'Safe, content-free failure classification; never raw exception text or payload content.';
comment on column vortex_event.consumer_occurrence_progress.terminally_failed_at is
  'Set once a retry budget is exhausted; withholds this claim from reclaim, renewal and acknowledgement until authorised operator recovery.';
comment on column vortex_event.consumer_occurrence_progress.recovered_by is
  'Registered operator identity that last recovered this claim; taken from the recovery authority, never from the caller, and never a credential.';
comment on function vortex_event.record_consumer_occurrence_delivery_failure(
  text, uuid, uuid, text, integer, integer
) is
  'Records one failed delivery attempt against an existing claim, scheduling a bounded retry or marking it terminally failed.';
comment on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer) is
  'Authorised operator recovery of one exhausted claim for the same consumer and occurrence identity, attributed to the registered operator.';
comment on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer) is
  'Bounded inspection of currently exhausted, replayable claims for one consumer.';

reset role;
commit;
