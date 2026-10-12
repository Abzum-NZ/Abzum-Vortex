CREATE FUNCTION vortex_access.validate_organization_direct_record_share_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.state <> 'active'
    or new.revision <> 1
    or new.changed_at is distinct from new.granted_at then
    raise exception using errcode = '23514',
      message = 'Initial direct record-share evidence is invalid';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.validate_organization_direct_record_share_insert() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_direct_record_share_insert() FROM PUBLIC;
