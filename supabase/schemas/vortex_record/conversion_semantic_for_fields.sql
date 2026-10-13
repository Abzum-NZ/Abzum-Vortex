CREATE FUNCTION vortex_record.conversion_semantic_for_fields(p_source_field jsonb, p_target_field jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case
    when (p_source_field ->> 'type') in ('whole_number', 'decimal_number', 'yes_no', 'date')
      and (p_target_field ->> 'type') in ('decimal_number', 'text', 'long_text', 'date_time')
      then vortex_record.conversion_semantic_for_types(
        vortex_record.database_value_type(p_source_field),
        vortex_record.database_value_type(p_target_field)
      )
    else null
  end
$$;
alter function vortex_record.conversion_semantic_for_fields(jsonb,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.conversion_semantic_for_fields(p_source_field jsonb, p_target_field jsonb) IS 'Closed, lossless conversion semantic for exact plain stored source/target field definitions, or null when the pair is unsupported.';

REVOKE ALL ON FUNCTION vortex_record.conversion_semantic_for_fields(p_source_field jsonb, p_target_field jsonb) FROM PUBLIC;
