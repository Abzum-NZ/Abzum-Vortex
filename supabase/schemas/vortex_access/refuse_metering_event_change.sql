CREATE FUNCTION vortex_access.refuse_metering_event_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using errcode = '23514', message = 'Metering event evidence is immutable';
end
$$;

ALTER FUNCTION vortex_access.refuse_metering_event_change() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.refuse_metering_event_change() FROM PUBLIC;
