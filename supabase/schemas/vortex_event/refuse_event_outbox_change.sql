CREATE FUNCTION vortex_event.refuse_event_outbox_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using errcode = '23514', message = 'Event outbox evidence is immutable';
end
$$;


ALTER FUNCTION vortex_event.refuse_event_outbox_change() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_event.refuse_event_outbox_change() FROM PUBLIC;
