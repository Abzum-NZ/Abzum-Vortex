set local role vortex_owner;

alter table vortex_platform.event_outbox
  add column occurrence_kind text not null default 'record',
  alter column storage_contract_id drop not null,
  alter column storage_scope drop not null,
  alter column record_id drop not null,
  drop constraint event_outbox_check,
  drop constraint event_outbox_check1;
alter table vortex_platform.event_outbox add constraint event_outbox_subject_check check (
  (occurrence_kind = 'record' and storage_contract_id is not null and record_id is not null
    and storage_scope is not null and (
      (storage_scope = 'organization_shared' and sequence_application_root_id is null)
      or (storage_scope = 'application_contained' and sequence_application_root_id is not null)
    ))
  or (occurrence_kind = 'installation_activated' and storage_contract_id is null
    and storage_scope is null and record_id is null and sequence_application_root_id is not null)
);
alter table vortex_platform.event_outbox add constraint event_outbox_envelope_subject_check check (
  (occurrence_kind = 'record' and ((envelope ?& ARRAY['contractVersion'::text, 'occurrenceId'::text, 'organizationId'::text, 'installation'::text, 'descriptor'::text, 'definitionRelease'::text, 'recordId'::text, 'occurredAt'::text, 'actorId'::text, 'correlationId'::text, 'recordSequence'::text, 'payload'::text]) AND ((envelope - ARRAY['contractVersion'::text, 'occurrenceId'::text, 'organizationId'::text, 'installation'::text, 'descriptor'::text, 'definitionRelease'::text, 'recordId'::text, 'occurredAt'::text, 'actorId'::text, 'correlationId'::text, 'recordSequence'::text, 'payload'::text]) = '{}'::jsonb) AND ((envelope ->> 'contractVersion'::text) = '2.0.0'::text) AND (NOT (((envelope ->> 'occurrenceId'::text))::uuid IS DISTINCT FROM occurrence_id)) AND (NOT (((envelope ->> 'organizationId'::text))::uuid IS DISTINCT FROM organization_id)) AND (NOT (((envelope ->> 'recordId'::text))::uuid IS DISTINCT FROM record_id)) AND (NOT (((envelope ->> 'recordSequence'::text))::bigint IS DISTINCT FROM record_sequence)) AND (NOT (((envelope ->> 'occurredAt'::text))::timestamp with time zone IS DISTINCT FROM occurred_at))))
  or (occurrence_kind = 'installation_activated'
    and envelope ?& array['kind', 'occurrenceId', 'organizationId', 'applicationRootId',
      'applicationReleaseRevision', 'occurredAt']
    and envelope - array['kind', 'occurrenceId', 'organizationId', 'applicationRootId',
      'applicationReleaseRevision', 'occurredAt'] = '{}'::jsonb
    and envelope ->> 'kind' = 'installation_activated'
    and (envelope ->> 'occurrenceId')::uuid is not distinct from occurrence_id
    and (envelope ->> 'organizationId')::uuid is not distinct from organization_id
    and (envelope ->> 'applicationRootId')::uuid is not distinct from sequence_application_root_id
    and (envelope ->> 'applicationReleaseRevision')::bigint is not distinct from record_sequence
    and (envelope ->> 'occurredAt')::timestamptz is not distinct from occurred_at)
);
alter table vortex_platform.consumer_occurrence_progress add column checkpoint jsonb;
create index event_outbox_installation_lookup on vortex_platform.event_outbox
  (organization_id, sequence_application_root_id, record_sequence)
  where occurrence_kind = 'installation_activated';

drop function vortex_access.resolve_search_index_scope(uuid, uuid);

