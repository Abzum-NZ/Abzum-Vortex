create or replace function vortex_record.total_inputs_readable_internal(
  p_loaded jsonb,
  p_target_record_type_id uuid,
  p_target_record_id uuid,
  p_total_field jsonb,
  p_seen_derived_field_keys jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  contract_value jsonb;
  source_projection jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  required_field_id text;
begin
  contract_value := vortex_record.total_dependency_contract_internal(
    p_loaded -> 'facts' -> 'recordTypes', p_loaded -> 'facts' -> 'relationships',
    p_target_record_type_id, p_total_field
  );
  if contract_value is null
    or pg_catalog.jsonb_typeof(p_seen_derived_field_keys) <> 'array' then
    return false;
  end if;
  for edge_row in
    select edge.* from vortex_record.relationship_edges as edge
    where edge.relationship_id = (contract_value ->> 'relationshipId')::uuid
      and edge.from_storage_contract_id =
        (contract_value ->> 'sourceStorageContractId')::uuid
      and edge.to_storage_contract_id =
        (p_loaded -> 'facts' -> 'binding' ->> 'storageContractId')::uuid
      and edge.to_record_id = p_target_record_id
      and edge.to_organisation_id = (p_loaded -> 'context' ->> 'organizationId')::uuid
      and edge.from_application_root_id is not distinct from case
        when contract_value ->> 'sourceStorageScope' = 'application_contained'
          then (p_loaded -> 'context' ->> 'applicationRootId')::uuid
        else null end
      and edge.to_application_root_id is not distinct from case
        when p_loaded -> 'facts' -> 'binding' ->> 'storageScope' = 'application_contained'
          then (p_loaded -> 'context' ->> 'applicationRootId')::uuid
        else null end
  loop
    source_projection := vortex_record.read_derived_field_ids_for_exact_record_internal(
      (contract_value ->> 'sourceRecordTypeId')::uuid,
      edge_row.from_record_id,
      contract_value -> 'sourceFieldIds',
      p_seen_derived_field_keys
    );
    if source_projection is null then
      if vortex_record.relationship_total_source_is_retained_internal(
        p_loaded -> 'facts',
        (contract_value ->> 'sourceRecordTypeId')::uuid,
        edge_row.from_record_id,
        (p_loaded -> 'context' ->> 'organizationId')::uuid,
        (p_loaded -> 'context' ->> 'applicationRootId')::uuid
      ) then
        continue;
      end if;
      return false;
    end if;
    for required_field_id in
      select item.value from pg_catalog.jsonb_array_elements_text(
        contract_value -> 'sourceFieldIds'
      ) as item(value)
    loop
      if not (source_projection ? required_field_id) then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end
$function$;

alter function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) to vortex_record_adapter;

comment on function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) is 'Private check that each related-total source is readable under the current installed scope.';
