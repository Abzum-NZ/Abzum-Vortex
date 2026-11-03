create or replace function vortex_definition.system_application_as_set(p_value jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      )
    then coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.value::text collate "C")
      from pg_catalog.jsonb_array_elements(p_value) as item(value)
    ), '[]'::jsonb)
    else p_value
  end;
$function$;

alter function vortex_definition.system_application_as_set(jsonb) owner to vortex_owner;

revoke all on function vortex_definition.system_application_as_set(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_as_set(jsonb) to postgres;

comment on function vortex_definition.system_application_as_set(jsonb) is
  'Private helper of the system Application surface comparison: an array of objects in one fixed order, so a reorder is no change.';
