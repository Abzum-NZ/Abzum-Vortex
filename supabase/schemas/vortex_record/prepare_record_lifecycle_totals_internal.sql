create or replace function vortex_record.prepare_record_lifecycle_totals_internal(
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid,
  p_root_snapshot jsonb
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
begin
  if p_operation is null or p_operation not in ('delete', 'restore')
    or (p_operation = 'restore' and p_root_snapshot is not null) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle total preparation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  catalogue := vortex_record.relationship_total_catalogue_internal();

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

  -- Mirrors the ordinary save: installed rules are not evaluated against
  -- generated parent values, so no parent total may change under them.
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) and exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
    where item.value ->> 'recordKey' <> 'root'
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'unsupported_relationship_totals',
      'correlationId', context_value -> 'correlationId'
    );
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
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
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
        order by edge.from_storage_contract_id, edge.from_record_id
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

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', '[]'::jsonb,
    'records', prepared_records
  );
end
$function$;
alter function vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb) is null;
