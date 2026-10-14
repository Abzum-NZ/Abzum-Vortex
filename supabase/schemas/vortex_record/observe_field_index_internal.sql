CREATE OR REPLACE FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  table_relation oid;
  index_relation oid;
  index_row record;
  expected_columns text[];
  key_position integer;
  sort_position integer;
  expected_attnum smallint;
  text_column boolean;
begin
  if p_purpose is null or p_purpose not in ('uniqueness', 'uniqueness_base', 'performance')
    or p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$' then
    return 'invalid';
  end if;

  expected_columns := pg_catalog.string_to_array(p_scope_index_columns, ', ')
    || p_column_token;
  if p_purpose = 'performance' then
    expected_columns := expected_columns || array['record_id'];
  end if;
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
      case when p_purpose = 'performance' then 'ix_' else 'ux_' end
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
    select attribute.attnum into expected_attnum
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = table_relation
      and attribute.attname = expected_columns[key_position]
      and attribute.attnum > 0 and not attribute.attisdropped;
    if expected_attnum is null
      or index_row.indkey[key_position - 1] is distinct from expected_attnum then
      return 'invalid';
    end if;
  end loop;

  if (p_purpose <> 'performance') <> index_row.indisunique then
    return 'invalid';
  end if;
  if p_purpose <> 'performance' then
    if index_row.indpred is null then
      return 'invalid';
    end if;
  else
    sort_position := pg_catalog.cardinality(expected_columns) - 1;
    select attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      into text_column
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = table_relation and attribute.attname = p_column_token;
    if index_row.indpred is null
      or pg_catalog.pg_get_expr(index_row.indpred, table_relation)
        is distinct from '(lifecycle_state = ''active''::text)'
      or (index_row.indoption[sort_position - 1]::integer & 2) <> 2
      or (index_row.indoption[sort_position - 1]::integer & 1) <> 0
      or index_row.indoption[sort_position]::integer <> 0
      or (text_column and index_row.indcollation[sort_position - 1]
        is distinct from 'pg_catalog."C"'::pg_catalog.regcollation) then
      return 'invalid';
    end if;
  end if;

  if p_purpose = 'uniqueness' and exists (
    select 1
    from vortex_record.storage_catalogue as storage
    join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = storage.storage_contract_id
    where storage.physical_table_token = p_table_token
      and mapping.physical_column_token = p_column_token
      and mapping.state = 'active'
      and coalesce((mapping.field_definition ->> 'sortable')::boolean, false)
  ) then
    return vortex_record.observe_field_index_internal(
      'performance', p_table_token, p_scope_index_columns, p_column_token
    );
  end if;

  return 'present';
end
$_$;
alter function vortex_record.observe_field_index_internal(text,text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Physical observation of one exact field index: missing, invalid or present from the live catalogs, never raising.';

REVOKE ALL ON FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;
