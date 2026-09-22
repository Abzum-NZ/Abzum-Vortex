-- #639: Consumer-owned delivery progress over immutable Event occurrences.
--
-- Delivery state deliberately lives outside event_outbox.  A consumer claims one
-- record sequence at a time, proves an acknowledgement with an opaque cursor,
-- and may be reclaimed after its short lease expires.

begin;

set local role postgres;

create table vortex_event.consumer_occurrence_progress (
  consumer_key text not null check (
    pg_catalog.octet_length(consumer_key) between 1 and 128
    and consumer_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  occurrence_id uuid not null references vortex_event.event_outbox (occurrence_id),
  claim_cursor uuid not null,
  claimed_at timestamptz not null check (
    claimed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  lease_expires_at timestamptz not null check (
    lease_expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and lease_expires_at > claimed_at
  ),
  acknowledged_at timestamptz check (
    acknowledged_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and acknowledged_at >= claimed_at
  ),
  primary key (consumer_key, occurrence_id)
);

alter table vortex_event.consumer_occurrence_progress enable row level security;
alter table vortex_event.consumer_occurrence_progress force row level security;

create index consumer_occurrence_progress_claimable
  on vortex_event.consumer_occurrence_progress (consumer_key, lease_expires_at)
  where acknowledged_at is null;

create function vortex_event.claim_consumer_occurrences(
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
      consumer_key, occurrence_id, claim_cursor, claimed_at, lease_expires_at
    )
    select p_consumer_key, occurrence_id, claim_cursor, claim_time,
      claim_time + pg_catalog.make_interval(secs => p_lease_seconds)
    from candidate
    on conflict (consumer_key, occurrence_id) do update
      set claim_cursor = excluded.claim_cursor,
          claimed_at = excluded.claimed_at,
          lease_expires_at = excluded.lease_expires_at
      where consumer_occurrence_progress.acknowledged_at is null
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

create function vortex_event.renew_consumer_occurrence_lease(
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

create function vortex_event.acknowledge_consumer_occurrence(
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

alter function vortex_event.claim_consumer_occurrences(text, integer, integer) owner to postgres;
alter function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer)
  owner to postgres;
alter function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid) owner to postgres;

revoke all on table vortex_event.consumer_occurrence_progress
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.claim_consumer_occurrences(text, integer, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
revoke all on function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant usage on schema vortex_event to vortex_runtime;
grant execute on function vortex_event.claim_consumer_occurrences(text, integer, integer)
  to vortex_runtime;
grant execute on function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer)
  to vortex_runtime;
grant execute on function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid)
  to vortex_runtime;

comment on table vortex_event.consumer_occurrence_progress is
  'Private consumer-local claim, lease and acknowledgement state for immutable Event occurrences.';
comment on function vortex_event.claim_consumer_occurrences(text, integer, integer) is
  'Claims a bounded ordered set of unacknowledged Event occurrences for one consumer with a short renewable lease.';
comment on function vortex_event.renew_consumer_occurrence_lease(text, uuid, uuid, integer) is
  'Renews one still-live consumer Event occurrence claim without changing immutable occurrence evidence.';
comment on function vortex_event.acknowledge_consumer_occurrence(text, uuid, uuid) is
  'Completes one live consumer Event occurrence claim; repeated acknowledgement with the same cursor is safe.';

reset role;
commit;
