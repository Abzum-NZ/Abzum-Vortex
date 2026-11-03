create or replace function vortex_definition.system_application_strip_text(
  p_value jsonb,
  p_depth integer,
  p_controls text[]
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  result jsonb;
begin
  if p_depth > 64 then
    return '"__too_deeply_nested__"'::jsonb;
  end if;
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      result := coalesce((
        select pg_catalog.jsonb_object_agg(
          entry.key, vortex_definition.system_application_strip_text(entry.value, p_depth + 1, p_controls)
        )
        from pg_catalog.jsonb_each(p_value) as entry(key, value)
      ), '{}'::jsonb);
      -- The text of a block is at known positions only: the properties of a typed block that is not
      -- a protected control (the label of the control that starts a protected action is the platform's).
      if pg_catalog.jsonb_typeof(result -> 'type') = 'string'
        and pg_catalog.jsonb_typeof(result -> 'props') = 'object'
        and not (pg_catalog.lower(coalesce(result #>> '{props,id}', '')) = any (p_controls)) then
        result := pg_catalog.jsonb_set(result, '{props}', (result -> 'props') - array[
          'title', 'label', 'text', 'description', 'placeholder', 'helpText', 'heading'
        ]);
      end if;
      return result;
    when 'array' then
      return coalesce((
        select pg_catalog.jsonb_agg(
          vortex_definition.system_application_strip_text(item.value, p_depth + 1, p_controls)
          order by item.position
        )
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as item(value, position)
      ), '[]'::jsonb);
    else
      return p_value;
  end case;
end
$function$;

alter function vortex_definition.system_application_strip_text(jsonb, integer, text[])
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_strip_text(jsonb, integer, text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_strip_text(jsonb, integer, text[])
  to postgres;

comment on function vortex_definition.system_application_strip_text(jsonb, integer, text[]) is
  'Private helper of the system Application surface comparison: a page or shell composition without the text properties of its typed blocks, except a protected control (bounded depth).';
