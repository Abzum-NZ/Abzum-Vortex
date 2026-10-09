create or replace function vortex_access.evaluate_typed_condition_node_internal(
  p_condition jsonb,
  p_field_types jsonb,
  p_field_values jsonb,
  p_parameter_types jsonb,
  p_parameter_values jsonb,
  p_validate_only boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
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
          when 'number' then candidate_type := 'number';
          when 'boolean' then candidate_type := 'boolean';
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
    and operand_types[1] in ('number', 'decimal_number')
    and operand_types[2] in ('number', 'decimal_number') then
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
              when 'number' then 'number' when 'boolean' then 'boolean'
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
              when 'number' then 'number' when 'boolean' then 'boolean'
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
    or shared_type not in ('text', 'number', 'decimal_number', 'money', 'date', 'date_time') then
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
    elsif shared_type = 'number' then
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
            if collection_element_type = 'number' then
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
        if collection_element_type = 'number' then
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
  if shared_type = 'number' then
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
$function$;

comment on function vortex_access.evaluate_typed_condition_node_internal(jsonb,jsonb,jsonb,jsonb,jsonb,boolean) is null;

alter function vortex_access.evaluate_typed_condition_node_internal(jsonb,jsonb,jsonb,jsonb,jsonb,boolean) owner to postgres;

revoke execute on function vortex_access.evaluate_typed_condition_node_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.evaluate_typed_condition_node_internal(jsonb,jsonb,jsonb,jsonb,jsonb,boolean) to vortex_access_owner;
