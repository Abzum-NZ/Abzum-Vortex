CREATE FUNCTION vortex_access.capability_policy_key_is_valid(p_key text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO ''
    AS $_$
  select p_key = pg_catalog.btrim(p_key)
    and pg_catalog.length(p_key) between 3 and 120
    and p_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    and not exists (
      select 1 from pg_catalog.unnest(pg_catalog.string_to_array(p_key, '.')) as part(value)
      where pg_catalog.length(part.value) > 40
    );
$_$;

ALTER FUNCTION vortex_access.capability_policy_key_is_valid(p_key text) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.capability_policy_key_is_valid(p_key text) FROM PUBLIC;