create or replace function vortex_access.resolve_event_consumer_scope(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  system_actor_id uuid,
  tenant_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_access_version bigint;
  dispatcher jsonb;
begin
  if p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Event consumer scope selection is invalid';
  end if;

  -- The organisation and its access version are share-locked before the
  -- dispatcher grant is read, in the request resolver's Access-first order.
  select organization.tenant_id, version.current_version
  into resolved_tenant_id, resolved_access_version
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where organization.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of organization, tenant, version;

  if resolved_tenant_id is null
    or not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_application_root_id
        and root.kind = 'application'
        and root.organization_id = p_organization_id
    ) then
    raise exception using errcode = '42501', message = 'Event consumer scope is unavailable';
  end if;

  -- Indexing runs inside event dispatch, so the actor is the dispatcher's own
  -- platform-wide system actor grant; nothing the caller supplies names it.
  dispatcher := vortex_access.resolve_event_dispatcher_actor();
  if dispatcher ->> 'outcome' is distinct from 'authorised' then
    raise exception using errcode = '42501', message = 'Event consumer scope is unavailable';
  end if;

  return query select (dispatcher ->> 'systemActorId')::uuid, resolved_tenant_id,
    resolved_access_version;
end
$function$;

revoke all on function vortex_access.resolve_event_consumer_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.resolve_event_consumer_scope(uuid, uuid)
  to vortex_runtime, vortex_record_adapter;

comment on function vortex_access.resolve_event_consumer_scope(uuid, uuid) is
  'Resolves the tenant, access version and the event dispatcher''s system actor for one active organisation Application, so the event consumer can read a record under a system context. Refuses for an inactive organisation, a foreign Application or a missing or ambiguous dispatcher grant. Runtime-only.';

