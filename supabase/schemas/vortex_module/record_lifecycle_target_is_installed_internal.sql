CREATE FUNCTION vortex_module.record_lifecycle_target_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid) RETURNS boolean
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
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    return false;
  end if;
  select true into matched
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.state = 'active'
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and (
      p_application_root_id is null
      or binding.application_root_id = p_application_root_id
    )
  limit 1
  for share;
  return coalesce(matched, false);
end
$$;

COMMENT ON FUNCTION vortex_module.record_lifecycle_target_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid) IS 'Private installation fact for record lifecycle policy administration; shares the matching active installation binding for the transaction.';

REVOKE ALL ON FUNCTION vortex_module.record_lifecycle_target_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_module.record_lifecycle_target_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid) TO vortex_record_owner;
