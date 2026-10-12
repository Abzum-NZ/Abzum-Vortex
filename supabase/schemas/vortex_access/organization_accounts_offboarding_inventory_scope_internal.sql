CREATE FUNCTION vortex_access.organization_accounts_offboarding_inventory_scope_internal() RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select authorized.tenant_id, authorized.organization_id,
    authorized.organization_account_id, authorized.access_version
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
$$;


ALTER FUNCTION vortex_access.organization_accounts_offboarding_inventory_scope_internal() OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.organization_accounts_offboarding_inventory_scope_internal() IS 'Private adapter-only bridge for the fixed accounts.manage check in account-offboarding inventory.';

REVOKE ALL ON FUNCTION vortex_access.organization_accounts_offboarding_inventory_scope_internal() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.organization_accounts_offboarding_inventory_scope_internal() TO vortex_record_adapter;
