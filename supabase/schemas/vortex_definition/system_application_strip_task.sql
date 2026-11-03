create or replace function vortex_definition.system_application_strip_task(
  p_task jsonb,
  p_depth integer
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  result jsonb;
  properties jsonb;
  child_key text;
begin
  if p_depth > 64 then
    return '"__too_deeply_nested__"'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_task) is distinct from 'object' then
    return p_task;
  end if;
  result := p_task - 'description';
  if p_task ->> 'type' = 'interface.show_message'
    and pg_catalog.jsonb_typeof(p_task -> 'properties') = 'object' then
    properties := (p_task -> 'properties') - array['title', 'message', 'details'];
    if properties -> 'actions' ->> 'kind' = 'array'
      and pg_catalog.jsonb_typeof(properties -> 'actions' -> 'items') = 'array' then
      properties := pg_catalog.jsonb_set(properties, '{actions,items}', coalesce((
        select pg_catalog.jsonb_agg(
          case when pg_catalog.jsonb_typeof(action.value) = 'object'
              and action.value ->> 'kind' = 'map'
              and pg_catalog.jsonb_typeof(action.value -> 'entries') = 'object'
            then action.value #- '{entries,label}'
            else action.value end
          order by action.position
        )
        from pg_catalog.jsonb_array_elements(properties -> 'actions' -> 'items') with ordinality
          as action(value, position)
      ), '[]'::jsonb));
    end if;
    result := pg_catalog.jsonb_set(result, '{properties}', properties);
  end if;
  foreach child_key in array array['then', 'else', 'default', 'tasks'] loop
    if pg_catalog.jsonb_typeof(result -> child_key) = 'array' then
      result := pg_catalog.jsonb_set(result, array[child_key], coalesce((
        select pg_catalog.jsonb_agg(
          vortex_definition.system_application_strip_task(child.value, p_depth + 1)
          order by child.position
        )
        from pg_catalog.jsonb_array_elements(result -> child_key) with ordinality
          as child(value, position)
      ), '[]'::jsonb));
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(result -> 'cases') = 'array' then
    result := pg_catalog.jsonb_set(result, '{cases}', coalesce((
      select pg_catalog.jsonb_agg(
        case when pg_catalog.jsonb_typeof(entry.value) = 'object'
            and pg_catalog.jsonb_typeof(entry.value -> 'tasks') = 'array'
          then pg_catalog.jsonb_set(entry.value, '{tasks}', coalesce((
            select pg_catalog.jsonb_agg(
              vortex_definition.system_application_strip_task(child.value, p_depth + 1)
              order by child.position
            )
            from pg_catalog.jsonb_array_elements(entry.value -> 'tasks') with ordinality
              as child(value, position)
          ), '[]'::jsonb))
          else entry.value end
        order by entry.position
      )
      from pg_catalog.jsonb_array_elements(result -> 'cases') with ordinality
        as entry(value, position)
    ), '[]'::jsonb));
  end if;
  return result;
end
$function$;

alter function vortex_definition.system_application_strip_task(jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_strip_task(jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_strip_task(jsonb, integer)
  to postgres;

comment on function vortex_definition.system_application_strip_task(jsonb, integer) is
  'Private helper of the system Application surface comparison: a flow task without its description, a result message''s text and its message actions'' labels, nested task lists included (bounded depth).';
