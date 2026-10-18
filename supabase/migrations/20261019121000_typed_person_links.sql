-- Person fields use ordinary typed record links. Data reset required.

set local role vortex_owner;

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
  elsif p_semantic_type = 'record_reference' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value ?& array['recordTypeId', 'recordId']
      and p_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
      and pg_catalog.jsonb_typeof(p_value -> 'recordTypeId') = 'string'
      and pg_catalog.jsonb_typeof(p_value -> 'recordId') = 'string'
      and vortex_platform.is_non_nil_uuid(p_value ->> 'recordTypeId')
      and vortex_platform.is_non_nil_uuid(p_value ->> 'recordId');
  elsif p_semantic_type = 'organization_account_reference' then
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


CREATE OR REPLACE FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
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
  account_record_type_id uuid;
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
          'text', 'whole_number', 'yes_no', 'date', 'date_time', 'organization_account_reference', 'record_reference'
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
      if key_count <> 2 or parameter_type not in ('text', 'organization_account_reference', 'record_reference') then
        raise exception using errcode = '22023', message = 'Typed record condition is invalid';
      end if;
      if parameter_type = 'record_reference' then
        -- The registered account projection is the current actor's record identity.
        -- Resolve it from protected platform metadata, never from the condition.
        if account_record_type_id is null then
          select distinct catalogue.record_type_id into strict account_record_type_id
          from vortex_record.storage_catalogue as catalogue
          where catalogue.physical_schema_token = 'system_projection'
            and catalogue.protected_read_model_key = 'organization_accounts'
            and catalogue.state = 'active';
        end if;
        parameter_values := parameter_values || pg_catalog.jsonb_build_object(
          parameter_key, pg_catalog.jsonb_build_object(
            'recordTypeId', account_record_type_id, 'recordId', p_current_organization_account_id
          )
        );
      else
        parameter_values := parameter_values || pg_catalog.jsonb_build_object(
          parameter_key, p_current_organization_account_id::text
        );
      end if;
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

COMMENT ON FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) IS 'Owner-only predicate for one sealed permission saved condition over trusted versioned record values and a protected current organization account.';

REVOKE ALL ON FUNCTION vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) FROM PUBLIC;

grant execute on function vortex_access.evaluate_permission_saved_condition(p_record_scope jsonb, p_saved_condition jsonb, p_source_record_type jsonb, p_field_values jsonb, p_current_organization_account_id uuid) to postgres;

set local role vortex_owner;

create or replace function vortex_access.list_organization_activity_entries_projection(
  p_record_ids uuid[],
  p_sort_key text,
  p_direction text,
  p_after jsonb,
  p_limit integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  actor_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean;
  person_record_type_id uuid;
  after_occurred_at timestamptz;
  after_record_id uuid;
  keyset_sql text := '';
  base_sql text;
  source_sql text;
  order_sql text;
  scan_sql text;
begin
  if p_sort_key <> 'occurred_at' or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Activity projection bounds are invalid';
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> 1
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) <> 'string'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end if;
    begin
      after_occurred_at := (p_after -> 'sortKey' ->> 0)::timestamptz;
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Activity projection cursor is invalid';
    end;
    keyset_sql := case when p_direction = 'descending'
      then ' and (entry.occurred_at, entry.activity_id) < ($6, $7)'
      else ' and (entry.occurred_at, entry.activity_id) > ($6, $7)' end;
  end if;
  begin
    checked_context := vortex_access.validated_human_request_context();
    visible_organization_id := (checked_context ->> 'organizationId')::uuid;
    actor_identity_id := (checked_context ->> 'identityId')::uuid;
    actor_account_id := (checked_context ->> 'organizationAccountId')::uuid;
    perform 1 from vortex_access.resolve_human_organization_scope(
      actor_identity_id, visible_organization_id
    );
  exception
    when insufficient_privilege or no_data_found then
      return;
  end;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.permissions.read'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = visible_organization_id
      and decision_account_id = actor_account_id,
    false
  );

  select distinct catalogue.record_type_id into strict person_record_type_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.physical_schema_token = 'system_projection'
    and catalogue.protected_read_model_key = 'organization_accounts'
    and catalogue.state = 'active';

  order_sql := pg_catalog.format(
    ' order by entry.occurred_at %s, entry.activity_id %s limit $8',
    case when p_direction = 'descending' then 'desc' else 'asc' end,
    case when p_direction = 'descending' then 'desc' else 'asc' end
  );
  base_sql := $scan$select entry.*
    from vortex_record.organization_activity_entries as entry
    where entry.organization_id = $1
      and entry.occurred_at >= pg_catalog.statement_timestamp() - interval '90 days'
      and ($2 is null or entry.activity_id = any($2))$scan$;
  if audit_projection then
    source_sql := base_sql || keyset_sql || order_sql;
  else
    source_sql := 'select visible.* from (('
      || base_sql
      || ' and entry.actor_kind = ''organization_account'' and entry.actor_id = $4'
      || keyset_sql || order_sql
      || ') union all ('
      || base_sql
      || ' and entry.actor_kind = ''identity'' and entry.actor_id = $5'
      || keyset_sql || order_sql
      || ')) as visible'
      || pg_catalog.format(' order by visible.occurred_at %s, visible.activity_id %s limit $8',
        case when p_direction = 'descending' then 'desc' else 'asc' end,
        case when p_direction = 'descending' then 'desc' else 'asc' end);
  end if;
  scan_sql := $scan$select
    entry.organization_id,
    entry.activity_id,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'organization_id', entry.organization_id::text,
      'revision', 1,
      'occurred_at', entry.occurred_at,
      'actor_kind', case entry.actor_kind
        when 'organization_account' then 'Person'
        when 'identity' then 'Platform operator'
        when 'system' then 'System'
        when 'public_session' then 'Public visitor'
        else 'Other' end,
      'actor', case when entry.actor_kind = 'organization_account'
        then pg_catalog.jsonb_build_object('recordTypeId', $9, 'recordId', entry.actor_id::text)
        else null end,
      'action', entry.action,
      'subject_count', pg_catalog.cardinality(entry.subject_ids),
      'changed_field_count', case when $3
        then pg_catalog.cardinality(entry.changed_field_ids) else null end
    )
  from ($scan$ || source_sql || $scan$) as entry$scan$
    || pg_catalog.format(' order by entry.occurred_at %s, entry.activity_id %s',
      case when p_direction = 'descending' then 'desc' else 'asc' end,
      case when p_direction = 'descending' then 'desc' else 'asc' end);
  return query execute scan_sql using visible_organization_id, p_record_ids,
    audit_projection, actor_account_id, actor_identity_id,
    after_occurred_at, after_record_id, p_limit, person_record_type_id;
end
$function$;

revoke all on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer
) to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_activity_entries_projection(
  uuid[], text, text, jsonb, integer
) owner to vortex_owner;

set local role vortex_record_adapter;

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  copy_plan jsonb;
  preview_installation jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_rows integer;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
  classification_value jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership', 'settings')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- A lifecycle command is the terminal delete, restore or ownership transfer.
  -- Delete and restore reach here only after their protected preflight has
  -- already run and claimed the record_lifecycle receipt; this operation owns
  -- the one terminal write and completes it. The request role reaches these
  -- branches only through apply_lifecycle_record_changes: a lifecycle command
  -- carries no submitted values, selected group or action, so the named-action
  -- entry can never reach a lifecycle write under an action identity.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
  end if;

  -- Settings use the same command entry and one settings mutation. Their
  -- physical row belongs to Identity, so the protected implementation below
  -- performs the specialised write and the common Record effects once.
  if p_operation = 'settings' then
    if p_action is not null
      or p_selected_group_id is not null
      or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or (p_mutations -> 0 ->> 'kind') is distinct from 'settings'
      or (p_mutations -> 0) - array['kind', 'values']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'values') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_settings_record_changes_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values,
      p_mutations -> 0 -> 'values', p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations, action_context
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed Rule the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
          );
          select item.value into root_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text);
          select item.value into root_snapshot
          from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
          where item.value ->> 'recordKey' = 'root';
          if root_type is null or root_snapshot is null then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
          for relationship_value, target_type in
            select item.value, target.value
            from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
            join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
              on vortex_record.relationship_declares_target_internal(
                item.value, (target.value ->> 'recordTypeId')::uuid
              )
            where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
            order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
          loop
            relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
            old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
            proposed_relationship_target := old_relationship_target;
            if p_submitted_values ? relationship_field_id then
              proposed_relationship_target := p_submitted_values -> relationship_field_id;
            end if;
            if not (
              (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
                pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
              or
              (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
                pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
            ) then
              continue;
            end if;
            for total_field in
              select field.value
              from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
              where field.value ->> 'type' = 'total'
                and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                  pg_catalog.lower(relationship_value ->> 'relationshipId')
            loop
              if p_submitted_values ? relationship_field_id and
                p_submitted_values -> relationship_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
              dependency_contract := vortex_record.total_dependency_contract_internal(
                catalogue -> 'recordTypes',
                pg_catalog.jsonb_build_array(relationship_value),
                (target_type ->> 'recordTypeId')::uuid, total_field
              );
              for dependency_field_id in
                select item.value
                from pg_catalog.jsonb_array_elements_text(
                  dependency_contract -> 'sourceFieldIds'
                ) item(value)
              loop
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
                    coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                  contributes_to_total := true;
                  exit;
                end if;
              end loop;
              exit when contributes_to_total;
            end loop;
            exit when contributes_to_total;
          end loop;
          if contributes_to_total then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
        end if;
      end if;

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
          preparation_value := null;
        else
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      else
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.lower(field.value ->> 'fieldId')
                order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
              )
              from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
              where field.value ->> 'type' in ('total', 'calculation')
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into expected_parents
        from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
              from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into supplied_parents
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs, action_context
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
      or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'completed'
    );
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
  else
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  classification_value := vortex_record.classify_record_change_values_internal(
    p_record_type_id, final_values, meta, p_submitted_values,
    organization_id_value, application_root_id_value, receipt_kind, effective_command_id
  );
  if classification_value ->> 'outcome' <> 'classified' then
    return classification_value;
  end if;
  relationship_changes := classification_value -> 'relationshipChanges';
  value_final_values := classification_value -> 'valueFinalValues';
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(classification_value -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
      );
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null, null::jsonb
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        -- Only a record of this application's own Module uses preview-owner authority.
        -- Borrowed records and live projections still need the builder's current permission.
        if preview_installation is not null
          and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
          and exists (
            select 1 from vortex_definition.roots as root
            where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
              and root.owner_application_root_id = application_root_id_value
          ) then
          target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
        else
          if pg_catalog.jsonb_array_length(
            target_loaded #> '{declaration,requiredPermissions}'
          ) = 0 then
            perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
            );
          end if;
          target_decision := vortex_access.evaluate_organization_record_access_internal(
            pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
              '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
          );
        end if;
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place replaces the per-writer #858 corrections.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    elsif not action_mode
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    elsif action_mode
      and p_operation = 'update'
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0
      and creation_count = 0
      and pg_catalog.jsonb_typeof(action_parents) = 'array'
      and pg_catalog.jsonb_array_length(action_parents) = 0
      and (case
        when copy_plan is null then true
        when pg_catalog.jsonb_typeof(copy_plan) = 'object'
          and copy_plan ->> 'outcome' = 'planned'
          and pg_catalog.jsonb_typeof(copy_plan -> 'copies') = 'array'
          then pg_catalog.jsonb_array_length(copy_plan -> 'copies') = 0
        else false
      end)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
        where task.value ->> 'type' = 'record.delete'
      ) then
      -- The named declaration and proposed graph already passed their protected
      -- decisions and target locks. Save one actual subject tuple before edges.
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
           definition_revision = $4
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number',
        loaded ->> 'table'
      ) into saved_record_id, saved_concurrency_number
      using organization_id_value, p_record_id, actor_id_value,
        (loaded ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
      get diagnostics changed_rows = row_count;
      if changed_rows <> 1 then
        raise exception using errcode = '40001',
          message = 'Named relationship change did not apply to exactly one row';
      end if;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named relationship saved identity is unavailable';
      end if;
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', saved_record_id,
        'concurrencyNumber', saved_concurrency_number
      );
      named_relationship_subject_saved := true;
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;
  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  perform vortex_platform.attach_record_files_internal(p_record_type_id, saved_record_id, meta -> 'recordType', final_values);
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_named_action_activity_internal(
      p_activity_id, saved_record_id, changed_field_ids, 'completed'
    );
  elsif preview_installation is null then
    activity_time := vortex_record.append_base_save_activity_internal(
      p_activity_id, p_operation, saved_record_id,
      changed_field_ids, 'completed'
    );
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_platform.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid,
      saved_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', p_record_type_id
        ),
        'payload', event_payload
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := vortex_record.read_record(p_record_type_id, saved_record_id);
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  return vortex_record.complete_named_action_changes_internal(
    action_owner_kind, action_owner_id, action_release_revision,
    action_id_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, result_value, subject_written,
    action_context, action_declared_occurrence_ids, creation_count,
    create_targets, action_creations, organization_id_value,
    action_creation_occurrence_ids, original_context_value, copy_plan,
    action_parents, preparation_value, named_action_receipt_pending,
    named_action_receipt_subject_write, effective_command_id, saved_record_id,
    saved_concurrency_number, application_root_id_value, correlation_id_value,
    named_relationship_subject_saved
  );
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one command receipt (a preview command carries its own preview-scoped id) and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

