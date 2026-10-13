CREATE OR REPLACE FUNCTION vortex_platform.refuse_event_outbox_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using errcode = '23514', message = 'Event outbox evidence is immutable';
end
$$;

alter function vortex_platform.refuse_event_outbox_change() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_platform.refuse_event_outbox_change() FROM PUBLIC;

grant execute on function vortex_platform.refuse_event_outbox_change() to postgres;
