CREATE FUNCTION vortex_identity.protect_organization_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.organization_id is distinct from old.organization_id
    or new.tenant_id is distinct from old.tenant_id
    or new.short_name is distinct from old.short_name then
    raise exception using
      errcode = '23514',
      message = 'Organisation identifiers, tenant ownership and short names are permanent';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_identity.protect_organization_identity() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.protect_organization_identity() FROM PUBLIC;
