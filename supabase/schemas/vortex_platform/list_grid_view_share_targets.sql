create or replace function vortex_platform.list_grid_view_share_targets(
  p_share_permission jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- Only someone who may share table views is offered who to share with.
  if not vortex_platform.grid_view_may_share_internal(
    scope.application_root_id, p_share_permission) then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'roles', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'roleId', listed.role_id, 'label', listed.label) order by listed.label, listed.role_id)
      from (
        select target_role.role_id, revision.label
        from vortex_access.organization_roles as target_role
        join vortex_access.organization_role_revisions as revision
          on revision.organization_id = target_role.organization_id
          and revision.role_id = target_role.role_id
          and revision.revision = target_role.live_revision
        where target_role.organization_id = scope.organization_id
          and (target_role.application_root_id is null
            or target_role.application_root_id = scope.application_root_id)
          and revision.lifecycle in ('active', 'acceptance_required')
        order by revision.label, target_role.role_id
        limit 200
      ) as listed
    ), '[]'::jsonb),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'groupId', listed.group_id, 'label', listed.label) order by listed.label, listed.group_id)
      from (
        select target_group.group_id, target_group.label
        from vortex_access.organization_groups as target_group
        where target_group.organization_id = scope.organization_id
          and target_group.state = 'active'
        order by target_group.label, target_group.group_id
        limit 200
      ) as listed
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.list_grid_view_share_targets(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.list_grid_view_share_targets(jsonb) to vortex_request;

comment on function vortex_platform.list_grid_view_share_targets(jsonb) is
  'Lists the roles of the application and the groups a table view can be shared with, for someone who may share table views.';

alter function vortex_platform.list_grid_view_share_targets(jsonb) owner to vortex_owner;
