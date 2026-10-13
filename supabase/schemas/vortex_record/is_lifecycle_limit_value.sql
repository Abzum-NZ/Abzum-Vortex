CREATE FUNCTION vortex_record.is_lifecycle_limit_value(p_value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case
    when p_value is null then false
    when pg_catalog.jsonb_typeof(p_value) = 'null' then true
    when pg_catalog.jsonb_typeof(p_value) <> 'number' then false
    else (p_value #>> '{}')::numeric = pg_catalog.trunc((p_value #>> '{}')::numeric)
      and (p_value #>> '{}')::numeric between 1 and 9007199254740991
  end;
$$;
alter function vortex_record.is_lifecycle_limit_value(jsonb) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.is_lifecycle_limit_value(p_value jsonb) FROM PUBLIC;
