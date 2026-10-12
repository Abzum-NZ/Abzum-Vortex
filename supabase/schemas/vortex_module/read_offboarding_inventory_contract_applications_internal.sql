CREATE FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  affected_applications jsonb;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();

  -- Provisioned bindings are not installed and are excluded; detached bindings
  -- are a disabled installation of a real application and stay visible, exactly
  -- as the inventory's installation reader treats them.
  select coalesce(
    pg_catalog.jsonb_agg(
      distinct binding.application_root_id order by binding.application_root_id
    ),
    '[]'::jsonb
  )
  into affected_applications
  from vortex_module.installation_bindings as binding
  where binding.organization_id = (context_value ->> 'organizationId')::uuid
    and binding.state in ('active', 'detached')
    and p_storage_contract_id = any (binding.storage_contract_ids);

  return affected_applications;
end
$$;

COMMENT ON FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) IS 'Private adapter-only bridge returning the installed application root IDs one storage contract is bound into, for account-offboarding shared impact.';

REVOKE ALL ON FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) FROM vortex_module_owner;
GRANT ALL ON FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) TO vortex_record_adapter;
