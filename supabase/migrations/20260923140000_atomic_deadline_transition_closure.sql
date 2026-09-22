-- #558: atomic deadline dependency-closure commit.
--
-- #557 claims one due row, locks it and establishes the System context for
-- exactly one due organisation/record inside the caller's own request
-- transaction, returning locked root/attribution/effect facts and the
-- recalculated authoritative field values for the Record runtime to derive.
-- This migration adds the owning private operation that consumes those exact
-- claimed facts and, still inside that same transaction and on that same
-- locked row, atomically commits the root record's calculation cascade,
-- Activity, Event and due-metadata effects, replaying safely and refusing a
-- stale claim without a partial effect.
--
-- Every ordinary Record save composes through primitives gated by
-- `vortex_access.validated_human_request_context()`, which only ever accepts
-- `callerKind = 'human'`. The System context #557 establishes is deliberately
-- not a human context, so this System-owned commit cannot compose through
-- those human-only primitives; it reuses the exact same physical write
-- technique (`storage_catalogue` + `field_storage_mappings`), the same
-- Activity/Event tables and the same due-metadata table instead, exactly as
-- #557's own claim already reuses that physical read technique rather than
-- the declarative human-gated reader.
--
-- Relationship totals: when a changed field id is a real dependency of a
-- parent's `total` field, this operation refuses with
-- `relationship_total_unsupported` rather than attempt a partial or
-- unverified propagation through the human-only relationship-total engine.
-- This mirrors the codebase's own existing precedent: the ordinary save
-- writer's defer path already refuses with `unsupported_relationship_total_save`
-- when it detects a contribution it cannot safely carry through its fast
-- path (see `save_base_record_with_relationship_totals`). Propagating
-- deadline-driven totals through the human relationship-total engine is
-- left as a follow-up.

begin;

-- `select/update on record_data` and `execute on read_current_active_installation`
-- for `postgres` are already permanent grants from #400
-- (20260913060000_first_private_transactional_event_append.sql); this
-- migration does not redeclare or revoke them.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
grant references on vortex_record.storage_catalogue to postgres;
reset role;

-- Idempotency ledger. Effect identity is derived deterministically by #557's
-- claim from the exact due row facts, so a genuine replay of the same commit
-- carries the same effect id; this ledger returns its stored outcome instead
-- of duplicating the Activity/Event/record effects it already committed.
create table vortex_record.deadline_transition_effects (
  effect_id uuid primary key,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  record_id uuid not null,
  application_root_id uuid,
  effect_identity text not null,
  state text not null default 'pending' check (state in ('pending', 'completed')),
  result jsonb not null default 'null'::jsonb,
  created_at timestamptz not null default pg_catalog.statement_timestamp()
);

alter table vortex_record.deadline_transition_effects enable row level security;
alter table vortex_record.deadline_transition_effects force row level security;
create policy deadline_transition_effects_adapter
  on vortex_record.deadline_transition_effects to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and case when application_root_id is null then true
      else application_root_id = vortex_context.application_root_id(true) end
  )
  with check (
    organization_id = vortex_context.organization_id()
    and case when application_root_id is null then true
      else application_root_id = vortex_context.application_root_id(true) end
  );
alter table vortex_record.deadline_transition_effects owner to vortex_record_adapter;
revoke all on table vortex_record.deadline_transition_effects
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

set local role vortex_record_adapter;

-- Confirms the current transaction is still the exact System context #557's
-- claim established for this due row: same organisation/Application scope
-- and same resolved System actor. It re-derives nothing and re-locks nothing
-- itself; the claim's own row lock and context are what this call trusts.
create function vortex_record.validated_system_deadline_context_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_system_actor_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or not context_value ?& array['organizationId', 'systemActorId', 'correlationId']
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'systemActorId')::uuid is distinct from p_system_actor_id
    or ((context_value ? 'applicationRootId') <> (p_application_root_id is not null))
    or (
      p_application_root_id is not null
      and (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    ) then
    raise exception using errcode = '42501',
      message = 'Deadline transition requires the exact claimed System context';
  end if;
  return context_value;
end
$function$;

set local role postgres;

-- Defensive: ensures the adapter can reach the shared Activity primitive it
-- calls directly below (bypassing only `append_base_save_activity_internal`'s
-- human-context read, not the underlying evidence writer). A harmless no-op
-- if this access already exists through another path.
grant usage on schema vortex_activity to vortex_record_adapter;
grant execute on function vortex_activity.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) to vortex_record_adapter;