set local role vortex_record_adapter;

create or replace function vortex_record.canonical_record_value_matches(
  p_value jsonb,
  p_field_type text,
  p_database_value_type text
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  -- Canonical exact decimal text: no exponent, no leading zero, no trailing
  -- fractional zero, and no negative zero -- exactly what
  -- `normalizeExactDecimal` emits (contracts/src/exact-decimal.ts:49-72).
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
  uuid_pattern constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  nil_uuid_text constant text := '00000000-0000-0000-0000-000000000000';
  date_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  date_time_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  value_text text;
begin
  if p_value is null then
    return false;
  end if;
  -- A JSON null clears the column, whatever the declared type.
  if pg_catalog.jsonb_typeof(p_value) = 'null' then
    return true;
  end if;

  if p_field_type = 'money'
    or (p_field_type in ('calculation', 'total') and p_database_value_type = 'json') then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['amount', 'currency']::text[] = '{}'::jsonb
      and p_value ?& array['amount', 'currency']
      and pg_catalog.jsonb_typeof(p_value -> 'amount') = 'string'
      and (p_value ->> 'amount') ~ canonical_decimal
      and pg_catalog.jsonb_typeof(p_value -> 'currency') = 'string'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$';
  elsif p_field_type = 'several_choices' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
      );
  elsif p_field_type = 'attachment' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
          or (member.value #>> '{}') !~ uuid_pattern
          or pg_catalog.lower(member.value #>> '{}') = nil_uuid_text
      );
  elsif p_field_type = 'table' then
    return pg_catalog.jsonb_typeof(p_value) = 'array';
  elsif p_field_type = 'formatted_text' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and pg_catalog.jsonb_typeof(p_value -> 'blocks') = 'array';
  end if;

  -- Every remaining field type is decided by its storage type.
  if p_database_value_type = 'decimal' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ canonical_decimal;
  elsif p_database_value_type = 'integer' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    return value_text ~ '^-?(?:0|[1-9][0-9]*)$'
      and value_text::numeric between -9223372036854775808 and 9223372036854775807;
  elsif p_database_value_type = 'boolean' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_database_value_type = 'date' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    if value_text !~ date_pattern then
      return false;
    end if;
    begin
      perform value_text::date;
    exception when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation then
      return false;
    end;
    return true;
  elsif p_database_value_type = 'timestamp_with_time_zone' then
    -- The instant is stored; the offset it arrived with is not preserved, and
    -- the read codec returns UTC `Z`. The pattern requires an explicit offset,
    -- so the stored instant never depends on the session time zone.
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    if value_text !~ date_time_pattern then
      return false;
    end if;
    begin
      perform value_text::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation then
      return false;
    end;
    return true;
  elsif p_database_value_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_database_value_type = 'json' then
    return true;
  end if;
  return false;
end
$function$;

alter function vortex_record.canonical_record_value_matches(jsonb, text, text) owner to vortex_record_adapter;

revoke all on function vortex_record.canonical_record_value_matches(jsonb, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.canonical_record_value_matches(jsonb, text, text) is
  'Private pure check that one value is the canonical shape for its declared field type; never raises and decides no authority.';

grant execute on function vortex_record.canonical_record_value_matches(jsonb, text, text) to vortex_owner;

set local role vortex_record_adapter;

create or replace function vortex_record.classify_record_change_values_internal(
  p_record_type_id uuid,
  final_values jsonb,
  meta jsonb,
  p_submitted_values jsonb,
  organization_id_value uuid,
  application_root_id_value uuid,
  receipt_kind text,
  effective_command_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
begin
  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'classified',
    'relationshipChanges', relationship_changes,
    'valueFinalValues', value_final_values,
    'valueSubmittedFieldIds', pg_catalog.to_jsonb(value_submitted_field_ids)
  );
end
$function$;

alter function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid)
  to vortex_record_adapter;

comment on function vortex_record.classify_record_change_values_internal(uuid,jsonb,jsonb,jsonb,uuid,uuid,text,uuid) is
  'Private field classification step of apply_record_changes: validates installed fields, separates relationship mutations from fixed values, and preserves refusal receipt release before the subject write.';

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

set local role vortex_record_adapter;

create or replace function vortex_record.complete_named_action_changes_internal(
  action_owner_kind text,
  action_owner_id uuid,
  action_release_revision bigint,
  action_id_value uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  result_value jsonb,
  subject_written boolean,
  action_context jsonb,
  action_declared_occurrence_ids jsonb,
  creation_count integer,
  create_targets jsonb,
  action_creations jsonb,
  organization_id_value uuid,
  action_creation_occurrence_ids jsonb,
  original_context_value jsonb,
  copy_plan jsonb,
  action_parents jsonb,
  preparation_value jsonb,
  named_action_receipt_pending boolean,
  named_action_receipt_subject_write boolean,
  effective_command_id uuid,
  saved_record_id uuid,
  saved_concurrency_number bigint,
  application_root_id_value uuid,
  correlation_id_value uuid,
  named_relationship_subject_saved boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  event_loaded jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  public_created_records jsonb := '{}'::jsonb;
  created_record_tuples jsonb := '[]'::jsonb;
  first_created_record_tuples jsonb := '[]'::jsonb;
  inserted_value jsonb;
  final_created_tuple jsonb;
  saved_tuple jsonb;
  seen_created_ordinals integer[] := array[]::integer[];
  seen_created_ids uuid[] := array[]::uuid[];
  created_ordinal integer;
  created_concurrency_number bigint;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  loaded jsonb;
  target_record_id uuid;
  notice_sequence bigint;
  changed_field_ids uuid[];
  event_result jsonb;
begin
  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- Reauthorize the complete new graph before any created-row Activity or
    -- Event is visible. This barrier is intentionally whole-command, not per row.
    first_created_record_tuples :=
      vortex_record.authorize_created_records_for_command_internal(
        action_creations, created_records, original_context_value
      );
    if pg_catalog.jsonb_typeof(first_created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(first_created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;

    -- Append each created-row Activity and its standard Event only after the
    -- complete set passed ordinary CREATE authorization.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_typeof(event_result -> 0) is distinct from 'object'
        or event_result -> 0 ->> 'occurrenceId' is distinct from occurrence_id_value::text then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;

  if creation_count > 0 then
    -- Re-load and reauthorize the entire graph after every mandatory created-row,
    -- copy and parent effect. These actual final target tuples drive both receipt
    -- completion and the narrow advisory created-notice attempts below.
    created_record_tuples := vortex_record.authorize_created_records_for_command_internal(
      action_creations, created_records, original_context_value
    );
    if pg_catalog.jsonb_typeof(created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    for final_created_tuple in
      select item.value
      from pg_catalog.jsonb_array_elements(created_record_tuples) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(final_created_tuple) is distinct from 'object'
        or not (final_created_tuple ?& array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ])
        or final_created_tuple - array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ]::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'ordinal') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'ordinal', 'integer'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'concurrencyNumber') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'concurrencyNumber', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'organizationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'organizationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') not in ('string', 'null')
        or (pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') = 'string'
          and coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'applicationRootId', 'uuid'), true))
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleRootId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleRootId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordTypeId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordTypeId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageContractId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'storageContractId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleReleaseRevision') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageScope') is distinct from 'string'
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'correlationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'correlationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'eligible') is distinct from 'boolean' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is malformed';
      end if;
      created_ordinal := (final_created_tuple ->> 'ordinal')::integer;
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      if created_ordinal < 0
        or created_ordinal = any (seen_created_ordinals)
        or created_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or created_record_id = any (seen_created_ids)
        or created_concurrency_number not between 1 and 9007199254740991
        or (final_created_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or (final_created_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
        or (final_created_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
        or (final_created_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
        or ((final_created_tuple ->> 'storageScope') = 'application_contained'
          and (final_created_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
        or ((final_created_tuple ->> 'storageScope') = 'organization_shared'
          and final_created_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
        or (final_created_tuple ->> 'eligible')::boolean is distinct from
          ((final_created_tuple ->> 'storageScope') = 'application_contained') then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is invalid';
      end if;
      inserted_value := created_records -> created_ordinal::text;
      saved_tuple := inserted_value -> '_savedTuple';
      if inserted_value is null
        or final_created_tuple -> 'recordId' is distinct from inserted_value -> 'recordId'
        or final_created_tuple -> 'organizationId' is distinct from saved_tuple -> 'organizationId'
        or final_created_tuple -> 'applicationRootId' is distinct from saved_tuple -> 'applicationRootId'
        or final_created_tuple -> 'moduleRootId' is distinct from saved_tuple -> 'moduleRootId'
        or final_created_tuple -> 'recordTypeId' is distinct from saved_tuple -> 'recordTypeId'
        or final_created_tuple -> 'storageContractId' is distinct from saved_tuple -> 'storageContractId'
        or final_created_tuple -> 'moduleReleaseRevision' is distinct from saved_tuple -> 'moduleReleaseRevision'
        or final_created_tuple -> 'storageScope' is distinct from saved_tuple -> 'storageScope'
        or final_created_tuple -> 'correlationId' is distinct from saved_tuple -> 'correlationId'
        or final_created_tuple -> 'eligible' is distinct from saved_tuple -> 'eligible' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple changed';
      end if;
      seen_created_ordinals := pg_catalog.array_append(seen_created_ordinals, created_ordinal);
      seen_created_ids := pg_catalog.array_append(seen_created_ids, created_record_id);
      public_created_records := public_created_records || pg_catalog.jsonb_build_object(
        created_ordinal::text, pg_catalog.jsonb_build_object(
          'recordId', inserted_value -> 'recordId',
          'storageContractId', inserted_value -> 'storageContractId',
          'values', inserted_value -> 'values'
        )
      );
    end loop;
    if pg_catalog.cardinality(seen_created_ordinals) <> creation_count
      or pg_catalog.cardinality(seen_created_ids) <> creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation set is incomplete';
    end if;

    if not named_action_receipt_pending then
      raise exception using errcode = '55000',
        message = 'Named action receipt completion is unavailable';
    end if;
    if named_action_receipt_subject_write then
      if saved_record_id is null
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named action receipt completion tuple is unavailable';
      end if;
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, saved_record_id, saved_concurrency_number,
        'Record save receipt is stale'
      );
    else
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    end if;
    named_action_receipt_pending := false;
  end if;

  -- Only the new created-row notice attempt is advisory. All tuple and context
  -- validation above is outside this per-tuple catch; allocation, safe sequence
  -- validation and exact publication share one narrow failure boundary.
  for final_created_tuple in
    select item.value from pg_catalog.jsonb_array_elements(created_record_tuples) item(value)
  loop
    if (final_created_tuple ->> 'eligible')::boolean then
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Created Record notice sequence is unavailable';
        end if;
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value,
          (final_created_tuple ->> 'recordTypeId')::uuid,
          created_record_id, created_concurrency_number, 'created',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  if named_relationship_subject_saved then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        organization_id_value, application_root_id_value, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Invalidation is advisory after the protected named action is complete.
      null;
    end;
  end if;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', public_created_records);
end
$function$;

alter function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean)
  to vortex_record_adapter;

comment on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean) is
  'Private terminal step of apply_record_changes: preserves declared Events, ordered creations and edges, whole-graph authorization, parent effects, receipt completion and advisory notices in the caller transaction and restricted record role.';

set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_record.database_value_type(p_field jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case
    when p_field ->> 'type' in ('calculation', 'total') then
      case p_field #>> '{settings,resultType}'
        when 'whole_number' then 'integer'
        when 'decimal_number' then 'decimal'
        when 'yes_no' then 'boolean'
        when 'date' then 'date'
        when 'date_time' then 'timestamp_with_time_zone'
        when 'money' then 'json'
        when 'text' then 'text'
        else null
      end
    else case p_field ->> 'type'
    when 'whole_number' then 'integer'
    when 'decimal_number' then 'decimal'
    when 'yes_no' then 'boolean'
    when 'date' then 'date'
    when 'date_time' then 'timestamp_with_time_zone'
    when 'link' then 'json'
    when 'link_to_one_of_several' then 'json'
    when 'formatted_text' then 'json'
    when 'several_choices' then 'json'
    when 'table' then 'json'
    when 'money' then 'json'
    when 'attachment' then 'json'
    when 'text' then 'text'
    when 'long_text' then 'text'
    when 'reference_number' then 'text'
    when 'email_address' then 'text'
    when 'phone_number' then 'text'
    when 'web_address' then 'text'
    when 'choice' then 'text'
    else null
    end
  end
$$;
alter function vortex_record.database_value_type(jsonb) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.database_value_type(p_field jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vortex_record.database_value_type(p_field jsonb) TO vortex_record_adapter;

set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_record.enforce_relationship_edge_scope() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  relationship_value jsonb;
  source_row vortex_record.storage_catalogue%rowtype;
  target_row vortex_record.storage_catalogue%rowtype;
begin
  select catalogue.* into strict source_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.from_storage_contract_id;
  select catalogue.* into strict target_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = new.to_storage_contract_id;
  -- Each storage identity carries its declared record type, including an isolated preview.
  -- Validate the edge against that source's own relationship rather than an installed mapping
  -- of the same relationship identity that belongs to another storage contract.
  select relationship.value into strict relationship_value
  from pg_catalog.jsonb_array_elements(source_row.record_type_definition -> 'relationships')
    as relationship(value)
  where (relationship.value ->> 'relationshipId')::uuid = new.relationship_id;
  if not vortex_record.relationship_declares_target_internal(
      relationship_value, target_row.record_type_id
    )
    or (source_row.storage_scope = 'organization_shared') <> (new.from_application_root_id is null)
    or (target_row.storage_scope = 'organization_shared') <> (new.to_application_root_id is null)
    or (
      source_row.storage_scope = 'application_contained'
      and target_row.storage_scope = 'application_contained'
      and new.from_application_root_id <> new.to_application_root_id
    ) then
    raise exception using errcode = '23514', message = 'Relationship edge scope is invalid';
  end if;
  return new;
exception when no_data_found or too_many_rows then
  raise exception using errcode = '23514', message = 'Relationship edge mapping is unavailable';
end
$$;
alter function vortex_record.enforce_relationship_edge_scope() owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.enforce_relationship_edge_scope() FROM PUBLIC;

grant execute on function vortex_record.enforce_relationship_edge_scope() to vortex_owner, vortex_record_adapter;

set local role vortex_owner;

create or replace function vortex_record.group_member_selector_internal(
  p_group_member jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  group_selector_item jsonb;
  group_selector_value jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_key text;
  group_field_type text;
  group_value_valid boolean;
begin
  -- The closed, typed generic group selector; null when any part of it is malformed.
  if pg_catalog.jsonb_typeof(p_group_member) is distinct from 'object' then
    return null;
  end if;
  if p_group_member - array['values']::text[] <> '{}'::jsonb
    or not (p_group_member ? 'values')
    or pg_catalog.jsonb_typeof(p_group_member -> 'values') is distinct from 'array' then
    return null;
  end if;
  if pg_catalog.jsonb_array_length(p_group_member -> 'values') not between 1 and 10 then
    return null;
  end if;
  for group_selector_item in
    select item.value from pg_catalog.jsonb_array_elements(p_group_member -> 'values') as item(value)
  loop
    if pg_catalog.jsonb_typeof(group_selector_item) is distinct from 'object' then
      return null;
    end if;
    if group_selector_item - array['fieldId', 'fieldType', 'value']::text[] <> '{}'::jsonb
      or not (group_selector_item ? 'fieldId')
      or not (group_selector_item ? 'fieldType')
      or not (group_selector_item ? 'value')
      or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldId') is distinct from 'string'
      or pg_catalog.lower(group_selector_item ->> 'fieldId') !~ uuid_pattern
      or pg_catalog.lower(group_selector_item ->> 'fieldId') = '00000000-0000-0000-0000-000000000000'
      or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldType') is distinct from 'string'
      or group_selector_item ->> 'fieldType' not in (
        'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
        'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
        'link', 'link_to_one_of_several'
      ) then
      return null;
    end if;
    group_key := pg_catalog.lower(group_selector_item ->> 'fieldId');
    if group_selector_types ? group_key then
      return null;
    end if;
    group_field_type := group_selector_item ->> 'fieldType';
    group_selector_value := group_selector_item -> 'value';
    group_value_valid := group_selector_value = 'null'::jsonb;
    if not group_value_valid then
      case group_field_type
        when 'text', 'reference_number', 'email_address', 'phone_number', 'web_address' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string';
        when 'choice' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and pg_catalog.length(group_selector_value #>> '{}') between 1 and 120;
        when 'whole_number' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'number'
            and case when pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'numeric') then
              (group_selector_value #>> '{}')::numeric = pg_catalog.trunc((group_selector_value #>> '{}')::numeric)
              and pg_catalog.abs((group_selector_value #>> '{}')::numeric) <= 9007199254740991
            else false end;
        when 'decimal_number' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and group_selector_value #>> '{}' ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$';
        when 'yes_no' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'boolean';
        when 'date' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'date');
        when 'date_time' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
            and pg_catalog.substr(group_selector_value #>> '{}', 12, 2) between '00' and '23'
            and pg_catalog.substr(group_selector_value #>> '{}', 15, 2) between '00' and '59'
            and (pg_catalog.substr(group_selector_value #>> '{}', 17, 1) <> ':'
              or pg_catalog.substr(group_selector_value #>> '{}', 18, 2) between '00' and '59')
            and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'timestamp with time zone');
        when 'link', 'link_to_one_of_several' then
          group_value_valid := case when pg_catalog.jsonb_typeof(group_selector_value) = 'object' then
            group_selector_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
            and group_selector_value ? 'recordTypeId' and group_selector_value ? 'recordId'
            and pg_catalog.jsonb_typeof(group_selector_value -> 'recordTypeId') = 'string'
            and pg_catalog.lower(group_selector_value ->> 'recordTypeId') ~ uuid_pattern
            and pg_catalog.lower(group_selector_value ->> 'recordTypeId') <> '00000000-0000-0000-0000-000000000000'
            and pg_catalog.jsonb_typeof(group_selector_value -> 'recordId') = 'string'
            and pg_catalog.lower(group_selector_value ->> 'recordId') ~ uuid_pattern
            and pg_catalog.lower(group_selector_value ->> 'recordId') <> '00000000-0000-0000-0000-000000000000'
          else false end;
        else
          group_value_valid := false;
      end case;
    end if;
    if not group_value_valid then
      return null;
    end if;
    group_selector_types := group_selector_types || pg_catalog.jsonb_build_object(group_key, group_field_type);
    group_selector_values := group_selector_values || pg_catalog.jsonb_build_object(group_key, group_selector_value);
  end loop;
  return pg_catalog.jsonb_build_object('types', group_selector_types, 'values', group_selector_values);
end
$function$;

alter function vortex_record.group_member_selector_internal(jsonb)
  owner to vortex_owner;
revoke all on function vortex_record.group_member_selector_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.group_member_selector_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.group_member_selector_internal(jsonb) is
  'Owner-only parser of a generic group member selector: the typed grouping values keyed by lower-case field identity with their declared field types, or null when the selector is malformed.';

set local role vortex_record_adapter;

create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  shared_record_ids uuid[],
  readable_field_ids text[],
  access_predicate text,
  access_parameters jsonb
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_account_id uuid;
  plan jsonb;
  target_meta jsonb;
  declaration jsonb;
  field_bounds jsonb;
  ownership_mode text;
  access_routes record;
  alternative jsonb;
  route jsonb;
  route_terms text[];
  route_sql text;
  alternative_terms text[] := array[]::text[];
  condition_sql text;
  condition_entry jsonb;
  condition_params jsonb;
  condition_field_types jsonb;
  condition_field_columns jsonb;
  condition_field_database_types jsonb;
  condition_field_definitions jsonb;
  condition_parameter_types jsonb;
  condition_parameter_values jsonb;
  condition_referenced_ids text[];
  declared_condition_ids text[];
  field_item jsonb;
  declaration_item jsonb;
  binding_item jsonb;
  field_id text;
  field_kind text;
  semantic_type text;
  column_entry jsonb;
  database_value_type text;
  parameter_offset integer;
  supported boolean;
  compiled jsonb;
  readable_field_ids_value text[];
  access_parameters_accum jsonb := '[]'::jsonb;
  access_predicate_value text := 'true';
  access_parameters_value jsonb := '[]'::jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  -- Narrowing only. A refusal or unsupported condition named below leaves the
  -- scan less selective, so the exact per-row decision is still what decides
  -- what a caller reads. Any other failure propagates with its cause: it is
  -- never turned into an unrestricted scan.
  if p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  ownership_mode := target_meta ->> 'ownershipMode';

  -- The declaration the record loader builds for a read.
  declaration := vortex_record.record_type_read_declaration_internal(
    plan, p_record_type_id, context_application_root_id
  );
  if declaration is null then
    return query select false, null::uuid, array[]::uuid[], array[]::uuid[],
      array[]::text[], 'false'::text, '[]'::jsonb;
    return;
  end if;

  -- The owner, owner-group and direct-share routes the scan can narrow, and the
  -- eligible alternatives reduced to their route lists and saved-condition
  -- envelopes. A null alternative list means no narrowing is possible.
  select routes.* into access_routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, ownership_mode
  ) as routes;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits, after the field-read decision for produced fields. A
  -- refused access context yields no fields, so the scan pushes neither an
  -- order nor a filter on a value it cannot prove is visible; any other
  -- failure propagates.
  field_bounds := vortex_record.decide_record_type_read_bounds_internal(
    plan, p_record_type_id, '[]'::jsonb
  );

  -- Those fields may drive the scan only when every row the scan examines is a
  -- row the exact decision admits: an unconditioned all-records alternative
  -- admits every active record, and a restricted plan examines only owned and
  -- directly shared records, which its routes admit unless a saved condition
  -- narrows them. Otherwise the scan also examines rows the reader cannot read,
  -- whose every value is hidden, so no field is readable for the scan.
  readable_field_ids_value := case
    when (field_bounds -> 'coversAllRecords') = 'true'::jsonb
      or (access_routes.restricted and (field_bounds -> 'conditionFree') = 'true'::jsonb)
    then coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    )
    else array[]::text[]
  end;

  -- Access routes with an exact table form narrow the candidate rows here so a
  -- reader limited to some records still gets full pages from a large table.
  -- Every eligible alternative contributes one term: its route's exact stored
  -- predicate (or true when the route has no exact form) AND its saved
  -- condition compiled into the same scan. The terms are OR-ed deliberately:
  -- the exact decision admits a record through any one alternative, so the
  -- scan must keep every row any of them admits. The result only removes rows
  -- the exact per-row decision below would refuse; every row the scan returns
  -- still goes through read_record, so it cannot widen a result.
  if access_routes.alternatives is null
    or pg_catalog.jsonb_typeof(access_routes.alternatives) is distinct from 'array' then
    access_predicate_value := 'true';
  elsif pg_catalog.jsonb_array_length(access_routes.alternatives) = 0 then
    -- No eligible alternative admits any record.
    access_predicate_value := 'false';
  else
    for alternative in
      select item.value
      from pg_catalog.jsonb_array_elements(access_routes.alternatives) as item(value)
    loop
      route_terms := array[]::text[];
      for route in
        select item.value
        from pg_catalog.jsonb_array_elements(alternative -> 'routes') as item(value)
      loop
        case route ->> 'kind'
          when 'ownership' then
            if ownership_mode = 'organization_account' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_organisation_account_id = $6');
            elsif ownership_mode = 'group' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_group_id = any ($7)');
            else
              -- Inherited ownership is reached only by a current-edge chase.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            end if;
          when 'direct_share' then
            if access_routes.shared_record_ids is null then
              -- More current shares than one query carries: not narrowed.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            else
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.record_id = any ($8)');
            end if;
          else
            -- all_records admits every record; a relationship route is a
            -- current-edge chase. Neither has an exact stored predicate.
            route_terms := pg_catalog.array_append(route_terms, 'true');
        end case;
      end loop;

      if pg_catalog.cardinality(route_terms) = 0 then
        route_sql := 'false';
      elsif 'true' = any (route_terms) then
        route_sql := 'true';
      else
        route_sql := '(' || pg_catalog.array_to_string(route_terms, ' or ') || ')';
      end if;

      -- A saved condition narrows every route of its alternative, including an
      -- all-records route. It is compiled with the exact-semantics type map and
      -- the alternative's own bound parameters; anything the compiler cannot
      -- express exactly is left as true, so the per-row decision still decides.
      condition_sql := null;
      condition_params := '[]'::jsonb;
      if alternative ? 'savedCondition'
        and pg_catalog.jsonb_typeof(alternative -> 'savedCondition') = 'object' then
        condition_entry := null;
        select entry.value into condition_entry
        from pg_catalog.jsonb_array_elements(plan -> 'sharingConditions') as entry(value)
        where (entry.value ->> 'conditionId')
            = (alternative -> 'savedCondition' ->> 'conditionId')
          and (entry.value ->> 'publishedRevision')::numeric
            = (alternative -> 'savedCondition' ->> 'publishedRevision')::numeric
          and (entry.value ->> 'contractFingerprint')
            = (alternative -> 'savedCondition' ->> 'contractFingerprint')
          and pg_catalog.lower(entry.value ->> 'sourceRecordTypeId')
            = pg_catalog.lower(p_record_type_id::text)
        limit 1;

        if condition_entry is not null then
          condition_field_types := '{}'::jsonb;
          condition_field_columns := '{}'::jsonb;
          condition_field_database_types := '{}'::jsonb;
          condition_field_definitions := '{}'::jsonb;
          for field_item in
            select item.value
            from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as item(value)
          loop
            field_id := pg_catalog.lower(field_item ->> 'fieldId');
            column_entry := target_meta -> 'columns' -> field_id;
            if column_entry is not null then
              field_kind := field_item ->> 'type';
              -- The exact (current Module contract) semantics of the
              -- saved-condition evaluator: calculation and total fields have no
              -- fixed stored value here and stay out of the map.
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
                when field_kind in (
                  'text', 'long_text', 'formatted_text', 'choice', 'reference_number',
                  'email_address', 'phone_number', 'web_address'
                ) then 'text'
                else null end;
              if semantic_type is not null then
                condition_field_types := condition_field_types
                  || pg_catalog.jsonb_build_object(field_id, semantic_type);
                condition_field_columns := condition_field_columns
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'token');
                condition_field_database_types := condition_field_database_types
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'databaseValueType');
                condition_field_definitions := condition_field_definitions
                  || pg_catalog.jsonb_build_object(
                    field_id, pg_catalog.jsonb_build_object('filterable', true, 'type', field_kind));
              end if;
            end if;
          end loop;

          select coalesce(
            pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
          into condition_referenced_ids
          from pg_catalog.jsonb_path_query(
            condition_entry -> 'condition', 'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value);
          select coalesce(
            pg_catalog.array_agg(pg_catalog.lower(declared.value #>> '{}')), array[]::text[])
          into declared_condition_ids
          from pg_catalog.jsonb_array_elements(
            condition_entry -> 'declaredFieldIds'
          ) as declared(value);

          supported := true;
          foreach field_id in array condition_referenced_ids loop
            field_id := pg_catalog.lower(field_id);
            if not (condition_field_types ? field_id)
              or not (condition_field_columns ? field_id)
              or not (condition_field_database_types ? field_id)
              or not (field_id = any (declared_condition_ids)) then
              supported := false;
              exit;
            end if;
            semantic_type := condition_field_types ->> field_id;
            database_value_type := condition_field_database_types ->> field_id;
            if not (
              (semantic_type = 'yes_no' and database_value_type = 'boolean')
              or (semantic_type = 'text' and database_value_type in ('text', 'json'))
              or (semantic_type = 'text_collection' and database_value_type = 'json')
              or (semantic_type = 'opaque_json' and database_value_type = 'json')
              or (semantic_type = 'money' and database_value_type = 'json')
              or (semantic_type = 'decimal_number' and database_value_type = 'decimal')
              or (semantic_type = 'whole_number' and database_value_type = 'integer')
              or (semantic_type = 'date' and database_value_type = 'date')
              or (semantic_type = 'date_time' and database_value_type = 'timestamp_with_time_zone')
            ) then
              supported := false;
              exit;
            end if;
          end loop;

          if supported then
            condition_parameter_types := '{}'::jsonb;
            condition_parameter_values := '{}'::jsonb;
            for declaration_item in
              select item.value
              from pg_catalog.jsonb_array_elements(condition_entry -> 'parameters') as item(value)
            loop
              condition_parameter_types := condition_parameter_types
                || pg_catalog.jsonb_build_object(
                  declaration_item ->> 'key', declaration_item ->> 'type');
            end loop;
            for binding_item in
              select item.value
              from pg_catalog.jsonb_array_elements(
                alternative -> 'savedCondition' -> 'parameterBindings'
              ) as item(value)
            loop
              if binding_item ->> 'source' = 'current_organization_account_id' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', context_account_id::text);
              elsif binding_item ->> 'source' = 'literal' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', binding_item -> 'value');
              else
                supported := false;
                exit;
              end if;
            end loop;
          end if;

          if supported then
            parameter_offset := pg_catalog.jsonb_array_length(access_parameters_accum);
            begin
              compiled := vortex_record.compile_query_filter_internal(
                condition_entry -> 'condition',
                condition_field_types,
                condition_field_columns,
                condition_field_database_types,
                condition_field_definitions,
                '{}'::jsonb,
                condition_parameter_types,
                condition_parameter_values,
                10,
                parameter_offset
              );
              condition_sql := compiled ->> 'predicate';
              condition_params := coalesce(compiled -> 'parameters', '[]'::jsonb);
            exception
              -- 22023 is the compiler's refusal of a condition it cannot express
              -- exactly; the condition is then left as true. Any other failure
              -- propagates.
              when sqlstate '22023' then
                get stacked diagnostics failure_sqlstate = returned_sqlstate,
                  failure_message = message_text;
                raise warning 'Record read scan condition was not pushed: SQLSTATE %, %',
                  failure_sqlstate, failure_message;
                condition_sql := null;
                condition_params := '[]'::jsonb;
            end;
          end if;

          -- Keep every compiled parameter even when nothing was pushed, so the
          -- next alternative's offsets stay aligned with the JSON array passed
          -- to the scan.
          access_parameters_accum := access_parameters_accum || condition_params;
        end if;
      end if;

      if condition_sql is null then
        alternative_terms := pg_catalog.array_append(alternative_terms, route_sql);
      elsif route_sql = 'true' then
        alternative_terms := pg_catalog.array_append(alternative_terms, condition_sql);
      else
        alternative_terms := pg_catalog.array_append(
          alternative_terms, '(' || route_sql || ' and ' || condition_sql || ')');
      end if;
    end loop;

    if 'true' = any (alternative_terms) then
      access_predicate_value := 'true';
      access_parameters_value := '[]'::jsonb;
    else
      access_predicate_value := '('
        || pg_catalog.array_to_string(alternative_terms, ' or ') || ')';
      access_parameters_value := access_parameters_accum;
    end if;
  end if;

  return query select
    access_routes.restricted,
    access_routes.owner_account_id,
    access_routes.owner_group_ids,
    access_routes.shared_record_ids,
    readable_field_ids_value,
    access_predicate_value,
    access_parameters_value;
  return;
end
$function$;

alter function vortex_record.plan_record_read_scan_internal(uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.plan_record_read_scan_internal(uuid) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account, owner groups and directly shared record identifiers a caller can be admitted through, the fields every eligible read alternative is guaranteed to expose, kept only when every row the scan examines is one the exact decision admits, and one scan predicate that OR-s every eligible alternative''s exact route test with its saved condition compiled into the same scan; any route without an exact stored predicate or any condition the compiler cannot express as a superset is left unrestricted or true, so the per-row decision remains the only thing that decides access.';

set local role vortex_record_adapter;

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
      -- Keep the canonical typed link object, including its target record type.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
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

  -- Inputs retain their canonical values. The bridge validates declared types.
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

set local role vortex_record_adapter;

create or replace function vortex_record.preview_record_field_bounds_internal(
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_record_type jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
begin
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null or preview_value ->> 'outcome' = 'refused'
    or pg_catalog.jsonb_typeof(p_record_type) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text)
    or (p_record_type ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or p_record_type ? 'systemProjection' then
    return null;
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(preview_value -> 'storageIdentities')
      as binding(value)
    where (binding.value ->> 'previewStorageContractId')::uuid = p_storage_contract_id
      and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
  ) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    ), '[]'::jsonb),
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
      where field.value ->> 'type' not in (
        'calculation', 'total', 'reference_number', 'attachment'
      )
    ), '[]'::jsonb)
  );
end
$function$;
alter function vortex_record.preview_record_field_bounds_internal(uuid,uuid,jsonb) owner to vortex_record_adapter;


alter function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb) is
  'Field bounds for a record already proven to use the exact owner-only preview storage identity; generated and derived fields remain non-changeable.';

set local role vortex_owner;

create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  projection_expression_pair record;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  stored_projection_role text;
  requested_projection_role text;
  stored_database_type text;
  requested_database_type text;
  stored_sql_type text;
  requested_sql_type text;
  stored_expression jsonb;
  requested_expression jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  reader_sort_key_value text;
  field_columns_sql text;
  projection_view_sql text;
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  -- A Module may hold no record types yet; its release is provisioned with no storage.
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision;
    if result_storage_ids is distinct from coalesce((
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ), array[]::uuid[]) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The eight-sortable-field limit is a publish rule; an older release may declare more and
    -- simply gets an index per sortable field.
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    -- A system projection record type has no generated storage. It is read
    -- through one registered protected view, created here as an ordinary
    -- record_data relation so the fixed read adapters resolve it unchanged,
    -- while the projection itself keeps every row-visibility rule inside the
    -- registered function. The view exposes exactly the record type's declared
    -- fields as record-data columns, plus the protected row identity and
    -- revision, and is read-only: the projection has no ordinary write path.
    -- Every projection value is reset per record type, so a generated record
    -- type provisioned after a projection never inherits its protected key.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    reader_schema_value := null;
    reader_function_value := null;
    reader_sort_key_value := null;
    projection_view_sql := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      -- The view exhausts bounded pages in the reader's first registered cursor
      -- order. Filters on the view must see every candidate, not just page one.
      select registered.reader_schema, registered.reader_function,
        registered.cursor_sort_keys[1]
      into reader_schema_value, reader_function_value, reader_sort_key_value
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501',
          message = 'Protected projection view is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
      field_columns_sql := '';
      for field_value in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
        order by item.value ->> 'fieldId'
      loop
        begin
          field_id_value := (field_value ->> 'fieldId')::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '42501',
            message = 'Record field storage identity is invalid';
        end;
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        database_type := vortex_record.database_value_type(field_value);
        if database_type is null then
          raise exception using errcode = '23514',
            message = 'Record field storage type is unsupported';
        end if;
        sql_type := vortex_record.sql_value_type(database_type);
        if field_value ->> 'fieldId' = record_type #>> '{systemProjection,organizationFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.organization_id::text as %I, ', column_token);
        elsif field_value ->> 'fieldId' = record_type #>> '{systemProjection,revisionFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.revision::%s as %I, ', sql_type, column_token);
        elsif database_type = 'json' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values -> %L) as %I, ', field_value ->> 'key', column_token
            );
        else
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values ->> %L)::%s as %I, ',
              field_value ->> 'key', sql_type, column_token
            );
        end if;
      end loop;
      field_columns_sql := pg_catalog.left(
        field_columns_sql, pg_catalog.length(field_columns_sql) - 2
      );
      projection_view_sql := pg_catalog.format(
        'create view record_data.%I as
         with recursive projection_pages(rows) as (
           values (null::jsonb)
           union all
           select page.rows
           from projection_pages as previous
           cross join lateral (
             select coalesce(pg_catalog.jsonb_agg(
               pg_catalog.to_jsonb(projected) - ''ordinality'' order by projected.ordinality
             ), ''[]''::jsonb) as rows
             from %I.%I(null::uuid[], %L, ''ascending'',
               case when previous.rows is null then null else
                 pg_catalog.jsonb_build_object(
                   ''recordId'', previous.rows -> -1 ->> ''record_id'',
                   ''sortKey'', case when %L = ''record_id'' then ''[]''::jsonb
                     else pg_catalog.jsonb_build_array(
                       previous.rows -> -1 -> ''attribute_values'' -> %L
                     ) end
                 ) end, 40
             ) with ordinality as projected(
               organization_id, record_id, revision, attribute_values, ordinality
             )
           ) as page
           where previous.rows is null or pg_catalog.jsonb_array_length(previous.rows) = 40
         )
         select
           projection.organization_id as organisation_id,
           %L::uuid as module_root_id,
           %L::uuid as record_type_id,
           %L::uuid as storage_contract_id,
           projection.record_id,
           null::uuid as application_root_id,
           %L::bigint as definition_revision,
           null::uuid as owner_organisation_account_id,
           null::uuid as owner_group_id,
           ''active''::text as lifecycle_state,
           projection.revision as concurrency_number,
           null::timestamptz as created_at,
           null::uuid as created_by,
           null::timestamptz as updated_at,
           null::uuid as updated_by,
           null::timestamptz as deleted_at,
           null::uuid as deleted_by,
           null::timestamptz as removal_due_at,
           %s
         from projection_pages as page
         cross join lateral pg_catalog.jsonb_to_recordset(page.rows) as projection(
           organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
         )',
        table_token, reader_schema_value, reader_function_value, reader_sort_key_value,
        reader_sort_key_value, reader_sort_key_value,
        p_module_root_id, record_type_id_value, storage_id,
        p_module_release_revision, field_columns_sql
      );
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if is_projection then
        execute projection_view_sql;
        execute pg_catalog.format(
          'grant select on record_data.%I to vortex_record_adapter', table_token
        );
      else
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value, true
        );
      end if;

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, content_fingerprint, record_type_definition, protected_read_model_key
      ) values (
        storage_id,
        case when is_projection then 'system_projection' else 'record_data' end,
        table_token, p_module_root_id, record_type_id_value, storage_scope_value,
        p_module_release_revision, p_module_release_revision, 'active',
        shape_fingerprint, record_type, protected_view_key
      );
      any_change := true;
    else
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
        if pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition) is distinct from 'object'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'fields') is distinct from 'array'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'systemProjection') is distinct from 'object'
          or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object' then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;

        -- The catalogue keeps the newest compatible exact definition. Compare
        -- only shared field identities so an older subset and newer additions
        -- retain their existing release-order behavior. These descriptors
        -- mirror the source expressions assembled above, including the
        -- protected attribute key, JSON/text extraction, and cast.
        for projection_expression_pair in
          select requested_item.value as requested_field,
            stored_item.value as stored_field
          from pg_catalog.jsonb_array_elements(record_type -> 'fields') as requested_item(value)
          join pg_catalog.jsonb_array_elements(
            stored_catalogue.record_type_definition -> 'fields'
          ) as stored_item(value)
            on stored_item.value ->> 'fieldId' = requested_item.value ->> 'fieldId'
          order by requested_item.value ->> 'fieldId'
        loop
          stored_projection_role := case
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          requested_projection_role := case
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          stored_database_type := vortex_record.database_value_type(
            projection_expression_pair.stored_field
          );
          requested_database_type := vortex_record.database_value_type(
            projection_expression_pair.requested_field
          );
          if stored_projection_role is distinct from requested_projection_role
            or stored_database_type is null
            or requested_database_type is null then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
          stored_sql_type := vortex_record.sql_value_type(stored_database_type);
          requested_sql_type := vortex_record.sql_value_type(requested_database_type);
          stored_expression := case stored_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.revision',
              'cast', stored_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.stored_field ->> 'key',
              'extraction', case when stored_database_type = 'json' then '->' else '->>' end,
              'cast', case when stored_database_type = 'json' then null else stored_sql_type end
            )
          end;
          requested_expression := case requested_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.revision',
              'cast', requested_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.requested_field ->> 'key',
              'extraction', case when requested_database_type = 'json' then '->' else '->>' end,
              'cast', case when requested_database_type = 'json' then null else requested_sql_type end
            )
          end;
          if stored_expression is distinct from requested_expression then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
        end loop;

        -- The view always carries the newest compatible release's shape, as a
        -- generated table keeps every column a newer release added. Provisioning
        -- the newest release also refreshes its reader expression; an older
        -- release, which the field checks above prove is a compatible subset,
        -- leaves the newer view alone. The projection has no indexes or
        -- dependent objects.
        if p_module_release_revision >= stored_catalogue.last_compatible_release_revision then
          execute pg_catalog.format('drop view record_data.%I', table_token);
          execute projection_view_sql;
          execute pg_catalog.format(
            'grant select on record_data.%I to vortex_record_adapter', table_token
          );
          any_change := true;
        end if;
      else
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'record_data'
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if not is_projection then
          if stored_catalogue.storage_contract_id is not null
            and (field_value ->> 'required')::boolean then
            raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
          end if;
          execute pg_catalog.format(
            'alter table record_data.%I add column %I %s%s',
            table_token, column_token, sql_type,
            case when (field_value ->> 'required')::boolean then ' not null' else '' end
          );
        end if;
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        -- A projection field lives in the protected view, which carries no
        -- indexes; the projection's own protected function applies visibility,
        -- ordering and filtering, so no generated index is provisioned.
        if is_projection then
          null;
        elsif (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    -- Only a field this Module itself introduced can prove a removed field. A
    -- field another Module contributed keeps its retained lineage and never
    -- refuses this Module's own storage.
    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_by_module_root_id = p_module_root_id
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;


  select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[]) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_storage(uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves the generated record_data storage, or the read-only record_data view over one registered protected projection reader for a system projection record type, for one published Module release and records its immutable provision evidence.';

set local role vortex_record_adapter;

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb,
  p_direction text,
  p_exact_record_id uuid
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
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_source_sql text;
  scan_projection_sql text := 'null::jsonb';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_batch jsonb;
  projection_after jsonb; projection_batch_size integer;
  projection_candidate_count integer := 0; projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  page_first_loaded jsonb;
  -- What every row of the page shares, built once in this invocation: the
  -- validated active installation, the facts envelope and the read-time inputs.
  page_shared jsonb; page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  first_returned_sort_key text[];
  first_returned_record_id uuid;
  next_value jsonb := null;
  opposite_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  -- Every board column this call reads: one for a member page, every displayed
  -- column for a board's first pages, each read in its own pass below.
  board_columns_mode boolean := false;
  board_columns jsonb := '[]'::jsonb;
  board_column_item jsonb;
  board_column_position integer := 0;
  board_column_pages jsonb := '[]'::jsonb;
  -- The stored choice column, when the reader is guaranteed to see the choice
  -- field on every scanned row, and the current column's candidate predicate.
  board_choice_column text;
  board_scan_sql text := '';
  group_member jsonb;
  group_selector jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_field_type text;
  group_member_matches boolean;
  preview_mode boolean := false;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
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
  -- User-facing sort and search, plus the user filter passed to shared
  -- preparation. The component's declared field sets only narrow user input;
  -- they never supply authority or replace the published query contract.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  board_columns_mode := p_user_inputs ? 'boardColumns';
  group_member_mode := p_user_inputs ? 'groupMember';
  if (board_member_mode and group_member_mode)
    or (board_columns_mode and (board_member_mode or group_member_mode)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- A board's first pages: every requested column, each from its start.
  if board_columns_mode and (p_direction <> 'forward' or p_exact_record_id is not null
    or (p_after is not null and p_after <> 'null'::jsonb)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := board_member_mode or board_columns_mode;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'boardColumns', 'groupMember'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := vortex_record.group_member_selector_internal(p_user_inputs -> 'groupMember');
    if group_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := p_user_inputs #> '{groupMember,values}';
    group_selector_types := group_member -> 'types';
    group_selector_values := group_member -> 'values';
  end if;
  if board_member_mode then
    board_member := vortex_record.board_column_selector_internal(
      p_user_inputs -> case when board_columns_mode then 'boardColumns' else 'boardMember' end,
      board_columns_mode
    );
    if board_member is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := board_member ->> 'choiceFieldId';
    board_columns := board_member -> 'columns';
  end if;
  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);
  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);
  -- An exact record id resolves one identity; the search only narrows pages of a list, so it is
  -- ignored here while the published filter and the viewer's authority still apply unchanged.
  if p_exact_record_id is not null then
    user_search := null;
    user_search_folded := null;
  end if;
  if (board_member_mode or group_member_mode) and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    or user_search is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
    or (group_member_mode and p_user_inputs ? 'search'
      and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') is distinct from 'null')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if p_exact_record_id is not null and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;
  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    if pg_catalog.jsonb_array_length(query_item -> 'groupByFieldIds') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(query_item -> 'groupByFieldIds') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) is distinct from 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = '00000000-0000-0000-0000-000000000000' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_key := pg_catalog.lower(field_item #>> '{}');
      group_field_type := coalesce(fields_by_id -> group_key ->> 'type', '');
      if group_key = any (group_by_ids)
        or group_field_type not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_by_ids := pg_catalog.array_append(group_by_ids, group_key);
    end loop;
    if pg_catalog.jsonb_array_length(group_selector) <> pg_catalog.cardinality(group_by_ids)
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(group_selector_types) as supplied(key)
        where supplied.key <> all (group_by_ids)
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    foreach group_key in array group_by_ids loop
      if group_selector_types ->> group_key is distinct from fields_by_id -> group_key ->> 'type' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
    end loop;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;
  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(board_columns) as requested(value)
      where requested.value ->> 'kind' = 'option'
        and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    -- A column reads only its own cards. When the reader is guaranteed to see the
    -- choice field on every row the scan examines, the stored choice value is the
    -- readable value, so the column's membership narrows the candidate scan and the
    -- budget is spent on that column's members only. Otherwise the scan stays
    -- unnarrowed and membership is decided from each readable projection below, so
    -- a withheld value never decides which rows are examined.
    if board_choice_field_id = any (readable_field_ids) then
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = board_choice_field_id::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      if mapping_row.database_value_type = 'text' then
        board_choice_column := mapping_row.physical_column_token;
      end if;
    end if;
  end if;
  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if board_member_mode or group_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
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
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 0 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;
  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);
  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
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
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;
  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when p_direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when p_direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;
  scan_source_sql := pg_catalog.format('record_data.%I as stored', physical_table_token);
  projection_page_scan := not preview_mode and record_type_item ? 'systemProjection'
    and not board_member_mode and not group_member_mode
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and vortex_record.has_bounded_system_projection_reader_internal(
      v_storage_contract_id, fields_by_id -> sort_ids[1] ->> 'key'
    );
  if projection_page_scan then
      projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
      if projection_sort_key is null then
        raise exception using errcode = '55000',
          message = 'Protected projection sort field is unavailable';
      end if;
      projection_after := p_after;
      projection_batch_size := least(p_page_size, scan_limit);
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        null::uuid[], projection_sort_key, scan_directions[1], projection_after,
        projection_batch_size) with ordinality as projected(organization_id, record_id,
        revision, attribute_values, ordinality);
  end if;
  if projection_page_scan then
      -- The registered view contributes its row type only. The bounded reader
      -- supplies every candidate, including rows later rejected by the query.
      scan_source_sql := pg_catalog.format($source$
        pg_catalog.jsonb_to_recordset($11) as projection(
          organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
        )
        cross join lateral pg_catalog.jsonb_populate_record(
          null::record_data.%I,
          pg_catalog.jsonb_build_object(
            'organisation_id', projection.organization_id,
            'module_root_id', %L::uuid,
            'record_type_id', %L::uuid,
            'storage_contract_id', %L::uuid,
            'record_id', projection.record_id,
            'definition_revision', %L::bigint,
            'lifecycle_state', 'active',
            'concurrency_number', projection.revision
          ) || coalesce((
            select pg_catalog.jsonb_object_agg(
              'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
              case
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.organization_id::text)
                when field.value ->> 'fieldId' = %L
                  then pg_catalog.to_jsonb(projection.revision)
                else projection.attribute_values -> (field.value ->> 'key')
              end
            )
            from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
          ), '{}'::jsonb)
        ) as stored$source$,
        physical_table_token, p_module_root_id, record_type_id_value,
        v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
        record_type_item #>> '{systemProjection,organizationFieldId}',
        record_type_item #>> '{systemProjection,revisionFieldId}',
        record_type_item
      );
      scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;
  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
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
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;
  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;
  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  end if;
  -- One pass per requested board column, each with its own page, budget and
  -- position; every other read makes exactly one pass. The page's access facts,
  -- eligibility and validated record types stay those of this one invocation.
  <<column_pass>>
  loop
  if board_member_mode then
    board_column_position := board_column_position + 1;
    exit column_pass when board_column_position > pg_catalog.jsonb_array_length(board_columns);
    board_column_item := board_columns -> (board_column_position - 1);
    board_column_kind := board_column_item ->> 'kind';
    board_column_value := board_column_item ->> 'value';
    board_scan_sql := case
      when board_choice_column is null then ''
      when board_column_kind = 'option' then pg_catalog.format(
        ' and stored.%I collate "C" = $13 collate "C"', board_choice_column)
      else pg_catalog.format(
        ' and (stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
        board_choice_column)
    end;
    if board_column_position > 1 then
      examined := 0;
      budget_exhausted := false;
      more_rows := false;
      rows_value := '[]'::jsonb;
      row_count := 0;
      capability_rows := array[]::jsonb[];
      decided_ids := array[]::uuid[];
      decided_loaded := null;
      decided_decisions := null;
      decided_bounds := null;
      last_examined_sort_key := null;
      last_examined_record_id := null;
      last_returned_sort_key := null;
      last_returned_record_id := null;
      first_returned_sort_key := null;
      first_returned_record_id := null;
      next_value := null;
      opposite_value := null;
    end if;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12 is null or stored.record_id = $12)
       and %s
       and (%s)
        and (case when (%s) then true else false end)%s%s
     order by %s
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
    scan_projection_sql,
    scan_source_sql,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    board_scan_sql,
    segment_sql,
    order_by_sql
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters, projection_batch, p_exact_record_id,
      board_column_value, board_option_values;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
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
      page_access_loaded := null;
      if not preview_mode and not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        page_shared := pg_catalog.jsonb_build_object(
          'installation', vortex_definition.read_current_active_installation());
        page_access_loaded := vortex_record.load_record_access_facts_from_installation_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= p_page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        -- Filters decide membership, so every referenced value must be readable.
        -- Sorts only decide order: the scan already drops unguaranteed sort keys
        -- and ends with record identity. A withheld published sort field must
        -- neither remove a readable row nor expose its value through ordering.
        if not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, readable_values -> grouped.id)
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          if row_count = 0 then
            first_returned_sort_key := scan_record.sort_key;
            first_returned_record_id := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          row_count := row_count + 1;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or more_rows or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(p_page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, scan_directions[1], projection_after,
    projection_batch_size) with ordinality as projected(organization_id, record_id,
    revision, attribute_values, ordinality);
  end loop;
  exit when more_rows or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not more_rows then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows), page_shared -> 'envelope'
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
    ) then
      raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
    end if;
    -- Each row gets its own capabilities, in one pass over the page.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;
  if first_returned_record_id is not null then
    opposite_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(first_returned_sort_key),
      'phase', case when pg_catalog.cardinality(first_returned_sort_key) > 0
        and first_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', first_returned_record_id
    );
  end if;
  if p_direction = 'backward' and row_count > 1 then
    select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
    into rows_value
    from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
  end if;
  exit column_pass when not board_columns_mode;
  board_column_pages := board_column_pages || pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('column', board_column_item, 'rows', rows_value, 'next', next_value)
  );
  end loop column_pass;
  if board_columns_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'columns', board_column_pages
    );
  end if;
  if group_member_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
      'groupValues', group_selector_values,
      'rows', rows_value,
      'next', next_value
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value,
    'opposite', opposite_value
  );
