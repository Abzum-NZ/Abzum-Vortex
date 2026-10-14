CREATE OR REPLACE FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'schemaToken', 'record_data',
    'tableToken', p_table_token,
    'columns', pg_catalog.string_to_array(p_scope_index_columns, ', ') ||
      case when p_purpose = 'performance' then array[
        p_column_token || case when exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('record_data.%I', p_table_token)
          )
            and attribute.attname = p_column_token
            and attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
        ) then ' COLLATE "C"' else '' end || ' NULLS FIRST',
        'record_id'
      ] else array[p_column_token] end,
    'unique', p_purpose = 'uniqueness',
    'predicate', case when p_purpose = 'uniqueness'
      then 'lifecycle_state in (active, soft_deleted, removal_pending)'
      else 'lifecycle_state = active' end
  )
$$;
alter function vortex_record.index_definition(text,text,text,text) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;
