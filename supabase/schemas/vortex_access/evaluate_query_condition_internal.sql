CREATE FUNCTION vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  entry record;
begin
  if pg_catalog.jsonb_typeof(p_condition) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_types) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parameter_types) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parameter_values) is distinct from 'object'
    or p_validate_only is null then
    raise exception using errcode = '22023', message = 'Query condition is invalid';
  end if;

  for entry in select item.key, item.value from pg_catalog.jsonb_each(p_field_values) as item loop
    if not (p_field_types ? entry.key)
      or not vortex_access.typed_condition_value_matches_internal(
        entry.value, p_field_types ->> entry.key, true
      ) then
      raise exception using errcode = '22023', message = 'Query condition is invalid';
    end if;
  end loop;

  -- Every declared parameter is bound, as JSON null when it is optional and
  -- absent; a supplied value must match its declared type exactly.
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_parameter_types) as declared(key)
    where not (p_parameter_values ? declared.key)
  ) then
    raise exception using errcode = '22023', message = 'Query condition is invalid';
  end if;
  for entry in select item.key, item.value from pg_catalog.jsonb_each(p_parameter_values) as item loop
    if not (p_parameter_types ? entry.key)
      or not vortex_access.typed_condition_value_matches_internal(
        entry.value, p_parameter_types ->> entry.key, true
      )
      or (
        p_parameter_types ->> entry.key = 'decimal_number'
        and entry.value <> 'null'::jsonb
        and pg_catalog.jsonb_typeof(entry.value) <> 'string'
      ) then
      raise exception using errcode = '22023', message = 'Query condition is invalid';
    end if;
  end loop;

  return vortex_access.evaluate_typed_condition_node_internal(
    p_condition, p_field_types, p_field_values, p_parameter_types, p_parameter_values,
    p_validate_only
  );
exception
  when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023', message = 'Query condition is invalid';
end
$$;

ALTER FUNCTION vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) IS 'Private bridge from the Query reader to the typed condition engine; checks bound values against their declared semantic types and never widens a condition.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.evaluate_query_condition_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) TO vortex_record_adapter;
