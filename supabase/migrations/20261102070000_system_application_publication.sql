set role vortex_owner;

-- FIX-SYSTEM-APP-PUBLISH: people holding platform.organization.system_applications.manage,
-- definition_drafts.manage and definition_releases.manage publish, discard, restore and upgrade a
-- platform system Application from Studio (architecture decision 11).
-- (0) system_application_surface_violation is an allow-list comparison of a release with the one it
-- follows (an Application or a Module it owns). Free: name, description, icon, theme; flows,
-- bindings and actions that are not protected; cosmetic text at named positions (labels,
-- descriptions, interface step text, field and record type labels). Additive: pages, menu entries,
-- queries, events and platform block dependencies. Everything else, protected flows (they call a
-- protected operation, or name a protected flow), the bindings that start them, protected actions,
-- record types, permissions, roles, module bindings, settings and the pages that hold a protected
-- control, must be equal after the cosmetic text is removed, ids compared in lower case. Helpers:
-- system_application_as_set, _strip_text, _strip_task, _strip_flow. Deliberately ordinary: the
-- name, description, icon and theme, and what is not protected.
-- (1) append_release accepts a human publication of a platform system Application and of the
-- Modules it owns, and then also demands system_applications.manage (at the start and again at the
-- end of the transaction). It refuses, inside the publish transaction, a release that the
-- comparison refuses, with errcode 23514 and hint system_surface_changed.
-- (2) restore_release_draft and read_release_for_restore no longer refuse a platform system
-- Application: the draft guard they already call demands both permissions for it.
-- (3) read_application_latest_release reads a platform system Application's latest version too, for
-- the upgrade review.
-- No earlier migration rewrites any of these functions in place (the regprocedures were
-- searched): the bodies below are the whole definitions and equal the canonical files in
-- supabase/schemas.

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
  if coalesce(p_task ->> 'type', '') like 'interface.%'
    and pg_catalog.jsonb_typeof(p_task -> 'properties') = 'object' then
    properties := (p_task -> 'properties') - array[
      'title', 'message', 'details', 'choice', 'confirm_label', 'submit_label', 'cancel_label',
      'working', 'steps', 'step', 'summary'
    ];
    if pg_catalog.jsonb_typeof(properties -> 'actions') = 'array' then
      properties := pg_catalog.jsonb_set(properties, '{actions}', coalesce((
        select pg_catalog.jsonb_agg(
          case when pg_catalog.jsonb_typeof(action.value) = 'object' then action.value - 'label'
            else action.value end
          order by action.position
        )
        from pg_catalog.jsonb_array_elements(properties -> 'actions') with ordinality
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
  'Private helper of the system Application surface comparison: a flow task without its description, an interface step''s text properties and its message actions'' labels, nested task lists included (bounded depth).';

create or replace function vortex_definition.system_application_strip_flow(p_flow jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  result jsonb := p_flow - array['labels', 'description', 'refusal_feedback'];
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
  'Private helper of the system Application surface comparison: a flow without its labels, description and refusal feedback and with its tasks stripped of their text.';

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
  protected_bindings as (
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
    select protected_bindings.side,
      pg_catalog.lower(protected_bindings.binding ->> 'controlId') as control
    from protected_bindings
    where coalesce(protected_bindings.binding ->> 'controlId', '') <> ''
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
        case when item.value ->> 'type' = 'heading' then coalesce(item.value ->> 'label', '')
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
          'permissionKey', item.value -> 'permissionKey',
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
        sides.navigation_a, 'strict $.**?(@.type == "page" || @.type == "heading")'
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
  order by problem.kind collate "C", problem.block collate "C", problem.ident collate "C"
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
  'Private allow-list comparison of two releases of a platform system Application or of a Module it owns: the first change that is not free (cosmetic text, unprotected flows, bindings and actions) or additive (pages, menu entries, queries, events, block dependencies), worded for the person publishing, or null.';

create or replace function vortex_definition.append_release(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_release jsonb
)
returns table (
  root_id uuid,
  release_revision bigint,
  release_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  dependency_manifest jsonb,
  published_at timestamptz,
  published_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  human_publication boolean;
  original_context jsonb;
  locked_access_version bigint;
  permission_key text;
  permission_keys text[];
  system_publication boolean := false;
  surface_violation text;
  permission_id uuid;
  permission_decision record;
  checked_at timestamptz;
  permission_deadline timestamptz;
  context_organization_id uuid;
  context_actor_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  supplied_dependency jsonb;
  supplied_kind text;
  supplied_reference text;
  supplied_version text;
  supplied_content_fingerprint text;
  supplied_target_root_id uuid;
  supplied_target_release_revision bigint;
  supplied_catalogue_item_id uuid;
  supplied_entry jsonb;
  supplied_owner_kind text;
  supplied_owner_id_key text;
  supplied_expected_keys text[];
  dependency_count integer := 0;
  inserted_dependency_count integer := 0;
  expected_history_revision bigint;
  release_version_value text;
  compilation_output_value jsonb;
  application_address_value jsonb;
  application_experience_value jsonb;
  record_content_value jsonb;
  resolution_snapshot_value jsonb;
  content_fingerprint_value text;
  resolution_fingerprint_value text;
  validation_contract_version_value text;
  impact_reasons_value jsonb;
  release_note_value text;
  dependency_manifest_value jsonb;
  permissions_value jsonb;
begin
  human_publication := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context ->> 'callerKind' is distinct from 'human'
      or checked_context ? 'applicationRootId'
      or checked_context ? 'delegatedContext' or checked_context ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
    original_context := checked_context;
    permission_deadline := (checked_context ->> 'expiresAt')::timestamptz;
    -- Access precedes root/draft locks, as in ordinary draft creation and saving. A shared lock
    -- pins the authority checked below until commit (an access change must wait for it) while
    -- other requests of the organisation, concurrent publications included, go on; the root
    -- lock below orders publications of one root.
    select version.current_version into locked_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked_context ->> 'organizationId')::uuid
    for share;
    if not found or locked_access_version
      is distinct from (checked_context ->> 'accessVersion')::bigint then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_actor_id := case when human_publication
    then (checked_context ->> 'organizationAccountId')::uuid
    else (checked_context ->> 'systemActorId')::uuid end;

  if human_publication then
    -- Publishing a platform system Application, or a Module it owns, needs
    -- platform.organization.system_applications.manage as well (architecture decision 11).
    select exists (
      select 1
      from vortex_definition.roots as publication_root
      left join vortex_definition.roots as owner_root
        on owner_root.root_id = publication_root.owner_application_root_id
        and owner_root.organization_id = publication_root.organization_id
        and owner_root.kind = 'application'
      where publication_root.root_id = p_root_id
        and publication_root.organization_id = context_organization_id
        and ((publication_root.kind = 'application'
            and publication_root.application_origin_kind = 'platform_system_application')
          or (publication_root.kind = 'module'
            and owner_root.application_origin_kind = 'platform_system_application'))
    ) into system_publication;
    permission_keys := array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] || case when system_publication
      then array['platform.organization.system_applications.manage']
      else array[]::text[] end;
  end if;

  if human_publication then
    foreach permission_key in array permission_keys loop
      permission_id := vortex_access.platform_permission_id(permission_key);
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            'ownerKind', 'platform', 'ownerId', vortex_access.platform_permission_owner_id(),
            'permissionId', permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      checked_at := pg_catalog.clock_timestamp();
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from permission_key
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_release) is distinct from 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_release) as supplied(key)
      where supplied.key not in (
        'releaseVersion', 'compilationOutput', 'resolutionSnapshot', 'contentFingerprint',
        'resolutionFingerprint', 'validationContractVersion',
        'impactReasons', 'releaseNote', 'dependencies'
      )
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_release)
    ) <> 9 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has an invalid request shape';
  end if;

  release_version_value := p_release ->> 'releaseVersion';
  compilation_output_value := p_release -> 'compilationOutput';
  resolution_snapshot_value := p_release -> 'resolutionSnapshot';
  content_fingerprint_value := p_release ->> 'contentFingerprint';
  resolution_fingerprint_value := p_release ->> 'resolutionFingerprint';
  validation_contract_version_value := p_release ->> 'validationContractVersion';
  impact_reasons_value := p_release -> 'impactReasons';
  release_note_value := p_release ->> 'releaseNote';
  dependency_manifest_value := p_release -> 'dependencies';

  if release_version_value !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or pg_catalog.jsonb_typeof(compilation_output_value) is distinct from 'object'
    or pg_catalog.jsonb_typeof(resolution_snapshot_value) is distinct from 'object'
    or content_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or resolution_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or validation_contract_version_value !~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
    or pg_catalog.jsonb_typeof(impact_reasons_value) is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(impact_reasons_value) as reason(value)
      where pg_catalog.jsonb_typeof(reason.value) is distinct from 'object'
    )
    or release_note_value is null
    or release_note_value <> pg_catalog.btrim(release_note_value)
    or pg_catalog.char_length(release_note_value) not between 1 and 2000
    or pg_catalog.jsonb_typeof(dependency_manifest_value) is distinct from 'array'
    or pg_catalog.jsonb_array_length(dependency_manifest_value) > 10000 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has invalid release evidence';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
  for update;

  if not found then
    return;
  end if;

  select draft.* into draft_row
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id
  for update;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A Definition root requires its current draft';
  end if;

  if root_row.organization_id <> context_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  -- A Module release is internal to its owning Application's publication: a person publishes
  -- only an Application, ordinary or platform system, and the Modules an Application owns.
  if human_publication and (root_row.kind not in ('application', 'module')
    or (root_row.kind = 'application'
      and root_row.application_origin_kind is null)
    or (root_row.kind = 'module' and not exists (
      select 1
      from vortex_definition.roots as owner_root
      where owner_root.root_id = root_row.owner_application_root_id
        and owner_root.organization_id = root_row.organization_id
        and owner_root.kind = 'application'
        and owner_root.application_origin_kind is not null
    ))) then
    raise exception using errcode = '42501',
      message = 'Definition publication authority is unavailable';
  end if;

  -- A platform system Application's protected-operation bindings, system projections,
  -- permissions and roles stay the platform's: the release may not change them, so the
  -- organisation's steward always keeps a working way to manage access.
  if human_publication and system_publication then
    select vortex_definition.system_application_surface_violation(
      (select previous_release.compilation_output #> '{canonical,content}'
        from vortex_definition.releases as previous_release
        where previous_release.root_id = p_root_id
          and previous_release.release_revision = root_row.current_release_revision),
      compilation_output_value #> '{canonical,content}',
      root_row.kind
    ) into surface_violation;
    if surface_violation is not null then
      raise exception using errcode = '23514', hint = 'system_surface_changed',
        message = surface_violation;
    end if;
  end if;

  if compilation_output_value ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'key' is distinct from root_row.key
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'organizationId'
      is distinct from root_row.organization_id::text then
    raise exception using
      errcode = '23514',
      message = 'Definition canonical release content does not belong to the locked root';
  end if;

  if compilation_output_value ->> 'resolutionFingerprint' is distinct from resolution_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'artifact' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'artifact' ->> 'definitionKey' is distinct from root_row.key
    or compilation_output_value -> 'artifact' ->> 'exactVersion' is distinct from release_version_value
    or compilation_output_value -> 'artifact' ->> 'contentFingerprint'
      is distinct from content_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'resolutionFingerprint'
      is distinct from resolution_fingerprint_value then
    raise exception using
      errcode = '23514',
      message = 'Definition compilation output does not match immutable release evidence';
  end if;

  if resolution_snapshot_value ->> 'fingerprint' is distinct from resolution_fingerprint_value
    or pg_catalog.jsonb_typeof(resolution_snapshot_value -> 'definitions') is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(resolution_snapshot_value -> 'definitions') as definition(value)
      where definition.value ->> 'kind' = root_row.kind
        and definition.value ->> 'key' = root_row.key
        and definition.value ->> 'rootId' = p_root_id::text
        and definition.value ->> 'exactVersion' = release_version_value
    ) then
    raise exception using
      errcode = '23514',
      message = 'Definition resolution snapshot does not match release evidence';
  end if;

  if draft_row.draft_revision <> p_expected_draft_revision
    or draft_row.source_fingerprint <> p_expected_source_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'Definition release append is stale or source evidence was substituted';
  end if;

  expected_history_revision := root_row.current_release_revision;
  if expected_history_revision is null then
    if exists (select 1 from vortex_definition.releases as release where release.root_id = p_root_id) then
      raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
    end if;
  elsif not exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision = expected_history_revision
  ) or exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision > expected_history_revision
  ) then
    raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
  end if;

  if root_row.current_release_revision is distinct from expected_history_revision then
    raise exception using
      errcode = '23514',
      message = 'Definition root current release pointer does not match immutable release history';
  end if;


  if exists (
    select 1
    from vortex_definition.releases as release
    where release.root_id = p_root_id
      and release.release_revision = draft_row.draft_revision
  ) then
    raise exception using
      errcode = '23505',
      message = 'Definition draft revision is already published';
  end if;

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    dependency_count := dependency_count + 1;
    if pg_catalog.jsonb_typeof(supplied_dependency) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Definition dependency has an invalid shape';
    end if;

    supplied_kind := supplied_dependency ->> 'kind';
    if supplied_kind = 'module' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseRevision', 'releaseVersion',
          'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 6 then
        raise exception using errcode = '22023', message = 'Module dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_target_root_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_target_release_revision := (supplied_dependency ->> 'releaseRevision')::bigint;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_target_root_id is null
        or supplied_target_root_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_target_release_revision not between 1 and 9007199254740991
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_target_root_id = p_root_id
        or not exists (
          select 1
          from vortex_definition.releases as target_release
          join vortex_definition.roots as target_root on target_root.root_id = target_release.root_id
          where target_release.root_id = supplied_target_root_id
            and target_release.release_revision = supplied_target_release_revision
            and target_release.release_version = supplied_version
            and target_release.content_fingerprint = supplied_content_fingerprint
            and target_root.organization_id = context_organization_id
            and target_root.kind = 'module'
            and target_root.key = supplied_reference
        ) then
        raise exception using errcode = '23514', message = 'Module dependency does not identify an exact same-organization module release';
      end if;
    elsif supplied_kind = 'connection_type' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 5 then
        raise exception using errcode = '22023', message = 'Connection type dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_catalogue_item_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Connection type dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_block' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'blockId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform block dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'blockId';
      supplied_catalogue_item_id := case
        when supplied_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then supplied_reference::uuid
        else null
      end;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform block dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_theme' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'catalogueThemeId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform theme dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'catalogueThemeId';
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or supplied_reference = '00000000-0000-0000-0000-000000000000'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform theme dependency has invalid evidence';
      end if;
    elsif supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'protected_operation'
    ) then
      -- Flow targets are contained by, or pinned for, one exact Application
      -- release. Each entry has exactly its contract shape, and its owner is
      -- this release, an exact pinned Module release in this same manifest, or
      -- a protected platform service operation verified before append.
      if root_row.kind is distinct from 'application' then
        raise exception using errcode = '23514',
          message = 'Flow target dependencies belong only to an Application release';
      end if;
      supplied_owner_kind := case supplied_kind
        when 'protected_operation' then supplied_dependency #>> '{operation,owner,kind}'
        when 'module_query' then 'module'
        else 'application'
      end;
      supplied_expected_keys := pg_catalog.array_cat(
        array['kind', 'releaseVersion', 'contentFingerprint']::text[],
        case supplied_kind
          when 'application_flow' then
            array['applicationRootId', 'flowId', 'resolutionFingerprint']::text[]
          when 'application_flow_node' then
            array[
              'applicationRootId', 'flowId', 'nodeId', 'operations', 'grantable',
              'resolutionFingerprint'
            ]::text[]
          when 'application_query' then
            array['applicationRootId', 'queryId', 'resolutionFingerprint']::text[]
          when 'module_query' then
            array['moduleRootId', 'queryId', 'declaredRequirement', 'resolutionFingerprint']::text[]
          when 'protected_operation' then array['operation', 'resolutionFingerprint']::text[]
        end
      );
      if exists (
          select 1
          from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
          where supplied.key <> all (supplied_expected_keys)
        )
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency))
          <> pg_catalog.cardinality(supplied_expected_keys)
        or exists (
          select 1
          from pg_catalog.unnest(supplied_expected_keys) as expected(key)
          where expected.key not in (
            'operation', 'declaredRequirement', 'operations', 'grantable'
          )
            and pg_catalog.jsonb_typeof(supplied_dependency -> expected.key) is distinct from 'string'
        )
        or (
          supplied_kind = 'module_query'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'declaredRequirement')
            is distinct from 'object'
        )
        or (
          supplied_kind = 'protected_operation'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operation') is distinct from 'object'
            or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,owner}')
              is distinct from 'object'
            or supplied_owner_kind is null
            or supplied_owner_kind not in ('application', 'module', 'platform_service')
          )
        )
        or (
          supplied_kind = 'application_flow_node'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operations') is distinct from 'array'
            or pg_catalog.jsonb_typeof(supplied_dependency -> 'grantable') is distinct from 'boolean'
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has an invalid shape';
      end if;
      if supplied_kind = 'protected_operation' then
        supplied_owner_id_key := case supplied_owner_kind
          when 'application' then 'applicationRootId'
          when 'module' then 'moduleRootId'
          else 'serviceId'
        end;
        if exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation') as operation_key(key)
            where operation_key.key not in ('owner', 'operationId')
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation')) <> 2
          or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,operationId}')
            is distinct from 'string'
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}') as owner_key(key)
            where owner_key.key not in ('kind', supplied_owner_id_key)
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}')) <> 2
          or pg_catalog.jsonb_typeof(
            supplied_dependency -> 'operation' -> 'owner' -> supplied_owner_id_key
          ) is distinct from 'string' then
          raise exception using errcode = '22023',
            message = 'Definition flow target dependency has an invalid shape';
        end if;
      end if;

      if supplied_kind = 'application_flow_node' then
        if (supplied_dependency ->> 'grantable')::boolean is distinct from
            (pg_catalog.jsonb_array_length(supplied_dependency -> 'operations') > 0) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references have an invalid grantability shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where pg_catalog.jsonb_typeof(operation.value) is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'owner') is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'operationId') is distinct from 'string'
            or pg_catalog.jsonb_typeof(operation.value #> '{owner,kind}') is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value)) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value) as operation_key(key)
              where operation_key.key not in ('owner', 'operationId')
            )
            or operation.value #>> '{owner,kind}' not in ('application', 'module')
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value -> 'owner')) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value -> 'owner') as owner_key(key)
              where owner_key.key not in (
                'kind',
                case operation.value #>> '{owner,kind}'
                  when 'application' then 'applicationRootId'
                  else 'moduleRootId'
                end
              )
            )
            or pg_catalog.jsonb_typeof(
              operation.value -> 'owner' -> case operation.value #>> '{owner,kind}'
                when 'application' then 'applicationRootId'
                else 'moduleRootId'
              end
            ) is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid owner shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where owner.owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or owner.owner_id = '00000000-0000-0000-0000-000000000000'
            or (operation.value ->> 'operationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or operation.value ->> 'operationId' = '00000000-0000-0000-0000-000000000000'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid identifier';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where (
              operation.value #>> '{owner,kind}' = 'application'
              and owner.owner_id is distinct from p_root_id::text
            )
            or (
              operation.value #>> '{owner,kind}' = 'module'
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
                where pinned.value ->> 'kind' = 'module'
                  and pg_catalog.lower(pinned.value ->> 'rootId') = owner.owner_id
              )
            )
        ) then
          raise exception using errcode = '23514',
            message = 'Definition flow node operation reference does not belong to this release or a pinned Module';
        end if;

        if exists (
          select 1
          from (
            select
              pg_catalog.lag(ordered.reference_key) over (order by ordered.ordinality) as previous_reference_key,
              ordered.reference_key
            from (
              select
                operation.ordinality,
                (operation.value #>> '{owner,kind}') || ':' ||
                  case operation.value #>> '{owner,kind}'
                    when 'application' then operation.value #>> '{owner,applicationRootId}'
                    else operation.value #>> '{owner,moduleRootId}'
                  end || ':' || (operation.value ->> 'operationId') as reference_key
              from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations')
                with ordinality as operation(value, ordinality)
            ) as ordered
          ) as adjacent
          where adjacent.previous_reference_key is not null
            and adjacent.previous_reference_key collate "C" >= adjacent.reference_key collate "C"
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references must be unique and canonically sorted';
        end if;
      end if;

      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference is null
        or pg_catalog.char_length(supplied_reference) not between 1 and 500
        or supplied_reference ~ '[[:space:]]'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or (
          supplied_dependency ? 'resolutionFingerprint'
          and supplied_dependency ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has invalid evidence';
      end if;

      if (
          supplied_owner_kind = 'application'
          and (
            case when supplied_kind = 'protected_operation'
              then supplied_dependency #>> '{operation,owner,applicationRootId}'
              else supplied_dependency ->> 'applicationRootId'
            end is distinct from p_root_id::text
            or supplied_version is distinct from release_version_value
            or supplied_dependency ->> 'resolutionFingerprint'
              is distinct from resolution_fingerprint_value
          )
        )
        or (
          supplied_owner_kind = 'module'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
            where pinned.value ->> 'kind' = 'module'
              and pinned.value ->> 'rootId' = case when supplied_kind = 'protected_operation'
                then supplied_dependency #>> '{operation,owner,moduleRootId}'
                else supplied_dependency ->> 'moduleRootId'
              end
              and pinned.value ->> 'releaseVersion' = supplied_version
              and pinned.value ->> 'resolutionFingerprint' =
                supplied_dependency ->> 'resolutionFingerprint'
          )
        ) then
        raise exception using errcode = '23514',
          message = 'Flow target dependency does not identify this release or an exact pinned module release';
      end if;
    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;

    if exists (
      select 1
      from vortex_definition.release_dependencies as existing
      where existing.root_id = p_root_id
        and existing.release_revision = draft_row.draft_revision
        and existing.dependency_kind = supplied_kind
        and existing.dependency_reference = supplied_reference
        and (
          supplied_kind <> 'platform_block'
          or existing.dependency_version = supplied_version
        )
    ) then
      raise exception using errcode = '23505', message = 'Definition dependency manifest repeats a subject';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select
        supplied.value ->> 'kind' as dependency_kind,
        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then
            (supplied.value ->> 'blockId') || '@' || (supplied.value ->> 'releaseVersion')
          when 'module' then supplied.value ->> 'key'
          when 'connection_type' then supplied.value ->> 'key'
          else vortex_definition.flow_target_dependency_reference(supplied.value)
        end as dependency_reference,
        pg_catalog.count(*) as duplicate_count
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as supplied(value)
      group by 1, 2
    ) as grouped
    where grouped.dependency_reference is null or grouped.duplicate_count <> 1
  ) then
    raise exception using errcode = '22023', message = 'Definition dependency manifest repeats or omits a subject';
  end if;

  -- An Application release is written last in its publication. It pins every inline Module it
  -- owns at that Module's current release, appended earlier in the same publication when it
  -- changed, and every Module it uses at the release its owning Application's current release
  -- pins, so one Application's publication never moves another's.
  if root_row.kind = 'application' and (
    exists (
      select 1
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
      join vortex_definition.roots as target_root
        on target_root.root_id = (dependency.value ->> 'rootId')::uuid
      where dependency.value ->> 'kind' = 'module'
        and case
          when target_root.owner_application_root_id = p_root_id then
            target_root.current_release_revision
              is distinct from (dependency.value ->> 'releaseRevision')::bigint
          else not exists (
            select 1
            from vortex_definition.roots as owner_root
            join vortex_definition.release_dependencies as pin
              on pin.root_id = owner_root.root_id
              and pin.release_revision = owner_root.current_release_revision
            where owner_root.root_id = target_root.owner_application_root_id
              and pin.dependency_kind = 'module'
              and pin.target_root_id = target_root.root_id
              and pin.target_release_revision = (dependency.value ->> 'releaseRevision')::bigint
          )
        end
    )
    or exists (
      select 1
      from vortex_definition.roots as owned_root
      join pg_catalog.jsonb_array_elements(
        coalesce(draft_row.draft_source #> '{body,modules}', '[]'::jsonb)
      ) as inline_module(value) on inline_module.value ->> 'key' = owned_root.key
      where owned_root.owner_application_root_id = p_root_id
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
          where dependency.value ->> 'kind' = 'module'
            and (dependency.value ->> 'rootId')::uuid = owned_root.root_id
        )
    )
  ) then
    raise exception using errcode = '23514',
      message = 'An Application release must pin its own Modules at their current release and used Modules at their owner''s current pin';
  end if;

  -- Field policy is an immutable part of a newly published permission. Validate
  -- it at the one supported release-write boundary so trusted callers cannot
  -- store a release the compiler would refuse. Existing releases are untouched.
  if root_row.kind in ('module', 'application') then
    permissions_value := coalesce(
      compilation_output_value #> '{canonical,content,permissions}',
      '[]'::jsonb
    );

    if pg_catalog.jsonb_typeof(permissions_value) is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition release permissions are unavailable for field-policy validation';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      where (
        permission.value ->> 'recordTypeId' is null
        and permission.value ? 'fieldPolicy'
      ) or (
        permission.value ->> 'recordTypeId' is not null
        and (
          not permission.value ? 'fieldPolicy'
          or not vortex_access.permission_field_policy_is_valid(
            permission.value -> 'fieldPolicy'
          )
        )
      )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy has invalid record ownership or shape';
    end if;

    if exists (
      with module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(
          case
            when root_row.kind = 'module'
              and pg_catalog.jsonb_typeof(
                compilation_output_value #> '{canonical,content,recordTypes}'
              ) = 'array'
            then compilation_output_value #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
      ), pinned_module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
        join vortex_definition.releases as module_release
          on module_release.root_id = (dependency.value ->> 'rootId')::uuid
          and module_release.release_revision =
            (dependency.value ->> 'releaseRevision')::bigint
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(
              module_release.compilation_output #> '{canonical,content,recordTypes}'
            ) = 'array'
            then module_release.compilation_output #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
        where root_row.kind = 'application'
          and dependency.value ->> 'kind' = 'module'
      ), available_record_types as (
        select value from module_record_types
        union all
        select value from pinned_module_record_types
      ), available_record_type_counts as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.count(*) as record_type_count
        from available_record_types as record_type(value)
        group by pg_catalog.lower(record_type.value ->> 'recordTypeId')
      ), available_fields as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value ->> 'fieldId') as field_id
        from available_record_types as record_type(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(record_type.value -> 'fields') = 'array'
            then record_type.value -> 'fields'
            else '[]'::jsonb
          end
        ) as field(value)
      ), policy_fields as (
        select
          pg_catalog.lower(permission.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value) as field_id
        from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(
          (permission.value #> '{fieldPolicy,readableFieldIds}')
          || (permission.value #> '{fieldPolicy,changeableFieldIds}')
        ) as field(value)
        where permission.value ->> 'recordTypeId' is not null
      )
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      left join available_record_type_counts as record_type_count
        on record_type_count.record_type_id =
          pg_catalog.lower(permission.value ->> 'recordTypeId')
      where permission.value ->> 'recordTypeId' is not null
        and (
          record_type_count.record_type_count is distinct from 1
          or exists (
            select 1
            from policy_fields as policy_field
            where policy_field.record_type_id =
                pg_catalog.lower(permission.value ->> 'recordTypeId')
              and not exists (
                select 1
                from available_fields as available_field
                where available_field.record_type_id = policy_field.record_type_id
                  and available_field.field_id = policy_field.field_id
              )
          )
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy names a field outside its exact record type';
    end if;
  end if;

  if root_row.kind = 'application' then
    if pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,pages}')
        is distinct from 'array'
      or pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,roles}')
        is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = 'Published Application address metadata is malformed';
    end if;
    application_address_value := pg_catalog.jsonb_build_object(
      'kind', compilation_output_value -> 'kind',
      'name', compilation_output_value #> '{canonical,content,name}',
      'icon', compilation_output_value #> '{canonical,content,icon}',
      'homePageId', compilation_output_value #> '{canonical,content,homePageId}',
      'pages', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'pageId', page.value -> 'pageId',
            'key', page.value -> 'key',
            'accessPermissionKey', page.value -> 'accessPermissionKey'
          ) order by page.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,pages}'
        ) with ordinality as page(value, ordinality)
      ), '[]'::jsonb),
      'roles', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleId', role.value -> 'roleId',
            'key', role.value -> 'key',
            'homePageId', role.value -> 'homePageId'
          ) order by role.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,roles}'
        ) with ordinality as role(value, ordinality)
      ), '[]'::jsonb)
    );
    application_experience_value := pg_catalog.jsonb_build_object(
      'experiences', coalesce(
        compilation_output_value #> '{canonical,content,experiences}', '[]'::jsonb
      ),
      'resolvedExperiences', case
        when pg_catalog.jsonb_typeof(
          compilation_output_value #> '{canonical,content,experiences}'
        ) = 'array' then coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'state', experience.value ->> 'state', 'page', page.value
            ) order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,experiences}'
          ) as experience(value)
          join pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,pages}'
          ) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb)
        else '[]'::jsonb
      end,
      'shells', compilation_output_value #> '{canonical,content,shells}',
      'theme', compilation_output_value #> '{canonical,content,theme}'
    );
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(item.key, item.value), '{}'::jsonb)
  into record_content_value
  from pg_catalog.jsonb_each(
    compilation_output_value #> '{canonical,content}'
  ) as item(key, value)
  where item.key in ('recordTypes', 'permissions', 'actions', 'events');

  -- A save runs only the BeforeSave flows, so only those travel with the record content.
  record_content_value := record_content_value || pg_catalog.jsonb_build_object(
    'flows', coalesce((
      select pg_catalog.jsonb_agg(flow.value order by flow.ordinality)
      from pg_catalog.jsonb_array_elements(
        coalesce(compilation_output_value #> '{canonical,content,flows}', '[]'::jsonb)
      ) with ordinality as flow(value, ordinality)
      where exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          coalesce(flow.value -> 'triggers', '[]'::jsonb)
        ) as trigger(value)
        where trigger.value ->> 'type' = 'BeforeSave'
      )
    ), '[]'::jsonb)
  );

  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
    content_fingerprint, resolution_fingerprint, validation_contract_version,
    impact_reasons, release_note, published_at, published_by,
    application_address, application_experience, record_content
  ) values (
    p_root_id, draft_row.draft_revision, release_version_value, draft_row.draft_source,
    draft_row.source_fingerprint, draft_row.source_contract_version, compilation_output_value,
    resolution_snapshot_value,
    content_fingerprint_value, resolution_fingerprint_value, validation_contract_version_value,
    impact_reasons_value, release_note_value, operation_at,
    context_actor_id, application_address_value, application_experience_value,
    record_content_value
  );

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    supplied_kind := supplied_dependency ->> 'kind';
    supplied_reference := case supplied_kind
      when 'platform_theme' then supplied_dependency ->> 'catalogueThemeId'
      when 'platform_block' then supplied_dependency ->> 'blockId'
      else supplied_dependency ->> 'key'
    end;
    supplied_version := supplied_dependency ->> 'releaseVersion';
    supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
    supplied_target_root_id := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'rootId')::uuid else null end;
    supplied_target_release_revision := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'releaseRevision')::bigint else null end;
    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;
    supplied_entry := null;
    if supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
    end if;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id, dependency_entry
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id,
      supplied_entry
    );
    inserted_dependency_count := inserted_dependency_count + 1;
  end loop;

  if inserted_dependency_count <> dependency_count then
    raise exception using errcode = '23514', message = 'Definition dependency manifest was not stored one-for-one';
  end if;

  perform 1
  from vortex_definition.reachable_module_dependency_edges(
    p_root_id, draft_row.draft_revision
  );

  update vortex_definition.roots as root
  set current_release_revision = draft_row.draft_revision
  where root.root_id = p_root_id
    and root.current_release_revision is not distinct from expected_history_revision;

  if not found then
    raise exception using errcode = '40001', message = 'Definition current release pointer changed during publication';
  end if;

  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context is distinct from original_context then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if human_publication then
    foreach permission_key in array permission_keys loop
      permission_id := vortex_access.platform_permission_id(permission_key);
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            'ownerKind', 'platform', 'ownerId', vortex_access.platform_permission_owner_id(),
            'permissionId', permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      checked_at := pg_catalog.clock_timestamp();
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from permission_key
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  return query
  select
    release.root_id,
    release.release_revision,
    release.release_version,
    release.content_fingerprint,
    release.resolution_fingerprint,
    coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module', 'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type', 'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    release.published_at,
    release.published_by
  from vortex_definition.releases as release
  where release.root_id = p_root_id
    and release.release_revision = draft_row.draft_revision;
