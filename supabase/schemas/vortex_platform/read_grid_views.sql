create or replace function vortex_platform.read_grid_views(
  p_page_id uuid,
  p_placement_ids uuid[],
  p_selected_view_ids uuid[],
  p_share_permissions jsonb
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
  declared record;
  shareable uuid[] := '{}'::uuid[];
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_ids is null
    or pg_catalog.cardinality(p_placement_ids) not between 1 and 500
    or pg_catalog.array_position(p_placement_ids, null) is not null
    or p_selected_view_ids is null
    or pg_catalog.cardinality(p_selected_view_ids) > 500
    or pg_catalog.array_position(p_selected_view_ids, null) is not null
    or p_share_permissions is null
    or pg_catalog.jsonb_typeof(p_share_permissions) <> 'object'
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_share_permissions) as supplied(key)
      where not vortex_platform.is_non_nil_uuid(supplied.key)
    ) then
    raise exception using errcode = '22023', message = 'Grid view read is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;
  select viewer.* into strict targets from vortex_platform.grid_view_viewer_targets_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id
  ) as viewer;

  -- The placements whose tables name a share permission the person holds now.
  for declared in
    select named.key, named.value from pg_catalog.jsonb_each(p_share_permissions) as named
    limit 500
  loop
    if declared.key::uuid = any (p_placement_ids)
      and vortex_platform.grid_view_may_share_internal(scope.application_root_id, declared.value) then
      shareable := pg_catalog.array_append(shareable, declared.key::uuid);
    end if;
  end loop;

  -- The person's current layouts and every named view they may see, for all the page's grids, in
  -- one bounded read. Only the views the address selected carry their document.
  return pg_catalog.jsonb_build_object(
    'shareablePlacementIds', pg_catalog.to_jsonb(shareable),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'placementId', stored.placement_id,
        'queryId', stored.query_id,
        'revision', stored.revision,
        'basedOnViewId', stored.based_on_view_id,
        'layout', stored.document
      ) order by stored.placement_id)
      from vortex_platform.grid_views as stored
      where stored.organization_id = scope.organization_id
        and stored.organization_account_id = scope.organization_account_id
        and stored.application_root_id = scope.application_root_id
        and stored.page_id = p_page_id
        and stored.placement_id = any (p_placement_ids)
        and stored.kind = 'current_layout'
    ), '[]'::jsonb),
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
      ) || case when listed.view_id = any (p_selected_view_ids)
        then pg_catalog.jsonb_build_object('document', listed.document) else '{}'::jsonb end
        order by listed.placement_id, pg_catalog.lower(listed.name), listed.view_id)
      from (
        select visible.*, pg_catalog.row_number() over (
          partition by visible.placement_id
          order by pg_catalog.lower(visible.name), visible.view_id
        ) as position
        from vortex_platform.grid_views as visible
        where visible.organization_id = scope.organization_id
          and visible.application_root_id = scope.application_root_id
          and visible.page_id = p_page_id
          and visible.placement_id = any (p_placement_ids)
          and visible.kind = 'named_view'
          and (visible.organization_account_id = scope.organization_account_id
            or (visible.scope = 'shared'
              and (visible.share_organization
                or visible.share_role_ids && targets.role_ids
                or visible.share_group_ids && targets.group_ids)))
      ) as listed
      where listed.position <= 200
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) to vortex_request;

comment on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) is
  'Reads the current person''s current grid layouts and the named views they may see for the named placements of one page of the selected application, in one bounded call.';

alter function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) owner to vortex_owner;
