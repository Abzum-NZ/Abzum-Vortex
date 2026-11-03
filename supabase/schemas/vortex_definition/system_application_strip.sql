create or replace function vortex_definition.system_application_strip(
  p_value jsonb,
  p_keys text[],
  p_drop_interface boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      return coalesce((
        select pg_catalog.jsonb_object_agg(
          entry.key, vortex_definition.system_application_strip(entry.value, p_keys, p_drop_interface)
        )
        from pg_catalog.jsonb_each(p_value) as entry(key, value)
        where entry.key <> all (p_keys)
      ), '{}'::jsonb);
    when 'array' then
      return coalesce((
        select pg_catalog.jsonb_agg(
          vortex_definition.system_application_strip(item.value, p_keys, p_drop_interface)
          order by item.position
        )
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, position)
        where not (
          p_drop_interface
          and pg_catalog.jsonb_typeof(item.value) = 'object'
          and coalesce(item.value ->> 'type', '') like 'interface.%'
        )
      ), '[]'::jsonb);
    else
      return p_value;
  end case;
end
$function$;

alter function vortex_definition.system_application_strip(jsonb, text[], boolean)
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_strip(jsonb, text[], boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_strip(jsonb, text[], boolean)
  to postgres;

comment on function vortex_definition.system_application_strip(jsonb, text[], boolean) is
  'Private helper of the system Application surface comparison: a definition value without the named presentation keys and, when asked, without interface steps.';
