CREATE FUNCTION vortex_identity.protect_tenant_identity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.tenant_id is distinct from old.tenant_id
    or new.short_name is distinct from old.short_name then
    raise exception using
      errcode = '23514',
      message = 'Tenant identifiers and short names are permanent';
  end if;

  return new;
end
$$;

alter function vortex_identity.protect_tenant_identity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.protect_tenant_identity() FROM PUBLIC;

grant execute on function vortex_identity.protect_tenant_identity() to postgres;
