create or replace function vortex_platform.delete_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_view_id uuid,
  p_expected_revision bigint
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
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text)
    or p_view_id is null or not vortex_platform.is_non_nil_uuid(p_view_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Grid view delete is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

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
  if stored.organization_account_id <> scope.organization_account_id
    and not vortex_platform.grid_view_may_share_internal() then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;
  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'revision', stored.revision, 'name', stored.name,
      'queryId', stored.query_id);
  end if;

  -- Layouts that derived from the view stay as the arrangements they are (the key is set null).
  delete from vortex_platform.grid_views as held where held.view_id = stored.view_id;
  return pg_catalog.jsonb_build_object('outcome', 'deleted');
end
$function$;

revoke all on function vortex_platform.delete_grid_view(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.delete_grid_view(uuid, uuid, uuid, bigint)
  to vortex_request;

comment on function vortex_platform.delete_grid_view(uuid, uuid, uuid, bigint) is
  'Deletes a named grid view at the expected revision for its owner or someone who may share table views.';

alter function vortex_platform.delete_grid_view(uuid, uuid, uuid, bigint)
  owner to vortex_owner;