-- Purpose-built Event append for exactly one deadline calculation-field
-- transition. It reuses `event_outbox`, the shared `vortex_event_occurrences`
-- queue and the same envelope shape as `vortex_event.append_record_occurrences`,
-- but resolves its actor from the caller's validated System context instead of
-- `vortex_access.validated_human_request_context()`, which only accepts human
-- callers. The record row itself is not locked here: the caller has already
-- locked and updated it, in this same transaction, immediately before this call.

create function vortex_event.append_record_deadline_transition_occurrence_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_record_type_id uuid,
  p_occurrence_id uuid,
  p_calculation_field_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_system_actor_id uuid,
  p_correlation_id uuid,
  p_carries_personal_data boolean,
  p_previous_value boolean,
  p_new_value boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  installation jsonb;
  binding_count integer;
  binding_value jsonb;
  binding_module_root_id uuid;
  binding_module_release_revision bigint;
  binding_revision bigint;
  module_release vortex_definition.releases%rowtype;
  sequence_application_scope_id uuid;
  next_sequence bigint;
  occurrence_time timestamptz := pg_catalog.statement_timestamp();
  occurrence_time_text text;
  descriptor jsonb;
  payload jsonb;
  definition_release jsonb;
  envelope jsonb;
  queued_message_id bigint;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_calculation_field_id is null or p_calculation_field_id = nil_uuid
    or p_organization_id is null or p_system_actor_id is null
    or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'Deadline Event append input is invalid';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or catalogue_row.physical_schema_token is distinct from 'record_data'
    or catalogue_row.record_type_id is distinct from p_record_type_id then
    raise exception using errcode = 'P0002', message = 'Deadline Event record is unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || p_organization_id::text || ':' ||
        pg_catalog.coalesce(p_application_root_id::text, 'organization_shared') || ':' ||
        catalogue_row.module_root_id::text,
      0
    )
  );
  installation := vortex_module.read_current_active_installation();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or not installation ?& array[
      'organizationId', 'applicationReleaseRevision', 'moduleBindings'
    ]
    or (installation ->> 'organizationId')::uuid is distinct from p_organization_id
    or ((installation ? 'applicationRootId') <> (p_application_root_id is not null))
    or (
      p_application_root_id is not null
      and (installation ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    ) then
    raise exception using errcode = '42501', message = 'Resolved deadline Event installation is unavailable';
  end if;

  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into binding_count, binding_value
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id;
  if binding_count <> 1 then
    raise exception using errcode = '55000', message = 'Installed deadline Event binding is unavailable';
  end if;
  binding_module_root_id := (binding_value ->> 'moduleRootId')::uuid;
  binding_module_release_revision := (binding_value ->> 'moduleReleaseRevision')::bigint;
  binding_revision := (binding_value ->> 'bindingRevision')::bigint;

  select release.* into module_release
  from vortex_definition.releases as release
  where release.root_id = binding_module_root_id
    and release.release_revision = binding_module_release_revision;
  if not found then
    raise exception using errcode = '55000', message = 'Installed deadline Event module release is unavailable';
  end if;
  definition_release := pg_catalog.jsonb_build_object(
    'kind', 'module',
    'rootId', module_release.root_id,
    'releaseRevision', module_release.release_revision,
    'releaseVersion', module_release.release_version,
    'contentFingerprint', module_release.content_fingerprint,
    'resolutionFingerprint', module_release.resolution_fingerprint
  );

  sequence_application_scope_id := case
    when catalogue_row.storage_scope = 'organization_shared' then null
    else p_application_root_id
  end;
  select coalesce(pg_catalog.max(stored.record_sequence), 0) + 1
  into next_sequence
  from vortex_event.event_outbox as stored
  where stored.organization_id = p_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.sequence_application_root_id is not distinct from sequence_application_scope_id
    and stored.record_id = p_record_id;
  if next_sequence > 9007199254740991 then
    raise exception using errcode = '22003', message = 'Deadline Event record sequence is exhausted';
  end if;

  occurrence_time_text := pg_catalog.to_char(
    pg_catalog.timezone('UTC', occurrence_time), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  descriptor := pg_catalog.jsonb_build_object(
    'kind', 'standard', 'eventKind', 'state_changed', 'recordTypeId', p_record_type_id
  );
  payload := pg_catalog.jsonb_build_object('kind', 'state_changed', 'fieldId', p_calculation_field_id)
    || case when p_carries_personal_data
      then pg_catalog.jsonb_build_object('previousValue', p_previous_value, 'newValue', p_new_value)
      else '{}'::jsonb end;

  envelope := pg_catalog.jsonb_build_object(
    'contractVersion', '2.0.0',
    'occurrenceId', p_occurrence_id,
    'organizationId', p_organization_id,
    'installation', pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id,
      'applicationReleaseRevision', installation ->> 'applicationReleaseRevision',
      'moduleBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', binding_module_root_id,
        'moduleReleaseRevision', binding_module_release_revision,
        'bindingRevision', binding_revision
      )
    ),
    'descriptor', descriptor,
    'definitionRelease', definition_release,
    'recordId', p_record_id,
    'occurredAt', occurrence_time_text,
    'actorId', p_system_actor_id,
    'correlationId', p_correlation_id,
    'recordSequence', next_sequence,
    'payload', payload
  );

  insert into vortex_event.event_outbox (
    occurrence_id, organization_id, storage_contract_id, storage_scope,
    sequence_application_root_id, record_id, record_sequence, occurred_at, envelope
  ) values (
    p_occurrence_id, p_organization_id, p_storage_contract_id, catalogue_row.storage_scope,
    sequence_application_scope_id, p_record_id, next_sequence, occurrence_time, envelope
  );

  select sent.msg_id into strict queued_message_id
  from pgmq.send(
    'vortex_event_occurrences',
    pg_catalog.jsonb_build_object('contractVersion', '2.0.0', 'occurrenceId', p_occurrence_id)
  ) as sent(msg_id);
  if queued_message_id is null then
    raise exception using errcode = '55000', message = 'Deadline Event queue append failed';
  end if;

  return envelope;
