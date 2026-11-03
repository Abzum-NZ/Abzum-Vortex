create or replace function vortex_definition.system_application_surface_violation(
  p_previous jsonb,
  p_next jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  with protected_present as (
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(p_previous -> 'flows', '[]'::jsonb)) as flow(value)
      where pg_catalog.jsonb_path_exists(flow.value, 'strict $.**?(@.type == "operation.call")')
      union all
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(p_previous -> 'actions', '[]'::jsonb)) as action(value)
      where action.value ? 'protectedOperation'
      union all
      select 1
      from pg_catalog.jsonb_array_elements(coalesce(p_previous -> 'recordTypes', '[]'::jsonb))
        as record_type(value)
      where record_type.value ? 'systemProjection'
    ) as value
  ),
  sides(side, content) as (
    values ('previous', coalesce(p_previous, '{}'::jsonb)), ('next', coalesce(p_next, '{}'::jsonb))
  ),
  protected_flows as (
    select sides.side, flow.value as flow
    from sides
    cross join lateral pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'flows', '[]'::jsonb))
      as flow(value)
    where pg_catalog.jsonb_path_exists(flow.value, 'strict $.**?(@.type == "operation.call")')
  ),
  surface as (
    select sides.side, entry.kind, entry.ident, entry.block, entry.detail
    from sides
    cross join lateral (
      select 'flow' as kind, coalesce(flow.flow ->> 'id', '') as ident,
        coalesce(flow.flow ->> 'key', '') as block,
        vortex_definition.system_application_strip(
          flow.flow, array['labels', 'description', 'refusal_feedback'], true
        ) as detail
      from protected_flows as flow
      where flow.side = sides.side
      union all
      select 'flow_binding', coalesce(binding.value ->> 'bindingId', ''),
        coalesce(binding.value ->> 'bindingId', ''), binding.value
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'flowBindings', '[]'::jsonb))
        as binding(value)
      where binding.value #>> '{flow,flowId}' in (
        select protected.flow ->> 'id' from protected_flows as protected
        where protected.side = sides.side
      )
      union all
      select 'action_operation', coalesce(action.value ->> 'key', ''),
        coalesce(action.value ->> 'key', ''),
        vortex_definition.system_application_strip(
          action.value, array['label', 'labels', 'description', 'singularLabel', 'pluralLabel'], false
        )
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'actions', '[]'::jsonb))
        as action(value)
      where action.value ? 'protectedOperation'
      union all
      select 'system_projection', coalesce(record_type.value ->> 'key', ''),
        coalesce(record_type.value ->> 'key', ''),
        vortex_definition.system_application_strip(
          record_type.value, array['label', 'labels', 'description', 'singularLabel', 'pluralLabel'], false
        )
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'recordTypes', '[]'::jsonb))
        as record_type(value)
      where record_type.value ? 'systemProjection'
      union all
      select 'permission', coalesce(permission.value ->> 'key', ''),
        coalesce(permission.value ->> 'key', ''),
        vortex_definition.system_application_strip(permission.value, array['label', 'description'], false)
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'permissions', '[]'::jsonb))
        as permission(value)
      union all
      select 'role', coalesce(role.value ->> 'key', ''), coalesce(role.value ->> 'key', ''),
        vortex_definition.system_application_strip(role.value, array['name'], false)
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'roles', '[]'::jsonb))
        as role(value)
      union all
      select 'page', coalesce(page.value ->> 'pageId', ''), coalesce(page.value ->> 'key', ''),
        pg_catalog.jsonb_build_object(
          'pageId', page.value -> 'pageId', 'key', page.value -> 'key',
          'accessPermissionKey', page.value -> 'accessPermissionKey'
        )
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'pages', '[]'::jsonb))
        as page(value)
      where (select value from protected_present)
      union all
      select 'navigation', coalesce(item.value ->> 'id', ''), coalesce(item.value ->> 'id', ''),
        pg_catalog.jsonb_build_object(
          'id', item.value -> 'id', 'pageId', item.value -> 'pageId',
          'permissionKey', item.value -> 'permissionKey'
        )
      from pg_catalog.jsonb_path_query(
        coalesce(sides.content -> 'navigation', '[]'::jsonb), 'strict $.**?(@.type == "page")'
      ) as item(value)
      where (select value from protected_present)
    ) as entry
  ),
  differences as (
    select
      coalesce(previous.kind, next.kind) as kind,
      coalesce(previous.block, next.block) as block,
      coalesce(previous.ident, next.ident) as ident,
      case
        when next.kind is null then 'be removed'
        when previous.kind is null then 'be added'
        else 'change'
      end as change
    from (select * from surface where side = 'previous') as previous
    full join (select * from surface where side = 'next') as next
      on next.kind = previous.kind and next.ident = previous.ident
    where previous.detail is distinct from next.detail
  )
  select pg_catalog.format(
    '%s "%s" would %s. %s',
    case difference.kind
      when 'flow' then 'The protected flow'
      when 'flow_binding' then 'The flow binding'
      when 'action_operation' then 'The action'
      when 'system_projection' then 'The platform data view'
      when 'permission' then 'The permission'
      when 'role' then 'The role'
      when 'page' then 'The page'
      else 'The menu entry'
    end,
    difference.block,
    difference.change,
    case
      when difference.kind in ('flow', 'flow_binding', 'action_operation') then
        'A platform application keeps the protected operations the platform gave it, with what feeds and triggers them, so undo this change before publishing.'
      when difference.kind = 'system_projection' then
        'A platform data view stays exactly as the platform defines it, so undo this change before publishing.'
      else
        'The organisation''s steward must always keep a working way to manage access, so a platform application keeps the permissions, roles, pages and menu entries the platform gave it. Undo this change before publishing.'
    end
  )
  from differences as difference
  order by difference.kind collate "C", difference.block collate "C", difference.ident collate "C"
  limit 1;
$function$;

alter function vortex_definition.system_application_surface_violation(jsonb, jsonb)
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_surface_violation(jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_surface_violation(jsonb, jsonb)
  to postgres;

comment on function vortex_definition.system_application_surface_violation(jsonb, jsonb) is
  'Private comparison of two releases of a platform system Application: the first change to its protected flows, flow bindings, protected-operation actions, system projections, permissions, roles, and (where something is protected) pages and menu entries, worded for the person publishing, or null when there is none.';
