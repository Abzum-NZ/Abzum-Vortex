-- The saved-condition consumer stops re-checking parameter-binding order
-- (#395). The stored-scope validator `permission_record_scope_is_valid`
-- (20260911101613) owns canonical binding order, in code-point order
-- (`collate "C"`), as Zod and the compiler do. This function re-checked that
-- order with a collation-sensitive `>=` under the database default ICU
-- collation, which sorts `a_b` before `a1`, so it raised 22023 for a
-- byte-ordered scope the store had accepted. It uses no order for its own
-- logic: values are keyed by parameter, duplicates are refused by
-- `= any(binding_keys)`, and completeness compares key arrays. Only the order
-- comparison and its `previous_binding_key` state are removed; every other
-- check is unchanged. CREATE OR REPLACE keeps the owner and ACL; the revoke
-- and comment are restated exactly as the replaced definition has them.

create or replace function vortex_access.evaluate_permission_saved_condition(
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
      or parameter_type not in (
        'text', 'number', 'boolean', 'date', 'date_time',
        'organization_account_reference'
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
    if parameter_key is null
      or not (parameter_types ? parameter_key)
      or parameter_key = any(binding_keys) then
      raise exception using errcode = '22023', message = 'Typed record condition is invalid';
    end if;
    if binding ->> 'source' = 'current_organization_account_id' then
      if key_count <> 2
        or parameter_types ->> parameter_key not in (
          'text', 'organization_account_reference'
        ) then
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

revoke execute on function vortex_access.evaluate_permission_saved_condition(
  jsonb, jsonb, jsonb, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.evaluate_permission_saved_condition(
  jsonb, jsonb, jsonb, jsonb, uuid
) is
  'Owner-only pure predicate for one sealed permission saved condition over trusted record values and a protected current organization account.';
