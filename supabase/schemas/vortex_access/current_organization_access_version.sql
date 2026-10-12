CREATE FUNCTION vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid) RETURNS TABLE(organization_id uuid, current_version bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_tenant_id is null
    or p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Access-version scope is invalid';
  end if;

  return query
  select version.organization_id, version.current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
    and organization.state = 'active'
    and tenant.state = 'active';

  if not found then
    raise exception using errcode = '42501', message = 'Access-version scope is unavailable';
  end if;
end
$$;


ALTER FUNCTION vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid) IS 'Returns only the current version for one exact active tenant and organisation.';

REVOKE ALL ON FUNCTION vortex_access.current_organization_access_version(p_tenant_id uuid, p_organization_id uuid) FROM PUBLIC;
