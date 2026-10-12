CREATE FUNCTION vortex_activity.refuse_activity_entry_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using
    errcode = '23514',
    message = 'Activity entries are immutable';
end
$$;


ALTER FUNCTION vortex_activity.refuse_activity_entry_change() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_activity.refuse_activity_entry_change() FROM PUBLIC;
