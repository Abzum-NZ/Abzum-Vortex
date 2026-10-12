CREATE FUNCTION vortex_module.storage_conversion_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_module_root_id uuid, p_module_release_revision bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;

COMMENT ON FUNCTION vortex_module.storage_conversion_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_module_root_id uuid, p_module_release_revision bigint) IS 'Private installation fact for storage conversion: shares the active installation of the exact Module release that installs the storage contract in this organisation scope.';

REVOKE ALL ON FUNCTION vortex_module.storage_conversion_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_module_root_id uuid, p_module_release_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_module.storage_conversion_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_module_root_id uuid, p_module_release_revision bigint) TO vortex_record_owner;
