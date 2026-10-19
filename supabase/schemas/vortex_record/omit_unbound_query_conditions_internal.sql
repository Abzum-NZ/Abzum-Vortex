create or replace function vortex_record.omit_unbound_query_conditions_internal(
  p_condition jsonb,
  p_parameter_values jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  child jsonb;
  kept jsonb := '[]'::jsonb;
  resolved jsonb;
begin
  -- The caller has validated the full tree and refused every missing required input.
  -- An omitted optional input removes its comparison, including beneath NOT or OR. An emptiness
  -- check asks about the value itself, so it stays and sees the input as empty.
  if p_condition is null or p_condition = 'null'::jsonb then
    return null;
  end if;
  if p_condition ->> 'kind' in ('all', 'any') then
    for child in select value from pg_catalog.jsonb_array_elements(p_condition -> 'conditions') loop
      resolved := vortex_record.omit_unbound_query_conditions_internal(child, p_parameter_values);
      if resolved is not null then
        kept := kept || pg_catalog.jsonb_build_array(resolved);
      end if;
    end loop;
    if pg_catalog.jsonb_array_length(kept) = 0 then return null; end if;
    return pg_catalog.jsonb_set(p_condition, '{conditions}', kept);
  elsif p_condition ->> 'kind' = 'not' then
    resolved := vortex_record.omit_unbound_query_conditions_internal(p_condition -> 'condition', p_parameter_values);
    if resolved is null then return null; end if;
    return pg_catalog.jsonb_set(p_condition, '{condition}', resolved);
  end if;
  if p_condition ->> 'operator' in ('is_empty', 'is_not_empty') then
    return p_condition;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_path_query(p_condition, 'lax $.** ? (@.source == "parameter").key') as reference(value)
    where p_parameter_values -> (reference.value #>> '{}') = 'null'::jsonb
  ) then return null; end if;
  return p_condition;
end;
$function$;

alter function vortex_record.omit_unbound_query_conditions_internal(jsonb, jsonb) owner to vortex_owner;
revoke all on function vortex_record.omit_unbound_query_conditions_internal(jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.omit_unbound_query_conditions_internal(jsonb, jsonb) to vortex_owner, vortex_record_adapter;
