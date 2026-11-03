create or replace function vortex_definition.system_application_strip_flow(p_flow jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  result jsonb := p_flow - array['description', 'refusal_feedback'];
  list_key text;
begin
  foreach list_key in array array['tasks', 'errors', 'finally'] loop
    if pg_catalog.jsonb_typeof(result -> list_key) = 'array' then
      result := pg_catalog.jsonb_set(result, array[list_key], coalesce((
        select pg_catalog.jsonb_agg(
          vortex_definition.system_application_strip_task(task.value, 1) order by task.position
        )
        from pg_catalog.jsonb_array_elements(result -> list_key) with ordinality
          as task(value, position)
      ), '[]'::jsonb));
    end if;
  end loop;
  return result;
end
$function$;

alter function vortex_definition.system_application_strip_flow(jsonb) owner to vortex_owner;

revoke all on function vortex_definition.system_application_strip_flow(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_strip_flow(jsonb) to postgres;

comment on function vortex_definition.system_application_strip_flow(jsonb) is
  'Private helper of the system Application surface comparison: a flow without its description and refusal feedback and with its tasks stripped of their text (the name of a flow and the wording of its confirmations stay).';