alter function vortex_access.resolve_event_consumer_scope(p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;

grant execute on function vortex_access.resolve_event_consumer_scope(p_organization_id uuid, p_application_root_id uuid) to postgres;


create or replace function vortex_access.derived_backfill_context_internal()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  scope record;
begin
  context_value := vortex_platform.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Derived backfill requires a system Application context';
  end if;
  select resolved.* into strict scope
  from vortex_access.resolve_event_consumer_scope(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid
  ) as resolved;
  if scope.system_actor_id is distinct from (context_value ->> 'systemActorId')::uuid
    or scope.tenant_id is distinct from (context_value ->> 'tenantId')::uuid
    or scope.access_version is distinct from (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501', message = 'Derived backfill system authority is stale or unavailable';
  end if;
  return context_value;
end
$function$;
alter function vortex_access.derived_backfill_context_internal() owner to vortex_owner;
revoke all on function vortex_access.derived_backfill_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.derived_backfill_context_internal()
  to vortex_record_adapter, vortex_owner, postgres;


create or replace function vortex_platform.enqueue_installation_backfill_internal(
  p_organization_id uuid, p_application_root_id uuid, p_release_revision bigint
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  occurrence_id_value uuid := pg_catalog.gen_random_uuid();
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
begin
  -- Called only by the atomic activation writer, never by a request role. The unique
  -- installation release key makes a repeated activation a no-op, including after a retry.
  insert into vortex_platform.event_outbox (
    occurrence_id, organization_id, sequence_application_root_id,
    record_sequence, occurred_at, occurrence_kind, envelope
  ) values (
    occurrence_id_value, p_organization_id, p_application_root_id,
    p_release_revision, occurred_at_value, 'installation_activated',
    pg_catalog.jsonb_build_object(
      'kind', 'installation_activated', 'occurrenceId', occurrence_id_value,
      'organizationId', p_organization_id, 'applicationRootId', p_application_root_id,
      'applicationReleaseRevision', p_release_revision,
      'occurredAt', pg_catalog.to_char(pg_catalog.timezone('UTC', occurred_at_value),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )
  ) on conflict do nothing;
end
$function$;
alter function vortex_platform.enqueue_installation_backfill_internal(uuid, uuid, bigint) owner to vortex_owner;
revoke all on function vortex_platform.enqueue_installation_backfill_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.enqueue_installation_backfill_internal(uuid, uuid, bigint)
  to vortex_owner, postgres;


create or replace function vortex_platform.installation_backfill_progress(
  p_occurrence_id uuid, p_claim_cursor uuid, p_checkpoint jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb;
  progress vortex_platform.consumer_occurrence_progress%rowtype;
  installed_revision bigint;
  settings jsonb;
begin
  context_value := vortex_access.derived_backfill_context_internal();
  -- The claim token is fenced by the existing dispatcher lease. Lock it through the
  -- record writes and checkpoint commit so a concurrent recovery cannot advance it.
  select claimed.* into progress
  from vortex_platform.consumer_occurrence_progress as claimed
  join vortex_platform.event_outbox as occurrence using (occurrence_id)
  where claimed.consumer_key = 'installation-derived-values'
    and claimed.occurrence_id = p_occurrence_id
    and claimed.claim_cursor = p_claim_cursor
    and claimed.acknowledged_at is null and claimed.terminally_failed_at is null
    and claimed.lease_expires_at > pg_catalog.clock_timestamp()
    and occurrence.occurrence_kind = 'installation_activated'
    and occurrence.organization_id = (context_value ->> 'organizationId')::uuid
    and occurrence.sequence_application_root_id = (context_value ->> 'applicationRootId')::uuid
  for update of claimed;
  if not found then
    raise exception using errcode = '40001', message = 'Installation backfill claim is unavailable';
  end if;

  -- Lock the installation using the lifecycle writer's canonical binding locks. A page
  -- either commits before the switch/detach or sees it; never writes through stale mappings.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'vortex_definition.binding:' || binding.organization_id::text || ':' ||
    binding.application_root_id::text || ':' || binding.module_root_id::text, 0
  ))
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = (context_value ->> 'organizationId')::uuid
    and binding.application_root_id = (context_value ->> 'applicationRootId')::uuid
  order by binding.module_root_id;
  select pg_catalog.min(binding.application_release_revision) into installed_revision
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = (context_value ->> 'organizationId')::uuid
    and binding.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and binding.state = 'active';

  if p_checkpoint is not null then
    if pg_catalog.jsonb_typeof(p_checkpoint) is distinct from 'object'
      or not p_checkpoint ?& array['releaseRevision', 'recordTypeId', 'afterRecordId',
        'processedCount', 'writtenCount', 'complete']
      or p_checkpoint - array['releaseRevision', 'recordTypeId', 'afterRecordId',
        'processedCount', 'writtenCount', 'complete'] <> '{}'::jsonb
      or (p_checkpoint ->> 'releaseRevision')::bigint is distinct from installed_revision
      or pg_catalog.jsonb_typeof(p_checkpoint -> 'complete') is distinct from 'boolean'
      or (p_checkpoint ->> 'processedCount')::bigint < 0
      or (p_checkpoint ->> 'writtenCount')::bigint < 0 then
      raise exception using errcode = '22023', message = 'Installation backfill checkpoint is invalid';
    end if;
    update vortex_platform.consumer_occurrence_progress
    set checkpoint = p_checkpoint,
      -- Successful pages do not spend the failure budget. The next ordinary dispatcher
      -- claim continues this occurrence; there is no second lease or retry mechanism.
      attempt_count = 0, failure_count = 0, last_failed_at = null, last_failure_code = null,
      lease_expires_at = case when (p_checkpoint ->> 'complete')::boolean
        then lease_expires_at else greatest(
          pg_catalog.clock_timestamp(), claimed_at + interval '1 microsecond') end
    where consumer_key = progress.consumer_key and occurrence_id = progress.occurrence_id;
    return p_checkpoint;
  end if;
  select pg_catalog.jsonb_build_object('timeZone', configured.time_zone, 'currency', configured.currency)
  into settings
  from vortex_identity.read_current_organization_runtime_settings_internal(
    (context_value ->> 'organizationId')::uuid
  ) as configured;
  if settings is null then
    raise exception using errcode = '55000', message = 'Installation backfill settings are unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'checkpoint', progress.checkpoint, 'releaseRevision', installed_revision, 'settings', settings
  );
end
$function$;
alter function vortex_platform.installation_backfill_progress(uuid, uuid, jsonb) owner to vortex_owner;
revoke all on function vortex_platform.installation_backfill_progress(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.installation_backfill_progress(uuid, uuid, jsonb)
  to vortex_runtime, postgres;


create or replace function vortex_platform.claim_consumer_occurrences(
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
  update vortex_platform.consumer_occurrence_progress as progress
  set last_failed_at = coalesce(progress.last_failed_at, claim_time),
      last_failure_code = coalesce(progress.last_failure_code, 'unclassified'),
      terminally_failed_at = case
        when progress.last_failed_at is not null and progress.last_failed_at > claim_time
          then progress.last_failed_at
        else claim_time
      end
  where (progress.consumer_key, progress.occurrence_id) in (
    select exhausted.consumer_key, exhausted.occurrence_id
    from vortex_platform.consumer_occurrence_progress as exhausted
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
    from vortex_platform.event_outbox as occurrence
    left join vortex_platform.consumer_occurrence_progress as progress
      on progress.consumer_key = p_consumer_key
      and progress.occurrence_id = occurrence.occurrence_id
    where ((p_consumer_key = 'installation-derived-values') =
      (occurrence.occurrence_kind = 'installation_activated'))
      and progress.acknowledged_at is null
      and progress.terminally_failed_at is null
      and (progress.lease_expires_at is null or progress.lease_expires_at <= claim_time)
      and not exists (
        select 1
        from vortex_platform.event_outbox as predecessor
        left join vortex_platform.consumer_occurrence_progress as predecessor_progress
          on predecessor_progress.consumer_key = p_consumer_key
          and predecessor_progress.occurrence_id = predecessor.occurrence_id
        where predecessor.organization_id = occurrence.organization_id
          and predecessor.occurrence_kind = occurrence.occurrence_kind
          and predecessor.storage_contract_id is not distinct from occurrence.storage_contract_id
          and predecessor.sequence_application_root_id is not distinct from
            occurrence.sequence_application_root_id
          and predecessor.record_id is not distinct from occurrence.record_id
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
          'vortex_platform.consumer:' || p_consumer_key || ':' || occurrence.occurrence_id::text,
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
        join vortex_platform.event_outbox as parent
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
            select 1 from vortex_platform.event_outbox as deeper
            where deeper.occurrence_id = causal_chain.causation_id
              and deeper.organization_id = occurrence.organization_id
          )
        ), false) as exceeds_limit,
        coalesce(pg_catalog.bool_or(
          causation_id is not null
          and exists (
            select 1 from vortex_platform.event_outbox as repeated
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
    insert into vortex_platform.consumer_occurrence_progress (
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

alter function vortex_platform.claim_consumer_occurrences(text, integer, integer) owner to vortex_owner;

revoke all on function vortex_platform.claim_consumer_occurrences(text, integer, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_platform.claim_consumer_occurrences(text, integer, integer)
  to vortex_runtime;

comment on function vortex_platform.claim_consumer_occurrences(text, integer, integer) is
  'Claims a bounded ordered set of unacknowledged Event occurrences for one consumer with a short renewable lease.';


create or replace function vortex_definition.activate_application_installation(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_definition.installation_bindings%rowtype;
  storage_provision record;
  expected_count integer;
  pin_count integer;
  all_provisioned boolean;
  all_active boolean;
  changed_value boolean;
  binding_evidence jsonb;
  sort_index_status jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Application installation activation command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_definition.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  select pg_catalog.bool_and(coalesce(
      binding.state = 'provisioned'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_provisioned, all_active
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  if all_provisioned is null or (not all_provisioned and not all_active)
    or exists (
      select 1 from vortex_definition.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select binding.* into strict locked_binding
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;

    if locked_binding.storage_contract_ids <> storage_provision.storage_contract_ids then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;
  end loop;

  select snapshot.* into permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if not found
    or permission_snapshot.release_revision <> p_application_release_revision
    or permission_snapshot.definition_key <> (
      select root.key from vortex_definition.roots as root
      where root.root_id = p_application_root_id
    )
    or permission_snapshot.release_version <> application_release.release_version
    or permission_snapshot.validation_contract_version <> application_release.validation_contract_version
    or permission_snapshot.content_fingerprint <> application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint <> application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  changed_value := all_provisioned;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_definition.installation_bindings as binding
    set state = 'active', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'provisioned';
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
    end if;
    sort_index_status := vortex_record.sync_published_sort_indexes_internal();
    perform vortex_platform.enqueue_installation_backfill_internal(
      initial_authority.organization_id, p_application_root_id, p_application_release_revision
    );
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'active', 'changed', changed_value,
    'sortIndexes', sort_index_status,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Application installation activation command is invalid';
end
$function$;

alter function vortex_definition.activate_application_installation(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.activate_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.activate_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_definition.activate_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic activation of the complete exact Module pin set for one Application release.';


reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.derived_field_backfill_scope_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_installation jsonb;
  installation jsonb;
  plan jsonb;
  binding_item jsonb;
  module_content jsonb;
  record_type_item jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  definitions jsonb := '{}'::jsonb;
  targets jsonb := '{}'::jsonb;
begin
  context_value := vortex_platform.current_context();
  if context_value ->> 'callerKind' = 'system' then
    context_value := vortex_access.derived_backfill_context_internal();
    installation := vortex_definition.read_active_installation_for_scope_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid
    );
  else
    context_value := vortex_access.validated_human_request_context();
  end if;
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Derived field backfill requires an application context';
  end if;
  if context_value ->> 'callerKind' <> 'system' then
    preview_installation := vortex_record.read_current_preview_installation_internal();
    if preview_installation is not null and preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode = '42501', message = 'Preview Record context is unavailable';
    end if;
    installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;
  end if;
  plan := vortex_record.resolve_installation_access_plan_internal(installation);

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = (binding_item ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_item ->> 'moduleReleaseRevision')::bigint;
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(module_content -> 'recordTypes', '[]'::jsonb))
        as item(value)
    loop
      record_type_key := pg_catalog.lower(record_type_item ->> 'recordTypeId');
      type_meta := plan -> 'recordTypes' -> record_type_key;
      continue when type_meta is null
        or coalesce((type_meta ->> 'isSystemProjection')::boolean, false);
      definitions := definitions || pg_catalog.jsonb_build_object(record_type_key, record_type_item);
      -- The fields a backfill works out: every total and every stored calculation. A preview's
      -- storage is new, so all of them; a live upgrade only those this exact Module release
      -- brought into storage. A background delivery catches up all stored derived fields of
      -- the current installation, including fields from releases superseded while it waited.
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"), '[]'::jsonb)
      into field_ids
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      where (field.value ->> 'type' = 'total'
          or (field.value ->> 'type' = 'calculation'
            and field.value #>> '{settings,evaluation}' is distinct from 'read_time'))
        and (context_value ->> 'callerKind' = 'system' or preview_installation is not null or exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = (type_meta ->> 'storageContractId')::uuid
            and mapping.field_id = (field.value ->> 'fieldId')::uuid
            and mapping.state = 'active'
            and mapping.introduced_by_module_root_id = (type_meta ->> 'moduleRootId')::uuid
            and mapping.introduced_at_release_revision = (type_meta ->> 'releaseRevision')::bigint
        ));
      if pg_catalog.jsonb_array_length(field_ids) > 0 then
        targets := targets || pg_catalog.jsonb_build_object(record_type_key, field_ids);
      end if;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'organizationId', context_value -> 'organizationId',
    'applicationRootId', context_value -> 'applicationRootId',
    'plan', plan,
    'definitions', definitions,
    'targets', targets
  );
end
$function$;

alter function vortex_record.derived_field_backfill_scope_internal() owner to vortex_record_adapter;

revoke all on function vortex_record.derived_field_backfill_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.derived_field_backfill_scope_internal()
  to vortex_record_adapter;
comment on function vortex_record.derived_field_backfill_scope_internal() is
  'Private derived-field backfill scope of the request''s live or preview installation: each record type''s definition and the totals and stored calculations a backfill works out for its existing records.';


reset role;
set local role vortex_owner;

-- The organisation's application catalogue: every ordinary Application it owns with a published
-- version, the latest version and its release note, and the version installed now, if any.
create or replace function vortex_access.list_application_store_entries_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer
set search_path = ''
set max_parallel_workers_per_gather = 0
as $function$
declare
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  sort_sql text;
  keyset_sql text := '';
  after_text text;
  after_record_id uuid;
  comparison text;
begin
  if p_sort_key not in ('record_id', 'key')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023',
      message = 'Application catalogue projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key = 'key' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
    exception when invalid_text_representation then
      raise exception using errcode = '22023',
        message = 'Application catalogue projection cursor is invalid';
    end;
  end if;

  begin
    context_value := vortex_access.validated_human_request_context();
  exception when insufficient_privilege then
    return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_platform.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception when sqlstate '42501' or sqlstate 'P0002' then
    return;
  end;

  comparison := case when p_direction = 'ascending' then '>' else '<' end;
  if p_after is not null then
    keyset_sql := case p_sort_key
      when 'key' then pg_catalog.format(
        ' and (root.key collate "C", root.root_id) %s ($3 collate "C", $4)', comparison)
      else pg_catalog.format(' and root.root_id %s $4', comparison) end;
  end if;
  sort_sql := case p_sort_key
    when 'key' then pg_catalog.format('root.key collate "C" %1$s, root.root_id %1$s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('root.root_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;

  return query execute $scan$
    select $1, root.root_id, root.current_release_revision,
      pg_catalog.jsonb_build_object(
        'key', root.key,
        'name', latest.application_address ->> 'name',
        'description', latest.compilation_output #>> '{canonical,content,description}',
        'latest_version', latest.release_version,
        'latest_release_note', latest.release_note,
        'published_at', latest.published_at,
        'record_update_status', case
          when installed.release_revision is null then 'not_required'
          when backfill.occurrence_id is null then 'up_to_date'
          when backfill.terminally_failed_at is not null then 'failed'
          when backfill.acknowledged_at is not null or (backfill.checkpoint ->> 'complete')::boolean then 'up_to_date'
          when backfill.last_failure_code is not null then 'retrying'
          when backfill.claimed_at is null then 'pending'
          else 'updating' end,
        'records_processed', coalesce((backfill.checkpoint ->> 'processedCount')::bigint, 0),
        'installed_version', coalesce(installed.release_version, 'Not installed'),
        'status', case
          when installed.release_revision is null then 'available'
          when installed.release_revision < root.current_release_revision then 'update_available'
          else 'installed' end
      )
    from vortex_definition.roots as root
    join vortex_definition.releases as latest
      on latest.root_id = root.root_id
      and latest.release_revision = root.current_release_revision
    left join lateral (
      select release.release_revision, release.release_version
      from vortex_access.permission_registrations as registration
      join vortex_definition.releases as release
        on release.root_id = root.root_id
        and release.release_revision = registration.source_revision
        and release.release_version = registration.source_version
        and release.validation_contract_version = registration.validation_contract_version
      where registration.organization_id = root.organization_id
        and registration.registration_owner_id = root.root_id
        and registration.registration_kind = 'application'
        and registration.state = 'active'
        and registration.source_definition_key = root.key
        and exists (
          select 1 from vortex_definition.installation_bindings as binding
          where binding.organization_id = root.organization_id
            and binding.application_root_id = root.root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
      limit 1
    ) as installed on true
    left join lateral (
      select occurrence.occurrence_id, progress.terminally_failed_at, progress.acknowledged_at,
        progress.claimed_at, progress.last_failure_code, progress.checkpoint
      from vortex_platform.event_outbox as occurrence
      left join vortex_platform.consumer_occurrence_progress as progress
        on progress.occurrence_id = occurrence.occurrence_id
        and progress.consumer_key = 'installation-derived-values'
      where occurrence.organization_id = root.organization_id
        and occurrence.sequence_application_root_id = root.root_id
        and occurrence.occurrence_kind = 'installation_activated'
        and occurrence.record_sequence = installed.release_revision
      limit 1
    ) as backfill on true
    where root.organization_id = $1
      and root.kind = 'application'
      and root.application_origin_kind = 'ordinary'
      and root.current_release_revision is not null
      and ($2 is null or root.root_id = any($2))
      and latest.application_address ->> 'kind' = 'application'
  $scan$ || keyset_sql || pg_catalog.format(' order by %s limit $5', sort_sql)
  using visible_organization_id, p_record_ids, after_text, after_record_id, p_limit;
end
$function$;

comment on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) is 'The organisation''s application catalogue: its ordinary Applications with a published version, the latest version and the installed one.';

revoke all on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_application_store_entries_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

reset role;
