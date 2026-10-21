create or replace function vortex_platform.grid_view_condition_field_ids_internal(
  p_condition jsonb,
  p_depth integer
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
declare
  node_kind text;
  collected text[] := '{}'::text[];
  child text[];
  child_node jsonb;
  operand jsonb;
  operator_name text;
begin
  if p_depth > 10 or p_condition is null or pg_catalog.jsonb_typeof(p_condition) <> 'object' then
    return null;
  end if;
  node_kind := p_condition ->> 'kind';
  if node_kind in ('all', 'any') then
    if p_condition - array['kind', 'conditions'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_condition -> 'conditions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_condition -> 'conditions') not between 1 and 50 then
      return null;
    end if;
    for child_node in
      select entry.value from pg_catalog.jsonb_array_elements(p_condition -> 'conditions') as entry(value)
    loop
      child := vortex_platform.grid_view_condition_field_ids_internal(child_node, p_depth + 1);
      if child is null then
        return null;
      end if;
      collected := collected || child;
    end loop;
    return collected;
  end if;
  if node_kind = 'not' then
    if p_condition - array['kind', 'condition'] <> '{}'::jsonb then
      return null;
    end if;
    return vortex_platform.grid_view_condition_field_ids_internal(p_condition -> 'condition', p_depth + 1);
  end if;
  if node_kind is distinct from 'comparison'
    or p_condition - array['kind', 'operator', 'left', 'right'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_condition -> 'operator') is distinct from 'string' then
    return null;
  end if;
  operator_name := p_condition ->> 'operator';
  if operator_name <> all (array[
    'equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'greater_than',
    'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'is_empty', 'is_not_empty'
  ]) then
    return null;
  end if;
  -- An empty-value comparison has one operand; every other comparison has two.
  if (operator_name in ('is_empty', 'is_not_empty')) = (p_condition ? 'right')
    or not p_condition ? 'left' then
    return null;
  end if;
  for operand in
    select entry.value
    from pg_catalog.jsonb_array_elements(case when p_condition ? 'right'
      then pg_catalog.jsonb_build_array(p_condition -> 'left', p_condition -> 'right')
      else pg_catalog.jsonb_build_array(p_condition -> 'left') end) as entry(value)
  loop
    if pg_catalog.jsonb_typeof(operand) <> 'object' then
      return null;
    end if;
    case operand ->> 'source'
      when 'field' then
        if operand - array['source', 'fieldId'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(operand -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(operand ->> 'fieldId') then
          return null;
        end if;
        collected := collected || pg_catalog.lower(operand ->> 'fieldId');
      when 'value' then
        if operand - array['source', 'value'] <> '{}'::jsonb or not operand ? 'value' then
          return null;
        end if;
      when 'parameter' then
        if operand - array['source', 'key'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(operand -> 'key') is distinct from 'string'
          or operand ->> 'key' <> all (array[
            'today', 'start_of_week', 'end_of_week', 'start_of_month', 'end_of_month'
          ]) then
          return null;
        end if;
      else
        return null;
    end case;
  end loop;
  return collected;
end
$function$;

revoke all on function vortex_platform.grid_view_condition_field_ids_internal(jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_condition_field_ids_internal(jsonb, integer) is
  'The lower-cased field identities a canonical condition tree reads, or null when the tree is malformed; owner-only.';

alter function vortex_platform.grid_view_condition_field_ids_internal(jsonb, integer) owner to vortex_owner;
