CREATE FUNCTION vortex_record.conversion_value_assignment(p_conversion_semantic text, p_source_column_token text, p_target_column_token text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case p_conversion_semantic
    when 'integer_to_decimal' then
      pg_catalog.format('%I = %I::numeric', p_target_column_token, p_source_column_token)
    when 'integer_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'decimal_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'boolean_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'uuid_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'date_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'date_to_timestamp_with_time_zone' then
      pg_catalog.format(
        '%I = (%I::timestamp without time zone at time zone ''UTC'')',
        p_target_column_token, p_source_column_token
      )
    else null
  end
$$;

COMMENT ON FUNCTION vortex_record.conversion_value_assignment(p_conversion_semantic text, p_source_column_token text, p_target_column_token text) IS 'Exact SQL assignment migrating one source column into one planned target column for a supported conversion semantic.';

REVOKE ALL ON FUNCTION vortex_record.conversion_value_assignment(p_conversion_semantic text, p_source_column_token text, p_target_column_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.conversion_value_assignment(p_conversion_semantic text, p_source_column_token text, p_target_column_token text) TO vortex_record_adapter;
