CREATE FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'schemaToken', 'record_data',
    'tableToken', p_table_token,
    'columns', pg_catalog.string_to_array(p_scope_index_columns, ', ') || p_column_token,
    'unique', p_purpose = 'uniqueness',
    'predicate', case when p_purpose = 'uniqueness'
      then 'lifecycle_state in (active, soft_deleted, removal_pending)' else null end
  )
$$;

REVOKE ALL ON FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;
