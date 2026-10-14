create or replace function vortex_record.published_sort_index_definition_internal(
  p_storage_contract_id uuid, p_sort jsonb
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  storage_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  sort_item jsonb;
  scope_columns text;
  key_columns text[];
  key_names text[];
  key_directions text[];
  field_ids uuid[] := array[]::uuid[];
  direction_value text;
  token text;
  relation_id oid;
  index_id oid;
  index_row pg_catalog.pg_index%rowtype;
  attribute_number smallint;
  position_value integer;
  expected_option integer;
  observed text := 'present';
  definition_value jsonb;
begin
  if p_sort is null or pg_catalog.jsonb_typeof(p_sort) <> 'array'
    or pg_catalog.jsonb_array_length(p_sort) < 2 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  select storage.* into storage_row
  from vortex_record.storage_catalogue as storage
  where storage.storage_contract_id = p_storage_contract_id
    and storage.state = 'active' and storage.physical_schema_token = 'record_data'
    and not (storage.record_type_definition ? 'systemProjection');
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'storage_contract_unavailable');
  end if;
  scope_columns := vortex_record.index_scope_columns(storage_row.storage_scope);
  if scope_columns is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'storage_contract_unavailable');
  end if;
  key_names := pg_catalog.string_to_array(scope_columns, ', ');
  key_columns := key_names;
  key_directions := pg_catalog.array_fill('ascending'::text, array[pg_catalog.cardinality(key_names)]);
  for sort_item in select item.value from pg_catalog.jsonb_array_elements(p_sort) as item(value)
  loop
    if pg_catalog.jsonb_typeof(sort_item) <> 'object'
      or sort_item - array['fieldId', 'direction']::text[] <> '{}'::jsonb
      or not pg_catalog.pg_input_is_valid(sort_item ->> 'fieldId', 'uuid')
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or (sort_item ->> 'fieldId')::uuid = any (field_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.field_id = (sort_item ->> 'fieldId')::uuid
      and mapping.state = 'active';
    if not found or mapping_row.database_value_type not in
      ('integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    field_ids := pg_catalog.array_append(field_ids, mapping_row.field_id);
    direction_value := sort_item ->> 'direction';
    key_names := pg_catalog.array_append(key_names, mapping_row.physical_column_token);
    key_directions := pg_catalog.array_append(key_directions, direction_value);
    key_columns := pg_catalog.array_append(key_columns,
      pg_catalog.format('%I%s %s nulls %s', mapping_row.physical_column_token,
        case when mapping_row.database_value_type = 'text' then ' collate "C"' else '' end,
        case when direction_value = 'ascending' then 'asc' else 'desc' end,
        case when direction_value = 'ascending' then 'first' else 'last' end));
  end loop;
  direction_value := p_sort -> -1 ->> 'direction';
  key_names := pg_catalog.array_append(key_names, 'record_id');
  key_directions := pg_catalog.array_append(key_directions, direction_value);
  key_columns := pg_catalog.array_append(key_columns,
    'record_id ' || case when direction_value = 'ascending'
      then 'asc' else 'desc nulls last' end);
  token := 'is_' || pg_catalog.md5(p_storage_contract_id::text || ':' || p_sort::text);
  definition_value := pg_catalog.jsonb_build_object(
    'table', storage_row.physical_table_token, 'scope', scope_columns,
    'columns', key_columns, 'predicate', 'lifecycle_state = active');
  relation_id := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', storage_row.physical_table_token));
  index_id := pg_catalog.to_regclass(pg_catalog.format('record_data.%I', token));
  if relation_id is null then
    observed := 'invalid';
  elsif index_id is null then
    observed := 'missing';
  else
    select index_value.* into index_row from pg_catalog.pg_index as index_value
    where index_value.indexrelid = index_id;
    if not found or index_row.indrelid <> relation_id or not index_row.indisvalid
      or index_row.indisunique or index_row.indnkeyatts <> pg_catalog.cardinality(key_names)
      or pg_catalog.pg_get_expr(index_row.indpred, relation_id)
        is distinct from '(lifecycle_state = ''active''::text)' then
      observed := 'invalid';
    else
      for position_value in 1 .. pg_catalog.cardinality(key_names) loop
        select attribute.attnum into attribute_number
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_id and attribute.attname = key_names[position_value]
          and attribute.attnum > 0 and not attribute.attisdropped;
        expected_option := case when key_directions[position_value] = 'descending' then 1 else 0 end
          + case when position_value > pg_catalog.cardinality(pg_catalog.string_to_array(scope_columns, ', '))
            and position_value <= pg_catalog.cardinality(key_names) - 1
            and key_directions[position_value] = 'ascending' then 2 else 0 end;
        if attribute_number is null
          or index_row.indkey[position_value - 1] <> attribute_number
          or index_row.indoption[position_value - 1]::integer <> expected_option
          or (position_value > pg_catalog.cardinality(pg_catalog.string_to_array(scope_columns, ', '))
            and position_value <= pg_catalog.cardinality(key_names) - 1
            and key_columns[position_value] like '%collate "C"%'
            and index_row.indcollation[position_value - 1]
              is distinct from 'pg_catalog."C"'::pg_catalog.regcollation) then
          observed := 'invalid';
          exit;
        end if;
      end loop;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'valid', 'indexToken', token,
    'fingerprint', 'sha256:' || pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(definition_value::text, 'UTF8'), 'sha256'), 'hex'),
    'observedState', observed,
    'createStatement', pg_catalog.format(
      'create index concurrently %I on record_data.%I (%s) where lifecycle_state = ''active''',
      token, storage_row.physical_table_token, pg_catalog.array_to_string(key_columns, ', '))
  );
end
$function$;
alter function vortex_record.published_sort_index_definition_internal(uuid,jsonb) owner to vortex_owner;
revoke all on function vortex_record.published_sort_index_definition_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.published_sort_index_definition_internal(uuid,jsonb) to vortex_owner;
