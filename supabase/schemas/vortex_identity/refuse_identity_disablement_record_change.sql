CREATE FUNCTION vortex_identity.refuse_identity_disablement_record_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception 'identity disablement history is append-only'
    using errcode = '55000';
end
$$;

alter function vortex_identity.refuse_identity_disablement_record_change() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.refuse_identity_disablement_record_change() FROM PUBLIC;

grant execute on function vortex_identity.refuse_identity_disablement_record_change() to postgres;
