CREATE FUNCTION vortex_identity.refuse_identity_disablement_record_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception 'identity disablement history is append-only'
    using errcode = '55000';
end
$$;


ALTER FUNCTION vortex_identity.refuse_identity_disablement_record_change() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.refuse_identity_disablement_record_change() FROM PUBLIC;
