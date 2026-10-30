create or replace function vortex_record.prepare_record_calculation_graph_internal(
  p_catalogue jsonb,
  p_records jsonb,
  p_proposals jsonb,
  p_visible_record_keys text[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  organization_id_value uuid := (context_value ->> 'organizationId')::uuid;
  application_id_value uuid := (context_value ->> 'applicationRootId')::uuid;
  prepared_record jsonb;
  prepared_records jsonb := '[]'::jsonb;
  parent_read jsonb;
  module_id uuid;
  release_revision bigint;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  source_snapshot jsonb;
  source_key text;
  edge_value vortex_record.relationship_edges%rowtype;
  proposal jsonb;
begin
  if pg_catalog.jsonb_typeof(p_records) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_proposals) is distinct from 'array'
    or p_visible_record_keys is null then
    raise exception using errcode = '22023', message = 'Record calculation graph is invalid';
  end if;
  for prepared_record in
    select item.value from pg_catalog.jsonb_array_elements(p_records) as item(value)
    order by item.value ->> 'recordKey'
  loop
    select storage.module_root_id into strict module_id
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
      and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
      and storage.state = 'active';
    select (item.value ->> 'moduleReleaseRevision')::bigint into strict release_revision
    from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
    where item.value -> 'recordTypeId' = prepared_record -> 'recordTypeId';
    parent_read := null;
    if not ((prepared_record ->> 'recordKey') = any(p_visible_record_keys))
      and prepared_record ? 'recordId' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid, (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', (prepared_record ->> 'recordKey') = any(p_visible_record_keys)
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        module_id, release_revision, (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value from pg_catalog.jsonb_array_elements(prepared_record #> '{recordType,fields}') as field(value)
      where field.value ->> 'type' = 'total' order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'relationships') as item(value)
      where item.value ->> 'relationshipId' = total_field #>> '{settings,relationshipId}'
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') as source(value)
        where source.value -> 'relationshipId' = relationship_value -> 'relationshipId'
      ) then continue; end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
      where item.value -> 'recordTypeId' = relationship_value -> 'fromRecordTypeId';
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
      end if;
      source_records := '[]'::jsonb;
      -- Unchanged members come from the protected storage graph. Every supplied
      -- proposal replaces its old membership below, including removals and links
      -- moved between two parents by different intentions in the same command.
      for edge_value in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = organization_id_value
          and edge.to_organisation_id = organization_id_value
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained' then application_id_value else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained' then application_id_value else null end
          and not exists (
            select 1 from pg_catalog.jsonb_array_elements(p_proposals) as changed(value)
            where changed.value -> 'recordTypeId' = source_type -> 'recordTypeId'
              and (changed.value ->> 'recordId')::uuid = edge.from_record_id
          )
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          p_catalogue, (source_type ->> 'recordTypeId')::uuid, edge_value.from_record_id, false
        );
        if source_snapshot is null and vortex_record.relationship_total_source_is_retained_internal(
          p_catalogue, (source_type ->> 'recordTypeId')::uuid, edge_value.from_record_id,
          organization_id_value, application_id_value
        ) then continue; end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(p_records) as item(value)
        where item.value -> 'recordTypeId' = source_type -> 'recordTypeId'
          and (item.value ->> 'recordId')::uuid = edge_value.from_record_id;
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('fieldValues', source_snapshot -> 'existingValues')
          || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;
      for proposal in
        select item.value from pg_catalog.jsonb_array_elements(p_proposals) as item(value)
        where item.value -> 'recordTypeId' = source_type -> 'recordTypeId'
          and item.value ->> 'lifecycleState' = 'active'
          and item.value -> 'values' -> (relationship_value ->> 'fromFieldId') -> 'recordTypeId'
            = prepared_record -> 'recordTypeId'
          and item.value -> 'values' -> (relationship_value ->> 'fromFieldId') -> 'recordId'
            = prepared_record -> 'recordId'
        order by item.value ->> 'recordKey'
      loop
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('fieldValues', proposal -> 'values')
          || case when proposal ->> 'recordKey' is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', proposal -> 'recordKey') end
        );
      end loop;
      prepared_record := pg_catalog.jsonb_set(prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision', 'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'records', prepared_records);
end
$function$;
alter function vortex_record.prepare_record_calculation_graph_internal(jsonb,jsonb,jsonb,text[]) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_calculation_graph_internal(jsonb,jsonb,jsonb,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_calculation_graph_internal(jsonb,jsonb,jsonb,text[]) is
  'Private calculation input preparation for a locked record set: delivers current rule definitions and total memberships after replacing every changed source with its proposed state, without mutating records.';
