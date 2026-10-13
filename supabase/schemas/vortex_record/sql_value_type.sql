CREATE FUNCTION vortex_record.sql_value_type(p_database_value_type text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case p_database_value_type
    when 'integer' then 'bigint'
    when 'decimal' then 'numeric'
    when 'boolean' then 'boolean'
    when 'date' then 'date'
    when 'timestamp_with_time_zone' then 'timestamp with time zone'
    when 'uuid' then 'uuid'
    when 'json' then 'jsonb'
    else 'text'
  end
$$;
alter function vortex_record.sql_value_type(text) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.sql_value_type(p_database_value_type text) FROM PUBLIC;
