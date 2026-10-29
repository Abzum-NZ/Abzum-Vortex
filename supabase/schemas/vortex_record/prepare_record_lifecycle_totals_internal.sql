create or replace function vortex_record.prepare_record_lifecycle_totals_internal(
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid,
  p_root_snapshot jsonb,
  p_proposed_records jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  rule_module_root_id uuid;
  rule_release_revision bigint;
  parent_read jsonb;
  lifecycle_effect record;
  lifecycle_loaded jsonb;
  lifecycle_type jsonb;
  lifecycle_proposed jsonb;
  lifecycle_records jsonb := '[]'::jsonb;
begin
  if p_operation is null or p_operation not in ('delete', 'restore')
    or (p_operation = 'restore' and p_root_snapshot is not null)
    or pg_catalog.jsonb_typeof(p_proposed_records) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record lifecycle total preparation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  catalogue := vortex_record.relationship_total_catalogue_internal()
    || pg_catalog.jsonb_build_object('proposedRecords', p_proposed_records);

  before_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if before_closure is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'relationship_refused',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    ) is null then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
  end loop;

  after_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if after_closure is null
    or (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from
      (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;

  for prepared_record in
    select ordered.value
    from (
      select p_root_snapshot || pg_catalog.jsonb_build_object('recordKey', 'root') as value,
        0 as position, '' as record_key
      where p_root_snapshot is not null
      union all
      select item.value,
        case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
        item.value ->> 'recordKey'
      from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
    ) as ordered
    order by ordered.position, ordered.record_key collate "C"
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        rule_module_root_id, rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      relationship_value := null;
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
          pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_refused',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') as source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      source_type := null;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_refused',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select distinct candidate.* from (
          select edge.* from vortex_record.relationship_edges as edge
          where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
            and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
            and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
            and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
            and edge.from_organisation_id = context_organization_id
            and edge.to_organisation_id = context_organization_id
            and edge.from_application_root_id is not distinct from case
              when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end
            and edge.to_application_root_id is not distinct from case
              when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
          union
          select (pg_catalog.jsonb_populate_record(null::vortex_record.relationship_edges,
            pg_catalog.jsonb_build_object(
              'relationship_id', relationship_value -> 'relationshipId',
              'from_organisation_id', context_organization_id, 'to_organisation_id', context_organization_id,
              'from_storage_contract_id', source_type -> 'storageContractId', 'from_record_id', proposed.value -> 'recordId',
              'to_storage_contract_id', prepared_record -> 'storageContractId', 'to_record_id', prepared_record -> 'recordId',
              'from_application_root_id', case when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end,
              'to_application_root_id', case when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
            )
          )).* from pg_catalog.jsonb_array_elements(p_proposed_records) as proposed(value)
          where proposed.value -> 'storageContractId' = source_type -> 'storageContractId'
            and proposed.value ->> 'lifecycleState' = 'active'
            and proposed.value -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordId'
              = prepared_record -> 'recordId'
            and proposed.value -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordTypeId'
              = prepared_record -> 'recordTypeId'
        ) as candidate
        order by candidate.from_storage_contract_id, candidate.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
          return pg_catalog.jsonb_build_object('outcome', 'restart');
        end if;
        if source_snapshot -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordId'
            is distinct from prepared_record -> 'recordId'
          or source_snapshot -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordTypeId'
            is distinct from prepared_record -> 'recordTypeId' then continue; end if;
        source_key := null;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;

  -- Every record removed or recovered by the command has its own lifecycle
  -- rules. Keep those stored-value snapshots separate from generated-field
  -- parents, whose applicable operation remains update.
  for lifecycle_effect in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
      and effect.effect_kind = case when p_operation = 'delete' then 'soft_deleted' else 'restored' end
    order by effect.storage_contract_id, effect.record_id
  loop
    select item.value into strict lifecycle_type
    from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = lifecycle_effect.record_type_id;
    lifecycle_loaded := vortex_record.load_record_access_facts_internal(
      lifecycle_effect.record_type_id, p_operation, lifecycle_effect.record_id,
      null, null
    );
    if lifecycle_loaded ->> 'outcome' is distinct from 'loaded' then
      raise exception using errcode = '55000', message = 'Lifecycle rule snapshot is unavailable';
    end if;
    select storage.module_root_id into strict rule_module_root_id
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = lifecycle_effect.storage_contract_id
      and storage.record_type_id = lifecycle_effect.record_type_id
      and storage.state = 'active';
    select item.value into lifecycle_proposed
    from pg_catalog.jsonb_array_elements(p_proposed_records) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = lifecycle_effect.record_type_id
      and (item.value ->> 'recordId')::uuid = lifecycle_effect.record_id;
    lifecycle_records := lifecycle_records || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordKey', case when lifecycle_effect.record_type_id = p_record_type_id
            and lifecycle_effect.record_id = p_record_id then 'root'
          else lifecycle_effect.record_type_id::text || ':' || lifecycle_effect.record_id::text end,
        'recordType', lifecycle_type - 'moduleReleaseRevision',
        'recordId', lifecycle_effect.record_id,
        'concurrencyNumber', lifecycle_loaded -> 'concurrencyNumber',
        'existingValues', case when p_root_snapshot is not null
            and lifecycle_effect.record_type_id = p_record_type_id
            and lifecycle_effect.record_id = p_record_id
          then p_root_snapshot -> 'existingValues'
          when p_operation = 'restore' and lifecycle_proposed is not null
            then lifecycle_proposed -> 'existingValues'
          else lifecycle_loaded -> 'fieldValues' end,
        'canRead', lifecycle_effect.record_type_id = p_record_type_id and lifecycle_effect.record_id = p_record_id,
        'relationshipSources', '[]'::jsonb,
        'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
          rule_module_root_id, (lifecycle_type ->> 'moduleReleaseRevision')::bigint,
          lifecycle_effect.record_type_id
        )
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', '[]'::jsonb,
    'records', prepared_records,
    'lifecycleRecords', lifecycle_records
  );
end
$function$;
alter function vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb, jsonb) is null;
