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
  -- in the claim query below would still read the pre-update snapshot.  The
  -- sweep is bounded and skips locked rows, so the reclaim below independently
  -- refuses to issue attempt maximum_delivery_attempts + 1; anything the sweep
  -- did not reach this time is simply terminalised on a later claim.
  update vortex_event.consumer_occurrence_progress as progress
  set last_failed_at = coalesce(progress.last_failed_at, claim_time),
      last_failure_code = coalesce(progress.last_failure_code, 'unclassified'),
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
        coalesce(pg_catalog.bool_or(
          depth = maximum_causal_depth
          and causation_id is not null
          and exists (
            select 1 from vortex_event.event_outbox as deeper
            where deeper.occurrence_id = causal_chain.causation_id
              and deeper.organization_id = occurrence.organization_id
          )
        ), false) as exceeds_limit,
        coalesce(pg_catalog.bool_or(
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
        and consumer_occurrence_progress.attempt_count < maximum_delivery_attempts
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
    'occurrences', coalesce(claimed, '[]'::jsonb)
  );
end
$function$;

alter function vortex_event.claim_consumer_occurrences(text, integer, integer) owner to vortex_event_owner;

revoke all on function vortex_event.claim_consumer_occurrences(text, integer, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant execute on function vortex_event.claim_consumer_occurrences(text, integer, integer)
  to vortex_runtime;

comment on function vortex_event.claim_consumer_occurrences(text, integer, integer) is
  'Claims a bounded ordered set of unacknowledged Event occurrences for one consumer with a short renewable lease.';
