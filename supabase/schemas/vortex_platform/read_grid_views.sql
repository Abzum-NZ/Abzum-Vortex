create or replace function vortex_platform.read_grid_views(
  p_page_id uuid,
  p_placement_ids uuid[]
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
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_ids is null
    or pg_catalog.cardinality(p_placement_ids) not between 1 and 500
    or pg_catalog.array_position(p_placement_ids, null) is not null then
    raise exception using errcode = '22023', message = 'Grid layout read is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- Every requested placement's current layout of this person, in one bounded read.
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'placementId', stored.placement_id,
      'queryId', stored.query_id,
      'revision', stored.revision,
      'layout', stored.layout
    ) order by stored.placement_id)
    from vortex_platform.grid_views as stored
    where stored.organization_id = scope.organization_id
      and stored.organization_account_id = scope.organization_account_id
      and stored.application_root_id = scope.application_root_id
      and stored.page_id = p_page_id
      and stored.placement_id = any (p_placement_ids)
      and stored.kind = 'current_layout'
  ), '[]'::jsonb);
end
$function$;

revoke all on function vortex_platform.read_grid_views(uuid, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.read_grid_views(uuid, uuid[]) to vortex_request;

comment on function vortex_platform.read_grid_views(uuid, uuid[]) is
  'Reads the current person''s current grid layouts for the named placements of one page of the selected application, in one bounded call.';

alter function vortex_platform.read_grid_views(uuid, uuid[]) owner to vortex_owner;
