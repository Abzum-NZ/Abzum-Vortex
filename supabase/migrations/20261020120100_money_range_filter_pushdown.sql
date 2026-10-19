-- A money range filter is pushed into the candidate scan: it orders amounts of one currency only.
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
        if operand_type = 'text' and field_database_type = 'json' then
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
    elsif left_type in ('money', 'text_collection', 'record_reference') then
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
    if left_type in ('money', 'text_collection', 'opaque_json', 'record_reference') then
      left_sql := pg_catalog.format('coalesce(%s, ''null''::jsonb)', left_sql);
    end if;
    left_array_sql := case when left_type = 'text_collection' then left_sql else null end;
  else
    left_sql := case
      when shared_type in ('money', 'text_collection', 'opaque_json', 'record_reference') then
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
    if right_type in ('money', 'text_collection', 'opaque_json', 'record_reference') then
      right_sql := pg_catalog.format('coalesce(%s, ''null''::jsonb)', right_sql);
    end if;
    right_array_sql := case when right_type = 'text_collection' then right_sql else null end;
  else
    right_sql := case
      when shared_type in ('money', 'text_collection', 'opaque_json', 'record_reference') then
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
          '(pg_catalog.lower(%s::text) is not distinct from pg_catalog.lower(%s::text))', left_sql, right_sql
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
          '(pg_catalog.lower(%s::text) is not distinct from pg_catalog.lower(item.value::text))', left_sql
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
    if shared_type not in ('text', 'whole_number', 'decimal_number', 'money', 'date', 'date_time') then
      return pg_catalog.jsonb_build_object('predicate', null, 'parameters', parameter_values);
    end if;
    operator_sql := case operator_value
      when 'greater_than' then '>'
      when 'greater_than_or_equal' then '>='
      when 'less_than' then '<'
      else '<='
    end;
    -- A money range orders amounts of one currency only: a value in another
    -- currency (or none) is outside every range, never compared across currencies.
    ordering_sql := case shared_type
      when 'money' then pg_catalog.format(
        '((%s ->> ''currency'') = (%s ->> ''currency'') and (%s ->> ''amount'')::numeric %s (%s ->> ''amount'')::numeric)',
        left_sql, right_sql, left_sql, operator_sql, right_sql
      )
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

reset role;

-- Preserve the same currency boundary when a filter needs per-row evaluation.
set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.evaluate_typed_condition_node_internal(p_condition jsonb, p_field_types jsonb, p_field_values jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_validate_only boolean) RETURNS boolean
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
          when 'object' then
            candidate_type := case when vortex_access.typed_condition_value_matches_internal(
              operand_values[operand_index], 'record_reference', false
            ) then 'record_reference' else 'opaque_json' end;
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
                else 'text' end
              when 'object' then case when vortex_access.typed_condition_value_matches_internal(
                member, 'record_reference', false
              ) then 'record_reference' else null end else null end;
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
                else 'text' end
              when 'object' then case when vortex_access.typed_condition_value_matches_internal(
                member, 'record_reference', false
              ) then 'record_reference' else null end else null end;
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
    -- Ordering never crosses currencies. Keep candidate pushdown and row evaluation identical.
    return p_validate_only;
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

reset role;
