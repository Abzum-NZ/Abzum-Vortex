create or replace function vortex_platform.list_grid_views(
  p_page_id uuid,
  p_placement_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  targets record;
  role_keys jsonb;
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text) then
    raise exception using errcode = '22023', message = 'Grid view list is invalid';
  end if;
  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;
  select viewer.* into strict targets from vortex_platform.grid_view_viewer_targets_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id
  ) as viewer;
  select coalesce((
      select pg_catalog.jsonb_agg(distinct template.key)
      from vortex_access.organization_roles as role
      join vortex_access.application_role_template_continuities as template
        on template.organization_id = role.organization_id
        and template.application_root_id = coalesce(role.application_root_id, role.derived_application_root_id)
        and template.source_role_id = coalesce(role.source_role_id, role.derived_source_role_id)
        and template.state = 'available'
      where role.organization_id = scope.organization_id
        and template.application_root_id = scope.application_root_id
        and role.role_id = any(targets.role_ids)
    ), '[]'::jsonb) into role_keys;

  return pg_catalog.jsonb_build_object(
    'roleKeys', role_keys,
    'canShare', vortex_platform.grid_view_may_share_internal(),
    'views', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'viewId', listed.view_id,
        'placementId', listed.placement_id,
        'queryId', listed.query_id,
        'name', listed.name,
        'scope', listed.scope,
        'mine', listed.organization_account_id = scope.organization_account_id,
        'revision', listed.revision,
        'shareOrganization', listed.share_organization,
        'shareRoleIds', listed.share_role_ids,
        'shareGroupIds', listed.share_group_ids
      )
        order by listed.placement_id, pg_catalog.lower(listed.name), listed.view_id)
      from (
        select visible.view_id, visible.placement_id, visible.query_id, visible.name,
          visible.scope, visible.organization_account_id, visible.revision,
          visible.share_organization, visible.share_role_ids, visible.share_group_ids
        from vortex_platform.grid_views as visible
        where visible.organization_id = scope.organization_id
          and visible.application_root_id = scope.application_root_id
          and visible.page_id = p_page_id
          and visible.placement_id = p_placement_id
          and visible.kind = 'named_view'
          and (visible.organization_account_id = scope.organization_account_id
            or (visible.scope = 'shared'
              and (visible.share_organization
                or visible.share_role_ids && targets.role_ids
                or visible.share_group_ids && targets.group_ids)))
        order by pg_catalog.lower(visible.name), visible.view_id
        limit 200
      ) as listed
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.list_grid_views(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.list_grid_views(uuid, uuid) to vortex_request;
comment on function vortex_platform.list_grid_views(uuid, uuid) is
  'Lists up to 200 currently visible named views with sharing targets for one placement when its picker opens; no view documents or record data are read.';
alter function vortex_platform.list_grid_views(uuid, uuid) owner to vortex_owner;
