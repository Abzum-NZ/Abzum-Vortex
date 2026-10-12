CREATE FUNCTION vortex_access.protect_organization_access_version() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception using errcode = '23514', message = 'Access-version organisation is permanent';
  end if;

  if new.current_version <> old.current_version + 1
    or new.changed_at < old.changed_at
    or new.change_reason is null then
    raise exception using errcode = '23514', message = 'Access-version updates require one complete increment';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.protect_organization_access_version() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_access_version() FROM PUBLIC;