end
$function$;

revoke execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  to vortex_request;
comment on function vortex_definition.append_release(uuid, bigint, text, jsonb) is
  'Atomically validates and records one compiled Definition release with exact field-policy ownership, pinned dependencies and canonical flow operations; retains System publication and permits human publication of an ordinary or platform system Application, and of the Modules it owns, only under locked current draft/release permissions (a system Application also under system_applications.manage and the protected-surface rule) and original account attribution, then advances only its root pointer.';

alter function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) owner to vortex_owner;

grant execute on function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) to postgres;

create or replace function vortex_definition.restore_release_draft(
  p_kind text,
  p_root_id uuid,
  p_target_release_revision bigint,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_identity_requirements jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  restored_draft jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  raw_context jsonb;
  initial_human_context jsonb;
  final_human_context jsonb;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  selected_release vortex_definition.releases%rowtype;
  permission_decision record;
  completion_at timestamptz;
  requested_identity_count bigint;
  snapshot_identity_count bigint;
  matched_identity_count bigint;
  unique_identity_count bigint;
begin
  raw_context := vortex_platform.current_context();
  if raw_context ->> 'callerKind' = 'human' then
    if p_kind is distinct from 'application'
      or p_root_id is null
      or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_target_release_revision is null
      or p_target_release_revision not between 1 and 9007199254740991
      or p_expected_draft_revision is null
      or p_expected_draft_revision not between 1 and 9007199254740991
      or p_expected_source_fingerprint is null
      or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array' then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;
    if pg_catalog.jsonb_array_length(p_identity_requirements) < 1 then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    initial_human_context := vortex_access.validated_human_request_context();
    if initial_human_context ->> 'callerKind' is distinct from 'human'
      or initial_human_context ->> 'channel' is distinct from 'web'
      or initial_human_context ? 'applicationRootId'
      or initial_human_context ? 'delegatedContext'
      or initial_human_context ? 'supportContext' then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if checked_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select root.*
    into root_row
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'application'
    for update;
    if not found
      or root_row.current_release_revision is null
      or p_target_release_revision > root_row.current_release_revision then
      return null;
    end if;

    select draft.*
    into draft_row
    from vortex_definition.drafts as draft
    where draft.root_id = root_row.root_id
    for update;
    if not found then
      raise exception using
        errcode = '23503',
        message = 'A Definition root requires its current draft';
    end if;
    if draft_row.draft_revision is distinct from p_expected_draft_revision
      or draft_row.draft_revision >= 9007199254740991 then
      return null;
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_typeof(requirement.value) is distinct from 'object'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where not (requirement.value ?& array[
          'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
        ])
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(requirement.value) as supplied(key)
          where supplied.key <> all (array[
            'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
          ])
        )
        or pg_catalog.jsonb_typeof(requirement.value -> 'definitionKey') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'definitionKey') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'ownerScope') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'ownerScope') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'scope') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'scope') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'kind') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'kind') not between 1 and 60
        or pg_catalog.jsonb_typeof(requirement.value -> 'componentOwner') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'componentOwner') not between 1 and 240
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_typeof(requirement.value -> 'aliases') is distinct from 'array'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_array_length(requirement.value -> 'aliases') < 1
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(requirement.value -> 'aliases') as alias_value(value)
          where pg_catalog.jsonb_typeof(alias_value.value) is distinct from 'string'
            or pg_catalog.char_length(alias_value.value #>> '{}') not between 1 and 500
        )
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(requirement.value -> 'aliases')), 0)
    into requested_identity_count
    from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value);

    select release_row.*
    into selected_release
    from vortex_definition.releases as release_row
    where release_row.root_id = root_row.root_id
      and release_row.release_revision = p_target_release_revision
      and release_row.authored_source_fingerprint = p_expected_source_fingerprint
      and release_row.release_revision <= root_row.current_release_revision;
    if not found then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(selected_release.resolution_snapshot) is distinct from 'object'
      or pg_catalog.jsonb_typeof(selected_release.resolution_snapshot -> 'identities') is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition restore identity evidence is inconsistent';
    end if;
    select count(*)::bigint
    into snapshot_identity_count
    from pg_catalog.jsonb_array_elements(
      selected_release.resolution_snapshot -> 'identities'
    ) as snapshot(value)
    where snapshot.value ->> 'definitionKey' = root_row.key;

    select
      count(*)::bigint,
      count(distinct pg_catalog.jsonb_build_array(
        requirement.value ->> 'definitionKey',
        requirement.value ->> 'ownerScope',
        requirement.value ->> 'scope',
        requirement.value ->> 'kind',
        requirement.value ->> 'componentOwner',
        requested_alias.alias
      )::text)::bigint
    into matched_identity_count, unique_identity_count
    from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
    cross join pg_catalog.jsonb_array_elements_text(requirement.value -> 'aliases') as requested_alias(alias)
    join pg_catalog.jsonb_array_elements(
      selected_release.resolution_snapshot -> 'identities'
    ) as snapshot(value)
      on snapshot.value ->> 'definitionKey' = root_row.key
      and snapshot.value ->> 'definitionKey' = requirement.value ->> 'definitionKey'
      and snapshot.value ->> 'scope' = requirement.value ->> 'scope'
      and snapshot.value ->> 'kind' = requirement.value ->> 'kind'
      and snapshot.value ->> 'componentOwner' = requirement.value ->> 'componentOwner'
      and snapshot.value ->> 'alias' = requested_alias.alias
    join vortex_definition.source_identity_aliases as existing_alias
      on existing_alias.root_id = root_row.root_id
      and existing_alias.owner_scope = requirement.value ->> 'ownerScope'
      and existing_alias.scope = requirement.value ->> 'scope'
      and existing_alias.kind = requirement.value ->> 'kind'
      and existing_alias.component_owner = requirement.value ->> 'componentOwner'
      and existing_alias.alias = requested_alias.alias
      and existing_alias.identity_id::text = (snapshot.value ->> 'identifier');

    if requested_identity_count < 1
      or requested_identity_count <> snapshot_identity_count
      or matched_identity_count <> requested_identity_count
      or unique_identity_count <> requested_identity_count
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
        where requirement.value ->> 'definitionKey' is distinct from root_row.key
      ) then
      raise exception using
        errcode = '23514',
        message = 'Definition restore identity evidence is inconsistent';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    update vortex_definition.drafts as draft
    set
      draft_revision = draft.draft_revision + 1,
      draft_source = selected_release.authored_source,
      identity_requirements = p_identity_requirements,
      source_contract_version = selected_release.source_contract_version,
      source_fingerprint = selected_release.authored_source_fingerprint,
      restored_from_release_revision = selected_release.release_revision,
      restored_from_source_fingerprint = selected_release.authored_source_fingerprint,
      restored_by = (checked_context ->> 'organizationAccountId')::uuid,
      restored_at = operation_at,
      restore_correlation_id = (checked_context ->> 'correlationId')::uuid,
      updated_at = operation_at,
      updated_by = (checked_context ->> 'organizationAccountId')::uuid
    where draft.root_id = root_row.root_id
      and draft.draft_revision = p_expected_draft_revision
      and draft.draft_revision < 9007199254740991
    returning pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'rootId', draft.root_id,
      'draftRevision', draft.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft.draft_source,
      'sourceContractVersion', draft.source_contract_version,
      'sourceFingerprint', draft.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft.updated_at,
      'updatedBy', draft.updated_by,
      'restoredFromReleaseRevision', draft.restored_from_release_revision,
      'restoredFromSourceFingerprint', draft.restored_from_source_fingerprint,
      'restoredBy', draft.restored_by,
      'restoredAt', draft.restored_at,
      'restoreCorrelationId', draft.restore_correlation_id
    ) into restored_draft;
    if not found then
      return null;
    end if;

    final_human_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if final_human_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select evaluated.*
    into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.definition_drafts.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    final_human_context := vortex_access.validated_human_request_context();
    completion_at := pg_catalog.clock_timestamp();
    if final_human_context is distinct from initial_human_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from 'platform.organization.definition_drafts.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id is distinct from (initial_human_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id is distinct from (initial_human_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from (initial_human_context ->> 'accessVersion')::bigint
      or permission_decision.correlation_id is distinct from (initial_human_context ->> 'correlationId')::uuid
      or permission_decision.reason_code is not null
      or permission_decision.checked_at is null
      or permission_decision.checked_at > completion_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= completion_at
      or (initial_human_context ->> 'issuedAt')::timestamptz > completion_at
      or (initial_human_context ->> 'expiresAt')::timestamptz <= completion_at
      or operation_at > completion_at then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    return restored_draft;
  end if;

  checked_context := vortex_definition.validated_system_context();

  if p_kind is null
    or p_kind is distinct from 'application'
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_release_revision is null
    or p_target_release_revision not between 1 and 9007199254740991
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint is null
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_identity_requirements) < 1 then
    raise exception using
      errcode = '22023',
      message = 'Definition restore has invalid verified evidence';
  end if;

  with selected_release as (
    select
      root.root_id,
      root.organization_id,
      root.kind,
      root.key,
      root.current_release_revision,
      root.created_at,
      root.created_by,
      release.release_revision,
      release.authored_source,
      release.authored_source_fingerprint,
      release.source_contract_version
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_target_release_revision
      and release.authored_source_fingerprint = p_expected_source_fingerprint
    where root.root_id = p_root_id
      and root.kind = p_kind
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
  ),
  updated_draft as (
    update vortex_definition.drafts as draft
    set
      draft_revision = draft.draft_revision + 1,
      draft_source = selected.authored_source,
      identity_requirements = p_identity_requirements,
      source_contract_version = selected.source_contract_version,
      source_fingerprint = selected.authored_source_fingerprint,
      restored_from_release_revision = selected.release_revision,
      restored_from_source_fingerprint = selected.authored_source_fingerprint,
      restored_by = (checked_context ->> 'systemActorId')::uuid,
      restored_at = operation_at,
      restore_correlation_id = (checked_context ->> 'correlationId')::uuid,
      updated_at = operation_at,
      updated_by = (checked_context ->> 'systemActorId')::uuid
    from selected_release as selected
    where draft.root_id = selected.root_id
      and draft.draft_revision = p_expected_draft_revision
      and draft.draft_revision < 9007199254740991
    returning
      draft.root_id,
      draft.draft_revision,
      draft.draft_source,
      draft.source_contract_version,
      draft.source_fingerprint,
      draft.restored_from_release_revision,
      draft.restored_from_source_fingerprint,
      draft.restored_by,
      draft.restored_at,
      draft.restore_correlation_id,
      draft.updated_at,
      draft.updated_by
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', selected.organization_id,
    'kind', selected.kind,
    'key', selected.key,
    'rootId', updated.root_id,
    'draftRevision', updated.draft_revision,
    'publishedRevision', selected.current_release_revision,
    'source', updated.draft_source,
    'sourceContractVersion', updated.source_contract_version,
    'sourceFingerprint', updated.source_fingerprint,
    'createdAt', selected.created_at,
    'createdBy', selected.created_by,
    'updatedAt', updated.updated_at,
    'updatedBy', updated.updated_by,
    'restoredFromReleaseRevision', updated.restored_from_release_revision,
    'restoredFromSourceFingerprint', updated.restored_from_source_fingerprint,
    'restoredBy', updated.restored_by,
    'restoredAt', updated.restored_at,
    'restoreCorrelationId', updated.restore_correlation_id
  )
  into restored_draft
  from updated_draft as updated
  join selected_release as selected on selected.root_id = updated.root_id;

  return restored_draft;
