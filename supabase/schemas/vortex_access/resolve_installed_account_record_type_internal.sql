create or replace function vortex_access.resolve_installed_account_record_type_internal(
  p_record_types jsonb
)
returns uuid
language plpgsql stable security invoker set search_path = ''
as $function$
declare
  account_record_type_id uuid;
begin
  -- Only the exact installation's protected fact/plan types are candidates.
  -- The caller is owner-only; request roles cannot supply this metadata.
  select distinct catalogue.record_type_id into strict account_record_type_id
  from pg_catalog.jsonb_array_elements(p_record_types) as installed(value)
  join vortex_record.storage_catalogue as catalogue
    on catalogue.storage_contract_id = (installed.value ->> 'storageContractId')::uuid
    and catalogue.module_root_id = (installed.value ->> 'moduleRootId')::uuid
    and catalogue.record_type_id = (installed.value ->> 'recordTypeId')::uuid
  where catalogue.physical_schema_token = 'system_projection'
    and catalogue.protected_read_model_key = 'organization_accounts'
    and catalogue.state = 'active';
  return account_record_type_id;
end
$function$;

alter function vortex_access.resolve_installed_account_record_type_internal(jsonb)
  owner to vortex_owner;
revoke all on function vortex_access.resolve_installed_account_record_type_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_installed_account_record_type_internal(jsonb)
  to postgres;
