-- #1108: replace invalid catalog-qualified COALESCE calls with the COALESCE construct.
--
-- COALESCE is SQL grammar, not a function in the pg_catalog schema, so every
-- live function that still called the catalog-qualified form failed on every
-- call. This migration re-creates each affected function as its complete live
-- definition with plain coalesce(...) in place of the catalog-qualified call.
-- Each body is otherwise identical to its live definition, including the
-- changes applied in place by 20260924070000, 20260924140000 and
-- 20260924180000 and the replacement of is_lifecycle_destination by
-- 20260924590000. Each function is re-created under its own current owner, so
-- OID, owner, grants, comment, security and search_path stay put; where the live
-- definition carried explicit owner, privilege or comment statements they are
-- restated verbatim below.

begin;

-- postgres-owned functions; the vortex_record schema grants CREATE only transiently.
set local role vortex_record_owner;
grant create on schema vortex_record to postgres;
reset role;

set local role postgres;

-- vortex_record.claim_configured_deadline_due_row_internal (live: 20260923061000_private_deadline_refresh_authority.sql, owner postgres; 2 catalog-qualified COALESCE calls) --
create or replace function vortex_record.claim_configured_deadline_due_row_internal(
  p_organization_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_due_before timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  due_row vortex_record.record_deadline_due_metadata%rowtype;
  actor_resolution jsonb;
begin
  if (p_organization_id is not null and p_organization_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_record_id is not null and p_record_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_application_root_id is not null and p_application_root_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_organization_id is null
        and (p_record_id is not null or p_application_root_id is not null))
    or (p_due_before is not null and not pg_catalog.isfinite(p_due_before)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  -- A scoped claim reports missing/disabled configuration even when no due row
  -- exists. An unscoped batch claim considers only rows assigned to this exact
  -- login role, so one tenant's configuration cannot starve another tenant.
  if p_organization_id is not null then
    actor_resolution := vortex_record.resolve_configured_deadline_actor_internal(
      p_organization_id, p_application_root_id
    );
    if actor_resolution ->> 'outcome' <> 'resolved' then
      return actor_resolution;
    end if;

    select metadata.* into due_row
    from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = p_organization_id
      and metadata.application_root_id is not distinct from p_application_root_id
      and (p_record_id is null or metadata.record_id = p_record_id)
      and metadata.transition_at <= coalesce(
        p_due_before, pg_catalog.statement_timestamp()
      )
    order by metadata.transition_at asc, metadata.changed_at asc,
      metadata.storage_contract_id asc, metadata.record_id asc
    limit 1
    for update skip locked;
  else
    select metadata.* into due_row
    from vortex_record.record_deadline_due_metadata as metadata
    join vortex_record.deadline_actor_bindings as binding
      on binding.organization_id = metadata.organization_id
      and binding.application_root_id is not distinct from metadata.application_root_id
      and binding.operation = 'refresh_record_deadline'
      and binding.state = 'active'
      and binding.execution_session_role_oid = pg_catalog.to_regrole(session_user)::oid
      and exists (
        select 1
        from vortex_record.deadline_actors as actor
        where actor.actor_id = binding.current_actor_id
          and actor.binding_id = binding.binding_id
          and actor.organization_id = binding.organization_id
          and actor.application_root_id is not distinct from binding.application_root_id
          and actor.operation = 'refresh_record_deadline'
          and actor.generation = binding.generation
          and actor.revoked_at is null
      )
      and exists (
        select 1
        from vortex_identity.organizations as org
        join vortex_identity.tenants as tenant on tenant.tenant_id = org.tenant_id
        join vortex_access.organization_access_versions as version
          on version.organization_id = org.organization_id
        join vortex_identity.organization_runtime_settings as settings
          on settings.organization_id = org.organization_id
        where org.organization_id = metadata.organization_id
          and org.state = 'active'
          and tenant.state = 'active'
          and version.current_version is not null
          and settings.time_zone is not null
      )
    where metadata.transition_at <= coalesce(
      p_due_before, pg_catalog.statement_timestamp()
    )
    order by metadata.transition_at asc, metadata.changed_at asc,
      metadata.organization_id asc, metadata.storage_contract_id asc,
      metadata.record_id asc
    limit 1
    for update of metadata skip locked;
  end if;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'none');
  end if;

  actor_resolution := vortex_record.establish_deadline_system_context_internal(
    due_row.organization_id, due_row.application_root_id
  );
  if actor_resolution ->> 'outcome' <> 'resolved' then
    return actor_resolution;
  end if;

  return actor_resolution || pg_catalog.jsonb_build_object(
    'due', pg_catalog.to_jsonb(due_row)
  );
end
$function$;

alter function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) owner to postgres;
revoke all on function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) to vortex_record_adapter;
comment on function vortex_record.claim_configured_deadline_due_row_internal(
  uuid, uuid, uuid, timestamptz
) is
  'Private fixed-purpose bridge that role-binds and locks one due row before establishing its exact System context.';

