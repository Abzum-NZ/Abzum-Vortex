CREATE FUNCTION vortex_access.refuse_organization_role_history_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using errcode = '23514', message = 'Organization role history is immutable';
end;
$$;


ALTER FUNCTION vortex_access.refuse_organization_role_history_mutation() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.refuse_organization_role_history_mutation() FROM PUBLIC;
