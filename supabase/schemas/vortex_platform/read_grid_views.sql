create or replace function vortex_platform.read_grid_views(
  p_page_id uuid,
  p_placement_ids uuid[],
  p_selected_view_ids uuid[],
  p_default_views jsonb,
  p_record_type_ids uuid[]
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
  shareable uuid[] := '{}'::uuid[];
  installation jsonb;
  access_plan jsonb;
  record_type_id uuid;
  visible_fields jsonb := '{}'::jsonb;
  role_keys jsonb;
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_ids is null
    or pg_catalog.cardinality(p_placement_ids) not between 1 and 500
    or pg_catalog.array_position(p_placement_ids, null) is not null
    or p_selected_view_ids is null
    or pg_catalog.cardinality(p_selected_view_ids) > 500
    or pg_catalog.array_position(p_selected_view_ids, null) is not null
    or p_record_type_ids is null
    or pg_catalog.cardinality(p_record_type_ids) not between 1 and 500
    or pg_catalog.array_position(p_record_type_ids, null) is not null
    or p_default_views is null
    or pg_catalog.jsonb_typeof(p_default_views) is distinct from 'array'
 then
    raise exception using errcode = '22023', message = 'Grid view read is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_default_views) > 10000 or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    where pg_catalog.jsonb_typeof(supplied.value) is distinct from 'object'
      or supplied.value - array['viewId', 'placementId', 'role', 'isDefault', 'selectedViewId', 'queryId', 'document'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(supplied.value -> 'viewId') is distinct from 'string'
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'placementId')
      or not ((supplied.value ->> 'placementId')::uuid = any(p_placement_ids))
      or pg_catalog.jsonb_typeof(supplied.value -> 'role') is distinct from 'string'
      or pg_catalog.jsonb_typeof(supplied.value -> 'isDefault') is distinct from 'boolean'
      or not (supplied.value ? 'selectedViewId')
      or (supplied.value -> 'selectedViewId' <> 'null'::jsonb
        and not vortex_platform.is_non_nil_uuid(supplied.value ->> 'selectedViewId'))
      or pg_catalog.jsonb_typeof(supplied.value -> 'queryId') is distinct from 'string'
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'viewId')
      or not vortex_platform.is_non_nil_uuid(supplied.value ->> 'queryId')
      or not vortex_platform.grid_view_document_valid_internal(supplied.value -> 'document', 'named_view')
  ) then
    raise exception using errcode = '22023', message = 'Grid default view read is invalid';
  end if;
  if (select pg_catalog.count(distinct pg_catalog.lower(supplied.value ->> 'viewId'))
      from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value))
    <> pg_catalog.jsonb_array_length(p_default_views) then
    raise exception using errcode = '22023', message = 'Grid default view identities are duplicated';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;
  select viewer.* into strict targets from vortex_platform.grid_view_viewer_targets_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id
  ) as viewer;

  if vortex_platform.grid_view_may_share_internal() then
    shareable := p_placement_ids;
  end if;

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

  installation := vortex_definition.read_current_active_installation();
  access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
  -- One column decision per record type of this layout request, by access route, from the plan
  -- resolved once here; it stays a local value and never enters caller-writable state.
  for record_type_id in select distinct id from pg_catalog.unnest(p_record_type_ids) as requested(id)
  loop
    visible_fields := visible_fields || pg_catalog.jsonb_build_object(
      pg_catalog.lower(record_type_id::text),
      vortex_record.resolve_record_type_visible_field_ids_internal(record_type_id, access_plan)
    );
  end loop;

  -- The visible grids need their layouts and selected/automatic view documents only. The picker
  -- inventory is read separately when opened. The automatic default also supplies the reset
  -- baseline while a personal layout is stored; this reads configuration, never record rows.
  return pg_catalog.jsonb_build_object(
    'visibleFields', visible_fields,
    'defaultDocuments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('viewId', supplied.value ->> 'viewId')
        || vortex_platform.grid_view_document_for_viewer_internal(
          (supplied.value ->> 'queryId')::uuid, supplied.value -> 'document', installation, access_plan,
          visible_fields
        )
      )
      from pg_catalog.jsonb_array_elements(p_default_views) with ordinality as supplied(value, position)
      where (supplied.value ->> 'role' = '*' or role_keys ? (supplied.value ->> 'role'))
        and (
          supplied.value ->> 'viewId' = supplied.value ->> 'selectedViewId'
          or (supplied.value -> 'selectedViewId' = 'null'::jsonb
            and (supplied.value ->> 'isDefault')::boolean
            and supplied.position = (
              select candidate.position
              from pg_catalog.jsonb_array_elements(p_default_views) with ordinality as candidate(value, position)
              where candidate.value ->> 'placementId' = supplied.value ->> 'placementId'
                and (candidate.value ->> 'role' = '*' or role_keys ? (candidate.value ->> 'role'))
                and (candidate.value ->> 'isDefault')::boolean
              order by (candidate.value ->> 'role' = '*'), candidate.position
              limit 1
            ))
        )
    ), '[]'::jsonb),
    'roleKeys', role_keys,
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
      ) || vortex_platform.grid_view_document_for_viewer_internal(
          listed.query_id, listed.document, installation, access_plan, visible_fields
        )
        order by listed.placement_id, pg_catalog.lower(listed.name), listed.view_id)
      from (
        select visible.*
        from vortex_platform.grid_views as visible
        where visible.organization_id = scope.organization_id
          and visible.application_root_id = scope.application_root_id
          and visible.page_id = p_page_id
          and visible.placement_id = any (p_placement_ids)
          and visible.kind = 'named_view'
          and visible.view_id = any(p_selected_view_ids)
          and (visible.organization_account_id = scope.organization_account_id
            or (visible.scope = 'shared'
              and (visible.share_organization
                or visible.share_role_ids && targets.role_ids
                or visible.share_group_ids && targets.group_ids)))
      ) as listed
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) to vortex_request;

comment on function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) is
  'Reads current layouts, readable columns, role keys and selected or automatic reset-baseline view documents for the visible page; the picker inventory is read on demand.';

alter function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb, uuid[]) owner to vortex_owner;