-- vortex_event.claim_consumer_occurrences (live: 20260923110000_event_delivery_recovery.sql, owner postgres; 5 catalog-qualified COALESCE calls) --
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

alter function vortex_event.claim_consumer_occurrences(text, integer, integer) owner to postgres;
revoke all on function vortex_event.claim_consumer_occurrences(text, integer, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_event.claim_consumer_occurrences(text, integer, integer)
  to vortex_runtime;
comment on function vortex_event.claim_consumer_occurrences(text, integer, integer) is
  'Claims a bounded ordered set of unacknowledged Event occurrences for one consumer with a short renewable lease.';

-- vortex_event.list_terminally_failed_consumer_occurrences (live: 20260923110000_event_delivery_recovery.sql, owner postgres; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_event.list_terminally_failed_consumer_occurrences(
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

  select coalesce(pg_catalog.jsonb_agg(
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

alter function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  owner to postgres;
revoke all on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer)
  to vortex_runtime;
comment on function vortex_event.list_terminally_failed_consumer_occurrences(text, integer) is
  'Bounded inspection of currently exhausted, replayable claims for one consumer.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from postgres;
reset role;

set local role vortex_record_owner;

-- vortex_record.is_lifecycle_uuid_text (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_record_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.is_lifecycle_uuid_text(p_value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and pg_catalog.lower(p_value) <> '00000000-0000-0000-0000-000000000000',
    false
  );
$function$;


-- vortex_record.is_lifecycle_destination (live: 20260924590000_remove_unreachable_surfaces.sql, owner vortex_record_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.is_lifecycle_destination(p_value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.char_length(p_value) between 1 and 80
    and p_value ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$',
    false
  );
$function$;


-- vortex_record.is_lifecycle_action_list (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_record_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.is_lifecycle_action_list(p_values text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_values is not null
    and pg_catalog.array_ndims(p_values) = 1
    and pg_catalog.cardinality(p_values) > 0
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or item.value <> all (array['delete', 'archive_workflow']::text[])
    )
    and pg_catalog.cardinality(p_values) = (
      select pg_catalog.count(distinct item.value)
      from pg_catalog.unnest(p_values) as item(value)
    ),
    false
  );
$function$;


-- vortex_record.is_lifecycle_destination_list (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_record_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.is_lifecycle_destination_list(p_values text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_values is not null
    and (
      pg_catalog.cardinality(p_values) = 0
      or pg_catalog.array_ndims(p_values) = 1
    )
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or not vortex_record.is_lifecycle_destination(item.value)
    ),
    false
  );
$function$;


-- vortex_record.is_record_type_lifecycle_policy (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_record_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.is_record_type_lifecycle_policy(p_policy jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_policy is not null
    and pg_catalog.jsonb_typeof(p_policy) = 'object'
    and p_policy ?& array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision', 'action', 'maxAgeDays', 'maxCount',
      'allowUnlimitedAge', 'allowUnlimitedCount'
    ]
    and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'policyId')
    and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'organizationId')
    and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'storageContractId')
    and (
      pg_catalog.jsonb_typeof(p_policy -> 'applicationRootId') = 'null'
      or vortex_record.is_lifecycle_uuid_text(p_policy ->> 'applicationRootId')
    )
    and vortex_record.is_lifecycle_revision_value(p_policy -> 'policyRevision')
    and p_policy ->> 'action' in ('delete', 'archive_workflow')
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedAge') = 'boolean'
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedCount') = 'boolean'
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxAgeDays')
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxCount')
    -- Closed representation: an explicit ceiling or an explicit unlimited
    -- permission, never both and never a silent missing-limit fallback.
    and (p_policy -> 'allowUnlimitedAge' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxAgeDays') = 'null')
    and (p_policy -> 'allowUnlimitedCount' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxCount') = 'null')
    and case
      when p_policy ->> 'action' = 'delete' then
        p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount', 'recoveryWindowDays'
        ] = '{}'::jsonb
        and (
          not p_policy ? 'recoveryWindowDays'
          or case
            when pg_catalog.jsonb_typeof(p_policy -> 'recoveryWindowDays') = 'number'
              and (p_policy ->> 'recoveryWindowDays') ~ '^[1-9][0-9]{0,8}$'
            then (p_policy ->> 'recoveryWindowDays')::bigint <= 104249991
            else false end
        )
      else
        p_policy ?& array[
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ]
        and p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount',
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ] = '{}'::jsonb
        and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'archiveWorkflowId')
        and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'archiveConnectionInstanceId')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedWorkflowRevision')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedConnectionRevision')
        and pg_catalog.jsonb_typeof(p_policy -> 'archiveDestination') = 'string'
        and vortex_record.is_lifecycle_destination(p_policy ->> 'archiveDestination')
        and pg_catalog.jsonb_typeof(p_policy -> 'expectedDestinationFingerprint') = 'string'
        and (p_policy ->> 'expectedDestinationFingerprint') ~ '^[a-f0-9]{64}$'
        and p_policy ->> 'expectedConnectionHealthOutcome' = 'healthy'
    end,
    false
  );
