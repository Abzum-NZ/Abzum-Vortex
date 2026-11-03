create or replace function vortex_definition.system_application_surface_violation(
  p_previous jsonb,
  p_next jsonb,
  p_kind text
)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  violation text;
begin
  if p_previous is not distinct from p_next then
    return null;
  end if;
  -- A change only to what is free at the top (name, description, and for an Application icon and
  -- theme) changes nothing on the surface.
  if pg_catalog.jsonb_typeof(p_previous) = 'object' and pg_catalog.jsonb_typeof(p_next) = 'object'
    and (p_previous - case when p_kind = 'module' then array['name', 'description']
      else array['name', 'description', 'icon', 'theme'] end)
      = (p_next - case when p_kind = 'module' then array['name', 'description']
      else array['name', 'description', 'icon', 'theme'] end) then
    return null;
  end if;
  with recursive sides as (
    select
      side.side,
      side.content,
      case when pg_catalog.jsonb_typeof(side.content -> 'flows') = 'array'
        then side.content -> 'flows' else '[]'::jsonb end as flows_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'flowBindings') = 'array'
        then side.content -> 'flowBindings' else '[]'::jsonb end as bindings_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'actions') = 'array'
        then side.content -> 'actions' else '[]'::jsonb end as actions_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'permissions') = 'array'
        then side.content -> 'permissions' else '[]'::jsonb end as permissions_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'queries') = 'array'
        then side.content -> 'queries' else '[]'::jsonb end as queries_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'events') = 'array'
        then side.content -> 'events' else '[]'::jsonb end as events_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'recordTypes') = 'array'
        then side.content -> 'recordTypes' else '[]'::jsonb end as record_types_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'pages') = 'array'
        then side.content -> 'pages' else '[]'::jsonb end as pages_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'navigation') = 'array'
        then side.content -> 'navigation' else '[]'::jsonb end as navigation_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'roles') = 'array'
        then side.content -> 'roles' else '[]'::jsonb end as roles_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'moduleBindings') = 'array'
        then side.content -> 'moduleBindings' else '[]'::jsonb end as module_bindings_a,
      case when pg_catalog.jsonb_typeof(side.content -> 'platformBlockDependencies') = 'array'
        then side.content -> 'platformBlockDependencies' else '[]'::jsonb end as dependencies_a
    from (
      values ('previous', coalesce(p_previous, '{}'::jsonb)), ('next', coalesce(p_next, '{}'::jsonb))
    ) as side(side, content)
  ),
  flows as (
    select sides.side, flow.value as flow,
      pg_catalog.lower(coalesce(flow.value ->> 'id', '')) as id,
      pg_catalog.jsonb_path_exists(flow.value, 'strict $.**?(@.type == "operation.call")') as calls,
      -- the text is read only of a flow that does not itself call a protected operation
      case when pg_catalog.jsonb_path_exists(flow.value, 'strict $.**?(@.type == "operation.call")')
        then null else pg_catalog.lower(flow.value::text) end as flow_text
    from sides
    cross join lateral pg_catalog.jsonb_array_elements(sides.flows_a) as flow(value)
    where pg_catalog.jsonb_typeof(flow.value) = 'object'
  ),
  references_between as (
    select distinct flows.side, flows.id as from_id, reference.match[1] as to_id
    from flows
    cross join lateral pg_catalog.regexp_matches(
      flows.flow_text,
      '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'g'
    ) as reference(match)
    where reference.match[1] <> flows.id and not flows.calls
  ),
  protected_flows(side, id) as (
    select flows.side, flows.id
    from flows
    where flows.calls
    union
    select reference.side, reference.from_id
    from references_between as reference
    join protected_flows as found
      on found.side = reference.side and found.id = reference.to_id
  ),
  flow_bound as (
    select sides.side, binding.value as binding
    from sides
    cross join lateral pg_catalog.jsonb_array_elements(sides.bindings_a) as binding(value)
    where pg_catalog.jsonb_typeof(binding.value) = 'object'
      and p_kind = 'application'
      and exists (
        select 1 from protected_flows as found
        where found.side = sides.side
          and found.id = pg_catalog.lower(coalesce(binding.value #>> '{flow,flowId}', ''))
      )
  ),
  controls as (
    select flow_bound.side, pg_catalog.lower(flow_bound.binding ->> 'controlId') as control
    from flow_bound
    where coalesce(flow_bound.binding ->> 'controlId', '') <> ''
  ),
  -- Every binding on a protected control is protected: the page runs the first one of an event.
  protected_bindings as (
    select flow_bound.side, flow_bound.binding from flow_bound
    union
    select sides.side, binding.value
    from sides
    cross join lateral pg_catalog.jsonb_array_elements(sides.bindings_a) as binding(value)
    where pg_catalog.jsonb_typeof(binding.value) = 'object'
      and p_kind = 'application'
      and exists (
        select 1 from controls
        where controls.side = sides.side
          and controls.control = pg_catalog.lower(coalesce(binding.value ->> 'controlId', ''))
      )
  ),
  surface as (
    select sides.side, entry.kind, entry.ident,
      case when entry.block = '' then '(unnamed)' else entry.block end as block, entry.detail
    from sides
    cross join lateral (
      select 'flow'::text as kind, flows.id as ident, coalesce(flows.flow ->> 'key', '') as block,
        flows.flow as detail
      from flows
      join protected_flows as found on found.side = flows.side and found.id = flows.id
      where flows.side = sides.side
      union all
      select 'action_operation', pg_catalog.lower(coalesce(action.value ->> 'key', '')),
        coalesce(action.value ->> 'key', ''), action.value - array['label', 'labels', 'description']
      from pg_catalog.jsonb_array_elements(sides.actions_a) as action(value)
      where pg_catalog.jsonb_typeof(action.value) = 'object' and action.value ? 'protectedOperation'
      union all
      select 'permission', pg_catalog.lower(coalesce(permission.value ->> 'key', '')),
        coalesce(permission.value ->> 'key', ''), permission.value - array['label', 'description']
      from pg_catalog.jsonb_array_elements(sides.permissions_a) as permission(value)
      where pg_catalog.jsonb_typeof(permission.value) = 'object'
      union all
      select 'query',
        pg_catalog.lower(coalesce(query.value ->> 'queryId', query.value ->> 'id', query.value ->> 'key', '')),
        coalesce(query.value ->> 'key', query.value ->> 'name', ''),
        query.value - array['name', 'label', 'description']
      from pg_catalog.jsonb_array_elements(sides.queries_a) as query(value)
      where pg_catalog.jsonb_typeof(query.value) = 'object'
      union all
      select 'event',
        pg_catalog.lower(coalesce(event.value ->> 'eventId', event.value ->> 'id', event.value ->> 'key', '')),
        coalesce(event.value ->> 'key', event.value ->> 'name', ''),
        event.value - array['name', 'label', 'description']
      from pg_catalog.jsonb_array_elements(sides.events_a) as event(value)
      where pg_catalog.jsonb_typeof(event.value) = 'object'
      union all
      select 'record_type', pg_catalog.lower(coalesce(record_type.value ->> 'recordTypeId', '')),
        coalesce(record_type.value ->> 'key', ''),
        case when pg_catalog.jsonb_typeof(record_type.value -> 'fields') = 'array'
          then pg_catalog.jsonb_set(
            record_type.value - array['singularLabel', 'pluralLabel', 'description'], '{fields}',
            coalesce((
              select pg_catalog.jsonb_agg(
                case when pg_catalog.jsonb_typeof(field.value) = 'object'
                  then field.value - array['label', 'description'] else field.value end
                order by field.position
              )
              from pg_catalog.jsonb_array_elements(record_type.value -> 'fields') with ordinality
                as field(value, position)
            ), '[]'::jsonb))
          else record_type.value - array['singularLabel', 'pluralLabel', 'description'] end
      from pg_catalog.jsonb_array_elements(sides.record_types_a) as record_type(value)
      where p_kind = 'module' and pg_catalog.jsonb_typeof(record_type.value) = 'object'
      union all
      select 'flow_binding', pg_catalog.lower(coalesce(bound.binding ->> 'bindingId', '')),
        coalesce((
          select nullif(flows.flow ->> 'key', '') from flows
          where flows.side = sides.side
            and flows.id = pg_catalog.lower(coalesce(bound.binding #>> '{flow,flowId}', ''))
          limit 1
        ), '(unnamed)') || ' (' || coalesce(bound.binding ->> 'event', '') || ')',
        bound.binding
      from protected_bindings as bound
      where bound.side = sides.side
      union all
      select 'page', pg_catalog.lower(coalesce(page.value ->> 'pageId', '')),
        coalesce(page.value ->> 'key', ''),
        pg_catalog.jsonb_build_object(
          'pageId', page.value -> 'pageId', 'key', page.value -> 'key',
          'accessPermissionKey', page.value -> 'accessPermissionKey'
        )
      from pg_catalog.jsonb_array_elements(sides.pages_a) as page(value)
      where p_kind = 'application' and pg_catalog.jsonb_typeof(page.value) = 'object'
      union all
      select 'page_content', pg_catalog.lower(coalesce(page.value ->> 'pageId', '')),
        coalesce(page.value ->> 'key', ''),
        vortex_definition.system_application_strip_text(page.value - 'name', 1)
      from pg_catalog.jsonb_array_elements(sides.pages_a) as page(value)
      where p_kind = 'application' and pg_catalog.jsonb_typeof(page.value) = 'object'
        and exists (
          select 1 from controls
          where controls.side = sides.side
            and pg_catalog.strpos(pg_catalog.lower(page.value::text), controls.control) > 0
        )
      union all
      select 'navigation', pg_catalog.lower(coalesce(item.value ->> 'id', '')),
        case when item.value ->> 'type' <> 'page' then coalesce(item.value ->> 'label', '')
          else coalesce((
            select page.value ->> 'key'
            from pg_catalog.jsonb_array_elements(sides.pages_a) as page(value)
            where pg_catalog.jsonb_typeof(page.value) = 'object'
              and pg_catalog.lower(coalesce(page.value ->> 'pageId', ''))
                = pg_catalog.lower(coalesce(item.value ->> 'pageId', ''))
            limit 1
          ), '') end,
        pg_catalog.jsonb_build_object(
          'id', item.value -> 'id', 'type', item.value -> 'type', 'pageId', item.value -> 'pageId',
          'address', item.value -> 'address', 'permissionKey', item.value -> 'permissionKey',
          'parent', coalesce((
            select heading.value ->> 'id'
            from pg_catalog.jsonb_path_query(
              sides.navigation_a, 'strict $.**?(@.type == "heading")'
            ) as heading(value)
            where heading.value -> 'children'
              @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', item.value -> 'id'))
            limit 1
          ), 'root')
        )
      from pg_catalog.jsonb_path_query(
        sides.navigation_a,
        'strict $.**?(@.type == "page" || @.type == "heading" || @.type == "external")'
      ) as item(value)
      where p_kind = 'application'
      union all
      select 'role', pg_catalog.lower(coalesce(role.value ->> 'key', '')),
        coalesce(role.value ->> 'key', ''), role.value - 'name'
      from pg_catalog.jsonb_array_elements(sides.roles_a) as role(value)
      where p_kind = 'application' and pg_catalog.jsonb_typeof(role.value) = 'object'
      union all
      select 'module_binding', pg_catalog.lower(coalesce(binding.value ->> 'moduleRootId', '')),
        coalesce(binding.value ->> 'key', ''), binding.value
      from pg_catalog.jsonb_array_elements(sides.module_bindings_a) as binding(value)
      where p_kind = 'application' and pg_catalog.jsonb_typeof(binding.value) = 'object'
      union all
      select 'block_dependency', pg_catalog.lower(dependency.value::text), '', dependency.value
      from pg_catalog.jsonb_array_elements(sides.dependencies_a) as dependency(value)
      where p_kind = 'application'
      union all
      select case when p_kind = 'module' then 'module_setting' else 'setting' end,
        setting.key, setting.key,
        case when setting.key = 'shells'
          then vortex_definition.system_application_as_set(
            vortex_definition.system_application_strip_text(setting.value, 1))
          else vortex_definition.system_application_as_set(setting.value) end
      from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(sides.content) = 'object'
        then sides.content else '{}'::jsonb end) as setting(key, value)
      where case when p_kind = 'module'
        then setting.key <> all (array[
          'name', 'description', 'recordTypes', 'permissions', 'actions', 'flows', 'queries', 'events'
        ])
        else setting.key <> all (array[
          'name', 'description', 'icon', 'theme', 'flows', 'flowBindings', 'actions', 'pages',
          'navigation', 'queries', 'events', 'platformBlockDependencies', 'permissions', 'roles',
          'moduleBindings'
        ]) end
    ) as entry
  ),
  counted as (
    select surface.side, surface.kind, surface.ident, pg_catalog.count(*) as copies,
      pg_catalog.max(surface.block) as block
    from surface
    group by surface.side, surface.kind, surface.ident
  ),
  one as (
    select distinct on (surface.side, surface.kind, surface.ident)
      surface.side, surface.kind, surface.ident, surface.block, surface.detail
    from surface
    order by surface.side, surface.kind, surface.ident
  ),
  problems as (
    select counted.kind, counted.block, counted.ident, 'twice' as change
    from counted where counted.copies > 1
    union all
    select coalesce(previous.kind, next.kind), coalesce(previous.block, next.block),
      coalesce(previous.ident, next.ident),
      case when next.kind is null then 'removed'
        when previous.kind is null then 'added'
        else 'changed' end
    from (select * from one where side = 'previous') as previous
    full join (select * from one where side = 'next') as next
      on next.kind = previous.kind and next.ident = previous.ident
    where case when previous.kind = 'flow' or next.kind = 'flow'
        -- A flow is compared as it is first; only a flow that differs is stripped of its text.
        then case when previous.detail is distinct from next.detail
          then vortex_definition.system_application_strip_flow(previous.detail)
            is distinct from vortex_definition.system_application_strip_flow(next.detail)
          else false end
        else previous.detail is distinct from next.detail end
      and not (previous.kind is null
        and next.kind in ('page', 'navigation', 'query', 'event', 'block_dependency'))
    union all
    -- Content nested deeper than the comparison bounds, and a menu that is not well formed.
    select 'flow', coalesce(flows.flow ->> 'key', ''), flows.id, 'deep'
    from flows
    join protected_flows as found on found.side = flows.side and found.id = flows.id
    where flows.side = 'next' and pg_catalog.jsonb_path_exists(flows.flow, 'strict $.**{129 to last}')
    union all
    select surface.kind, surface.block, surface.ident, 'deep'
    from surface
    where surface.side = 'next' and surface.kind <> 'flow'
      and pg_catalog.strpos(surface.detail::text, '__too_deeply_nested__') > 0
    union all
    select 'navigation', '(menu)', '(menu)', 'malformed'
    from sides
    where sides.side = 'next' and p_kind = 'application'
      and pg_catalog.jsonb_path_exists(
        sides.navigation_a,
        'strict $.**?((!(exists(@.type)) || @.type != "heading") && exists(@.children))'
      )
  )
  select pg_catalog.format(
    '%s "%s" %s. %s',
    case problem.kind
      when 'flow' then 'The protected flow'
      when 'flow_binding' then 'The flow binding'
      when 'action_operation' then 'The action'
      when 'record_type' then 'The record type'
      when 'permission' then 'The permission'
      when 'role' then 'The role'
      when 'page' then 'The page'
      when 'page_content' then 'The page'
      when 'navigation' then 'The menu entry'
      when 'query' then 'The query'
      when 'event' then 'The event'
      when 'block_dependency' then 'The platform block'
      when 'setting' then 'The application setting'
      when 'module_setting' then 'The module setting'
      else 'The module binding'
    end,
    case when problem.block = '' then '(unnamed)' else problem.block end,
    case problem.change
      when 'twice' then 'appears twice'
      when 'malformed' then 'is malformed'
      when 'deep' then 'is nested too deeply to compare'
      when 'removed' then 'would be removed'
      when 'added' then 'would be added'
      else case when problem.kind = 'page_content' then 'would change what it shows'
        else 'would change' end
    end,
    case
      when problem.kind in ('flow', 'flow_binding', 'action_operation') then
        'A platform application keeps its protected operations, and what feeds or starts them, as the platform gave them. Undo this change before publishing.'
      when problem.kind in ('record_type', 'module_setting', 'query', 'event', 'block_dependency') then
        'A platform application''s data definitions stay as the platform defines them. Undo this change before publishing.'
      else
        'The steward must always keep a working way to manage access, so these stay as the platform gave them. Undo this change before publishing.'
    end
  )
  into violation
  from problems as problem
  order by problem.kind collate "C", problem.block collate "C", problem.ident collate "C", problem.change collate "C"
  limit 1;
  return violation;
end
$function$;

alter function vortex_definition.system_application_surface_violation(jsonb, jsonb, text)
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_surface_violation(jsonb, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_surface_violation(jsonb, jsonb, text)
  to postgres;

comment on function vortex_definition.system_application_surface_violation(jsonb, jsonb, text) is
  'Private allow-list comparison of two releases of a platform system Application or of a Module it owns: the first change that is not free (cosmetic text and result messages, unprotected flows, bindings and actions) or additive (pages, menu entries, queries, events, block dependencies), worded for the person publishing, or null. The name of a protected flow and the wording of its confirmations are compared, every binding on a protected control is protected, and content nested too deeply to compare is refused.';
