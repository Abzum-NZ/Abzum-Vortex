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
  all_exact boolean := true;
  parameter_values jsonb := '[]'::jsonb;
  operand_entry jsonb;
  operand_source text;
  operand_key text;
  operand_type text;
  operand_sql text;
  operand_is_field boolean;
  operand_parameter_index integer;
  operand_value jsonb;
  member jsonb;
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
  value_valid boolean := true;
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
      -- Each child numbers its own values from the next free position, and
      -- every value it bound is kept so later positions stay aligned.
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
      parameter_values := parameter_values || coalesce(child_result -> 'parameters', '[]'::jsonb);
      if child_result ->> 'predicate' is null then
        -- Every alternative of an "any" must be known to narrow it. Leaving a
        -- child out of an "all" only widens the candidates, so the others
        -- still apply, but the result is no longer exact.
        if node_kind = 'any' then
          return pg_catalog.jsonb_build_object(
            'predicate', null,
            'exact', false,
            'parameters', parameter_values
          );
        end if;
        all_exact := false;
        continue;
      end if;
      if (child_result ->> 'exact')::boolean is not true then
        all_exact := false;
      end if;
      child_predicates := pg_catalog.array_append(child_predicates, child_result ->> 'predicate');
    end loop;
    if pg_catalog.cardinality(child_predicates) = 0 then
      return pg_catalog.jsonb_build_object(
        'predicate', null,
        'exact', false,
        'parameters', parameter_values
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'predicate', '(' || pg_catalog.array_to_string(child_predicates,
        case when node_kind = 'all' then ' and ' else ' or ' end) || ')',
      'exact', all_exact,
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
    -- Negating a wider predicate would drop rows, so only an exact child is
    -- negated.
    if child_result ->> 'predicate' is null
      or (child_result ->> 'exact')::boolean is not true then
      return pg_catalog.jsonb_build_object(
        'predicate', null,
        'exact', false,
        'parameters', coalesce(child_result -> 'parameters', parameter_values)
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'predicate', '(not (' || (child_result ->> 'predicate') || '))',
      'exact', true,
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
      'exact', true,
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

  if shared_type in (
    'number', 'decimal_number', 'money', 'date', 'date_time'
  ) then
    for i in 1..operand_count loop
      if not operand_is_fields[i]
        and operand_values[i] is not null
        and operand_values[i] <> 'null'::jsonb then
        if pg_catalog.jsonb_typeof(operand_values[i]) = 'array' then
          for member in
            select item.value from pg_catalog.jsonb_array_elements(operand_values[i]) as item(value)
          loop
            if shared_type = 'number'
              and (pg_catalog.jsonb_typeof(member) <> 'number'
                or not pg_catalog.pg_input_is_valid(member #>> '{}', 'double precision')) then
              value_valid := false;
            elsif shared_type = 'decimal_number'
              and (pg_catalog.jsonb_typeof(member) not in ('number', 'string')
                or not pg_catalog.pg_input_is_valid(member #>> '{}', 'numeric')) then
              value_valid := false;
            elsif shared_type = 'money'
              and (pg_catalog.jsonb_typeof(member) <> 'object'
                or pg_catalog.jsonb_typeof(member -> 'amount') <> 'string'
                or not pg_catalog.pg_input_is_valid(member ->> 'amount', 'numeric')) then
              value_valid := false;
            elsif shared_type = 'date'
              and (pg_catalog.jsonb_typeof(member) <> 'string'
                or not pg_catalog.pg_input_is_valid(member #>> '{}', 'date')) then
              value_valid := false;
            elsif shared_type = 'date_time'
              and (pg_catalog.jsonb_typeof(member) <> 'string'
                or not pg_catalog.pg_input_is_valid(
                  member #>> '{}', 'timestamp with time zone'
                )) then
              value_valid := false;
            end if;
          end loop;
        elsif shared_type = 'number'
          and (pg_catalog.jsonb_typeof(operand_values[i]) <> 'number'
            or not pg_catalog.pg_input_is_valid(
              operand_values[i] #>> '{}', 'double precision'
            )) then
          value_valid := false;
        elsif shared_type = 'decimal_number'
          and (pg_catalog.jsonb_typeof(operand_values[i]) not in ('number', 'string')
            or not pg_catalog.pg_input_is_valid(
              operand_values[i] #>> '{}', 'numeric'
            )) then
          value_valid := false;
        elsif shared_type = 'money'
          and (pg_catalog.jsonb_typeof(operand_values[i]) <> 'object'
            or pg_catalog.jsonb_typeof(operand_values[i] -> 'amount') <> 'string'
            or not pg_catalog.pg_input_is_valid(
              operand_values[i] ->> 'amount', 'numeric'
            )) then
          value_valid := false;
        elsif shared_type = 'date'
          and (pg_catalog.jsonb_typeof(operand_values[i]) <> 'string'
            or not pg_catalog.pg_input_is_valid(
              operand_values[i] #>> '{}', 'date'
            )) then
          value_valid := false;
        elsif shared_type = 'date_time'
          and (pg_catalog.jsonb_typeof(operand_values[i]) <> 'string'
            or not pg_catalog.pg_input_is_valid(
              operand_values[i] #>> '{}', 'timestamp with time zone'
            )) then
          value_valid := false;
        end if;
      end if;
    end loop;
  end if;
  if not value_valid then
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
          '(pg_catalog.lower(%s) is not distinct from pg_catalog.lower(%s))', left_sql, right_sql
        )
        when 'organization_account_reference' then pg_catalog.format(
          '(pg_catalog.lower(%s) is not distinct from pg_catalog.lower(%s))', left_sql, right_sql
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
        'exists (select 1 from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(%s) = ''array'' then %s else ''[]''::jsonb end) as item(value) where item.value is not null and item.value <> ''null''::jsonb and (item.value #>> ''{}'') = %s)',
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
          '(pg_catalog.lower(%s) is not distinct from pg_catalog.lower(item.value #>> ''{}''))', left_sql
        )
        when 'organization_account_reference' then pg_catalog.format(
          '(pg_catalog.lower(%s) is not distinct from pg_catalog.lower(item.value #>> ''{}''))', left_sql
        )
        else pg_catalog.format(
          '(%s is not distinct from (item.value #>> ''{}''))', left_sql
        )
      end;
    end if;
    in_sql := pg_catalog.format(
      'exists (select 1 from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(%s) = ''array'' then %s else ''[]''::jsonb end) as item(value) where item.value is not null and item.value <> ''null''::jsonb and %s)',
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
    'exact', true,
    'parameters', parameter_values
  );
end
$function$;

revoke all on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) is
  'Compiles one validated typed query condition into a candidate-scan predicate over catalogue columns, with every value bound through one JSON parameter array; the predicate admits every row the condition engine admits, and is marked exact only when it admits no other row; a subtree it cannot express adds no condition, so the per-row condition and read_record stay authoritative; owner-only.';