$function$;

comment on function vortex_record.is_record_type_lifecycle_policy(jsonb) is
  'Closed shape check for one complete stored record-type lifecycle policy; guards both the protected save and the stored row.';

-- vortex_record.initialize_organization_lifecycle_limits (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_record_owner; 2 catalog-qualified COALESCE calls) --
create or replace function vortex_record.initialize_organization_lifecycle_limits(
  p_organization_id uuid,
  p_limits jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_record.organization_lifecycle_limits%rowtype;
  max_retention_value bigint;
  max_count_value bigint;
  allow_unlimited_retention_value boolean;
  allow_unlimited_count_value boolean;
  allowed_actions_value text[];
  allowed_destinations_value text[];
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_limits is null
    or pg_catalog.jsonb_typeof(p_limits) <> 'object'
    or not p_limits ?& array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ]
    or p_limits - array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ] <> '{}'::jsonb
    or not vortex_record.is_lifecycle_uuid_text(p_limits ->> 'organizationId')
    or pg_catalog.lower(p_limits ->> 'organizationId')
      <> pg_catalog.lower(p_organization_id::text)
    or (p_limits -> 'settingsRevision') <> pg_catalog.to_jsonb(1)
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRetentionDays') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRecordCount') <> 'boolean'
    or not vortex_record.is_lifecycle_limit_value(p_limits -> 'maxRetentionDays')
    or not vortex_record.is_lifecycle_limit_value(p_limits -> 'maxRecordCount')
    or (p_limits -> 'allowUnlimitedRetentionDays' = 'true'::jsonb)
      <> (pg_catalog.jsonb_typeof(p_limits -> 'maxRetentionDays') = 'null')
    or (p_limits -> 'allowUnlimitedRecordCount' = 'true'::jsonb)
      <> (pg_catalog.jsonb_typeof(p_limits -> 'maxRecordCount') = 'null')
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') <> 'array'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') <> 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') = 'array'
          then p_limits -> 'allowedActions' else '[]'::jsonb end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') = 'array'
            then p_limits -> 'allowedArchiveDestinations'
          else '[]'::jsonb
        end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    ) then
    raise exception using errcode = '22023',
      message = 'Organisation lifecycle limits setup is invalid';
  end if;

  max_retention_value := case
    when pg_catalog.jsonb_typeof(p_limits -> 'maxRetentionDays') = 'null' then null
    else (p_limits #>> '{maxRetentionDays}')::bigint
  end;
  max_count_value := case
    when pg_catalog.jsonb_typeof(p_limits -> 'maxRecordCount') = 'null' then null
    else (p_limits #>> '{maxRecordCount}')::bigint
  end;
  allow_unlimited_retention_value := (p_limits -> 'allowUnlimitedRetentionDays') = 'true'::jsonb;
  allow_unlimited_count_value := (p_limits -> 'allowUnlimitedRecordCount') = 'true'::jsonb;
  select coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_actions_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedActions')
    with ordinality as item(value, ordinal);
  select coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_destinations_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedArchiveDestinations')
    with ordinality as item(value, ordinal);

  if not vortex_record.is_lifecycle_action_list(allowed_actions_value)
    or not vortex_record.is_lifecycle_destination_list(allowed_destinations_value)
    or (
      'archive_workflow' = any (allowed_actions_value)
      and pg_catalog.cardinality(allowed_destinations_value) = 0
    ) then
    raise exception using errcode = '22023',
      message = 'Organisation lifecycle limits setup is invalid';
  end if;

  -- Serialize the absent-row case as well as retries against an existing row.
  -- Locking only the settings row cannot coordinate two concurrent first calls.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_record.lifecycle_limits:' || p_organization_id::text,
      0
    )
  );

  -- The existing row is the setup decision for this organisation. Locking it
  -- makes two simultaneous identical calls behave as retries.
  select stored.* into existing
  from vortex_record.organization_lifecycle_limits as stored
  where stored.organization_id = p_organization_id
  for update;

  if found then
    if existing.settings_revision <> 1
      or existing.max_retention_days is distinct from max_retention_value
      or existing.max_record_count is distinct from max_count_value
      or existing.allow_unlimited_retention_days is distinct from allow_unlimited_retention_value
      or existing.allow_unlimited_record_count is distinct from allow_unlimited_count_value
      or existing.allowed_actions is distinct from allowed_actions_value
      or existing.allowed_archive_destinations is distinct from allowed_destinations_value then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end if;
  else
    begin
      insert into vortex_record.organization_lifecycle_limits (
        organization_id, settings_revision, max_retention_days, max_record_count,
        allow_unlimited_retention_days, allow_unlimited_record_count,
        allowed_actions, allowed_archive_destinations
      ) values (
        p_organization_id, 1, max_retention_value, max_count_value,
        allow_unlimited_retention_value, allow_unlimited_count_value,
        allowed_actions_value, allowed_destinations_value
      ) returning * into existing;
    exception when unique_violation then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', existing.organization_id,
    'settingsRevision', existing.settings_revision,
    'maxRetentionDays', existing.max_retention_days,
    'maxRecordCount', existing.max_record_count,
    'allowUnlimitedRetentionDays', existing.allow_unlimited_retention_days,
    'allowUnlimitedRecordCount', existing.allow_unlimited_record_count,
    'allowedActions', pg_catalog.to_jsonb(existing.allowed_actions),
    'allowedArchiveDestinations', pg_catalog.to_jsonb(existing.allowed_archive_destinations)
  );
