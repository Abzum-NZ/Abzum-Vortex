create or replace function vortex_platform.reset_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
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
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Grid layout reset is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- Serialize creation, updates and deletion of this scope, including when no row exists yet.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    scope.organization_id::text || ':' || scope.organization_account_id::text || ':' ||
    scope.application_root_id::text || ':' || p_page_id::text || ':' || p_placement_id::text,
    0
  ));

  -- Reset removes the person's layout, so the grid shows the authored defaults again.
  delete from vortex_platform.grid_views as held
  where held.organization_id = scope.organization_id
    and held.organization_account_id = scope.organization_account_id
    and held.application_root_id = scope.application_root_id
    and held.page_id = p_page_id
    and held.placement_id = p_placement_id
    and held.kind = 'current_layout'
    and held.revision = p_expected_revision;
  if found then
    return pg_catalog.jsonb_build_object('outcome', 'reset');
  end if;

  select held.* into stored
  from vortex_platform.grid_views as held
  where held.organization_id = scope.organization_id
    and held.organization_account_id = scope.organization_account_id
    and held.application_root_id = scope.application_root_id
    and held.page_id = p_page_id
    and held.placement_id = p_placement_id
    and held.kind = 'current_layout';
  return pg_catalog.jsonb_build_object(
    'outcome', 'conflict',
    'revision', case when found then stored.revision end,
    'queryId', case when found then stored.query_id end,
    'layout', case when found then stored.document end
  );
end
$function$;

revoke all on function vortex_platform.reset_grid_view(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.reset_grid_view(uuid, uuid, bigint) to vortex_request;

comment on function vortex_platform.reset_grid_view(uuid, uuid, bigint) is
  'Removes the current person''s layout of one grid placement at the expected revision, or returns the stored layout as a conflict.';

alter function vortex_platform.reset_grid_view(uuid, uuid, bigint) owner to vortex_owner;
