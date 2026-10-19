create or replace function vortex_platform.write_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_query_id uuid,
  p_expected_revision bigint,
  p_layout jsonb
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
  held_found boolean;
  written_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text)
    or p_query_id is null or not vortex_platform.is_non_nil_uuid(p_query_id::text)
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990)
    or p_layout is null or pg_catalog.jsonb_typeof(p_layout) <> 'object'
    or pg_catalog.octet_length(p_layout::text) > 16384 then
    raise exception using errcode = '22023', message = 'Grid layout write is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  select held.* into stored
  from vortex_platform.grid_views as held
  where held.organization_id = scope.organization_id
    and held.organization_account_id = scope.organization_account_id
    and held.application_root_id = scope.application_root_id
    and held.page_id = p_page_id
    and held.placement_id = p_placement_id
    and held.kind = 'current_layout'
  for update;
  held_found := found;

  -- The write names the revision it was made from (none for a first write); a newer layout from
  -- another tab is never overwritten, it is returned as the conflict.
  if held_found <> (p_expected_revision is not null)
    or (held_found and stored.revision <> p_expected_revision) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'revision', case when held_found then stored.revision end,
      'queryId', case when held_found then stored.query_id end,
      'layout', case when held_found then stored.layout end
    );
  end if;

  if held_found then
    update vortex_platform.grid_views as held
    set query_id = p_query_id,
      revision = held.revision + 1,
      release_revision = scope.release_revision,
      layout = p_layout,
      updated_at = written_at
    where held.organization_id = stored.organization_id
      and held.organization_account_id = stored.organization_account_id
      and held.application_root_id = stored.application_root_id
      and held.page_id = stored.page_id
      and held.placement_id = stored.placement_id
      and held.kind = stored.kind
    returning held.* into stored;
  else
    begin
      insert into vortex_platform.grid_views (
        tenant_id, organization_id, organization_account_id, application_root_id,
        page_id, placement_id, kind, query_id, revision, release_revision, layout,
        created_at, updated_at
      ) values (
        scope.tenant_id, scope.organization_id, scope.organization_account_id,
        scope.application_root_id, p_page_id, p_placement_id, 'current_layout', p_query_id,
        1, scope.release_revision, p_layout, written_at, written_at
      )
      returning * into stored;
    exception
      when unique_violation then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'revision', null, 'queryId', null, 'layout', null
        );
    end;
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', stored.revision);
end
$function$;

revoke all on function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, jsonb)
  to vortex_request;

comment on function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, jsonb) is
  'Writes the current person''s current layout of one grid placement at the expected revision (none for a first write), or returns the stored layout as a conflict.';

alter function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, jsonb)
  owner to vortex_owner;