end
$function$;

grant execute on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb)
  to vortex_runtime;
comment on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) is
  'Trusted explicit setup of one organisation lifecycle ceiling row at revision 1; identical retries return the existing row and conflicting retries refuse.';

-- vortex_record.authorize_storage_conversion_internal (live: 20260924430000_record_storage_conversion_preparation.sql, owner vortex_record_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.authorize_storage_conversion_internal(
  p_storage_contract_id uuid,
  p_installed_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  checked_context jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  scope_application_root_id uuid;
  owns_module boolean;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      p_installed_release_revision is not null
      and p_installed_release_revision not between 1 and 9007199254740991
    ) then
    raise exception using errcode = '22023',
      message = 'Storage conversion command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.storage_conversion',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Storage conversion authority is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Storage conversion context changed';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  if catalogue_row.storage_scope = 'application_contained' then
    if not coalesce(
      vortex_context.is_non_nil_uuid(checked_context ->> 'applicationRootId'), false
    ) then
      raise exception using errcode = '42501',
        message = 'Storage conversion requires an application context';
    end if;
    scope_application_root_id := (checked_context ->> 'applicationRootId')::uuid;
  else
    scope_application_root_id := null;
  end if;

  owns_module := exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = catalogue_row.module_root_id
      and root.kind = 'module'
      and root.organization_id = permission_decision.organization_id
  );

  if p_installed_release_revision is not null
    and not vortex_module.storage_conversion_is_installed_internal(
      permission_decision.organization_id, scope_application_root_id,
      p_storage_contract_id, catalogue_row.module_root_id, p_installed_release_revision
    ) then
    raise exception using errcode = '42501',
      message = 'Storage conversion installation is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', permission_decision.organization_id,
    'organizationAccountId', permission_decision.organization_account_id,
    'accessVersion', permission_decision.access_version,
    'correlationId', permission_decision.correlation_id,
    'applicationRootId', scope_application_root_id,
    'ownsModule', owns_module
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '42501',
      message = 'Storage conversion authority is unavailable';