end
$function$;

alter function vortex_event.append_record_deadline_transition_occurrence_internal(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, boolean
) owner to postgres;
revoke all on function vortex_event.append_record_deadline_transition_occurrence_internal(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_event.append_record_deadline_transition_occurrence_internal(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, boolean
) to vortex_record_adapter;

reset role;
set local role vortex_record_adapter;

-- The owning atomic commit. Runs in the same transaction, on the same locked
-- row, as the #557 claim whose facts `p_final_values`/`p_due_transition` were
-- derived from; it neither re-claims nor re-derives those facts.
create function vortex_record.finalize_record_deadline_refresh(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_record_type_id uuid,
  p_application_root_id uuid,
  p_expected_concurrency_number bigint,
  p_system_actor_id uuid,
  p_effect_id uuid,
  p_effect_identity text,
  p_calculation_field_id uuid,
  p_transition_at timestamptz,
  p_final_values jsonb,
  p_due_transition jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_carries_personal_data boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  inserted_effect_id uuid;
  ledger_row vortex_record.deadline_transition_effects%rowtype;
  storage_row vortex_record.storage_catalogue%rowtype;
  catalogue jsonb;
  root_type jsonb;
  contributes_to_total boolean := false;
  entry record;
  field_item jsonb;
  column_value jsonb;
  assignments text[] := array[]::text[];
  changed_field_ids uuid[] := array[]::uuid[];
  update_sql text;
  new_concurrency_number bigint;
  transition_field_id uuid;
  transition_at_value timestamptz;
  metadata_application_root_id uuid;
  activity_time timestamptz := pg_catalog.statement_timestamp();
  append_result text;
  event_result jsonb;
  result_value jsonb;
begin
  if p_organization_id is null or p_storage_contract_id is null or p_record_id is null
    or p_record_type_id is null or p_system_actor_id is null or p_effect_id is null
    or p_effect_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_effect_identity is null or p_calculation_field_id is null or p_transition_at is null
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_final_values = '{}'::jsonb
    or not (p_final_values ? pg_catalog.lower(p_calculation_field_id::text))
    or (p_final_values -> pg_catalog.lower(p_calculation_field_id::text)) <> 'true'::jsonb
    or (p_due_transition is not null and (
      pg_catalog.jsonb_typeof(p_due_transition) <> 'object'
      or p_due_transition - array['calculationFieldId', 'transitionAt'] <> '{}'::jsonb
      or not (p_due_transition ?& array['calculationFieldId', 'transitionAt'])
      or pg_catalog.jsonb_typeof(p_due_transition -> 'calculationFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(p_due_transition -> 'transitionAt') <> 'string'
      or not pg_catalog.pg_input_is_valid(p_due_transition ->> 'calculationFieldId', 'uuid')
      or not pg_catalog.pg_input_is_valid(p_due_transition ->> 'transitionAt', 'timestamp with time zone')
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  context_value := vortex_record.validated_system_deadline_context_internal(
    p_organization_id, p_application_root_id, p_system_actor_id
  );

  insert into vortex_record.deadline_transition_effects (
    effect_id, organization_id, storage_contract_id, record_id, application_root_id,
    effect_identity, state, result
  ) values (
    p_effect_id, p_organization_id, p_storage_contract_id, p_record_id, p_application_root_id,
    p_effect_identity, 'pending', 'null'::jsonb
  )
  on conflict (effect_id) do nothing
  returning effect_id into inserted_effect_id;

  if inserted_effect_id is null then
    select stored.* into strict ledger_row
    from vortex_record.deadline_transition_effects as stored
    where stored.effect_id = p_effect_id
    for share;
    if ledger_row.effect_identity is distinct from p_effect_identity then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    if ledger_row.state = 'completed' then
      return ledger_row.result || pg_catalog.jsonb_build_object('replayed', true);
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'concurrency_mismatch'
    );
  end if;

  select catalogue_row.* into storage_row
  from vortex_record.storage_catalogue as catalogue_row
  where catalogue_row.storage_contract_id = p_storage_contract_id
    and catalogue_row.record_type_id = p_record_type_id
    and catalogue_row.state = 'active'
    and catalogue_row.physical_schema_token = 'record_data';
  if not found then
    delete from vortex_record.deadline_transition_effects where effect_id = p_effect_id;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  -- Refuse rather than silently skip when a changed field genuinely feeds a
  -- parent `total`; propagating it safely is left to a follow-up (see header).
  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is not null then
    select pg_catalog.coalesce(pg_catalog.bool_or(true), false) into contributes_to_total
    from pg_catalog.jsonb_array_elements(root_type -> 'relationships') as rel(value)
    join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as tgt(value)
      on pg_catalog.lower(tgt.value ->> 'recordTypeId') =
        pg_catalog.lower(rel.value #>> '{toRecordType,recordTypeId}')
    join lateral pg_catalog.jsonb_array_elements(tgt.value -> 'fields') as tf(value)
      on tf.value ->> 'type' = 'total'
      and pg_catalog.lower(tf.value #>> '{settings,relationshipId}') =
        pg_catalog.lower(rel.value ->> 'relationshipId')
    cross join lateral (
      select vortex_record.total_dependency_contract_internal(
        catalogue -> 'recordTypes',
        pg_catalog.jsonb_build_array(rel.value || pg_catalog.jsonb_build_object(
          'toRecordTypeId', rel.value #> '{toRecordType,recordTypeId}'
        )),
        (tgt.value ->> 'recordTypeId')::uuid, tf.value
      ) as contract
    ) as dc
    cross join lateral pg_catalog.jsonb_array_elements_text(
      pg_catalog.coalesce(dc.contract -> 'sourceFieldIds', '[]'::jsonb)
    ) as src(value)
    where rel.value ? 'toRecordType'
      and rel.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
      and exists (
        select 1 from pg_catalog.jsonb_object_keys(p_final_values) fk(value)
        where pg_catalog.lower(fk.value) = src.value
      );
  end if;
  if contributes_to_total then
    delete from vortex_record.deadline_transition_effects where effect_id = p_effect_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'relationship_total_unsupported'
    );
  end if;

  -- Build and apply the physical column patch. The claim already holds this
  -- exact row's lock for the duration of this transaction; the guarded
  -- concurrency predicate below is this write's own bounded conflict check.
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_item
    from pg_catalog.jsonb_array_elements(storage_row.record_type_definition -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_item is null or field_item ->> 'type' <> 'calculation' then
      delete from vortex_record.deadline_transition_effects where effect_id = p_effect_id;
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token, 'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_item ->> 'type', column_value ->> 'databaseValueType'
    ) then
      delete from vortex_record.deadline_transition_effects where effect_id = p_effect_id;
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;
    assignments := pg_catalog.array_append(assignments, pg_catalog.format(
      '%I = %s', column_value ->> 'token',
      case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
      else case column_value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
        when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
        when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
        when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
        when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
        when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
        else pg_catalog.format('%L::text', entry.value #>> '{}') end end
    ));
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);

  update_sql := pg_catalog.format(
    'update record_data.%I stored set %s,
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.application_root_id is not distinct from $5
       and stored.concurrency_number = $4
     returning stored.concurrency_number',
    storage_row.physical_table_token,
    pg_catalog.array_to_string(assignments, ', ')
  );
  execute update_sql into new_concurrency_number using
    p_organization_id, p_record_id, p_system_actor_id, p_expected_concurrency_number,
    p_application_root_id;
  if new_concurrency_number is null then
    delete from vortex_record.deadline_transition_effects where effect_id = p_effect_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'concurrency_mismatch'
    );
  end if;

  perform vortex_record.bump_record_data_version_internal(
    p_organization_id, p_storage_contract_id, p_application_root_id
  );

  -- Due metadata: reuses the exact same table and upsert/cancel shape as the
  -- ordinary-save composer (`save_base_record_with_relationship_totals_and_deadline_due_metadata`).
  if p_due_transition is null then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = p_organization_id
      and metadata.storage_contract_id = p_storage_contract_id
      and metadata.record_id = p_record_id
      and metadata.application_root_id is not distinct from p_application_root_id;
  else
    transition_field_id := (p_due_transition ->> 'calculationFieldId')::uuid;
    transition_at_value := (p_due_transition ->> 'transitionAt')::timestamptz;
    metadata_application_root_id := p_application_root_id;
    insert into vortex_record.record_deadline_due_metadata (
      organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
      application_root_id, record_concurrency_number,
      deadline_calculation_field_id, transition_at
    ) values (
      p_organization_id, p_storage_contract_id, storage_row.storage_scope, p_record_id,
      p_record_type_id, metadata_application_root_id, new_concurrency_number,
      transition_field_id, transition_at_value
    ) on conflict (organization_id, storage_contract_id, record_id, application_root_id)
    do update set
      storage_scope = excluded.storage_scope,
      record_type_id = excluded.record_type_id,
      record_concurrency_number = excluded.record_concurrency_number,
      deadline_calculation_field_id = excluded.deadline_calculation_field_id,
      transition_at = excluded.transition_at,
      changed_at = pg_catalog.statement_timestamp();
  end if;

  -- Activity: `'system'` is an established actor_kind/source, reused directly
  -- from the shared Activity primitive (bypassing only the human-context read
  -- that `append_base_save_activity_internal` performs before this same call).
  append_result := vortex_activity.append_organization_activity_entry(
    p_organization_id, p_activity_id, activity_time, 'system', p_system_actor_id,
    'update_record', array[p_record_id]::uuid[], changed_field_ids, 'system',
    (context_value ->> 'correlationId')::uuid, 'completed'
  );
  if append_result is distinct from 'inserted' and append_result is distinct from 'already_recorded' then
    raise exception using errcode = '40001', message = 'Deadline transition Activity is stale';
  end if;

  event_result := vortex_event.append_record_deadline_transition_occurrence_internal(
    p_storage_contract_id, p_record_id, p_record_type_id, p_occurrence_id,
    p_calculation_field_id, p_organization_id, p_application_root_id, p_system_actor_id,
    (context_value ->> 'correlationId')::uuid, p_carries_personal_data, false, true
  );
  if pg_catalog.jsonb_typeof(event_result) <> 'object' then
    raise exception using errcode = '55000', message = 'Deadline transition Event append failed';
  end if;

  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'closed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number
  );
  update vortex_record.deadline_transition_effects
  set state = 'completed', result = result_value
  where effect_id = p_effect_id;

  return result_value;
end
$function$;

alter function vortex_record.finalize_record_deadline_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, timestamptz, jsonb, jsonb, uuid, uuid, boolean
) owner to vortex_record_adapter;
revoke all on function vortex_record.finalize_record_deadline_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, timestamptz, jsonb, jsonb, uuid, uuid, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_record_deadline_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, timestamptz, jsonb, jsonb, uuid, uuid, boolean
) to vortex_runtime;

alter function vortex_record.validated_system_deadline_context_internal(uuid, uuid, uuid)
  owner to vortex_record_adapter;
revoke all on function vortex_record.validated_system_deadline_context_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on table vortex_record.deadline_transition_effects is
  'Private idempotency ledger for #558 atomic deadline-transition commits; keyed by #557''s deterministic effect identity so a replay returns its stored outcome instead of duplicating effects.';
comment on function vortex_record.validated_system_deadline_context_internal(uuid, uuid, uuid) is
  'Confirms the current transaction still carries the exact System context #557''s claim established for this due row.';
comment on function vortex_event.append_record_deadline_transition_occurrence_internal(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, boolean, boolean, boolean
) is
  'Purpose-built Event append for one deadline calculation-field transition under a validated System context; reuses the shared outbox/queue and envelope shape.';
comment on function vortex_record.finalize_record_deadline_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, timestamptz, jsonb, jsonb, uuid, uuid, boolean
) is
  'Private atomic deadline-transition commit: consumes #557''s claimed facts and updates the root record, due metadata, Activity and Event in the caller''s existing transaction; refuses a relationship-total contribution and a stale/replayed claim without a partial effect.';

reset role;
set local role vortex_record_owner;
revoke references on vortex_record.storage_catalogue from postgres;
revoke create on schema vortex_record from vortex_record_adapter;
revoke create on schema vortex_record from postgres;
reset role;

commit;
