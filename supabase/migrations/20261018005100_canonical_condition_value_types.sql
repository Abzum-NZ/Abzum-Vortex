-- Use canonical value-type declarations throughout database-backed conditions.
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
          when 'number' then 'whole_number'
          when 'boolean' then 'yes_no'
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
    elsif left_type = 'whole_number' and right_type = 'decimal_number' then
      shared_type := 'decimal_number';
    elsif left_type = 'decimal_number' and right_type = 'whole_number' then
      shared_type := 'decimal_number';
    else
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
  elsif left_is_field then
    if left_type = 'whole_number' and right_type = 'decimal_number' then
      shared_type := 'decimal_number';
    else
      shared_type := left_type;
    end if;
  elsif right_is_field then
    if right_type = 'whole_number' and left_type = 'decimal_number' then
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
    'whole_number', 'decimal_number', 'money', 'date', 'date_time'
  ) then
    for i in 1..operand_count loop
      if not operand_is_fields[i]
        and operand_values[i] is not null
        and operand_values[i] <> 'null'::jsonb then
        if pg_catalog.jsonb_typeof(operand_values[i]) = 'array' then
          for member in
            select item.value from pg_catalog.jsonb_array_elements(operand_values[i]) as item(value)
          loop
            if shared_type = 'whole_number'
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
        elsif shared_type = 'whole_number'
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
      'text', 'whole_number', 'decimal_number', 'money', 'yes_no', 'date', 'date_time',
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
        when 'whole_number' then pg_catalog.format(
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
        when 'yes_no' then pg_catalog.format(
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
        when 'whole_number' then pg_catalog.format(
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
        when 'yes_no' then pg_catalog.format(
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
    if shared_type not in ('text', 'whole_number', 'decimal_number', 'date', 'date_time') then
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
      when 'whole_number' then pg_catalog.format(
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

alter function vortex_record.compile_query_filter_internal(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,integer,integer) owner to vortex_record_adapter;

revoke all on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.compile_query_filter_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer, integer
) is
  'Compiles one validated typed query condition into a candidate-scan predicate over catalogue columns, with every value bound through one JSON parameter array; the predicate admits every row the condition engine admits, and is marked exact only when it admits no other row; a subtree it cannot express adds no condition, so the per-row condition and read_record stay authoritative; owner-only.';

create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
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
  filter_condition jsonb;
  filter_exact boolean := false;
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
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
  failure_sqlstate text;
  failure_message text;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview installation): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_platform.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    -- A plan for a system projection is a live plan, in a preview too: see below.
    if preview_mode and not (prepared_plan ? 'preview')
      and prepared_plan -> 'recordType' ? 'systemProjection' then
      preview_mode := false;
    end if;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception
        -- A refused access context or a stale preview is the expected refusal; any
        -- other failure is logged with its cause before the same safe refusal.
        when sqlstate '42501' or sqlstate '40001' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        when others then
          get stacked diagnostics failure_sqlstate = returned_sqlstate,
            failure_message = message_text;
          raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
            failure_sqlstate, failure_message;
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') or resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      -- A system projection has no preview copy: it is the platform's live read model, which a
      -- preview reads on the live path, under the reader's own live access and never under the
      -- preview's roles.
      if resolved is null then
        resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
        if resolved -> 'recordType' ? 'systemProjection' then
          preview_mode := false;
        else
          resolved := null;
        end if;
      end if;
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview query): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  -- A preview reads its copy of the records with their stored totals and calculations; a system
  -- projection is read only through its protected reader, never from a preview.
  if preview_mode and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      -- A record type of a Module the previewed Application only uses is shared data: the preview
      -- takes the same read plan decision as the installed path, in the preview's registration,
      -- where that Module's own permissions follow the builder's live access. No eligible read
      -- alternative is the same refusal, never an empty preview table. A row the RLS policy does
      -- not show counts as used, so the decision is never skipped.
      if not exists (
        select 1
        from vortex_definition.roots as root
        where root.root_id = (resolved ->> 'recordTypeModuleRootId')::uuid
          and root.kind = 'module'
          and root.owner_application_root_id = context_application_root_id
      ) then
        begin
          select plan.* into access_plan
          from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
        exception
          -- A refused access context or a stale preview is the expected refusal; any
          -- other failure is logged with its cause before the same safe refusal.
          when sqlstate '42501' or sqlstate '40001' then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
          when others then
            get stacked diagnostics failure_sqlstate = returned_sqlstate,
              failure_message = message_text;
            raise warning 'Query preview preparation failed (read plan): SQLSTATE %, %',
              failure_sqlstate, failure_message;
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end;
        if access_plan.access_predicate is null then
          raise warning 'Query preview preparation failed (read plan): no access predicate';
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        if access_plan.access_predicate = 'false' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
        end if;
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb,
          'sharedRecordIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
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

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A planning failure propagates; it never widens the scan.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
      -- No eligible read alternative admits any record. Report a refusal before
      -- an empty scan can be mistaken for an empty query result.
      if access_plan.access_predicate = 'false' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', access_plan.access_predicate,
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[])),
          'sharedRecordIds', pg_catalog.to_jsonb(coalesce(access_plan.shared_record_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
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
        when field_kind = 'whole_number' then 'whole_number'
        when field_kind = 'yes_no' then 'yes_no'
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
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
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
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
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

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
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
      -- An incomplete compiled predicate remains a candidate narrowing step.
      filter_exact := filter_plan ->> 'predicate' is not null
        and (filter_plan ->> 'exact')::boolean is true;
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedExact', filter_exact,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  to vortex_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, refuses a preview of a used Module''s record type with read_forbidden when the same read plan decision admits no read alternative, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

reset role;
set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  scope_condition jsonb;
  field_entry jsonb;
  field_id text;
  field_kind text;
  result_kind text;
  semantic_type text;
  field_types jsonb := '{}'::jsonb;
  declared_fields jsonb;
  declaration jsonb;
  binding jsonb;
  parameter_key text;
  parameter_type text;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  declaration_keys text[] := array[]::text[];
  binding_keys text[] := array[]::text[];
  key_count integer;
  tree_depth integer;
  tree_operands integer;
  supplied_key text;
  supplied_value jsonb;
  contract_version text;
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
begin
  if p_record_scope is null or pg_catalog.jsonb_typeof(p_record_scope) is distinct from 'object'
    or p_saved_condition is null or pg_catalog.jsonb_typeof(p_saved_condition) is distinct from 'object'
    or p_source_record_type is null or pg_catalog.jsonb_typeof(p_source_record_type) is distinct from 'object'
    or p_field_values is null or pg_catalog.jsonb_typeof(p_field_values) is distinct from 'object'
    or p_current_organization_account_id is null
    or p_current_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  -- The evaluator selects semantics only from explicit trusted version
  -- evidence. Actual adapter facts below always carry the pinned version.
  contract_version := p_source_record_type ->> 'validationContractVersion';
  if not (p_source_record_type ? 'validationContractVersion')
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'validationContractVersion') is distinct from 'string'
    or contract_version <> all (vortex_definition.accepted_contract_version('record_type')) then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  scope_condition := p_record_scope -> 'savedCondition';
  if pg_catalog.jsonb_typeof(scope_condition) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(scope_condition);
  if key_count <> 4
    or pg_catalog.jsonb_typeof(scope_condition -> 'conditionId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(scope_condition ->> 'conditionId')
    or pg_catalog.jsonb_typeof(scope_condition -> 'publishedRevision') is distinct from 'number'
    or (scope_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
    or (scope_condition ->> 'publishedRevision')::numeric > 9007199254740991
    or pg_catalog.jsonb_typeof(scope_condition -> 'contractFingerprint') is distinct from 'string'
    or (scope_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(scope_condition -> 'parameterBindings') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  if pg_catalog.jsonb_typeof(p_saved_condition -> 'conditionId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(p_saved_condition ->> 'conditionId')
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'sourceRecordTypeId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(p_saved_condition ->> 'sourceRecordTypeId')
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'publishedRevision') is distinct from 'number'
    or (p_saved_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
    or (p_saved_condition ->> 'publishedRevision')::numeric > 9007199254740991
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'contractFingerprint') is distinct from 'string'
    or (p_saved_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'parameters') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'condition') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'declaredFieldIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'recordTypeId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(p_source_record_type ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'fields') is distinct from 'array'
    or scope_condition ->> 'conditionId' <> p_saved_condition ->> 'conditionId'
    or (scope_condition ->> 'publishedRevision')::numeric <> (p_saved_condition ->> 'publishedRevision')::numeric
    or scope_condition ->> 'contractFingerprint' <> p_saved_condition ->> 'contractFingerprint'
    or p_saved_condition ->> 'sourceRecordTypeId' <> p_source_record_type ->> 'recordTypeId' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  for field_entry in select value from pg_catalog.jsonb_array_elements(p_source_record_type -> 'fields') loop
    if pg_catalog.jsonb_typeof(field_entry) is distinct from 'object'
      or pg_catalog.jsonb_typeof(field_entry -> 'fieldId') is distinct from 'string'
      or not vortex_platform.is_non_nil_uuid(field_entry ->> 'fieldId')
      or pg_catalog.jsonb_typeof(field_entry -> 'type') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    field_id := field_entry ->> 'fieldId';
    field_kind := field_entry ->> 'type';
    if field_types ? field_id then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    semantic_type := case
      when field_kind = 'decimal_number' then 'decimal_number'
      when field_kind = 'money' then 'money'
      when field_kind = 'whole_number' then 'whole_number'
      when field_kind = 'yes_no' then 'yes_no'
      when field_kind = 'date' then 'date'
      when field_kind = 'date_time' then 'date_time'
      when field_kind = 'several_choices' then 'text_collection'
      when field_kind in ('table', 'attachment') then 'opaque_json'
      when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
      when field_kind = 'link_to_person' then 'organization_account_reference'
      when field_kind in ('calculation', 'total') then null
      when field_kind in (
        'text', 'long_text', 'formatted_text', 'choice', 'reference_number',
        'email_address', 'phone_number', 'web_address'
      ) then 'text'
      else null end;
    if field_kind in ('calculation', 'total') then
      result_kind := field_entry #>> '{settings,resultType}';
      semantic_type := case
        when result_kind = 'decimal_number' then 'decimal_number'
        when result_kind = 'money' then 'money'
        when result_kind = 'whole_number' then 'whole_number'
        when result_kind = 'yes_no' then 'yes_no'
        when result_kind = 'date' then 'date'
        when result_kind = 'date_time' then 'date_time'
        when result_kind in ('text', 'choice') then 'text'
        else null end;
    end if;
    if semantic_type is null then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    field_types := field_types || pg_catalog.jsonb_build_object(field_id, semantic_type);
  end loop;

  declared_fields := '{}'::jsonb;
  for field_entry in select value from pg_catalog.jsonb_array_elements(p_saved_condition -> 'declaredFieldIds') loop
    if pg_catalog.jsonb_typeof(field_entry) is distinct from 'string'
      or not (field_types ? (field_entry #>> '{}'))
      or declared_fields ? (field_entry #>> '{}') then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    declared_fields := declared_fields || pg_catalog.jsonb_build_object(field_entry #>> '{}', true);
  end loop;

  select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(p_field_values);
  if key_count <> pg_catalog.jsonb_array_length(p_saved_condition -> 'declaredFieldIds') then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  for supplied_key, supplied_value in select key, value from pg_catalog.jsonb_each(p_field_values) loop
    semantic_type := field_types ->> supplied_key;
    if not (declared_fields ? supplied_key)
      or not vortex_access.typed_condition_value_matches_internal(supplied_value, semantic_type, true)
      or (
        supplied_value <> 'null'::jsonb and semantic_type = 'decimal_number'
        and (
          pg_catalog.jsonb_typeof(supplied_value) <> 'string'
          or (supplied_value #>> '{}') !~ canonical_decimal
        )
      ) then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
  end loop;

  for declaration in select value from pg_catalog.jsonb_array_elements(p_saved_condition -> 'parameters') loop
    if pg_catalog.jsonb_typeof(declaration) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(declaration);
    parameter_key := declaration ->> 'key';
    parameter_type := declaration ->> 'type';
    if key_count <> 2
      or parameter_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or pg_catalog.length(parameter_key) > 40
      or parameter_type is null
      or not (
        parameter_type in (
          'text', 'whole_number', 'yes_no', 'date', 'date_time', 'organization_account_reference'
        )
        or parameter_type in ('decimal_number', 'money')
      )
      or parameter_types ? parameter_key then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(parameter_key, parameter_type);
    declaration_keys := pg_catalog.array_append(declaration_keys, parameter_key);
  end loop;

  for binding in select value from pg_catalog.jsonb_array_elements(scope_condition -> 'parameterBindings') loop
    if pg_catalog.jsonb_typeof(binding) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(binding);
    parameter_key := binding ->> 'key';
    parameter_type := parameter_types ->> parameter_key;
    if parameter_key is null or not (parameter_types ? parameter_key) or parameter_key = any(binding_keys) then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    if binding ->> 'source' = 'current_organization_account_id' then
      if key_count <> 2 or parameter_type not in ('text', 'organization_account_reference') then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_object(
        parameter_key, p_current_organization_account_id::text
      );
    elsif binding ->> 'source' = 'literal' then
      if key_count <> 3 or not (binding ? 'value')
        or not vortex_access.typed_condition_value_matches_internal(binding -> 'value', parameter_type, false)
        or (parameter_type = 'decimal_number' and (
          pg_catalog.jsonb_typeof(binding -> 'value') <> 'string'
          or (binding ->> 'value') !~ canonical_decimal
        )) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_object(parameter_key, binding -> 'value');
    else
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    binding_keys := pg_catalog.array_append(binding_keys, parameter_key);
  end loop;
  if pg_catalog.cardinality(declaration_keys) <> pg_catalog.cardinality(binding_keys)
    or exists (
      select 1 from pg_catalog.unnest(declaration_keys) as declared(key)
      where not (declared.key = any(binding_keys))
    ) then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  with recursive nodes(node, depth) as (
    select p_saved_condition -> 'condition', 1
    union all
    select children.child, nodes.depth + 1
    from nodes
    cross join lateral (
      select child.value as child
      from pg_catalog.jsonb_array_elements(case
        when nodes.node ->> 'kind' in ('all', 'any')
          and pg_catalog.jsonb_typeof(nodes.node -> 'conditions') = 'array'
          then nodes.node -> 'conditions' else '[]'::jsonb end) as child(value)
      union all
      select nodes.node -> 'condition'
      where nodes.node ->> 'kind' = 'not'
        and pg_catalog.jsonb_typeof(nodes.node -> 'condition') = 'object'
    ) as children
  )
  select pg_catalog.max(depth), pg_catalog.sum(case when node ->> 'kind' = 'comparison'
    then case when node ->> 'operator' in ('is_empty', 'is_not_empty') then 1 else 2 end else 0 end)::integer
  into tree_depth, tree_operands from nodes;
  if tree_depth > 10 or tree_operands > 100 then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  perform vortex_access.evaluate_typed_condition_node_internal(
    p_saved_condition -> 'condition', field_types, p_field_values,
    parameter_types, parameter_values, true
  );
  return vortex_access.evaluate_typed_condition_node_internal(
    p_saved_condition -> 'condition', field_types, p_field_values,
    parameter_types, parameter_values, false
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
end
$_$;

alter function vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) IS 'Owner-only pure predicate for one sealed permission saved condition over trusted versioned record values and a protected current organization account.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) FROM PUBLIC;

grant execute on function vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) to postgres;

CREATE FUNCTION vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  node_kind text;
  operator_value text;
  child jsonb;
  child_result boolean;
  combined_result boolean;
  operand_count integer;
  operand_entry jsonb;
  operand_source text;
  operand_key text;
  operand_types text[] := array[null::text, null::text];
  operand_values jsonb[] := array[null::jsonb, null::jsonb];
  operand_typed boolean[] := array[false, false];
  operand_literal boolean[] := array[false, false];
  shared_type text;
  expected_type text;
  collection_element_type text;
  candidate_type text;
  member jsonb;
  member_type text;
  collection_valid boolean;
  contains_value boolean;
  equal_value boolean;
  comparison_value integer;
  left_number double precision;
  right_number double precision;
  key_count integer;
  exact_compatible boolean;
begin
  if p_condition is null or pg_catalog.jsonb_typeof(p_condition) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  node_kind := p_condition ->> 'kind';

  if node_kind in ('all', 'any') then
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(p_condition);
    if key_count <> 2
      or pg_catalog.jsonb_typeof(p_condition -> 'conditions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_condition -> 'conditions') not between 1 and 50 then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    combined_result := node_kind = 'all';
    for child in select value from pg_catalog.jsonb_array_elements(p_condition -> 'conditions') loop
      child_result := vortex_access.evaluate_typed_condition_node_internal(
        child, p_field_types, p_field_values, p_parameter_types, p_parameter_values, p_validate_only
      );
      combined_result := case when node_kind = 'all'
        then combined_result and child_result else combined_result or child_result end;
    end loop;
    return case when p_validate_only then true else combined_result end;
  elsif node_kind = 'not' then
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(p_condition);
    if key_count <> 2
      or pg_catalog.jsonb_typeof(p_condition -> 'condition') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    child_result := vortex_access.evaluate_typed_condition_node_internal(
      p_condition -> 'condition', p_field_types, p_field_values,
      p_parameter_types, p_parameter_values, p_validate_only
    );
    return case when p_validate_only then true else not child_result end;
  elsif node_kind is distinct from 'comparison' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  operator_value := p_condition ->> 'operator';
  if operator_value is null or operator_value not in (
    'equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in',
    'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal',
    'is_empty', 'is_not_empty'
  ) then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  operand_count := case when operator_value in ('is_empty', 'is_not_empty') then 1 else 2 end;
  select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(p_condition);
  if key_count <> (case when operand_count = 1 then 3 else 4 end)
    or pg_catalog.jsonb_typeof(p_condition -> 'left') is distinct from 'object'
    or (operand_count = 1 and p_condition ? 'right')
    or (operand_count = 2 and pg_catalog.jsonb_typeof(p_condition -> 'right') is distinct from 'object') then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  for operand_index in 1..operand_count loop
    operand_entry := case when operand_index = 1 then p_condition -> 'left' else p_condition -> 'right' end;
    operand_source := operand_entry ->> 'source';
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(operand_entry);
    if operand_source = 'field' then
      operand_key := operand_entry ->> 'fieldId';
      if key_count <> 2 or operand_key is null or not (p_field_types ? operand_key)
        or not (p_field_values ? operand_key) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      operand_types[operand_index] := p_field_types ->> operand_key;
      operand_values[operand_index] := p_field_values -> operand_key;
      operand_typed[operand_index] := true;
    elsif operand_source = 'parameter' then
      operand_key := operand_entry ->> 'key';
      if key_count <> 2 or operand_key is null or not (p_parameter_types ? operand_key)
        or not (p_parameter_values ? operand_key) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      operand_types[operand_index] := p_parameter_types ->> operand_key;
      operand_values[operand_index] := p_parameter_values -> operand_key;
      operand_typed[operand_index] := true;
    elsif operand_source = 'value' then
      if key_count <> 2 or not (operand_entry ? 'value') then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      operand_values[operand_index] := operand_entry -> 'value';
      operand_literal[operand_index] := true;
      if operand_values[operand_index] <> 'null'::jsonb then
        case pg_catalog.jsonb_typeof(operand_values[operand_index])
          when 'number' then candidate_type := 'whole_number';
          when 'boolean' then candidate_type := 'yes_no';
          when 'string' then
            if vortex_access.typed_condition_temporal_value_internal(
              operand_values[operand_index] #>> '{}', 'date'
            ) is not null then candidate_type := 'date';
            elsif vortex_access.typed_condition_temporal_value_internal(
              operand_values[operand_index] #>> '{}', 'date_time'
            ) is not null then candidate_type := 'date_time';
            else candidate_type := 'text'; end if;
          when 'array' then
            if not exists (
              select 1 from pg_catalog.jsonb_array_elements(operand_values[operand_index]) as element(value)
              where pg_catalog.jsonb_typeof(element.value) is distinct from 'string'
            ) then candidate_type := 'text_collection'; else candidate_type := 'opaque_json'; end if;
          else candidate_type := 'opaque_json';
        end case;
        if not vortex_access.typed_condition_value_matches_internal(
          operand_values[operand_index], candidate_type, true
        ) then
          raise exception using errcode = '22023', message = 'Typed record condition is invalid';
        end if;
        operand_types[operand_index] := candidate_type;
      end if;
    else
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
  end loop;

  if operand_count = 1 then
    return case when p_validate_only then true
      when operator_value = 'is_empty' then operand_values[1] = 'null'::jsonb or operand_values[1] = '""'::jsonb
      else operand_values[1] <> 'null'::jsonb and operand_values[1] <> '""'::jsonb end;
  end if;

  if operand_typed[1] and operand_typed[2] then
    if operand_types[1] = operand_types[2] then shared_type := operand_types[1]; end if;
  elsif operand_typed[1] then
    if operand_literal[2] and vortex_access.typed_condition_value_matches_internal(
      operand_values[2], operand_types[1], true
    ) then shared_type := operand_types[1]; end if;
  elsif operand_typed[2] then
    if operand_literal[1] and vortex_access.typed_condition_value_matches_internal(
      operand_values[1], operand_types[2], true
    ) then shared_type := operand_types[2]; end if;
  elsif operand_values[1] = 'null'::jsonb and operand_values[2] = 'null'::jsonb then
    shared_type := 'opaque_json';
  elsif operand_values[1] = 'null'::jsonb then shared_type := operand_types[2];
  elsif operand_values[2] = 'null'::jsonb then shared_type := operand_types[1];
  elsif operand_types[1] = operand_types[2] then shared_type := operand_types[1];
  end if;

  -- V2 decimal operands may pair with whole JSON-number literals or legacy
  -- number parameters only when those values are integers, exactly as the
  -- TypeScript V2 evaluator lifts them into exact base ten.
  if shared_type is null
    and operand_types[1] in ('whole_number', 'decimal_number')
    and operand_types[2] in ('whole_number', 'decimal_number') then
    exact_compatible := true;
    for operand_index in 1..2 loop
      if operand_values[operand_index] <> 'null'::jsonb
        and not vortex_access.typed_condition_value_matches_internal(
          operand_values[operand_index], 'decimal_number', true
        ) then
        exact_compatible := false;
      end if;
    end loop;
    if exact_compatible then shared_type := 'decimal_number'; end if;
  end if;

  if operator_value in ('contains', 'not_contains', 'in', 'not_in') then
    if operator_value in ('contains', 'not_contains') then
      if vortex_access.typed_condition_value_matches_internal(operand_values[1], 'text', true)
        and vortex_access.typed_condition_value_matches_internal(operand_values[2], 'text', true)
        and (operand_types[1] is null or operand_types[1] = 'text')
        and (operand_types[2] is null or operand_types[2] = 'text') then
        collection_element_type := null;
      elsif operand_typed[1] and operand_types[1] = 'text_collection' then
        collection_element_type := 'text';
      elsif operand_literal[1] and pg_catalog.jsonb_typeof(operand_values[1]) = 'array' then
        expected_type := case when operand_typed[2] then operand_types[2] else null end;
        collection_valid := true;
        member_type := null;
        for member in select value from pg_catalog.jsonb_array_elements(operand_values[1]) loop
          if expected_type is not null then
            if expected_type in ('text_collection', 'opaque_json')
              or not vortex_access.typed_condition_value_matches_internal(member, expected_type, true) then
              collection_valid := false;
            else member_type := expected_type; end if;
          else
            candidate_type := case pg_catalog.jsonb_typeof(member)
              when 'number' then 'whole_number' when 'boolean' then 'yes_no'
              when 'string' then case
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date') is not null then 'date'
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time') is not null then 'date_time'
                else 'text' end else null end;
            if candidate_type is null or candidate_type in ('text_collection', 'opaque_json')
              or (member_type is not null and member_type <> candidate_type) then collection_valid := false;
            else member_type := candidate_type; end if;
          end if;
        end loop;
        if pg_catalog.jsonb_array_length(operand_values[1]) = 0 then
          member_type := case when expected_type not in ('text_collection', 'opaque_json') then expected_type else null end;
        end if;
        if collection_valid then collection_element_type := member_type; end if;
      end if;
      if ((collection_element_type is null and shared_type = 'text') or (
        collection_element_type is not null
        and vortex_access.typed_condition_value_matches_internal(operand_values[2], collection_element_type, true)
        and (not operand_typed[2] or operand_types[2] = collection_element_type)
      )) is not true then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
    else
      if operand_typed[2] and operand_types[2] = 'text_collection' then
        collection_element_type := 'text';
      elsif operand_literal[2] and pg_catalog.jsonb_typeof(operand_values[2]) = 'array' then
        expected_type := case when operand_typed[1] then operand_types[1] else null end;
        collection_valid := true;
        member_type := null;
        for member in select value from pg_catalog.jsonb_array_elements(operand_values[2]) loop
          if expected_type is not null then
            if expected_type in ('text_collection', 'opaque_json')
              or not vortex_access.typed_condition_value_matches_internal(member, expected_type, true) then
              collection_valid := false;
            else member_type := expected_type; end if;
          else
            candidate_type := case pg_catalog.jsonb_typeof(member)
              when 'number' then 'whole_number' when 'boolean' then 'yes_no'
              when 'string' then case
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date') is not null then 'date'
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time') is not null then 'date_time'
                else 'text' end else null end;
            if candidate_type is null or candidate_type in ('text_collection', 'opaque_json')
              or (member_type is not null and member_type <> candidate_type) then collection_valid := false;
            else member_type := candidate_type; end if;
          end if;
        end loop;
        if pg_catalog.jsonb_array_length(operand_values[2]) = 0 then
          member_type := case when expected_type not in ('text_collection', 'opaque_json') then expected_type else null end;
        end if;
        if collection_valid then collection_element_type := member_type; end if;
      end if;
      if collection_element_type is null
        or not vortex_access.typed_condition_value_matches_internal(operand_values[1], collection_element_type, true)
        or (operand_typed[1] and operand_types[1] <> collection_element_type) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
    end if;
  elsif operator_value in ('equals', 'not_equals') then
    if shared_type is null then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
  elsif shared_type is null
    or shared_type not in ('text', 'whole_number', 'decimal_number', 'money', 'date', 'date_time') then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  if shared_type = 'money'
    and operator_value in ('greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal')
    and operand_values[1] <> 'null'::jsonb and operand_values[2] <> 'null'::jsonb
    and operand_values[1] ->> 'currency' <> operand_values[2] ->> 'currency' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  if p_validate_only then return true; end if;

  if operator_value in ('equals', 'not_equals') then
    if operand_values[1] = 'null'::jsonb or operand_values[2] = 'null'::jsonb then
      equal_value := operand_values[1] = operand_values[2];
    elsif shared_type = 'whole_number' then
      equal_value := (operand_values[1] #>> '{}')::double precision
        = (operand_values[2] #>> '{}')::double precision;
    elsif shared_type = 'decimal_number' then
      equal_value := (operand_values[1] #>> '{}')::numeric = (operand_values[2] #>> '{}')::numeric;
    elsif shared_type = 'money' then
      equal_value := operand_values[1] ->> 'currency' = operand_values[2] ->> 'currency'
        and (operand_values[1] ->> 'amount')::numeric = (operand_values[2] ->> 'amount')::numeric;
    elsif shared_type = 'date_time' then
      equal_value := vortex_access.typed_condition_temporal_value_internal(
        operand_values[1] #>> '{}', 'date_time'
      ) = vortex_access.typed_condition_temporal_value_internal(
        operand_values[2] #>> '{}', 'date_time'
      );
    elsif shared_type in ('record_reference', 'organization_account_reference') then
      equal_value := pg_catalog.lower(operand_values[1] #>> '{}')
        = pg_catalog.lower(operand_values[2] #>> '{}');
    else equal_value := operand_values[1] = operand_values[2]; end if;
    return case when operator_value = 'equals' then equal_value else not equal_value end;
  end if;

  if operator_value in ('contains', 'not_contains', 'in', 'not_in') then
    contains_value := false;
    if operator_value in ('contains', 'not_contains') then
      if operand_values[1] <> 'null'::jsonb and operand_values[2] <> 'null'::jsonb then
        if shared_type = 'text' and pg_catalog.jsonb_typeof(operand_values[1]) = 'string' then
          contains_value := pg_catalog.strpos(operand_values[1] #>> '{}', operand_values[2] #>> '{}') > 0;
        elsif pg_catalog.jsonb_typeof(operand_values[1]) = 'array' then
          for member in select value from pg_catalog.jsonb_array_elements(operand_values[1]) loop
            if collection_element_type = 'whole_number' then
              equal_value := (member #>> '{}')::double precision = (operand_values[2] #>> '{}')::double precision;
            elsif collection_element_type = 'decimal_number' then
              equal_value := (member #>> '{}')::numeric = (operand_values[2] #>> '{}')::numeric;
            elsif collection_element_type = 'money' then
              equal_value := member ->> 'currency' = operand_values[2] ->> 'currency'
                and (member ->> 'amount')::numeric = (operand_values[2] ->> 'amount')::numeric;
            elsif collection_element_type = 'date_time' then
              equal_value := vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time')
                = vortex_access.typed_condition_temporal_value_internal(operand_values[2] #>> '{}', 'date_time');
            elsif collection_element_type in ('record_reference', 'organization_account_reference') then
              equal_value := pg_catalog.lower(member #>> '{}') = pg_catalog.lower(operand_values[2] #>> '{}');
            else equal_value := member = operand_values[2]; end if;
            contains_value := contains_value or (equal_value is true);
          end loop;
        end if;
      end if;
      return case when operator_value = 'contains' then contains_value else not contains_value end;
    end if;

    if operand_values[1] <> 'null'::jsonb and operand_values[2] <> 'null'::jsonb then
      for member in select value from pg_catalog.jsonb_array_elements(operand_values[2]) loop
        if collection_element_type = 'whole_number' then
          equal_value := (operand_values[1] #>> '{}')::double precision = (member #>> '{}')::double precision;
        elsif collection_element_type = 'decimal_number' then
          equal_value := (operand_values[1] #>> '{}')::numeric = (member #>> '{}')::numeric;
        elsif collection_element_type = 'money' then
          equal_value := operand_values[1] ->> 'currency' = member ->> 'currency'
            and (operand_values[1] ->> 'amount')::numeric = (member ->> 'amount')::numeric;
        elsif collection_element_type = 'date_time' then
          equal_value := vortex_access.typed_condition_temporal_value_internal(operand_values[1] #>> '{}', 'date_time')
            = vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time');
        elsif collection_element_type in ('record_reference', 'organization_account_reference') then
          equal_value := pg_catalog.lower(operand_values[1] #>> '{}') = pg_catalog.lower(member #>> '{}');
        else equal_value := operand_values[1] = member; end if;
        contains_value := contains_value or (equal_value is true);
      end loop;
    end if;
    return case when operator_value = 'in' then contains_value else not contains_value end;
  end if;

  if operand_values[1] = 'null'::jsonb or operand_values[2] = 'null'::jsonb then return false; end if;
  if shared_type = 'whole_number' then
    left_number := (operand_values[1] #>> '{}')::double precision;
    right_number := (operand_values[2] #>> '{}')::double precision;
    comparison_value := case when left_number < right_number then -1 when left_number > right_number then 1 else 0 end;
  elsif shared_type = 'decimal_number' then
    comparison_value := case
      when (operand_values[1] #>> '{}')::numeric < (operand_values[2] #>> '{}')::numeric then -1
      when (operand_values[1] #>> '{}')::numeric > (operand_values[2] #>> '{}')::numeric then 1 else 0 end;
  elsif shared_type = 'money' then
    comparison_value := case
      when (operand_values[1] ->> 'amount')::numeric < (operand_values[2] ->> 'amount')::numeric then -1
      when (operand_values[1] ->> 'amount')::numeric > (operand_values[2] ->> 'amount')::numeric then 1 else 0 end;
  elsif shared_type in ('date', 'date_time') then
    comparison_value := case
      when vortex_access.typed_condition_temporal_value_internal(operand_values[1] #>> '{}', shared_type)
        < vortex_access.typed_condition_temporal_value_internal(operand_values[2] #>> '{}', shared_type) then -1
      when vortex_access.typed_condition_temporal_value_internal(operand_values[1] #>> '{}', shared_type)
        > vortex_access.typed_condition_temporal_value_internal(operand_values[2] #>> '{}', shared_type) then 1 else 0 end;
  else
    comparison_value := case
      when (operand_values[1] #>> '{}') collate "C" < (operand_values[2] #>> '{}') collate "C" then -1
      when (operand_values[1] #>> '{}') collate "C" > (operand_values[2] #>> '{}') collate "C" then 1 else 0 end;
  end if;
  return case operator_value
    when 'greater_than' then comparison_value > 0
    when 'greater_than_or_equal' then comparison_value >= 0
    when 'less_than' then comparison_value < 0
    else comparison_value <= 0 end;
end
$$;

alter function vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) FROM PUBLIC;

grant execute on function vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.typed_condition_value_matches_internal(p_value jsonb, p_semantic_type text, p_nullable boolean) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
declare
  numeric_value numeric;
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
begin
  if p_semantic_type is null or p_semantic_type not in (
    'text', 'whole_number', 'decimal_number', 'money', 'yes_no', 'date', 'date_time',
    'text_collection', 'opaque_json', 'record_reference', 'organization_account_reference'
  ) then
    return false;
  end if;
  if p_value is null then
    return false;
  end if;
  if p_value = 'null'::jsonb then
    return p_nullable;
  end if;

  if p_semantic_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_semantic_type = 'whole_number' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    begin
      numeric_value := (p_value #>> '{}')::numeric;
    exception when numeric_value_out_of_range or invalid_text_representation then
      return false;
    end;
    return numeric_value = pg_catalog.trunc(numeric_value)
      and numeric_value between -9007199254740991 and 9007199254740991;
  elsif p_semantic_type = 'decimal_number' then
    -- Safe whole-number JSON literals can participate in an
    -- exact comparison. Trusted field values and explicit exact parameters are
    -- separately required to use canonical text by the outer evaluator.
    return (
      pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ canonical_decimal
    ) or (
      pg_catalog.jsonb_typeof(p_value) = 'number'
      and (p_value #>> '{}') ~ '^-?(?:0|[1-9][0-9]*)$'
      and (p_value #>> '{}')::numeric between -9007199254740991 and 9007199254740991
    );
  elsif p_semantic_type = 'money' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value ?& array['amount', 'currency']
      and not exists (
        select 1 from pg_catalog.jsonb_object_keys(p_value) as supplied(key)
        where supplied.key <> all (array['amount', 'currency'])
      )
      and pg_catalog.jsonb_typeof(p_value -> 'amount') = 'string'
      and (p_value ->> 'amount') ~ canonical_decimal
      and pg_catalog.jsonb_typeof(p_value -> 'currency') = 'string'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$';
  elsif p_semantic_type = 'yes_no' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_semantic_type = 'date' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_access.typed_condition_temporal_value_internal(p_value #>> '{}', 'date') is not null;
  elsif p_semantic_type = 'date_time' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_access.typed_condition_temporal_value_internal(p_value #>> '{}', 'date_time') is not null;
  elsif p_semantic_type = 'text_collection' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
      );
  elsif p_semantic_type in ('record_reference', 'organization_account_reference') then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_platform.is_non_nil_uuid(p_value #>> '{}');
  elsif p_semantic_type = 'opaque_json' then
    return true;
  end if;
  return false;
end
$_$;

alter function vortex_access.typed_condition_value_matches_internal(p_value jsonb, p_semantic_type text, p_nullable boolean) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.typed_condition_value_matches_internal(p_value jsonb, p_semantic_type text, p_nullable boolean) FROM PUBLIC;

grant execute on function vortex_access.typed_condition_value_matches_internal(p_value jsonb, p_semantic_type text, p_nullable boolean) to postgres;

reset role;