end
$function$;

grant execute on function vortex_record.authorize_storage_conversion_internal(uuid, bigint)
  to vortex_record_adapter;
comment on function vortex_record.authorize_storage_conversion_internal(uuid, bigint) is
  'Private authority for storage conversion: Application-management permission, validated tenant scope, Module ownership and, when named, an active installation of the exact source release.';

reset role;

set local role vortex_module_owner;

-- vortex_module.record_lifecycle_target_is_installed_internal (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_module_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_module.record_lifecycle_target_is_installed_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_contract_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    return false;
  end if;
  select true into matched
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.state = 'active'
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and (
      p_application_root_id is null
      or binding.application_root_id = p_application_root_id
    )
  limit 1
  for share;
  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_module.record_lifecycle_target_is_installed_internal(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.record_lifecycle_target_is_installed_internal(
  uuid, uuid, uuid
) to vortex_record_owner;
comment on function vortex_module.record_lifecycle_target_is_installed_internal(
  uuid, uuid, uuid
) is 'Private installation fact for record lifecycle policy administration; shares the matching active installation binding for the transaction.';

-- vortex_module.record_lifecycle_workflow_is_installed_internal (live: 20260923080000_record_lifecycle_policy_storage.sql, owner vortex_module_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_module.record_lifecycle_workflow_is_installed_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_contract_id uuid,
  p_workflow_id uuid,
  p_expected_workflow_revision bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  active_release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_workflow_id is null
    or p_workflow_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_workflow_revision is null
    or p_expected_workflow_revision not between 1 and 9007199254740991 then
    return false;
  end if;

  select binding.application_release_revision into active_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'active'
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found or active_release_revision <> p_expected_workflow_revision then
    return false;
  end if;

  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = active_release_revision
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
    and application_release.compilation_output #>> '{kind}' = 'application'
    and application_release.compilation_output #>> '{canonical,envelope,rootId}'
      = p_application_root_id::text
    and application_release.compilation_output #>> '{validationContractVersion}'
      = application_release.validation_contract_version
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            application_release.compilation_output #> '{canonical,content,workflows}'
          ) = 'array'
            then application_release.compilation_output #> '{canonical,content,workflows}'
          else '[]'::jsonb
        end
      ) as workflow(value)
      where pg_catalog.jsonb_typeof(workflow.value) = 'object'
        and workflow.value ->> 'workflowId' = p_workflow_id::text
    )
  for share of application_release, application_root;

  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_module.record_lifecycle_workflow_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.record_lifecycle_workflow_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) to vortex_record_owner;
comment on function vortex_module.record_lifecycle_workflow_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) is 'Private exact-active-Application workflow fact for record lifecycle policy administration; locks the matching installation and immutable Application release.';

-- vortex_module.record_lifecycle_provisioned_setup_target_internal (live: 20260923100001_lifecycle_policy_activation_readiness.sql, owner vortex_module_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_expected_binding_revision bigint,
  p_storage_contract_id uuid,
  p_workflow_id uuid,
  p_expected_workflow_revision bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  provisioned_release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_binding_revision is null
    or p_expected_binding_revision not between 1 and 9007199254740991
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    -- A workflow reference is either completely absent or completely present.
    or (p_workflow_id is null) <> (p_expected_workflow_revision is null)
    or (p_workflow_id is not null
      and p_workflow_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_expected_workflow_revision is not null
      and p_expected_workflow_revision not between 1 and 9007199254740991) then
    return false;
  end if;

  select binding.application_release_revision into provisioned_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned'
    and binding.binding_revision = p_expected_binding_revision
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found then
    return false;
  end if;

  if p_workflow_id is null then
    return true;
  end if;

  -- There is no free-standing workflow revision in a compiled definition: the
  -- Application release revision is the workflow revision runtime pins.
  if provisioned_release_revision <> p_expected_workflow_revision then
    return false;
  end if;

  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = provisioned_release_revision
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
    and application_release.compilation_output #>> '{kind}' = 'application'
    and application_release.compilation_output #>> '{canonical,envelope,rootId}'
      = p_application_root_id::text
    and application_release.compilation_output #>> '{validationContractVersion}'
      = application_release.validation_contract_version
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            application_release.compilation_output #> '{canonical,content,workflows}'
          ) = 'array'
            then application_release.compilation_output #> '{canonical,content,workflows}'
          else '[]'::jsonb
        end
      ) as workflow(value)
      where pg_catalog.jsonb_typeof(workflow.value) = 'object'
        and workflow.value ->> 'workflowId' = p_workflow_id::text
    )
  for share of application_release, application_root;

  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  uuid, uuid, bigint, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  uuid, uuid, bigint, uuid, uuid, bigint
) to vortex_record_owner;
comment on function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  uuid, uuid, bigint, uuid, uuid, bigint
) is 'Private provisioned-setup installation fact for one exact Application binding revision and, optionally, one workflow of that exact immutable release; never used by the #566 administration save.';

