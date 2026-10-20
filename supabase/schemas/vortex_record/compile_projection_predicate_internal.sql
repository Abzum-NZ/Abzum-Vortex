create or replace function vortex_record.compile_projection_predicate_internal(
  p_predicate jsonb,
  p_declared jsonb,
  p_parameter_slot integer
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare
  condition_item jsonb;
  field_keys jsonb;
  field_types jsonb;
  field_database_types jsonb;
  field_columns jsonb := '{}'::jsonb;
  field_expressions jsonb := '{}'::jsonb;
  field_definitions jsonb := '{}'::jsonb;
  field_id text;
  attribute_key text;
  declared_item jsonb;
  filter_plan jsonb;
  filter_sql text;
  filter_parameters jsonb := '[]'::jsonb;
  search_item jsonb;
  search_terms text[] := array[]::text[];
  search_key text;
  search_index integer;
  predicates text[] := array[]::text[];
begin
  -- The one typed predicate every bounded system-projection reader applies
  -- inside its keyset scan. A reader declares, per attribute key, the SQL
  -- expression of its own scan, the database value type and whether the key
  -- may be filtered or searched. A key the reader does not declare is refused
  -- by cause; a predicate the shared condition compiler cannot express exactly
  -- is refused by cause, never ignored and never left to a second pass.
  if p_predicate is null or p_predicate = 'null'::jsonb then
    return pg_catalog.jsonb_build_object('predicate', null, 'parameters', '[]'::jsonb);
  end if;
  if pg_catalog.jsonb_typeof(p_predicate) is distinct from 'object'
    or p_predicate - array['filter', 'search']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_declared) is distinct from 'object'
    or p_parameter_slot is null or p_parameter_slot < 1 then
    raise exception using errcode = '22023', message = 'predicate_unsupported';
  end if;

  if p_predicate ? 'filter' and p_predicate -> 'filter' <> 'null'::jsonb then
    condition_item := p_predicate #> '{filter,condition}';
    field_keys := p_predicate #> '{filter,fieldKeys}';
    field_types := p_predicate #> '{filter,fieldTypes}';
    field_database_types := p_predicate #> '{filter,fieldDatabaseTypes}';
    if pg_catalog.jsonb_typeof(p_predicate -> 'filter') is distinct from 'object'
      or (p_predicate -> 'filter') - array[
        'condition', 'fieldKeys', 'fieldTypes', 'fieldDatabaseTypes', 'inputTypes', 'inputValues'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(condition_item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(field_keys) is distinct from 'object'
      or pg_catalog.jsonb_typeof(field_types) is distinct from 'object'
      or pg_catalog.jsonb_typeof(field_database_types) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_predicate #> '{filter,inputTypes}') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_predicate #> '{filter,inputValues}') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'predicate_unsupported';
    end if;
    for field_id, attribute_key in
      select item.key, item.value #>> '{}'
      from pg_catalog.jsonb_each(field_keys) as item(key, value)
    loop
      declared_item := p_declared -> attribute_key;
      if declared_item is null
        or coalesce((declared_item ->> 'filter')::boolean, false) is not true then
        raise exception using errcode = '22023', message = 'filter_field_not_declared';
      end if;
      if declared_item ->> 'database' is distinct from field_database_types ->> field_id then
        raise exception using errcode = '22023', message = 'predicate_unsupported';
      end if;
      field_columns := field_columns || pg_catalog.jsonb_build_object(field_id, attribute_key);
      field_expressions := field_expressions
        || pg_catalog.jsonb_build_object(field_id, declared_item ->> 'sql');
      field_definitions := field_definitions
        || pg_catalog.jsonb_build_object(field_id, pg_catalog.jsonb_build_object('filterable', true));
    end loop;
    filter_plan := vortex_record.compile_query_filter_internal(
      condition_item, field_types, field_columns, field_database_types, field_definitions,
      field_expressions, p_predicate #> '{filter,inputTypes}', p_predicate #> '{filter,inputValues}',
      p_parameter_slot, 0
    );
    if filter_plan ->> 'predicate' is null or (filter_plan ->> 'exact')::boolean is not true then
      raise exception using errcode = '22023', message = 'predicate_unsupported';
    end if;
    predicates := pg_catalog.array_append(predicates, filter_plan ->> 'predicate');
    filter_parameters := filter_plan -> 'parameters';
  end if;

  if p_predicate ? 'search' and p_predicate -> 'search' <> 'null'::jsonb then
    search_item := p_predicate -> 'search';
    if pg_catalog.jsonb_typeof(search_item) is distinct from 'object'
      or search_item - array['term', 'keys']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(search_item -> 'term') is distinct from 'string'
      or pg_catalog.jsonb_typeof(search_item -> 'keys') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'predicate_unsupported';
    end if;
    -- The term is bound as the last entry of the one parameter array.
    search_index := pg_catalog.jsonb_array_length(filter_parameters);
    filter_parameters := filter_parameters || pg_catalog.jsonb_build_array(search_item -> 'term');
    for search_key in
      select item.value #>> '{}' from pg_catalog.jsonb_array_elements(search_item -> 'keys') as item(value)
    loop
      declared_item := p_declared -> search_key;
      if declared_item is null
        or coalesce((declared_item ->> 'search')::boolean, false) is not true then
        raise exception using errcode = '22023', message = 'filter_field_not_declared';
      end if;
      search_terms := pg_catalog.array_append(search_terms, pg_catalog.format(
        'pg_catalog.strpos(pg_catalog.lower(%s), pg_catalog.lower($%s ->> %s)) > 0',
        declared_item ->> 'sql', p_parameter_slot, search_index));
    end loop;
    -- A search over no readable searchable key matches no row.
    predicates := pg_catalog.array_append(predicates, case
      when pg_catalog.cardinality(search_terms) = 0 then 'false'
      else '(' || pg_catalog.array_to_string(search_terms, ' or ') || ')' end);
  end if;

  return pg_catalog.jsonb_build_object(
    'predicate', case when pg_catalog.cardinality(predicates) = 0 then null
      else '(' || pg_catalog.array_to_string(predicates, ' and ') || ')' end,
    'parameters', filter_parameters
  );
end
$function$;

alter function vortex_record.compile_projection_predicate_internal(jsonb, jsonb, integer)
  owner to vortex_record_adapter;

revoke all on function vortex_record.compile_projection_predicate_internal(jsonb, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.compile_projection_predicate_internal(jsonb, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;

comment on function vortex_record.compile_projection_predicate_internal(jsonb, jsonb, integer) is
  'Compiles the one typed filter and search predicate a bounded system-projection reader applies inside its keyset scan over the reader''s own declared columns: the filter through the shared condition compiler, the search as a case-insensitive substring match over declared searchable keys, every value bound through one JSON parameter array; refuses an undeclared key with filter_field_not_declared and a predicate it cannot express exactly with predicate_unsupported; owner-only.';
