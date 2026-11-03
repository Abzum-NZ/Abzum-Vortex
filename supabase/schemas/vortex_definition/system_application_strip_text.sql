create or replace function vortex_definition.system_application_strip_text(
  p_value jsonb,
  p_depth integer
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_depth > 64 then
    return '"__too_deeply_nested__"'::jsonb;
  end if;
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      return coalesce((
        select pg_catalog.jsonb_object_agg(
          entry.key, vortex_definition.system_application_strip_text(entry.value, p_depth + 1)
        )
        from pg_catalog.jsonb_each(p_value) as entry(key, value)
        where entry.key <> all (array[
          'title', 'label', 'text', 'description', 'placeholder', 'helpText', 'heading'
        ])
      ), '{}'::jsonb);
    when 'array' then
      return coalesce((
        select pg_catalog.jsonb_agg(
          vortex_definition.system_application_strip_text(item.value, p_depth + 1)
          order by item.position
        )
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, position)
      ), '[]'::jsonb);
    else
      return p_value;
  end case;
end
$function$;

alter function vortex_definition.system_application_strip_text(jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_strip_text(jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_strip_text(jsonb, integer)
  to postgres;

comment on function vortex_definition.system_application_strip_text(jsonb, integer) is
  'Private helper of the system Application surface comparison: a page or shell composition without its text properties, at any depth (bounded).';
