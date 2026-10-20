create or replace function vortex_platform.share_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_view_id uuid,
  p_expected_revision bigint,
  p_share_organization boolean,
  p_role_ids uuid[],
  p_group_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_platform.grid_views%rowtype;
  shared boolean;
  known_roles bigint;
  known_groups bigint;
  written_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text)
    or p_view_id is null or not vortex_platform.is_non_nil_uuid(p_view_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or p_share_organization is null
    or p_role_ids is null or pg_catalog.cardinality(p_role_ids) > 50
    or pg_catalog.array_position(p_role_ids, null) is not null
    or p_group_ids is null or pg_catalog.cardinality(p_group_ids) > 50
    or pg_catalog.array_position(p_group_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Grid view share is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- Sharing is the permission's to give: nobody shares a table view without it.
  if not vortex_platform.grid_view_may_share_internal() then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    scope.organization_id::text || ':' || scope.application_root_id::text || ':' ||
    p_page_id::text || ':' || p_placement_id::text || ':views',
    0
  ));

  if not vortex_platform.grid_view_visible_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id,
    p_page_id, p_placement_id, p_view_id
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  select held.* into stored
  from vortex_platform.grid_views as held
  where held.view_id = p_view_id and held.organization_id = scope.organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'revision', stored.revision, 'name', stored.name,
      'queryId', stored.query_id);
  end if;

  shared := p_share_organization
    or pg_catalog.cardinality(p_role_ids) > 0
    or pg_catalog.cardinality(p_group_ids) > 0;

  -- Targets are roles of this application (or custom roles) and groups of this organisation.
  select pg_catalog.count(*) into known_roles
  from vortex_access.organization_roles as target_role
  where target_role.organization_id = scope.organization_id
    and target_role.role_id = any (p_role_ids)
    and (target_role.application_root_id is null
      or target_role.application_root_id = scope.application_root_id);
  select pg_catalog.count(*) into known_groups
  from vortex_access.organization_groups as target_group
  where target_group.organization_id = scope.organization_id
    and target_group.group_id = any (p_group_ids)
    and target_group.state = 'active';
  if known_roles <> (select pg_catalog.count(distinct role_id) from pg_catalog.unnest(p_role_ids) as role_id)
    or known_groups <> (select pg_catalog.count(distinct group_id) from pg_catalog.unnest(p_group_ids) as group_id) then
    return pg_catalog.jsonb_build_object('outcome', 'target_unknown');
  end if;

  update vortex_platform.grid_views as held
  set scope = case when shared then 'shared' else 'personal' end,
    share_organization = p_share_organization,
    share_role_ids = (select coalesce(pg_catalog.array_agg(distinct role_id), '{}'::uuid[])
      from pg_catalog.unnest(p_role_ids) as role_id),
    share_group_ids = (select coalesce(pg_catalog.array_agg(distinct group_id), '{}'::uuid[])
      from pg_catalog.unnest(p_group_ids) as group_id),
    revision = pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
    updated_at = written_at
  where held.view_id = stored.view_id
  returning held.* into stored;

  return pg_catalog.jsonb_build_object('outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
end
$function$;

revoke all on function vortex_platform.share_grid_view(uuid, uuid, uuid, bigint, boolean, uuid[], uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.share_grid_view(uuid, uuid, uuid, bigint, boolean, uuid[], uuid[])
  to vortex_request;

comment on function vortex_platform.share_grid_view(uuid, uuid, uuid, bigint, boolean, uuid[], uuid[]) is
  'Shares a grid view with the organisation, roles or groups, or makes it personal again, at the expected revision, for someone who may share table views.';

alter function vortex_platform.share_grid_view(uuid, uuid, uuid, bigint, boolean, uuid[], uuid[])
  owner to vortex_owner;
