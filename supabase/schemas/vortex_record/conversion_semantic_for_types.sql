CREATE FUNCTION vortex_record.conversion_semantic_for_types(p_source_database_value_type text, p_target_database_value_type text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case
    when p_source_database_value_type = 'integer'
      and p_target_database_value_type = 'decimal' then 'integer_to_decimal'
    when p_source_database_value_type = 'integer'
      and p_target_database_value_type = 'text' then 'integer_to_text'
    when p_source_database_value_type = 'decimal'
      and p_target_database_value_type = 'text' then 'decimal_to_text'
    when p_source_database_value_type = 'boolean'
      and p_target_database_value_type = 'text' then 'boolean_to_text'
    when p_source_database_value_type = 'uuid'
      and p_target_database_value_type = 'text' then 'uuid_to_text'
    when p_source_database_value_type = 'date'
      and p_target_database_value_type = 'text' then 'date_to_text'
    when p_source_database_value_type = 'date'
      and p_target_database_value_type = 'timestamp_with_time_zone'
      then 'date_to_timestamp_with_time_zone'
    else null
  end
$$;

COMMENT ON FUNCTION vortex_record.conversion_semantic_for_types(p_source_database_value_type text, p_target_database_value_type text) IS 'Closed, lossless conversion semantic for an exact source/target database value type pair, or null when the pair is unsupported.';

REVOKE ALL ON FUNCTION vortex_record.conversion_semantic_for_types(p_source_database_value_type text, p_target_database_value_type text) FROM PUBLIC;
