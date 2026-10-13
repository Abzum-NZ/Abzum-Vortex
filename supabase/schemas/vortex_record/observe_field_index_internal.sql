CREATE FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  table_relation oid;
  index_relation oid;
  index_row record;
  expected_columns text[];
  key_position integer;
begin
  if p_purpose is null or p_purpose not in ('uniqueness', 'performance')
    or p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$' then
    return 'invalid';
  end if;

  expected_columns := pg_catalog.string_to_array(p_scope_index_columns, ', ')
    || p_column_token;
  if pg_catalog.cardinality(expected_columns) < 2 then
    return 'invalid';
  end if;

  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_table_token)
  );
  if table_relation is null then
    return 'invalid';
  end if;

  index_relation := pg_catalog.to_regclass(
    pg_catalog.format(
      'record_data.%I',
      case p_purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(p_column_token, 3)
    )
  );
  if index_relation is null then
    return 'missing';
  end if;

  select index_value.* into index_row
  from pg_catalog.pg_index as index_value
  where index_value.indexrelid = index_relation;
  if not found
    or index_row.indrelid is distinct from table_relation
    or index_row.indisvalid is not true
    or index_row.indnkeyatts is distinct from pg_catalog.cardinality(expected_columns) then
    return 'invalid';
  end if;

  for key_position in 1 .. index_row.indnkeyatts
  loop
    if pg_catalog.pg_get_indexdef(index_relation, key_position, false)
      is distinct from expected_columns[key_position] then
      return 'invalid';
    end if;
  end loop;

  if (p_purpose = 'uniqueness') <> index_row.indisunique then
    return 'invalid';
  end if;
  if p_purpose = 'uniqueness' then
    if index_row.indpred is null then
      return 'invalid';
    end if;
  elsif index_row.indpred is not null then
    return 'invalid';
  end if;

  return 'present';
end
$_$;
alter function vortex_record.observe_field_index_internal(text,text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Physical observation of one exact field index: missing, invalid or present from the live catalogs, never raising.';

REVOKE ALL ON FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;