-- vortex_module.storage_conversion_is_installed_internal (live: 20260924430000_record_storage_conversion_preparation.sql, owner vortex_module_owner; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_module.storage_conversion_is_installed_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_contract_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision is null
    or p_module_release_revision not between 1 and 9007199254740991
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    return false;
  end if;
  select true into matched
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.state = 'active'
    and binding.module_root_id = p_module_root_id
    and binding.module_release_revision = p_module_release_revision
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and (
      p_application_root_id is null
      or binding.application_root_id = p_application_root_id
    )
  order by binding.application_root_id
  limit 1
  for share;
  return coalesce(matched, false);
end
$function$;

revoke all on function vortex_module.storage_conversion_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.storage_conversion_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) to vortex_record_owner;
comment on function vortex_module.storage_conversion_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) is 'Private installation fact for storage conversion: shares the active installation of the exact Module release that installs the storage contract in this organisation scope.';

reset role;

-- The adapter-owned record functions need schema CREATE to be replaced under their own owner.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;

-- vortex_record.claim_record_deadline_refresh (live: 20260923061000_private_deadline_refresh_authority.sql, owner vortex_record_adapter; 1 catalog-qualified COALESCE calls) --
create or replace function vortex_record.claim_record_deadline_refresh(
  p_organization_id uuid default null,
  p_record_id uuid default null,
  p_application_root_id uuid default null,
  p_due_before timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  due_row vortex_record.record_deadline_due_metadata%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  actor_resolution jsonb;
  record_row record;
  field_item jsonb;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb := '{}'::jsonb;
  column_entry record;
  value_expression text;
  existing_field_values jsonb := '{}'::jsonb;
  transition_time_text text;
  effect_identity text;
  effect_hash text;
  effect_id uuid;
  root_value jsonb;
begin
  if (p_organization_id is not null and p_organization_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_record_id is not null and p_record_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_application_root_id is not null and p_application_root_id =
        '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_organization_id is null
        and (p_record_id is not null or p_application_root_id is not null))
    or (p_due_before is not null and not pg_catalog.isfinite(p_due_before)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  actor_resolution := vortex_record.claim_configured_deadline_due_row_internal(
    p_organization_id, p_record_id, p_application_root_id, p_due_before
  );
  if actor_resolution ->> 'outcome' <> 'resolved' then
    return actor_resolution;
  end if;
  due_row := pg_catalog.jsonb_populate_record(
    null::vortex_record.record_deadline_due_metadata,
    actor_resolution -> 'due'
  );

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = due_row.storage_contract_id
  for share;
  if not found
    or catalogue_row.state <> 'active'
    or catalogue_row.physical_schema_token <> 'record_data'
    or catalogue_row.record_type_id <> due_row.record_type_id
    or catalogue_row.storage_scope <> due_row.storage_scope then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  -- Ordinary saves lock the record before updating due metadata. NOWAIT keeps
  -- this inverse claim order bounded: the save wins, and this claim retries.
  begin
    if due_row.application_root_id is null then
      execute pg_catalog.format(
        'select stored.storage_contract_id, stored.record_type_id,
           stored.application_root_id, stored.definition_revision,
           stored.concurrency_number, stored.lifecycle_state
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id is null
         for update nowait',
        catalogue_row.physical_table_token
      ) into record_row using due_row.organization_id, due_row.record_id;
    else
      execute pg_catalog.format(
        'select stored.storage_contract_id, stored.record_type_id,
           stored.application_root_id, stored.definition_revision,
           stored.concurrency_number, stored.lifecycle_state
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id = $3
         for update nowait',
        catalogue_row.physical_table_token
      ) into record_row using due_row.organization_id, due_row.record_id,
        due_row.application_root_id;
    end if;
  exception when lock_not_available then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_busy'
    );
  end;

  if not found or record_row.lifecycle_state <> 'active' then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_unavailable'
    );
  end if;
  if record_row.storage_contract_id <> due_row.storage_contract_id
    or record_row.record_type_id <> due_row.record_type_id
    or record_row.application_root_id is distinct from due_row.application_root_id
    or record_row.definition_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null
        and record_row.definition_revision > catalogue_row.last_compatible_release_revision) then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_storage_incompatible'
    );
  end if;
  if record_row.concurrency_number <> due_row.record_concurrency_number then
    update vortex_record.record_deadline_due_metadata as metadata
    set record_concurrency_number = record_row.concurrency_number,
      changed_at = pg_catalog.statement_timestamp()
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    due_row.record_concurrency_number := record_row.concurrency_number;
  end if;

  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      catalogue_row.record_type_definition -> 'fields'
    ) as item(value)
  loop
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = catalogue_row.storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid
    for share;
    if not found or mapping_row.state <> 'active' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_storage_incompatible'
      );
    end if;
    columns_value := columns_value || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
        'token', mapping_row.physical_column_token,
        'databaseValueType', mapping_row.database_value_type
      )
    );
  end loop;

  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s', ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then
              pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
                ordered_fields.value ->> 'token'
              )
            when 'date' then
              pg_catalog.format(
                'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                ordered_fields.value ->> 'token'
              )
            else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
          end
        ),
        ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select column_entry.key, column_entry.value,
        pg_catalog.row_number() over (
          order by column_entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  if value_expression is not null then
    if due_row.application_root_id is null then
      execute pg_catalog.format(
        'select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id is null',
        value_expression, catalogue_row.physical_table_token
      ) into existing_field_values using due_row.organization_id, due_row.record_id;
    else
      execute pg_catalog.format(
        'select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.application_root_id = $3',
        value_expression, catalogue_row.physical_table_token
      ) into existing_field_values using due_row.organization_id, due_row.record_id,
        due_row.application_root_id;
    end if;
  end if;
  if existing_field_values is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_unavailable'
    );
  end if;

  transition_time_text := pg_catalog.to_char(
    pg_catalog.timezone('UTC', due_row.transition_at),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  effect_identity := pg_catalog.format(
    'deadline:%s:%s:%s:%s:%s:%s:%s',
    due_row.organization_id,
    due_row.storage_contract_id,
    coalesce(due_row.application_root_id::text, 'organization_shared'),
    due_row.record_id,
    due_row.record_concurrency_number,
    due_row.deadline_calculation_field_id,
    transition_time_text
  );
  effect_hash := pg_catalog.md5(effect_identity);
  effect_id := (
    pg_catalog.substr(effect_hash, 1, 8) || '-' ||
    pg_catalog.substr(effect_hash, 9, 4) || '-5' ||
    pg_catalog.substr(effect_hash, 14, 3) || '-a' ||
    pg_catalog.substr(effect_hash, 18, 3) || '-' ||
    pg_catalog.substr(effect_hash, 21, 12)
  )::uuid;
  root_value := pg_catalog.jsonb_build_object(
    'organizationId', due_row.organization_id,
    'storageContractId', due_row.storage_contract_id,
    'storageScope', due_row.storage_scope,
    'recordId', due_row.record_id,
    'recordTypeId', due_row.record_type_id,
    'concurrencyNumber', due_row.record_concurrency_number
  ) || case when due_row.application_root_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object(
      'applicationRootId', due_row.application_root_id
    ) end;

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'root', root_value,
    'attribution', pg_catalog.jsonb_build_object(
      'bindingId', actor_resolution -> 'bindingId',
      'actorId', actor_resolution -> 'actorId',
      'generation', actor_resolution -> 'generation',
      'operation', 'refresh_record_deadline',
      'systemActorId', actor_resolution -> 'actorId'
    ),
    'effect', pg_catalog.jsonb_build_object(
      'effectId', effect_id,
      'effectIdentity', effect_identity,
      'calculationFieldId', due_row.deadline_calculation_field_id,
      'transitionAt', transition_time_text
    ),
    'recordType', catalogue_row.record_type_definition,
    'existingValues', existing_field_values,
    'timeZone', actor_resolution -> 'timeZone'
  );
