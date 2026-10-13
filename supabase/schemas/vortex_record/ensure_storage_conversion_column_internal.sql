CREATE FUNCTION vortex_record.ensure_storage_conversion_column_internal(p_table_token text, p_column_token text, p_database_value_type text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  sql_type text;
  existing_type text;
  table_relation oid;
begin
  if p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$'
    or p_database_value_type is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion column request is invalid';
  end if;

  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_table_token)
  );
  if table_relation is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion table is unavailable';
  end if;

  sql_type := vortex_record.sql_value_type(p_database_value_type);
  if sql_type is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion target type is unsupported';
  end if;

  select pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
  into existing_type
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = table_relation
    and attribute.attname = p_column_token
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if existing_type is null then
    execute pg_catalog.format(
      'alter table record_data.%I add column %I %s',
      p_table_token, p_column_token, sql_type
    );
    return sql_type;
  end if;

  if existing_type <> sql_type then
    raise exception using errcode = '55000',
      message = 'Existing storage conversion target column is incompatible';
  end if;
  return sql_type;
end
$_$;
alter function vortex_record.ensure_storage_conversion_column_internal(text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.ensure_storage_conversion_column_internal(p_table_token text, p_column_token text, p_database_value_type text) IS 'Private Record-owner helper: creates the nullable planned target column when absent and refuses a conflicting physical column; never touches the active source column.';

REVOKE ALL ON FUNCTION vortex_record.ensure_storage_conversion_column_internal(p_table_token text, p_column_token text, p_database_value_type text) FROM PUBLIC;
