CREATE FUNCTION vortex_record.is_lifecycle_destination(p_value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select coalesce(
    pg_catalog.char_length(p_value) between 1 and 80
    and p_value ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$',
    false
  );
$_$;
alter function vortex_record.is_lifecycle_destination(text) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.is_lifecycle_destination(p_value text) FROM PUBLIC;