end
$function$;

alter function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz)
  owner to vortex_record_adapter;
revoke all on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz)
  to vortex_runtime;
comment on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz) is
  'Private atomic due-row claim returning locked root, attribution, effect identity and calculation inputs; patches in #857 offer only rows whose configured actor and organisation can establish context, reselect a stale revision in place and retire a due row whose storage or record can no longer serve it.';

-- vortex_record.read_record_lifecycle_preview_candidates_internal (live: 20260923120000_record_lifecycle_preview.sql, owner vortex_record_adapter; 2 catalog-qualified COALESCE calls) --
create or replace function vortex_record.read_record_lifecycle_preview_candidates_internal(
  p_physical_table_token text,
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid,
  p_after_created_at timestamptz,
  p_after_record_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_limit is null
    or p_limit not between 1 and 500
    or ((p_after_created_at is null) <> (p_after_record_id is null))
    or (p_after_record_id is not null
      and p_after_record_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_organization_id <> vortex_context.organization_id()
    or p_application_root_id is distinct from vortex_context.application_root_id(false) then
    raise exception using errcode = '42501',
      message = 'Record lifecycle preview candidates are unavailable';
  end if;

  execute pg_catalog.format(
    'with ranked as materialized (
       select stored.record_id,
              stored.concurrency_number,
              stored.created_at,
              stored.lifecycle_state,
              stored.deleted_at,
              pg_catalog.row_number() over (
                order by stored.created_at asc, stored.record_id asc
              )::bigint as record_position,
              pg_catalog.count(*) over ()::bigint as total_retained_count
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.storage_contract_id = $2
         and stored.application_root_id is not distinct from $3
         and stored.lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')
     ), page as materialized (
       select ranked.*
       from ranked
       where $5::timestamptz is null
          or ranked.created_at > $5
          or (ranked.created_at = $5 and ranked.record_id > $6)
       order by ranked.created_at asc, ranked.record_id asc
       limit $4 + 1
     ), selected as materialized (
       select page.*
       from page
       order by page.created_at asc, page.record_id asc
       limit $4
     )
     select pg_catalog.jsonb_build_object(
       ''totalRetainedCount'', coalesce(
         (select ranked.total_retained_count from ranked limit 1), 0
       ),
       ''records'', coalesce((
         select pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             ''recordId'', selected.record_id,
             ''expectedRecordRevision'', selected.concurrency_number,
             ''createdAt'', pg_catalog.to_jsonb(selected.created_at),
             ''lifecycleState'', selected.lifecycle_state,
             ''deletedAt'', pg_catalog.to_jsonb(selected.deleted_at),
             ''recordPosition'', selected.record_position
           ) order by selected.created_at asc, selected.record_id asc
         )
         from selected
       ), ''[]''::jsonb),
       ''hasMore'', (select pg_catalog.count(*) > $4 from page)
     )',
    p_physical_table_token
  ) into strict result_value using
    p_organization_id, p_storage_contract_id, p_application_root_id,
    p_limit, p_after_created_at, p_after_record_id;

  return result_value;
end
$function$;

alter function vortex_record.read_record_lifecycle_preview_candidates_internal(
  text, uuid, uuid, uuid, timestamptz, uuid, integer
) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_lifecycle_preview_candidates_internal(
  text, uuid, uuid, uuid, timestamptz, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner;
grant execute on function vortex_record.read_record_lifecycle_preview_candidates_internal(
  text, uuid, uuid, uuid, timestamptz, uuid, integer
) to vortex_record_owner;
comment on function vortex_record.read_record_lifecycle_preview_candidates_internal(
  text, uuid, uuid, uuid, timestamptz, uuid, integer
) is 'Private adapter-owned, forced-RLS lifecycle candidate page and global-position projection for Record owner.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
