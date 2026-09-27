create or replace function vortex_record.allocate_preview_reference_number_internal(
  p_preview_installation_id uuid,
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_settings jsonb
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
  start_number numeric(78,0);
  allocated numeric(78,0);
  digit_width integer;
  prefix_value text;
  suffix_value text;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_context.is_non_nil_uuid(p_field_id::text)
    or pg_catalog.jsonb_typeof(p_settings) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_settings -> 'digits') is distinct from 'number'
    or (p_settings ->> 'digits')::integer not between 1 and 20
    or (p_settings ? 'startingNumber' and (
      pg_catalog.jsonb_typeof(p_settings -> 'startingNumber') <> 'number'
      or (p_settings ->> 'startingNumber')::numeric < 1
      or pg_catalog.trunc((p_settings ->> 'startingNumber')::numeric)
        <> (p_settings ->> 'startingNumber')::numeric
    )) then
    raise exception using errcode = '22023', message = 'Preview reference-number settings are invalid';
  end if;

  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null
    or preview_value ->> 'outcome' = 'refused'
    or (preview_value ->> 'previewInstallationId')::uuid
      is distinct from p_preview_installation_id
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(preview_value -> 'storageIdentities')
        as binding(value)
      where (binding.value ->> 'previewStorageContractId')::uuid = p_storage_contract_id
    )
    or not exists (
      select 1
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = p_storage_contract_id
        and mapping.field_id = p_field_id
        and mapping.state = 'active'
    ) then
    raise exception using errcode = '42501', message = 'Preview reference-number storage is unavailable';
  end if;

  digit_width := (p_settings ->> 'digits')::integer;
  start_number := coalesce((p_settings ->> 'startingNumber')::numeric, 1);
  prefix_value := coalesce(p_settings ->> 'prefix', '');
  suffix_value := coalesce(p_settings ->> 'suffix', '');

  insert into vortex_record.preview_reference_counters (
    preview_installation_id, storage_contract_id, field_id, next_number
  ) values (
    p_preview_installation_id, p_storage_contract_id, p_field_id, start_number + 1
  )
  on conflict (preview_installation_id, storage_contract_id, field_id)
    do update set next_number =
      vortex_record.preview_reference_counters.next_number + 1
  returning next_number - 1 into allocated;

  return prefix_value
    || pg_catalog.lpad(
      allocated::text,
      case when pg_catalog.length(allocated::text) > digit_width
        then pg_catalog.length(allocated::text) else digit_width end,
      '0'
    )
    || suffix_value;
end
$function$;

alter function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb) is
  'Allocates a reference number from the exact preview installation''s private counter, after revalidating its owner, expiry and storage identity.';