end
$function$;
alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb,text,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid)
  to vortex_request;
comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, reads one column''s member page or, for a board''s first pages, the first page of every requested column in one invocation with its own budget and position per column, classifies those columns from current readable values and, when the choice field is guaranteed readable on every scanned row, narrows each column''s candidate scan to its own stored choice value so a column reads only its own cards, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values or affects scan order or budget; orders board and generic group pages by record identity, returns generic group identity even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; reads the copied records of a preview like installed ones and refuses a system projection in a preview.';

set local role vortex_owner;

create or replace function vortex_record.run_module_query_summary_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_inputs jsonb,
  p_prepared_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  summary_candidate_limit constant integer := 100000;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb := p_prepared_plan;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  v_storage_contract_id uuid;
  physical_table_token text;
  storage_scope text;
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  readable_field_ids text[] := array[]::text[];
  filter_condition jsonb;
  filter_types jsonb := '{}'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  filter_ids text[] := array[]::text[];
  filter_predicate text := 'true';
  filter_parameters jsonb := '[]'::jsonb;
  filter_expression_pairs text[] := array[]::text[];
  filter_values_sql text := '''{}''::jsonb';
  group_ids text[] := array[]::text[];
  aggregate_items jsonb := '[]'::jsonb;
  aggregate_item jsonb;
  aggregate_aliases text[] := array[]::text[];
  summary_field_ids text[] := array[]::text[];
  fast_field_ids text[] := array[]::text[];
  fields_by_id jsonb := '{}'::jsonb;
  field_item jsonb;
  field_key text;
  field_type text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  fast_path boolean := false;
  fast_path_fields_valid boolean := true;
  scan_sql text;
  candidate_sql text;
  selected_sql text;
  summary_sql text;
  expression_pairs text[] := array[]::text[];
  group_value_pairs text[] := array[]::text[];
  group_by_terms text[] := array[]::text[];
  group_presence_terms text[] := array[]::text[];
  group_values_sql text;
  group_by_sql text;
  group_presence_sql text;
  aggregate_object_sql text := '';
  aggregate_result_sql text;
  aggregate_count_sql text;
  aggregate_sum_sql text;
  aggregate_average_sql text;
  aggregate_present_sql text;
  aggregate_value_sql text;
  aggregate_currency_sql text;
  aggregate_amount_sql text;
  aggregate_mixed_currency_sql text;
  aggregate_operation text;
  aggregate_field_id text;
  aggregate_field_type text;
  aggregate_original_field_type text;
  aggregate_alias text;
  average_places integer;
  value_expression text;
  groups_json_sql text := '''[]''::jsonb';
  board_summary_mode boolean := false;
  board_choice_field_id text;
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_bucket_sql text;
  board_option_position integer;
  board_totals_sql text;
  board_empty_aggregates_sql text;
  result_value jsonb;
