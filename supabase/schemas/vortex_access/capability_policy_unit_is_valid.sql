CREATE FUNCTION vortex_access.capability_policy_unit_is_valid(p_unit text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO ''
    AS $_$
  select p_unit = pg_catalog.btrim(p_unit)
    and pg_catalog.length(p_unit) between 1 and 40
    and p_unit ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$';
$_$;

alter function vortex_access.capability_policy_unit_is_valid(p_unit text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.capability_policy_unit_is_valid(p_unit text) FROM PUBLIC;

grant execute on function vortex_access.capability_policy_unit_is_valid(p_unit text) to postgres;
