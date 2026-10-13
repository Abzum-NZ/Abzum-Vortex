CREATE OR REPLACE FUNCTION vortex_record.refuse_activity_entry_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  raise exception using
    errcode = '23514',
    message = 'Activity entries are immutable';
end
$$;

alter function vortex_record.refuse_activity_entry_change() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_record.refuse_activity_entry_change() FROM PUBLIC;

grant execute on function vortex_record.refuse_activity_entry_change() to postgres;
