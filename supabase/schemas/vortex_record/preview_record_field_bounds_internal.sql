create or replace function vortex_record.preview_record_field_bounds_internal(
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_record_type jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
begin
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null or preview_value ->> 'outcome' = 'refused'
    or pg_catalog.jsonb_typeof(p_record_type) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or (p_record_type ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or p_record_type ? 'systemProjection' then
    return null;
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(preview_value -> 'storageIdentities')
      as binding(value)
    where (binding.value ->> 'previewStorageContractId')::uuid = p_storage_contract_id
      and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
  ) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    ), '[]'::jsonb),
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
      where field.value ->> 'type' not in (
        'calculation', 'total', 'reference_number', 'link',
        'link_to_one_of_several', 'link_to_person', 'attachment'
      )
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb) is
  'Field bounds for a record already proven to use the exact owner-only preview storage identity; generated and derived fields remain non-changeable.';