begin
  board_summary_mode := p_user_inputs ? 'boardSummary';
  if board_summary_mode then
    board_choice_field_id := pg_catalog.lower(p_user_inputs #>> '{boardSummary,choiceFieldId}');
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;

  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 10
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if board_summary_mode
    and pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'fields', '[]'::jsonb)) as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    field_key := pg_catalog.lower(field_item #>> '{}');
    field_type := coalesce(fields_by_id -> field_key ->> 'type', '');
    if field_key = any (group_ids)
      or field_type not in (
        'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
        'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
        'link', 'link_to_one_of_several'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    group_ids := pg_catalog.array_append(group_ids, field_key);
    if not (field_key = any (summary_field_ids)) then
      summary_field_ids := pg_catalog.array_append(summary_field_ids, field_key);
      fast_field_ids := pg_catalog.array_append(fast_field_ids, field_key);
    end if;
  end loop;

  if board_summary_mode then
    if pg_catalog.cardinality(group_ids) <> 1
      or group_ids[1] is distinct from board_choice_field_id
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true
      or pg_catalog.jsonb_typeof(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) is distinct from 'array'
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) as selected(value)
        where pg_catalog.jsonb_typeof(selected.value) = 'string'
          and pg_catalog.lower(selected.value #>> '{}') = board_choice_field_id
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
  end if;

  aggregate_items := coalesce(query_item -> 'aggregates', '[]'::jsonb);
  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    if aggregate_operation not in ('count', 'sum', 'minimum', 'maximum', 'average')
      or aggregate_alias is null
      or aggregate_alias !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or pg_catalog.length(aggregate_alias) > 40
      or aggregate_alias = any (aggregate_aliases)
      or (aggregate_item ? 'fieldId' and aggregate_field_id is null)
      or (aggregate_operation <> 'count' and aggregate_field_id is null)
      or (aggregate_operation = 'count' and aggregate_field_id is not null) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    aggregate_aliases := pg_catalog.array_append(aggregate_aliases, aggregate_alias);
    if aggregate_field_id is not null then
      if aggregate_field_id !~ uuid_pattern or not (fields_by_id ? aggregate_field_id) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_original_field_type = 'calculation' then
        if (fields_by_id -> aggregate_field_id) #>> '{settings,expression,kind}' is distinct from 'numeric'
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if (aggregate_operation in ('sum', 'average')
          and aggregate_field_type not in ('whole_number', 'decimal_number', 'money'))
        or (aggregate_operation in ('minimum', 'maximum')
          and aggregate_field_type not in (
            'text', 'whole_number', 'decimal_number', 'yes_no', 'money', 'date', 'date_time'
          )) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if not (aggregate_field_id = any (summary_field_ids)) then
        summary_field_ids := pg_catalog.array_append(summary_field_ids, aggregate_field_id);
        fast_field_ids := pg_catalog.array_append(fast_field_ids, aggregate_field_id);
      end if;
    end if;
  end loop;

  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := coalesce(prepared_plan #>> '{access,predicate}', 'true');
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  -- The compiler already applied an exact predicate over guaranteed readable
  -- columns. Re-evaluating it for each selected row adds no decision.
  if (prepared_plan #>> '{filter,pushedExact}')::boolean is true then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value order by item.position), array[]::text[])
  into filter_expression_pairs
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}')
    with ordinality as item(value, position);
  if pg_catalog.cardinality(filter_expression_pairs) > 0 then
    select pg_catalog.string_agg(
      'pg_catalog.jsonb_build_object(' || chunk.pairs_text || ')', ' || '
      order by chunk.chunk_index
    )
    into filter_values_sql
    from (
      select (pair.position - 1) / 50 as chunk_index,
        pg_catalog.string_agg(pair.value, ', ' order by pair.position) as pairs_text
      from pg_catalog.unnest(filter_expression_pairs)
        with ordinality as pair(value, position)
      group by (pair.position - 1) / 50
    ) as chunk;
  end if;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);

  -- The plan is exact only when every candidate is readable and every field
  -- used by grouping, aggregates or filtering is readable on every candidate.
  -- Derived filter and aggregate fields can lose their projection on an
  -- individual record when an input is withheld, so both require read_record.
  fast_path := pg_catalog.cardinality(readable_field_ids) > 0
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as required(id)
      where fields_by_id -> required.id ->> 'type' in ('calculation', 'total')
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and fields_by_id -> pg_catalog.lower(item.value ->> 'fieldId') ->> 'type'
          in ('calculation', 'total')
    )
    and not exists (
      select 1 from pg_catalog.unnest(group_ids || filter_ids) as required(id)
      where required.id <> all (readable_field_ids)
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and pg_catalog.lower(item.value ->> 'fieldId') <> all (readable_field_ids)
    );

  if fast_path then
    foreach field_key in array fast_field_ids loop
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        fast_path_fields_valid := false;
        exit;
      end if;
      field_type := fields_by_id -> field_key ->> 'type';
      fast_path_fields_valid := fast_path_fields_valid and case field_type
        when 'whole_number' then mapping_row.database_value_type = 'integer'
        when 'decimal_number' then mapping_row.database_value_type = 'decimal'
        when 'yes_no' then mapping_row.database_value_type = 'boolean'
        when 'date' then mapping_row.database_value_type = 'date'
        when 'date_time' then mapping_row.database_value_type = 'timestamp_with_time_zone'
        when 'money' then mapping_row.database_value_type = 'json'
        when 'link' then mapping_row.database_value_type = 'json'
        when 'link_to_one_of_several' then mapping_row.database_value_type = 'json'
        when 'text' then mapping_row.database_value_type = 'text'
        when 'long_text' then mapping_row.database_value_type = 'text'
        when 'formatted_text' then mapping_row.database_value_type = 'json'
        when 'choice' then mapping_row.database_value_type = 'text'
        when 'reference_number' then mapping_row.database_value_type = 'text'
        when 'email_address' then mapping_row.database_value_type = 'text'
        when 'phone_number' then mapping_row.database_value_type = 'text'
        when 'web_address' then mapping_row.database_value_type = 'text'
        when 'several_choices' then mapping_row.database_value_type = 'json'
        when 'table' then mapping_row.database_value_type = 'json'
        when 'attachment' then mapping_row.database_value_type = 'json'
        else false end;
      if not fast_path_fields_valid then
        exit;
      end if;
      value_expression := case mapping_row.database_value_type
        when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
        when 'timestamp_with_time_zone' then pg_catalog.format(
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
          mapping_row.physical_column_token
        )
        when 'date' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
          mapping_row.physical_column_token
        )
        else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
      end;
      expression_pairs := pg_catalog.array_append(
        expression_pairs, pg_catalog.format('%L, %s', field_key, value_expression)
      );
    end loop;
    fast_path := fast_path_fields_valid;
  end if;

  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    aggregate_count_sql := 'pg_catalog.count(*)';
    aggregate_present_sql := 'true';
    aggregate_value_sql := 'pg_catalog.to_jsonb(pg_catalog.count(*))';
    aggregate_mixed_currency_sql := 'false';
    if aggregate_field_id is not null then
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_original_field_type = 'calculation' then
        if (fields_by_id -> aggregate_field_id) #>> '{settings,expression,kind}' is distinct from 'numeric'
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_present_sql := pg_catalog.format(
        '(candidate.projected_values ? %L and candidate.projected_values -> %L <> ''null''::jsonb)',
        aggregate_field_id, aggregate_field_id
      );
      aggregate_count_sql := pg_catalog.format(
        'pg_catalog.count(*) filter (where %s)', aggregate_present_sql
      );
      value_expression := pg_catalog.format('(candidate.projected_values -> %L)', aggregate_field_id);
      aggregate_currency_sql := pg_catalog.format(
        '(candidate.projected_values -> %L ->> ''currency'')', aggregate_field_id
      );
      aggregate_amount_sql := pg_catalog.format(
        '((candidate.projected_values -> %L ->> ''amount'')::numeric)', aggregate_field_id
      );
      if aggregate_operation = 'count' then
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', aggregate_count_sql);
      elsif aggregate_field_type = 'money' then
        aggregate_mixed_currency_sql := pg_catalog.format(
          '(pg_catalog.count(distinct %s) filter (where %s)) > 1',
          aggregate_currency_sql, aggregate_present_sql
        );
        if aggregate_operation = 'minimum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s asc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        elsif aggregate_operation = 'maximum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s desc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        else
          average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
          if average_places not between 0 and 12 then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
          end if;
          if aggregate_operation = 'sum' then
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale(pg_catalog.sum(%s) filter (where %s))::text',
              aggregate_amount_sql, aggregate_present_sql
            );
          else
            aggregate_sum_sql := pg_catalog.format(
              'pg_catalog.sum(%s) filter (where %s)', aggregate_amount_sql, aggregate_present_sql
            );
            aggregate_average_sql := pg_catalog.format(
              'case when %3$s = 0 then null else
                 pg_catalog.sign(%1$s) * (
                   pg_catalog.div(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   )
                   + case when 2 * pg_catalog.mod(
                       pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                       (%3$s)::numeric
                     ) >= (%3$s)::numeric then 1 else 0 end
                 ) / pg_catalog.power(10::numeric, %2$s)
               end',
              aggregate_sum_sql, average_places, aggregate_count_sql
            );
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
            );
          end if;
          aggregate_value_sql := pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', (pg_catalog.array_agg(%s order by %s collate "C" asc) filter (where %s))[1])',
            value_expression, aggregate_currency_sql, aggregate_currency_sql, aggregate_present_sql
          );
        end if;
      elsif aggregate_operation in ('minimum', 'maximum') then
        if aggregate_field_type = 'text' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L) collate "C" %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'yes_no' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L)::boolean %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'whole_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s((candidate.projected_values ->> %L)::bigint) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'decimal_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.trim_scale(pg_catalog.%s((candidate.projected_values ->> %L)::numeric) filter (where %s))::text)',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'date' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s(candidate.projected_values ->> %L) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        else
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(pg_catalog.%s((candidate.projected_values ->> %L)::timestamp with time zone) filter (where %s)))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        end if;
        aggregate_value_sql := value_expression;
      else
        average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
        if aggregate_operation = 'average' and average_places not between 0 and 12 then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        if aggregate_operation = 'sum' then
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale(pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s))::text',
            aggregate_field_id, aggregate_present_sql
          );
        else
          aggregate_sum_sql := pg_catalog.format(
            'pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s)',
            aggregate_field_id, aggregate_present_sql
          );
          aggregate_average_sql := pg_catalog.format(
            'case when %3$s = 0 then null else
               pg_catalog.sign(%1$s) * (
                 pg_catalog.div(
                   pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                   (%3$s)::numeric
                 )
                 + case when 2 * pg_catalog.mod(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   ) >= (%3$s)::numeric then 1 else 0 end
               ) / pg_catalog.power(10::numeric, %2$s)
             end',
            aggregate_sum_sql, average_places, aggregate_count_sql
          );
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
          );
        end if;
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', value_expression);
      end if;
      if aggregate_operation = 'count' then
        aggregate_result_sql := pg_catalog.format(
          'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', %s)',
          aggregate_count_sql, aggregate_value_sql
        );
      else
        aggregate_result_sql := pg_catalog.format(
          'case when %s then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''mixed_currency'') else pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', case when %s = 0 then ''null''::jsonb else %s end) end',
          aggregate_mixed_currency_sql, aggregate_count_sql, aggregate_count_sql, aggregate_value_sql
        );
      end if;
    else
      aggregate_result_sql := pg_catalog.format(
        'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', pg_catalog.count(*), ''value'', pg_catalog.to_jsonb(pg_catalog.count(*)))'
      );
    end if;
    if aggregate_object_sql <> '' then
      aggregate_object_sql := aggregate_object_sql || ', ';
    end if;
    aggregate_object_sql := aggregate_object_sql || pg_catalog.format('%L, %s', aggregate_alias, aggregate_result_sql);
  end loop;

  foreach field_key in array group_ids loop
    group_value_pairs := pg_catalog.array_append(
      group_value_pairs,
      pg_catalog.format('%L, candidate.projected_values -> %L', field_key, field_key)
    );
    group_by_terms := pg_catalog.array_append(
      group_by_terms, pg_catalog.format('(candidate.projected_values -> %L)', field_key)
    );
    group_presence_terms := pg_catalog.array_append(
      group_presence_terms, pg_catalog.format('(candidate.projected_values ? %L)', field_key)
    );
  end loop;
  group_values_sql := 'pg_catalog.jsonb_build_object(' || pg_catalog.array_to_string(group_value_pairs, ', ') || ')';
  group_by_sql := pg_catalog.array_to_string(group_by_terms, ', ');
  group_presence_sql := pg_catalog.array_to_string(group_presence_terms, ' and ');

  if fast_path then
    candidate_sql := pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as projected_values,
         %s as filter_values
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
       limit $5',
      pg_catalog.array_to_string(expression_pairs, ', '),
      filter_values_sql,
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate
    );
  else
    -- The access predicate supplies only the planner's candidate superset.
    -- Decide every scanned row through read_record before evaluating its Query
    -- filter, so a withheld field can never decide whether it counts.
    scan_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
       limit $5',
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate
    );
    candidate_sql := scan_sql;
  end if;

  -- A compiled predicate may be a superset. The fast path still evaluates the
  -- complete condition over values the exact plan proves readable; the raw
  -- candidate count remains the ceiling, before any totals are returned.
  if fast_path then
    selected_sql := case when filter_condition is not null then
      'select candidate.projected_values from candidate where
         vortex_access.evaluate_query_condition_internal(
           $12, $13, candidate.filter_values, $14, $15, false
         )'
      else 'select candidate.projected_values from candidate' end;
  else
    -- Materialize each read once. The raw candidate count gates the reads, and
    -- every filter and aggregate uses only the fields this read returned.
    selected_sql := pg_catalog.format(
      'with readable as materialized (
         select vortex_record.read_record(%L::uuid, candidate.record_id) as result
         from candidate
         where (select value from candidate_count) <= %s
       )
       select (
         select coalesce(pg_catalog.jsonb_object_agg(field.id, readable.result -> ''values'' -> field.id), ''{}''::jsonb)
         from pg_catalog.unnest($17::text[]) as field(id)
         where readable.result -> ''values'' ? field.id
       ) as projected_values
       from readable
       where readable.result ->> ''outcome'' = ''allowed''
         and not exists (
           select 1 from pg_catalog.unnest($16::text[]) as required(id)
           where not (readable.result -> ''values'' ? required.id)
         )
         and ($12::jsonb is null or vortex_access.evaluate_query_condition_internal(
           $12, $13,
           (select coalesce(pg_catalog.jsonb_object_agg(referenced.id,
             case $13 ->> referenced.id
               when ''organization_account_reference'' then pg_catalog.to_jsonb(
                 pg_catalog.lower(readable.result -> ''values'' -> referenced.id ->> ''organizationAccountId''))
               else readable.result -> ''values'' -> referenced.id
             end), ''{}''::jsonb)
            from pg_catalog.unnest($16::text[]) as referenced(id)),
           $14, $15, false
         ))',
      record_type_id_value::text, summary_candidate_limit
    );
  end if;

  -- Omitted grouping fields are withheld on that row, so they form no group;
  -- a readable JSON null remains a legitimate null group.
  if board_summary_mode then
    board_bucket_sql := pg_catalog.format(
      'case when pg_catalog.jsonb_typeof(candidate.projected_values -> %L) = ''string'' then case ',
      board_choice_field_id
    );
    board_option_position := 0;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      board_option_position := board_option_position + 1;
      board_bucket_sql := board_bucket_sql || pg_catalog.format(
        'when (candidate.projected_values ->> %L) collate "C" = %L collate "C" then %s ',
        board_choice_field_id, board_option ->> 'value', board_option_position
      );
    end loop;
    board_bucket_sql := board_bucket_sql || 'else 0 end else 0 end';
    if aggregate_object_sql = '' then
      board_totals_sql := 'select ''{}''::jsonb as aggregate_values';
      board_empty_aggregates_sql := 'select ''{}''::jsonb as aggregates';
    else
      board_totals_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) as aggregate_values
         from normalized as candidate',
        aggregate_object_sql
      );
      board_empty_aggregates_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) as aggregates
         from (select null::jsonb as projected_values) as candidate where false',
        aggregate_object_sql
      );
    end if;
    if fast_path then
      -- One grouping-set scan computes both each bucket and the grand total.
      -- The raw candidate count is retained separately for the existing limit.
      summary_sql := pg_catalog.format(
        'with candidate as materialized (%s),
         candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
         selected as (%s),
         normalized as (
           select candidate.projected_values, %s as bucket_index
           from selected as candidate
         ),
         aggregate_rows as materialized (
           select grouping(candidate.bucket_index) as is_total,
             candidate.bucket_index,
             pg_catalog.count(*)::integer as row_count,
             %s as aggregates
           from normalized as candidate
           group by rollup(candidate.bucket_index)
         ),
         totals as (select row_count, aggregates from aggregate_rows where is_total = 1),
         grouped as (select bucket_index, row_count, aggregates from aggregate_rows where is_total = 0),
         installed_options as (
           select choice_option.value, choice_option.position::integer as position
           from pg_catalog.jsonb_array_elements(%L::jsonb)
             with ordinality as choice_option(value, position)
         ),
         empty_aggregates as (%s),
         columns_result as (
           select coalesce(pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               ''value'', installed.value ->> ''value'',
               ''label'', installed.value ->> ''label'',
               ''rowCount'', coalesce(grouped.row_count, 0),
               ''aggregates'', coalesce(grouped.aggregates, empty_aggregates.aggregates)
             ) order by installed.position
           ), ''[]''::jsonb) as value
           from installed_options as installed
           left join grouped on grouped.bucket_index = installed.position
           cross join empty_aggregates
         ),
         unassigned_result as (
           select pg_catalog.jsonb_build_object(
             ''rowCount'', coalesce(grouped.row_count, 0),
             ''aggregates'', coalesce(grouped.aggregates, empty_aggregates.aggregates)
           ) as value
           from (select 0::integer as bucket_index) as unassigned
           left join grouped on grouped.bucket_index = unassigned.bucket_index
           cross join empty_aggregates
         )
         select case when candidate_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
           else pg_catalog.jsonb_build_object(
             ''outcome'', ''completed'',
             ''moduleRootId'', %L,
             ''moduleReleaseVersion'', %L,
             ''queryId'', %L,
             ''choiceFieldId'', %L,
             ''totalRowCount'', totals.row_count,
             ''columns'', columns_result.value,
             ''unassigned'', unassigned_result.value,
             ''aggregates'', totals.aggregates
           ) end
         from candidate_count cross join totals
           cross join columns_result cross join unassigned_result',
        candidate_sql,
        selected_sql,
        board_bucket_sql,
        case when aggregate_object_sql = '' then '''{}''::jsonb'
          else pg_catalog.format('pg_catalog.jsonb_build_object(%s)', aggregate_object_sql) end,
        board_options::text,
        board_empty_aggregates_sql,
        summary_candidate_limit,
        p_module_root_id::text,
        resolved ->> 'moduleReleaseVersion',
        p_query_id::text,
        board_choice_field_id
      );
    else
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       normalized as materialized (
         select candidate.projected_values, %s as bucket_index
         from selected as candidate
       ),
       selected_count as (select pg_catalog.count(*)::integer as value from normalized),
       installed_options as (
         select choice_option.value, choice_option.position::integer as position
         from pg_catalog.jsonb_array_elements(%L::jsonb)
           with ordinality as choice_option(value, position)
       ),
       totals as (%s),
       grouped as (
         select candidate.bucket_index,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from normalized as candidate
         group by candidate.bucket_index
       ),
       empty_aggregates as (%s),
       columns_result as (
         select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             ''value'', installed.value ->> ''value'',
             ''label'', installed.value ->> ''label'',
             ''rowCount'', coalesce(grouped.row_count, 0),
             ''aggregates'', coalesce(grouped.aggregates, empty_aggregates.aggregates)
           ) order by installed.position
         ), ''[]''::jsonb) as value
         from installed_options as installed
         left join grouped on grouped.bucket_index = installed.position
         cross join empty_aggregates
       ),
       unassigned_result as (
         select pg_catalog.jsonb_build_object(
           ''rowCount'', coalesce(grouped.row_count, 0),
           ''aggregates'', coalesce(grouped.aggregates, empty_aggregates.aggregates)
         ) as value
         from (select 0::integer as bucket_index) as unassigned
         left join grouped on grouped.bucket_index = unassigned.bucket_index
         cross join empty_aggregates
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''choiceFieldId'', %L,
           ''totalRowCount'', selected_count.value,
           ''columns'', columns_result.value,
           ''unassigned'', unassigned_result.value,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals
         cross join columns_result cross join unassigned_result',
      candidate_sql,
      selected_sql,
      board_bucket_sql,
      board_options::text,
      board_totals_sql,
      aggregate_object_sql,
      board_empty_aggregates_sql,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      board_choice_field_id
    );
    end if;
  elsif pg_catalog.cardinality(group_ids) > 0 then
    groups_json_sql := pg_catalog.format(
      '(select coalesce(pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           ''groupKey'', grouped.group_values::text,
           ''groupValues'', grouped.group_values,
           ''rowCount'', grouped.row_count,
           ''aggregates'', grouped.aggregates
         ) order by grouped.group_values::text collate "C"
       ), ''[]''::jsonb) from grouped)'
    );
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       selected_count as (select pg_catalog.count(*)::integer as value from selected),
       totals as (select pg_catalog.jsonb_build_object(%s) as aggregate_values from selected as candidate),
       grouped as (
         select %s as group_values,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from selected as candidate
         where %s
         group by %s
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', selected_count.value,
           ''groups'', %s,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals',
      candidate_sql,
      selected_sql,
      aggregate_object_sql,
      group_values_sql,
      aggregate_object_sql,
      group_presence_sql,
      group_by_sql,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text,
      groups_json_sql
    );
  else
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       selected_count as (select pg_catalog.count(*)::integer as value from selected),
       totals as (select pg_catalog.jsonb_build_object(%s) as aggregate_values from selected as candidate)
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', selected_count.value,
           ''groups'', ''[]''::jsonb,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals',
      candidate_sql,
      selected_sql,
      aggregate_object_sql,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text
    );
  end if;

  begin
    execute summary_sql into result_value
      using context_organization_id, context_application_root_id, null::text[], null::uuid,
        summary_candidate_limit + 1, access_owner_account_id, access_owner_group_ids,
        access_shared_record_ids, filter_parameters, access_parameters, null::jsonb,
        filter_condition, filter_types, parameter_types, parameter_values,
        filter_ids, summary_field_ids;
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
  end;
  return result_value;
end
$function$;

alter function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_owner;

revoke all on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) is
  'Owner-only summary execution over the access plan prepared by the protected adapter entry point; explicit organisation and application scope and the exact read plan bound every aggregate scan.';

set local role vortex_owner;

drop function vortex_record.mirror_person_links_internal(uuid,uuid,uuid,jsonb);
drop function vortex_record.backfill_person_links_internal(uuid,bigint);

reset role;
