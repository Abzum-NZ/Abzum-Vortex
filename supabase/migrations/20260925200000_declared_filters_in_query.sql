begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create or replace function vortex_record.compile_query_filter_internal(
  p_condition jsonb,
  p_field_types jsonb,
  p_field_columns jsonb,
  p_field_database_types jsonb,
  p_field_definitions jsonb,
  p_read_time_expressions jsonb,
  p_parameter_types jsonb,
  p_parameter_values jsonb,
  p_parameter_sql_parameter integer,
  p_parameter_offset integer
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  node_kind text;
  operator_value text;
  child_item jsonb;
  child_result jsonb;
  child_predicates text[] := array[]::text[];
  child_parameter_offset integer;
  parameter_values jsonb := '[]'::jsonb;
  operand_entry jsonb;
  operand_source text;
  operand_key text;
  operand_type text;
  operand_sql text;
  operand_is_field boolean;
  operand_parameter_index integer;
  operand_value jsonb;
  operand_is_array boolean;
  operand_types text[];
  operand_sqls text[];
  operand_is_fields boolean[];
  operand_parameter_indices integer[];
  operand_values jsonb[];
  operand_is_arrays boolean[];
  field_definition jsonb;
  field_sql text;
  field_database_type text;
  field_token text;
  operand_count integer;
  i integer;
  left_is_field boolean;
  right_is_field boolean;
  left_type text;
  right_type text;
  shared_type text;
  left_sql text;
  right_sql text;
  left_array_sql text;
  right_array_sql text;
  element_sql text;
  equality_sql text;
  contains_sql text;
  in_sql text;
  ordering_sql text;
  empty_sql text;
  predicate_sql text;
  operator_sql text;
begin
  if p_condition is null
    or pg_catalog.jsonb_typeof(p_condition) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_types) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_columns) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_database_types) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_field_definitions) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_read_time_expressions) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parameter_types) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parameter_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(parameter_values) is distinct from 'array'
    or p_parameter_sql_parameter is null
    or p_parameter_sql_parameter < 1
    or p_parameter_offset is null
    or p_parameter_offset < 0 then
    raise exception using errcode = '22023', message = 'Query filter is invalid';
  end if;

  node_kind := p_condition ->> 'kind';
  if node_kind in ('all', 'any') then
    if pg_catalog.jsonb_typeof(p_condition -> 'conditions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_condition -> 'conditions') not between 1 and 50 then
      raise exception using errcode = '22023', message = 'Query filter is invalid';
    end if;
    for child_item in
      select item.value from pg_catalog.jsonb_array_elements(p_condition -> 'conditions') as item(value)
    loop
      child_parameter_offset := p_parameter_offset + pg_catalog.jsonb_array_length(parameter_values);
      child_result := vortex_record.compile_query_filter_internal(
        child_item,
        p_field_types,
        p_field_columns,
        p_field_database_types,
        p_field_definitions,
        p_read_time_expressions,
        p_parameter_types,
        p_parameter_values,
        p_parameter_sql_parameter,
        child_parameter_offset
      );
      parameter_values := coalesce(child_result -> 'parameters', parameter_values);
      if child_result ->> 'predicate' is null then
        return pg_catalog.jsonb_build_object(
          'predicate', null,
          'parameters', parameter_values
        );
      end if;
      child_predicates := pg_catalog.array_append(child_predicates, child_result ->> 'predicate');
    end loop;
    return pg_catalog.jsonb_build_object(
      'predicate', '(' || pg_catalog.array_to_string(child_predicates,
        case when node_kind = 'all' then ' and ' else ' or ' end) || ')',
      'parameters', parameter_values
    );
  elsif node_kind = 'not' then
    if pg_catalog.jsonb_typeof(p_condition -> 'condition') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Query filter is invalid';
    end if;
    child_result := vortex_record.compile_query_filter_internal(
      p_condition -> 'condition',
      p_field_types,
      p_field_columns,
      p_field_database_types,
      p_field_definitions,
      p_read_time_expressions,
      p_parameter_types,
      p_parameter_values,
      p_parameter_sql_parameter,
      p_parameter_offset
    );
    if child_result ->> 'predicate' is null then
      return pg_catalog.jsonb_build_object(
        'predicate', null,
        'parameters', coalesce(child_result -> 'parameters', parameter_values)
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'predicate', '(not (' || child_result ->> 'predicate' || '))',
      'parameters', coalesce(child_result -> 'parameters', parameter_values)
    );
  elsif node_kind is distinct from 'comparison' then
    raise exception using errcode = '22023', message = 'Query filter is invalid';
  end if;

  operator_value := p_condition ->> 'operator';
  if operator_value is null or operator_value not in (
    'equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in',
    'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
    'is_empty', 'is_not_empty'
  ) then
    return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
  end if;

  operand_count := case when operator_value in ('is_empty', 'is_not_empty') then 1 else 2 end;
  if (operand_count = 1 and p_condition ? 'right')
    or (operand_count = 2 and pg_catalog.jsonb_typeof(p_condition -> 'right') is distinct from 'object')
    or pg_catalog.jsonb_typeof(p_condition -> 'left') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Query filter is invalid';
  end if;

  operand_types := array[]::text[];
  operand_sqls := array[]::text[];
  operand_is_fields := array[]::boolean[];
  operand_parameter_indices := array[]::integer[];
  operand_values := array[]::jsonb[];
  operand_is_arrays := array[]::boolean[];

  for i in 1..operand_count loop
    operand_entry := case when i = 1 then p_condition -> 'left' else p_condition -> 'right' end;
    operand_source := operand_entry ->> 'source';
    operand_is_field := false;
    operand_parameter_index := null;
    operand_value := null;
    operand_is_array := false;
    operand_type := null;
    operand_sql := null;

    if operand_source = 'field' then
      operand_key := pg_catalog.lower(operand_entry ->> 'fieldId');
      field_definition := p_field_definitions -> operand_key;
      if operand_key is null
        or not (p_field_types ? operand_key)
        or not (p_field_columns ? operand_key)
        or not (p_field_database_types ? operand_key)
        or field_definition is null
        or field_definition ->> 'filterable' is distinct from 'true' then
        raise exception using errcode = '22023', message = 'Query filter is invalid';
      end if;
      operand_type := p_field_types ->> operand_key;
      field_database_type := p_field_database_types ->> operand_key;
      field_token := p_field_columns ->> operand_key;
      if p_read_time_expressions ? operand_key then
        field_sql := p_read_time_expressions ->> operand_key;
        if field_sql is null or field_sql = '' then
          raise exception using errcode = '22023', message = 'Query filter is invalid';
        end if;
      else
        if field_token is null
          or field_token !~ '^f_[a-f0-9]{32}$'
          or field_database_type not in (
            'boolean', 'date', 'decimal', 'integer', 'json', 'text',
            'timestamp_with_time_zone', 'uuid'
          ) then
          raise exception using errcode = '22023', message = 'Query filter is invalid';
        end if;
        field_sql := pg_catalog.format('stored.%I', field_token);
        if operand_type = 'record_reference' then
          field_sql := pg_catalog.format('pg_catalog.lower(%s ->> ''recordId'')', field_sql);
        elsif operand_type = 'organization_account_reference' then
          field_sql := pg_catalog.format(
            'pg_catalog.lower(%s ->> ''organizationAccountId'')', field_sql
          );
        elsif operand_type = 'text' and field_database_type = 'json' then
          field_sql := pg_catalog.format('%s #>> ''{}''', field_sql);
        end if;
      end if;
      operand_sql := field_sql;
      operand_is_field := true;
      operand_is_array := operand_type = 'text_collection';
    elsif operand_source = 'parameter' then
      operand_key := operand_entry ->> 'key';
      if operand_key is null
        or not (p_parameter_types ? operand_key)
        or not (p_parameter_values ? operand_key) then
        raise exception using errcode = '22023', message = 'Query filter is invalid';
      end if;
      operand_type := p_parameter_types ->> operand_key;
      operand_value := p_parameter_values -> operand_key;
      parameter_values := parameter_values || pg_catalog.jsonb_build_array(operand_value);
      operand_parameter_index := pg_catalog.jsonb_array_length(parameter_values) - 1;
      operand_is_array := pg_catalog.jsonb_typeof(operand_value) = 'array';
    elsif operand_source = 'value' then
      if not (operand_entry ? 'value') then
        raise exception using errcode = '22023', message = 'Query filter is invalid';
      end if;
      operand_value := operand_entry -> 'value';
      if operand_value = 'null'::jsonb then
        operand_type := null;
      else
        operand_type := case pg_catalog.jsonb_typeof(operand_value)
          when 'number' then 'number'
          when 'boolean' then 'boolean'
          when 'string' then 'text'
          when 'array' then 'array'
          else 'opaque_json'
        end;
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_array(operand_value);
      operand_parameter_index := pg_catalog.jsonb_array_length(parameter_values) - 1;
      operand_is_array := pg_catalog.jsonb_typeof(operand_value) = 'array';
    else
      raise exception using errcode = '22023', message = 'Query filter is invalid';
    end if;

    operand_types := pg_catalog.array_append(operand_types, operand_type);
    operand_sqls := pg_catalog.array_append(operand_sqls, operand_sql);
    operand_is_fields := pg_catalog.array_append(operand_is_fields, operand_is_field);
    operand_parameter_indices := pg_catalog.array_append(
      operand_parameter_indices, operand_parameter_index
    );
    operand_values := pg_catalog.array_append(operand_values, operand_value);
    operand_is_arrays := pg_catalog.array_append(operand_is_arrays, operand_is_array);
  end loop;

  left_is_field := operand_is_fields[1];
  if operand_count = 1 then
    if not left_is_field then
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
    left_type := operand_types[1];
    if left_type = 'text' then
      empty_sql := pg_catalog.format(
        '(%s is null or %s = '''')',
        operand_sqls[1], operand_sqls[1]
      );
    elsif left_type = 'opaque_json' then
      empty_sql := pg_catalog.format(
        '(%s is null or %s = ''null''::jsonb or %s = ''""''::jsonb)',
        operand_sqls[1], operand_sqls[1], operand_sqls[1]
      );
    elsif left_type in ('money', 'text_collection') then
      empty_sql := pg_catalog.format(
        '(%s is null or %s = ''null''::jsonb)',
        operand_sqls[1], operand_sqls[1]
      );
    else
      empty_sql := pg_catalog.format('%s is null', operand_sqls[1]);
    end if;
    if operator_value = 'is_empty' then
      predicate_sql := empty_sql;
    else
      predicate_sql := '(not (' || empty_sql || '))';
    end if;
    return pg_catalog.jsonb_build_object(
      'predicate', '(' || predicate_sql || ')',
      'parameters', parameter_values
    );
  end if;

  right_is_field := operand_is_fields[2];
  left_type := operand_types[1];
  right_type := operand_types[2];

  if operator_value in ('contains', 'not_contains') then
    if left_is_field and left_type = 'text'
      and (right_type = 'text' or right_type is null) then
      shared_type := 'text';
    elsif left_is_field and left_type = 'text_collection'
      and (right_type = 'text' or right_type is null) then
      shared_type := 'text';
    else
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
  elsif operator_value in ('in', 'not_in') then
    if left_is_field and left_type not in ('text_collection', 'opaque_json', 'array') then
      shared_type := left_type;
    elsif right_is_field and right_type = 'text_collection'
      and left_type not in ('text_collection', 'opaque_json', 'array') then
      shared_type := left_type;
    else
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
    if right_is_field and right_type <> 'text_collection' then
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
  elsif left_is_field and right_is_field then
    if left_type = right_type then
      shared_type := left_type;
    elsif left_type = 'number' and right_type = 'decimal_number' then
      shared_type := 'decimal_number';
    elsif left_type = 'decimal_number' and right_type = 'number' then
      shared_type := 'decimal_number';
    else
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
  elsif left_is_field then
    if left_type = 'number' and right_type = 'decimal_number' then
      shared_type := 'decimal_number';
    else
      shared_type := left_type;
    end if;
  elsif right_is_field then
    if right_type = 'number' and left_type = 'decimal_number' then
      shared_type := 'decimal_number';
    else
      shared_type := right_type;
    end if;
  else
    return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
  end if;

  if shared_type is null then
    return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
  end if;

  if left_is_field then
    left_sql := operand_sqls[1];
    if left_type in ('money', 'text_collection', 'opaque_json') then
      left_sql := pg_catalog.format('coalesce(%s, ''null''::jsonb)', left_sql);
    end if;
    left_array_sql := case when left_type = 'text_collection' then left_sql else null end;
  else
    left_sql := case
      when shared_type in ('money', 'text_collection', 'opaque_json') then
        pg_catalog.format('($%s::jsonb -> %s)', p_parameter_sql_parameter,
          p_parameter_offset + operand_parameter_indices[1])
      else pg_catalog.format('($%s::jsonb #>> ''{%s}'')', p_parameter_sql_parameter,
        p_parameter_offset + operand_parameter_indices[1])
    end;
    left_array_sql := case when shared_type = 'text_collection' or operand_is_arrays[1]
      then pg_catalog.format('($%s::jsonb -> %s)', p_parameter_sql_parameter,
        p_parameter_offset + operand_parameter_indices[1])
      else null end;
  end if;
  if right_is_field then
    right_sql := operand_sqls[2];
    if right_type in ('money', 'text_collection', 'opaque_json') then
      right_sql := pg_catalog.format('coalesce(%s, ''null''::jsonb)', right_sql);
    end if;
    right_array_sql := case when right_type = 'text_collection' then right_sql else null end;
  else
    right_sql := case
      when shared_type in ('money', 'text_collection', 'opaque_json') then
        pg_catalog.format('($%s::jsonb -> %s)', p_parameter_sql_parameter,
          p_parameter_offset + operand_parameter_indices[2])
      else pg_catalog.format('($%s::jsonb #>> ''{%s}'')', p_parameter_sql_parameter,
        p_parameter_offset + operand_parameter_indices[2])
    end;
    right_array_sql := case when shared_type = 'text_collection' or operand_is_arrays[2]
      then pg_catalog.format('($%s::jsonb -> %s)', p_parameter_sql_parameter,
        p_parameter_offset + operand_parameter_indices[2])
      else null end;
  end if;

  if operator_value in ('equals', 'not_equals') then
    if shared_type not in (
      'text', 'number', 'decimal_number', 'money', 'boolean', 'date', 'date_time',
      'text_collection', 'opaque_json', 'record_reference', 'organization_account_reference', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
    if shared_type = 'money' then
      equality_sql := pg_catalog.format(
        '((%s is null or %s = ''null''::jsonb) and (%s is null or %s = ''null''::jsonb)) or (%s is not null and %s <> ''null''::jsonb and %s is not null and %s <> ''null''::jsonb and (%s ->> ''currency'') is not distinct from (%s ->> ''currency'') and (%s ->> ''amount'')::numeric is not distinct from (%s ->> ''amount'')::numeric)',
        left_sql, left_sql, right_sql, right_sql,
        left_sql, left_sql, right_sql, right_sql,
        left_sql, right_sql, left_sql, right_sql
      );
    else
      equality_sql := case shared_type
        when 'number' then pg_catalog.format(
          '(%s::double precision is not distinct from %s::double precision)', left_sql, right_sql
        )
        when 'decimal_number' then pg_catalog.format(
          '(%s::numeric is not distinct from %s::numeric)', left_sql, right_sql
        )
        when 'date' then pg_catalog.format(
          '(%s::date is not distinct from %s::date)', left_sql, right_sql
        )
        when 'date_time' then pg_catalog.format(
          '(%s::timestamp with time zone is not distinct from %s::timestamp with time zone)',
          left_sql, right_sql
        )
        when 'boolean' then pg_catalog.format(
          '(%s::boolean is not distinct from %s::boolean)', left_sql, right_sql
        )
        when 'uuid' then pg_catalog.format(
          '(%s::uuid is not distinct from %s::uuid)', left_sql, right_sql
        )
        when 'record_reference' then pg_catalog.format(
          '(lower(%s) is not distinct from lower(%s))', left_sql, right_sql
        )
        when 'organization_account_reference' then pg_catalog.format(
          '(lower(%s) is not distinct from lower(%s))', left_sql, right_sql
        )
        else pg_catalog.format('(%s is not distinct from %s)', left_sql, right_sql)
      end;
    end if;
    predicate_sql := case when operator_value = 'equals' then equality_sql
      else '(not (' || equality_sql || '))' end;
  elsif operator_value in ('contains', 'not_contains') then
    if left_type = 'text' then
      contains_sql := pg_catalog.format('pg_catalog.strpos(%s, %s) > 0', left_sql, right_sql);
    else
      contains_sql := pg_catalog.format(
        'exists (select 1 from pg_catalog.jsonb_array_elements(case when jsonb_typeof(%s) = ''array'' then %s else ''[]''::jsonb end) as item(value) where item.value is not null and item.value <> ''null''::jsonb and (item.value #>> ''{}'') = %s)',
        left_array_sql, left_array_sql, right_sql
      );
    end if;
    predicate_sql := case when operator_value = 'contains' then
      'coalesce(' || contains_sql || ', false)'
      else '(not (coalesce(' || contains_sql || ', false)))' end;
  elsif operator_value in ('in', 'not_in') then
    if shared_type = 'money' then
      element_sql := pg_catalog.format(
        '((%s is null or %s = ''null''::jsonb) and (item.value is null or item.value = ''null''::jsonb)) or (%s is not null and %s <> ''null''::jsonb and item.value is not null and item.value <> ''null''::jsonb and (%s ->> ''currency'') is not distinct from (item.value ->> ''currency'') and (%s ->> ''amount'')::numeric is not distinct from (item.value ->> ''amount'')::numeric)',
        left_sql, left_sql, left_sql, left_sql, left_sql, left_sql
      );
    else
      element_sql := case shared_type
        when 'number' then pg_catalog.format(
          '(%s::double precision is not distinct from (item.value #>> ''{}'')::double precision)', left_sql
        )
        when 'decimal_number' then pg_catalog.format(
          '(%s::numeric is not distinct from (item.value #>> ''{}'')::numeric)', left_sql
        )
        when 'date' then pg_catalog.format(
          '(%s::date is not distinct from (item.value #>> ''{}'')::date)', left_sql
        )
        when 'date_time' then pg_catalog.format(
          '(%s::timestamp with time zone is not distinct from (item.value #>> ''{}'')::timestamp with time zone)',
          left_sql
        )
        when 'boolean' then pg_catalog.format(
          '(%s::boolean is not distinct from (item.value #>> ''{}'')::boolean)', left_sql
        )
        when 'uuid' then pg_catalog.format(
          '(%s::uuid is not distinct from (item.value #>> ''{}'')::uuid)', left_sql
        )
        when 'record_reference' then pg_catalog.format(
          '(lower(%s) is not distinct from lower(item.value #>> ''{}''))', left_sql
        )
        when 'organization_account_reference' then pg_catalog.format(
          '(lower(%s) is not distinct from lower(item.value #>> ''{}''))', left_sql
        )
        else pg_catalog.format(
          '(%s is not distinct from (item.value #>> ''{}''))', left_sql
        )
      end;
    end if;
    in_sql := pg_catalog.format(
      'exists (select 1 from pg_catalog.jsonb_array_elements(case when jsonb_typeof(%s) = ''array'' then %s else ''[]''::jsonb end) as item(value) where item.value is not null and item.value <> ''null''::jsonb and %s)',
      right_array_sql, right_array_sql, element_sql
    );
    predicate_sql := case when operator_value = 'in' then in_sql
      else '(not (' || in_sql || '))' end;
  else
    if shared_type not in ('text', 'number', 'decimal_number', 'date', 'date_time') then
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
    operator_sql := case operator_value
      when 'greater_than' then '>'
      when 'greater_than_or_equal' then '>='
      when 'less_than' then '<'
      else '<='
    end;
    ordering_sql := case shared_type
      when 'text' then pg_catalog.format(
        '(%s collate "C" %s %s collate "C")', left_sql, operator_sql, right_sql
      )
      when 'number' then pg_catalog.format(
        '(%s::double precision %s %s::double precision)', left_sql, operator_sql, right_sql
      )
      when 'decimal_number' then pg_catalog.format(
        '(%s::numeric %s %s::numeric)', left_sql, operator_sql, right_sql
      )
      when 'date' then pg_catalog.format(
        '(%s::date %s %s::date)', left_sql, operator_sql, right_sql
      )
      when 'date_time' then pg_catalog.format(
        '(%s::timestamp with time zone %s %s::timestamp with time zone)',
        left_sql, operator_sql, right_sql
      )
    end;
    predicate_sql := 'coalesce(' || ordering_sql || ', false)';
  end if;

  return pg_catalog.jsonb_build_object(
    'predicate', '(' || predicate_sql || ')',
    'parameters', parameter_values
  );
end
$function$;

revoke all on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) to vortex_record_adapter;

comment on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) is
  'Compiles one validated typed query condition into a SQL predicate and bound parameter array; unsupported but valid subtrees return no predicate so the protected row check remains authoritative.';

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  field_kind text;
  semantic_type text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  sort_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  scan_sql text;
  access_plan record;
  access_terms text[] := array[]::text[];
  access_sql text;
  scan_record record;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  next_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;

  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.created_at), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.updated_at), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  -- The verified organisation and Application; never a caller value.
  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501', message = 'Query requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;

  resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;

  -- Grouped and totalled shapes are arrangements (#573); relationship hops have
  -- no declared path in this contract. Neither is run as plain rows.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;

  -- The installed physical table for this exact record type.
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
  if not found
    or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
    or catalogue_row.record_type_id <> record_type_id_value
    or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
    or catalogue_row.physical_schema_token <> 'record_data' then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the installed definition';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;

  -- Order: the published sort over orderable typed columns, then the record id.
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(query_item -> 'sort') as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = catalogue_row.storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(sort_ids) = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;

  -- Filter: the published condition tree over this record type's own fields.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      field_kind := fields_by_id -> field_key ->> 'type';
      if field_kind in ('calculation', 'total') then
        field_kind := fields_by_id -> field_key #>> '{settings,resultType}';
      end if;
      -- The exact (current Module contract) semantics of the saved-condition
      -- evaluator, so Query and database-backed conditions agree.
      semantic_type := case
        when field_kind = 'decimal_number' then 'decimal_number'
        when field_kind = 'money' then 'money'
        when field_kind = 'whole_number' then 'number'
        when field_kind = 'yes_no' then 'boolean'
        when field_kind = 'date' then 'date'
        when field_kind = 'date_time' then 'date_time'
        when field_kind = 'several_choices' then 'text_collection'
        when field_kind in ('table', 'attachment', 'formatted_text') then 'opaque_json'
        when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
        when field_kind = 'link_to_person' then 'organization_account_reference'
        when field_kind in (
          'text', 'long_text', 'choice', 'reference_number',
          'email_address', 'phone_number', 'web_address'
        ) then 'text'
        else null end;
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- The same canonical value text the record reader projects; references
      -- are compared by their identifier, as the condition engine defines.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when semantic_type = 'record_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''recordId''))',
              mapping_row.physical_column_token)
          when semantic_type = 'organization_account_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''organizationAccountId''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', stored.%I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs: exactly the declared keys, required ones present, references
  -- reduced to their identifier. Types are checked by the condition bridge.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and (input_item ->> 'required')::boolean then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'recordId'));
    elsif input_value <> 'null'::jsonb and input_item ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['organizationAccountId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'organizationAccountId') ~ uuid_pattern, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'organizationAccountId'));
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  filter_predicate := 'true';
  if filter_condition is not null then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        9,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The keyset position, which must fit this exact order.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'recordId']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;

  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when sort_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'pg_catalog.to_char(pg_catalog.timezone(''UTC'', %s), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'')',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);

    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false)', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix || 'stored.record_id > $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;

  -- Access routes with an exact table form narrow the candidate rows here so a
  -- reader limited to some records still gets full pages from a large table.
  -- This only removes rows the exact per-row decision below would refuse; every
  -- row the scan returns still goes through read_record, so it cannot widen a
  -- result. An unrestricted plan adds no condition.
  select plan.* into access_plan
  from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
  if access_plan.owner_account_id is not null then
    access_terms := pg_catalog.array_append(
      access_terms, 'stored.owner_organisation_account_id = $6');
  end if;
  if pg_catalog.cardinality(access_plan.owner_group_ids) > 0 then
    access_terms := pg_catalog.array_append(access_terms, 'stored.owner_group_id = any ($7)');
  end if;
  if pg_catalog.cardinality(access_plan.shared_record_ids) > 0 then
    access_terms := pg_catalog.array_append(access_terms, 'stored.record_id = any ($8)');
  end if;
  access_sql := case
    when not access_plan.restricted then 'true'
    when pg_catalog.cardinality(access_terms) = 0 then 'false'
    else pg_catalog.array_to_string(access_terms, ' or ')
  end;

  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and %s
       and (%s)
       and (%s)%s
     order by %s, stored.record_id asc
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    catalogue_row.physical_table_token,
    case when catalogue_row.storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    keyset_sql,
    pg_catalog.array_to_string(order_terms, ', ')
  );

  for scan_record in execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_plan.owner_account_id,
      access_plan.owner_group_ids, access_plan.shared_record_ids,
      filter_parameters
  loop
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;

    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    if filter_condition is null then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;

    if passes then
      projection := vortex_record.read_record(record_type_id_value, scan_record.record_id);
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ));
          row_count := row_count + 1;
          if pg_catalog.cardinality(system_field_keys) > 0 then
            rows_value := pg_catalog.jsonb_set(
              rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
            );
          end if;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;

    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;

  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'recordId', last_examined_record_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value
  );
end
$function$;


revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, with only the declared Record system values, or one refusal before any row is exposed; requires every filtered field to be declared filterable, pushes supported typed conditions into the candidate scan with bound values, narrows the scan to the caller''s owner, owner-group and direct-share records where those routes have an exact table form, and still decides every returned row through read_record; works out read-time fields, such as a deadline-passed calculation, inside the query at one statement timestamp in the organisation time zone, so no query is refused for freshness.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
