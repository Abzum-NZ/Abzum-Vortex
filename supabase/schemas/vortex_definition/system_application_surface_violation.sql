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
  with sides(side, content) as (
    values ('previous', coalesce(p_previous, '{}'::jsonb)), ('next', coalesce(p_next, '{}'::jsonb))
  ),
  surface as (
    select sides.side, entry.kind, entry.block, entry.detail
    from sides
    cross join lateral (
      select 'action_operation' as kind, action.value ->> 'key' as block,
        pg_catalog.jsonb_build_object(
          'operation', action.value -> 'protectedOperation',
          'subject', action.value -> 'subjectRecordTypeId'
        ) as detail
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'actions', '[]'::jsonb))
        as action(value)
      where action.value ? 'protectedOperation'
      union all
      select 'flow_operation', (flow.value ->> 'key') || '/' || (task.value ->> 'id'),
        coalesce(task.value #> '{properties,operation}', 'null'::jsonb)
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'flows', '[]'::jsonb))
        as flow(value)
      cross join lateral pg_catalog.jsonb_path_query(
        flow.value, 'strict $.**?(@.type == "operation.call")'
      ) as task(value)
      union all
      select 'system_projection', record_type.value ->> 'key',
        pg_catalog.jsonb_build_object(
          'recordTypeId', record_type.value -> 'recordTypeId',
          'storageContractId', record_type.value -> 'storageContractId',
          'projection', record_type.value -> 'systemProjection',
          'standardActions', record_type.value -> 'standardActions',
          'customActionIds', record_type.value -> 'customActionIds',
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', field.value -> 'fieldId',
                'key', field.value -> 'key',
                'type', field.value -> 'type'
              ) order by field.value ->> 'fieldId' collate "C"
            )
            from pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
          ), '[]'::jsonb)
        )
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'recordTypes', '[]'::jsonb))
        as record_type(value)
      where record_type.value ? 'systemProjection'
      union all
      select 'permission', permission.value ->> 'key', permission.value - 'label' - 'description'
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'permissions', '[]'::jsonb))
        as permission(value)
      union all
      select 'role', role.value ->> 'key', role.value - 'name'
      from pg_catalog.jsonb_array_elements(coalesce(sides.content -> 'roles', '[]'::jsonb))
        as role(value)
    ) as entry
  ),
  differences as (
    select
      coalesce(previous.kind, next.kind) as kind,
      coalesce(previous.block, next.block) as block,
      case
        when next.kind is null then 'removed'
        when previous.kind is null then 'added'
        else 'changed'
      end as state
    from (select * from surface where side = 'previous') as previous
    full join (select * from surface where side = 'next') as next
      on next.kind = previous.kind and next.block = previous.block
    where previous.detail is distinct from next.detail
  )
  select
    case difference.kind
      when 'action_operation' then 'The action'
      when 'flow_operation' then 'The flow step'
      when 'system_projection' then 'The platform data view'
      when 'permission' then 'The permission'
      else 'The role'
    end
    || ' "' || difference.block || '" '
    || case
      when difference.kind in ('action_operation', 'flow_operation') then
        case difference.state
          when 'removed' then 'no longer calls its protected platform operation'
          when 'added' then 'would call a protected platform operation the platform did not give it'
          else 'would call a different protected platform operation than the platform gave it'
        end
      when difference.kind = 'system_projection' then
        case difference.state
          when 'removed' then 'would be removed'
          when 'added' then 'would be added'
          else 'would change its shape or its platform actions'
        end
      else
        case difference.state
          when 'removed' then 'would be removed'
          when 'added' then 'would be added'
          else 'would change'
        end
    end
    || '. '
    || case
      when difference.kind in ('action_operation', 'flow_operation') then
        'A platform application keeps the protected operations the platform gave it, so undo this change before publishing.'
      when difference.kind = 'system_projection' then
        'A platform data view stays exactly as the platform defines it, so undo this change before publishing.'
      else
        'The organisation''s steward must always keep a working way to manage access, so a platform application keeps the permissions and roles the platform gave it. Undo this change before publishing.'
    end
  from differences as difference
  order by difference.kind collate "C", difference.block collate "C"
  limit 1;
$function$;

alter function vortex_definition.system_application_surface_violation(jsonb, jsonb)
  owner to vortex_owner;

revoke all on function vortex_definition.system_application_surface_violation(jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.system_application_surface_violation(jsonb, jsonb)
  to postgres;

comment on function vortex_definition.system_application_surface_violation(jsonb, jsonb) is
  'Private comparison of two releases of a platform system Application: the first change to its protected-operation bindings, system projections, permissions or roles, worded for the person publishing, or null when there is none.';
