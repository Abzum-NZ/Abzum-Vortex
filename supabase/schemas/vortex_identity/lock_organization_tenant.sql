CREATE FUNCTION vortex_identity.lock_organization_tenant() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- State and hierarchy changes share the same per-tenant serialisation point.
  -- This prevents parent/child and tenant/organisation lifecycle write skew as
  -- well as opposing hierarchy moves.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id
  for update;

  return new;
end
$$;

alter function vortex_identity.lock_organization_tenant() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.lock_organization_tenant() FROM PUBLIC;

grant execute on function vortex_identity.lock_organization_tenant() to postgres;
