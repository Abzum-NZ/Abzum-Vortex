-- Pure PostgreSQL parity for one sealed saved-condition restriction. The
-- functions in this migration read no authority state and remain owner-only;
-- a later protected record operation supplies the sealed evidence and the
-- verified current organization account.

create function vortex_access.typed_condition_temporal_value_internal(
  p_value text,
  p_kind text
)
returns bigint
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  parts text[];
  year_value integer;
  month_value integer;
  day_value integer;
  hour_value integer := 0;
  minute_value integer := 0;
  second_value integer := 0;
  fraction_value bigint := 0;
  offset_minutes integer := 0;
  leap_year boolean;
  maximum_day integer;
  month_offsets integer[] := array[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  day_ordinal bigint;
begin
  if p_kind = 'date' then
    parts := pg_catalog.regexp_match(p_value, '^([0-9]{4})-([0-9]{2})-([0-9]{2})$');
  elsif p_kind = 'date_time' then
    parts := pg_catalog.regexp_match(
      p_value,
      '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})([.]([0-9]{1,6}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$'
    );
  else
    return null;
  end if;

  if parts is null then
    return null;
  end if;

  year_value := parts[1]::integer;
  month_value := parts[2]::integer;
  day_value := parts[3]::integer;
  leap_year := year_value % 4 = 0 and (year_value % 100 <> 0 or year_value % 400 = 0);

  if month_value not between 1 and 12 then
    return null;
  end if;
  maximum_day := case month_value
    when 2 then case when leap_year then 29 else 28 end
    when 4 then 30
    when 6 then 30
    when 9 then 30
    when 11 then 30
    else 31
  end;
  if day_value not between 1 and maximum_day then
    return null;
  end if;

  day_ordinal := year_value::bigint * 365
    + (year_value + 3) / 4
    - (year_value + 99) / 100
    + (year_value + 399) / 400
    + month_offsets[month_value]
    + case when leap_year and month_value > 2 then 1 else 0 end
    + day_value - 1;

  if p_kind = 'date' then
    return day_ordinal;
  end if;

  hour_value := parts[4]::integer;
  minute_value := parts[5]::integer;
  second_value := parts[6]::integer;
  if hour_value > 23 or minute_value > 59 or second_value > 59 then
    return null;
  end if;
  if parts[8] is not null then
    fraction_value := pg_catalog.rpad(parts[8], 6, '0')::bigint;
  end if;
  if parts[9] <> 'Z' then
    if parts[11]::integer > 23 or parts[12]::integer > 59 then
      return null;
    end if;
    offset_minutes := (parts[11]::integer * 60 + parts[12]::integer)
      * case parts[10] when '+' then 1 else -1 end;
  end if;

  return day_ordinal * 86400000000::bigint
    + hour_value::bigint * 3600000000::bigint
    + minute_value::bigint * 60000000::bigint
    + second_value::bigint * 1000000::bigint
    + fraction_value
    - offset_minutes::bigint * 60000000::bigint;
end
$function$;

create function vortex_access.typed_condition_value_matches_internal(
  p_value jsonb,
  p_semantic_type text,
  p_nullable boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  numeric_value double precision;
begin
  if p_value is null then
    return false;
  end if;
  if p_value = 'null'::jsonb then
    return p_nullable;
  end if;

  if p_semantic_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_semantic_type = 'number' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    begin
      numeric_value := (p_value #>> '{}')::double precision;
    exception when numeric_value_out_of_range or invalid_text_representation then
      return false;
    end;
    return numeric_value::text not in ('Infinity', '-Infinity', 'NaN');
  elsif p_semantic_type = 'boolean' then
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
      and vortex_context.is_non_nil_uuid(p_value #>> '{}');
  elsif p_semantic_type = 'opaque_json' then
    return true;
  end if;
  return false;
end
$function$;

create function vortex_access.evaluate_typed_condition_node_internal(
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
      if node_kind = 'all' then
        combined_result := combined_result and child_result;
      else
        combined_result := combined_result or child_result;
      end if;
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
    or (
      operand_count = 2
      and pg_catalog.jsonb_typeof(p_condition -> 'right') is distinct from 'object'
    ) then
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
          when 'number' then
            candidate_type := 'number';
          when 'boolean' then
            candidate_type := 'boolean';
          when 'string' then
            if vortex_access.typed_condition_temporal_value_internal(
              operand_values[operand_index] #>> '{}', 'date'
            ) is not null then
              candidate_type := 'date';
            elsif vortex_access.typed_condition_temporal_value_internal(
              operand_values[operand_index] #>> '{}', 'date_time'
            ) is not null then
              candidate_type := 'date_time';
            else
              candidate_type := 'text';
            end if;
          when 'array' then
            if not exists (
              select 1 from pg_catalog.jsonb_array_elements(operand_values[operand_index]) as element(value)
              where pg_catalog.jsonb_typeof(element.value) is distinct from 'string'
            ) then
              candidate_type := 'text_collection';
            else
              candidate_type := 'opaque_json';
            end if;
          else
            candidate_type := 'opaque_json';
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
      else operand_values[1] <> 'null'::jsonb and operand_values[1] <> '""'::jsonb
    end;
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
  elsif operand_values[1] = 'null'::jsonb then
    shared_type := operand_types[2];
  elsif operand_values[2] = 'null'::jsonb then
    shared_type := operand_types[1];
  elsif operand_types[1] = operand_types[2] then
    shared_type := operand_types[1];
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
            else
              member_type := expected_type;
            end if;
          else
            candidate_type := case pg_catalog.jsonb_typeof(member)
              when 'number' then 'number'
              when 'boolean' then 'boolean'
              when 'string' then case
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date') is not null then 'date'
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time') is not null then 'date_time'
                else 'text'
              end
              else null
            end;
            if candidate_type is null or candidate_type in ('text_collection', 'opaque_json')
              or (member_type is not null and member_type <> candidate_type) then
              collection_valid := false;
            else
              member_type := candidate_type;
            end if;
          end if;
        end loop;
        if pg_catalog.jsonb_array_length(operand_values[1]) = 0 then
          member_type := case when expected_type not in ('text_collection', 'opaque_json') then expected_type else null end;
        end if;
        if collection_valid then collection_element_type := member_type; end if;
      end if;
      if (
        (collection_element_type is null and shared_type = 'text')
        or (
          collection_element_type is not null
          and vortex_access.typed_condition_value_matches_internal(
            operand_values[2], collection_element_type, true
          )
          and (not operand_typed[2] or operand_types[2] = collection_element_type)
        )
      ) is not true then
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
            else
              member_type := expected_type;
            end if;
          else
            candidate_type := case pg_catalog.jsonb_typeof(member)
              when 'number' then 'number'
              when 'boolean' then 'boolean'
              when 'string' then case
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date') is not null then 'date'
                when vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time') is not null then 'date_time'
                else 'text'
              end
              else null
            end;
            if candidate_type is null or candidate_type in ('text_collection', 'opaque_json')
              or (member_type is not null and member_type <> candidate_type) then
              collection_valid := false;
            else
              member_type := candidate_type;
            end if;
          end if;
        end loop;
        if pg_catalog.jsonb_array_length(operand_values[2]) = 0 then
          member_type := case when expected_type not in ('text_collection', 'opaque_json') then expected_type else null end;
        end if;
        if collection_valid then collection_element_type := member_type; end if;
      end if;
      if collection_element_type is null
        or not vortex_access.typed_condition_value_matches_internal(
          operand_values[1], collection_element_type, true
        )
        or (operand_typed[1] and operand_types[1] <> collection_element_type) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
    end if;
  elsif operator_value in ('equals', 'not_equals') then
    if shared_type is null then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
  elsif shared_type is null or shared_type not in ('text', 'number', 'date', 'date_time') then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  if p_validate_only then return true; end if;

  if operator_value in ('equals', 'not_equals') then
    if operand_values[1] = 'null'::jsonb or operand_values[2] = 'null'::jsonb then
      equal_value := operand_values[1] = operand_values[2];
    elsif shared_type = 'number' then
      equal_value := (operand_values[1] #>> '{}')::double precision
        = (operand_values[2] #>> '{}')::double precision;
    elsif shared_type = 'date_time' then
      equal_value := vortex_access.typed_condition_temporal_value_internal(
        operand_values[1] #>> '{}', 'date_time'
      ) = vortex_access.typed_condition_temporal_value_internal(
        operand_values[2] #>> '{}', 'date_time'
      );
    elsif shared_type in ('record_reference', 'organization_account_reference') then
      equal_value := pg_catalog.lower(operand_values[1] #>> '{}')
        = pg_catalog.lower(operand_values[2] #>> '{}');
    else
      equal_value := operand_values[1] = operand_values[2];
    end if;
    return case when operator_value = 'equals' then equal_value else not equal_value end;
  end if;

  if operator_value in ('contains', 'not_contains') then
    contains_value := false;
    if operand_values[1] <> 'null'::jsonb and operand_values[2] <> 'null'::jsonb then
      if shared_type = 'text' and pg_catalog.jsonb_typeof(operand_values[1]) = 'string' then
        contains_value := pg_catalog.strpos(
          operand_values[1] #>> '{}', operand_values[2] #>> '{}'
        ) > 0;
      elsif pg_catalog.jsonb_typeof(operand_values[1]) = 'array' then
        for member in select value from pg_catalog.jsonb_array_elements(operand_values[1]) loop
          if collection_element_type = 'number' then
            equal_value := (member #>> '{}')::double precision
              = (operand_values[2] #>> '{}')::double precision;
          elsif collection_element_type = 'date_time' then
            equal_value := vortex_access.typed_condition_temporal_value_internal(
              member #>> '{}', 'date_time'
            ) = vortex_access.typed_condition_temporal_value_internal(
              operand_values[2] #>> '{}', 'date_time'
            );
          elsif collection_element_type in ('record_reference', 'organization_account_reference') then
            equal_value := pg_catalog.lower(member #>> '{}')
              = pg_catalog.lower(operand_values[2] #>> '{}');
          else
            equal_value := member = operand_values[2];
          end if;
          contains_value := contains_value or equal_value;
        end loop;
      end if;
    end if;
    return case when operator_value = 'contains' then contains_value else not contains_value end;
  elsif operator_value in ('in', 'not_in') then
    contains_value := false;
    if operand_values[1] <> 'null'::jsonb and operand_values[2] <> 'null'::jsonb then
      for member in select value from pg_catalog.jsonb_array_elements(operand_values[2]) loop
        if collection_element_type = 'number' then
          equal_value := (operand_values[1] #>> '{}')::double precision
            = (member #>> '{}')::double precision;
        elsif collection_element_type = 'date_time' then
          equal_value := vortex_access.typed_condition_temporal_value_internal(
            operand_values[1] #>> '{}', 'date_time'
          ) = vortex_access.typed_condition_temporal_value_internal(member #>> '{}', 'date_time');
        elsif collection_element_type in ('record_reference', 'organization_account_reference') then
          equal_value := pg_catalog.lower(operand_values[1] #>> '{}')
            = pg_catalog.lower(member #>> '{}');
        else
          equal_value := operand_values[1] = member;
        end if;
        contains_value := contains_value or equal_value;
      end loop;
    end if;
    return case when operator_value = 'in' then contains_value else not contains_value end;
  end if;

  if operand_values[1] = 'null'::jsonb or operand_values[2] = 'null'::jsonb then
    return false;
  end if;
  if shared_type = 'number' then
    left_number := (operand_values[1] #>> '{}')::double precision;
    right_number := (operand_values[2] #>> '{}')::double precision;
    comparison_value := case when left_number < right_number then -1 when left_number > right_number then 1 else 0 end;
  elsif shared_type in ('date', 'date_time') then
    comparison_value := case
      when vortex_access.typed_condition_temporal_value_internal(
        operand_values[1] #>> '{}', shared_type
      ) < vortex_access.typed_condition_temporal_value_internal(
        operand_values[2] #>> '{}', shared_type
      ) then -1
      when vortex_access.typed_condition_temporal_value_internal(
        operand_values[1] #>> '{}', shared_type
      ) > vortex_access.typed_condition_temporal_value_internal(
        operand_values[2] #>> '{}', shared_type
      ) then 1
      else 0
    end;
  else
    comparison_value := case
      when (operand_values[1] #>> '{}') collate "C" < (operand_values[2] #>> '{}') collate "C" then -1
      when (operand_values[1] #>> '{}') collate "C" > (operand_values[2] #>> '{}') collate "C" then 1
      else 0
    end;
  end if;
  return case operator_value
    when 'greater_than' then comparison_value > 0
    when 'greater_than_or_equal' then comparison_value >= 0
    when 'less_than' then comparison_value < 0
    else comparison_value <= 0
  end;
end
$function$;

create function vortex_access.evaluate_permission_saved_condition(
  p_record_scope jsonb,
  p_saved_condition jsonb,
  p_source_record_type jsonb,
  p_field_values jsonb,
  p_current_organization_account_id uuid
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
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
  previous_binding_key text;
  key_count integer;
  tree_depth integer;
  tree_operands integer;
  supplied_key text;
  supplied_value jsonb;
begin
  if p_record_scope is null or pg_catalog.jsonb_typeof(p_record_scope) is distinct from 'object'
    or p_saved_condition is null or pg_catalog.jsonb_typeof(p_saved_condition) is distinct from 'object'
    or p_source_record_type is null
      or pg_catalog.jsonb_typeof(p_source_record_type) is distinct from 'object'
    or p_field_values is null or pg_catalog.jsonb_typeof(p_field_values) is distinct from 'object'
    or p_current_organization_account_id is null
    or p_current_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  scope_condition := p_record_scope -> 'savedCondition';
  if pg_catalog.jsonb_typeof(scope_condition) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;
  select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(scope_condition);
  if key_count <> 4
    or pg_catalog.jsonb_typeof(scope_condition -> 'conditionId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(scope_condition ->> 'conditionId')
    or pg_catalog.jsonb_typeof(scope_condition -> 'publishedRevision') is distinct from 'number'
    or (scope_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
    or (scope_condition ->> 'publishedRevision')::numeric > 9007199254740991
    or pg_catalog.jsonb_typeof(scope_condition -> 'contractFingerprint') is distinct from 'string'
    or (scope_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(scope_condition -> 'parameterBindings') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  if pg_catalog.jsonb_typeof(p_saved_condition -> 'conditionId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(p_saved_condition ->> 'conditionId')
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'sourceRecordTypeId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(p_saved_condition ->> 'sourceRecordTypeId')
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'publishedRevision') is distinct from 'number'
    or (p_saved_condition ->> 'publishedRevision') !~ '^[1-9][0-9]*$'
    or (p_saved_condition ->> 'publishedRevision')::numeric > 9007199254740991
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'contractFingerprint') is distinct from 'string'
    or (p_saved_condition ->> 'contractFingerprint') !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'parameters') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'condition') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_saved_condition -> 'declaredFieldIds') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'recordTypeId') is distinct from 'string'
    or not vortex_context.is_non_nil_uuid(p_source_record_type ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_source_record_type -> 'fields') is distinct from 'array'
    or scope_condition ->> 'conditionId' <> p_saved_condition ->> 'conditionId'
    or (scope_condition ->> 'publishedRevision')::numeric
      <> (p_saved_condition ->> 'publishedRevision')::numeric
    or scope_condition ->> 'contractFingerprint' <> p_saved_condition ->> 'contractFingerprint'
    or p_saved_condition ->> 'sourceRecordTypeId' <> p_source_record_type ->> 'recordTypeId' then
    raise exception using errcode = '22023', message = 'Typed record condition is invalid';
  end if;

  for field_entry in select value from pg_catalog.jsonb_array_elements(p_source_record_type -> 'fields') loop
    if pg_catalog.jsonb_typeof(field_entry) is distinct from 'object'
      or pg_catalog.jsonb_typeof(field_entry -> 'fieldId') is distinct from 'string'
      or not vortex_context.is_non_nil_uuid(field_entry ->> 'fieldId')
      or pg_catalog.jsonb_typeof(field_entry -> 'type') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    field_id := field_entry ->> 'fieldId';
    field_kind := field_entry ->> 'type';
    if field_types ? field_id then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    semantic_type := case
      when field_kind in ('whole_number', 'decimal_number', 'money') then 'number'
      when field_kind = 'yes_no' then 'boolean'
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
      else null
    end;
    if field_kind in ('calculation', 'total') then
      result_kind := field_entry #>> '{settings,resultType}';
      semantic_type := case
        when result_kind in ('whole_number', 'decimal_number', 'money') then 'number'
        when result_kind = 'yes_no' then 'boolean'
        when result_kind = 'date' then 'date'
        when result_kind = 'date_time' then 'date_time'
        when result_kind in ('text', 'choice') then 'text'
        else null
      end;
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
    if not (declared_fields ? supplied_key)
      or not vortex_access.typed_condition_value_matches_internal(
        supplied_value, field_types ->> supplied_key, true
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
      or parameter_type not in ('text', 'number', 'boolean', 'date', 'date_time')
      or parameter_types ? parameter_key then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(parameter_key, parameter_type);
    declaration_keys := pg_catalog.array_append(declaration_keys, parameter_key);
  end loop;

  previous_binding_key := null;
  for binding in select value from pg_catalog.jsonb_array_elements(scope_condition -> 'parameterBindings') loop
    if pg_catalog.jsonb_typeof(binding) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    select pg_catalog.count(*) into key_count from pg_catalog.jsonb_object_keys(binding);
    parameter_key := binding ->> 'key';
    if parameter_key is null
      or not (parameter_types ? parameter_key)
      or parameter_key = any(binding_keys)
      or (previous_binding_key is not null and previous_binding_key >= parameter_key) then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    if binding ->> 'source' = 'current_organization_account_id' then
      if key_count <> 2 or parameter_types ->> parameter_key <> 'text' then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_object(
        parameter_key, p_current_organization_account_id::text
      );
    elsif binding ->> 'source' = 'literal' then
      if key_count <> 3 or not (binding ? 'value')
        or not vortex_access.typed_condition_value_matches_internal(
          binding -> 'value', parameter_types ->> parameter_key, false
        ) then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      parameter_values := parameter_values || pg_catalog.jsonb_build_object(parameter_key, binding -> 'value');
    else
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    binding_keys := pg_catalog.array_append(binding_keys, parameter_key);
    previous_binding_key := parameter_key;
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
      from pg_catalog.jsonb_array_elements(
        case
          when nodes.node ->> 'kind' in ('all', 'any')
            and pg_catalog.jsonb_typeof(nodes.node -> 'conditions') = 'array'
            then nodes.node -> 'conditions'
          else '[]'::jsonb
        end
      ) as child(value)
      union all
      select nodes.node -> 'condition'
      where nodes.node ->> 'kind' = 'not'
        and pg_catalog.jsonb_typeof(nodes.node -> 'condition') = 'object'
    ) as children
  )
  select pg_catalog.max(depth), pg_catalog.sum(
    case when node ->> 'kind' = 'comparison'
      then case when node ->> 'operator' in ('is_empty', 'is_not_empty') then 1 else 2 end
      else 0
    end
  )::integer
  into tree_depth, tree_operands
  from nodes;
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
$function$;

revoke execute on function vortex_access.typed_condition_temporal_value_internal(text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.typed_condition_value_matches_internal(jsonb, text, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.evaluate_typed_condition_node_internal(
  jsonb, jsonb, jsonb, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function vortex_access.evaluate_permission_saved_condition(
  jsonb, jsonb, jsonb, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.evaluate_permission_saved_condition(
  jsonb, jsonb, jsonb, jsonb, uuid
) is
  'Owner-only pure predicate for one sealed permission saved condition over trusted record values and a protected current organization account.';