end
$function$;

revoke execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) to vortex_request;

comment on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) is
  'Conditionally restores one verified immutable authored source into the expected draft revision without allocating identities or moving a release pointer.';

alter function vortex_definition.restore_release_draft(p_kind text, p_root_id uuid, p_target_release_revision bigint, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_identity_requirements jsonb) owner to vortex_owner;

create or replace function vortex_definition.read_release_for_restore(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  initial_human_context jsonb;
  final_human_context jsonb;
  raw_context jsonb;
  release_evidence jsonb;
  human_current_draft jsonb;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  permission_decision record;
  completion_at timestamptz;
  human_restore boolean := false;
begin
  raw_context := vortex_platform.current_context();
  human_restore := raw_context ->> 'callerKind' = 'human';
  if human_restore then
    if p_kind is null
      or p_kind is distinct from 'application'
      or p_root_id is null
      or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_release_revision is null
      or p_release_revision not between 1 and 9007199254740991 then
      raise exception using
        errcode = '22023',
        message = 'Definition restore evidence has an invalid selector';
    end if;

    initial_human_context := vortex_access.validated_human_request_context();
    if initial_human_context ->> 'callerKind' is distinct from 'human'
      or initial_human_context ->> 'channel' is distinct from 'web'
      or initial_human_context ? 'applicationRootId'
      or initial_human_context ? 'delegatedContext'
      or initial_human_context ? 'supportContext' then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if checked_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select root.*
    into root_row
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'application'
    for update;
    if not found
      or root_row.current_release_revision is null then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select draft.*
    into draft_row
    from vortex_definition.drafts as draft
    where draft.root_id = root_row.root_id
    for update;
    if not found then
      raise exception using
        errcode = '23503',
        message = 'A Definition root requires its current draft';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision is null
    or p_release_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition restore evidence has an invalid selector';
  end if;

  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'key', root.key,
    'rootId', root.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'authoredSource', release.authored_source,
    'sourceFingerprint', release.authored_source_fingerprint,
    'sourceContractVersion', release.source_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint,
    'validationContractVersion', release.validation_contract_version,
    'compilationOutput', release.compilation_output,
    'resolutionSnapshot', release.resolution_snapshot,
    'dependencyManifest', coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end
        order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    'moduleDependencyTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rootId', target.root_id,
          'releaseRevision', target.release_revision,
          'releaseVersion', target.release_version,
          'contentFingerprint', target.content_fingerprint,
          'resolutionFingerprint', target.resolution_fingerprint
        )
        order by
          dependency.dependency_reference collate "C",
          target.root_id,
          target.release_revision
      )
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb),
    'identityEvidence', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'definitionKey', root.key,
          'ownerScope', alias.owner_scope,
          'scope', alias.scope,
          'kind', alias.kind,
          'componentOwner', alias.component_owner,
          'alias', alias.alias,
          'identifier', alias.identity_id
        )
        order by
          alias.scope collate "C",
          alias.kind collate "C",
          alias.component_owner collate "C",
          alias.alias collate "C"
      )
      from vortex_definition.source_identity_aliases as alias
      where alias.root_id = root.root_id
    ), '[]'::jsonb)
  )
  into release_evidence
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
      and (not human_restore or release.release_revision <= root_row.current_release_revision)
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  if human_restore and release_evidence is not null then
    human_current_draft := pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'rootId', draft_row.root_id,
      'draftRevision', draft_row.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft_row.draft_source,
      'sourceContractVersion', draft_row.source_contract_version,
      'sourceFingerprint', draft_row.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft_row.updated_at,
      'updatedBy', draft_row.updated_by
    ) || case
      when draft_row.restored_from_release_revision is not null then pg_catalog.jsonb_build_object(
        'restoredFromReleaseRevision', draft_row.restored_from_release_revision,
        'restoredFromSourceFingerprint', draft_row.restored_from_source_fingerprint,
        'restoredBy', draft_row.restored_by,
        'restoredAt', draft_row.restored_at,
        'restoreCorrelationId', draft_row.restore_correlation_id
      )
      else '{}'::jsonb
    end;

    release_evidence := release_evidence || pg_catalog.jsonb_build_object(
      'humanDraftSnapshot', pg_catalog.jsonb_build_object(
        'draftRevision', draft_row.draft_revision,
        'sourceFingerprint', draft_row.source_fingerprint,
        'anchorReleaseRevision', root_row.current_release_revision
      ),
      'humanCurrentDraft', human_current_draft
    );

    final_human_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if final_human_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select evaluated.*
    into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.definition_drafts.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    final_human_context := vortex_access.validated_human_request_context();
    completion_at := pg_catalog.clock_timestamp();
    if final_human_context is distinct from initial_human_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from 'platform.organization.definition_drafts.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id is distinct from (initial_human_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id is distinct from (initial_human_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from (initial_human_context ->> 'accessVersion')::bigint
      or permission_decision.correlation_id is distinct from (initial_human_context ->> 'correlationId')::uuid
      or permission_decision.reason_code is not null
      or permission_decision.checked_at is null
      or permission_decision.checked_at > completion_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= completion_at
      or (initial_human_context ->> 'issuedAt')::timestamptz > completion_at
      or (initial_human_context ->> 'expiresAt')::timestamptz <= completion_at
      or draft_row.updated_at > completion_at
      or (draft_row.restored_at is not null and draft_row.restored_at > completion_at) then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;
  end if;

  return release_evidence;
end
$function$;

revoke execute on function vortex_definition.read_release_for_restore(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_release_for_restore(text, uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_release_for_restore(text, uuid, bigint) is
  'Returns narrow private evidence needed to verify one immutable source before restoring its draft.';

alter function vortex_definition.read_release_for_restore(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

-- The latest published version of one Application, ordinary or platform system, of the request's organisation, for a
-- person who may manage the organisation's application installations. Installing and upgrading are
-- anchored to it; no draft right is needed.
create or replace function vortex_definition.read_application_latest_release(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
  latest jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application latest release selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context is null
    or checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select pg_catalog.jsonb_build_object(
    'definitionKey', root.key,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'releaseNote', release.release_note
  ) into latest
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application';
  return latest;
end
$function$;

revoke all on function vortex_definition.read_application_latest_release(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.read_application_latest_release(uuid)
  to vortex_request, postgres;
comment on function vortex_definition.read_application_latest_release(uuid) is
  'Returns the latest published version of one Application, ordinary or platform system, of the request organisation to a caller holding platform.organization.applications.manage, or null when it has none.';
alter function vortex_definition.read_application_latest_release(uuid) owner to vortex_owner;

reset role;
