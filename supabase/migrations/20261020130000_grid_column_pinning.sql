begin;

set local role vortex_owner;

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
    or pg_catalog.octet_length(p_layout::text) > 32768 then
    raise exception using errcode = '22023', message = 'Grid layout write is invalid';
  end if;

  -- The API stores presentation metadata only, even when called directly by the request role.
  if p_layout - array['columns', 'density'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_layout -> 'columns') is distinct from 'array'
    or (p_layout ? 'density' and (pg_catalog.jsonb_typeof(p_layout -> 'density') <> 'string'
      or p_layout ->> 'density' not in ('compact', 'comfortable'))) then
    raise exception using errcode = '22023', message = 'Grid layout shape is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_layout -> 'columns') not between 1 and 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_layout -> 'columns') as entry(value)
      where pg_catalog.jsonb_typeof(entry.value) <> 'object'
        or entry.value - array['fieldId', 'visible', 'width', 'pin'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
        or pg_catalog.jsonb_typeof(entry.value -> 'visible') is distinct from 'boolean'
        or pg_catalog.jsonb_typeof(entry.value -> 'pin') is distinct from 'string'
        or entry.value ->> 'pin' not in ('start', 'end', 'unpinned')
        or (entry.value ? 'width' and case
          when pg_catalog.jsonb_typeof(entry.value -> 'width') = 'number' then
            (entry.value ->> 'width')::numeric not between 64 and 640
            or (entry.value ->> 'width')::numeric <> pg_catalog.trunc((entry.value ->> 'width')::numeric)
          else true end)
    )
    or not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_layout -> 'columns') as entry(value)
      where entry.value -> 'visible' = 'true'::jsonb
    )
    or (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
      from pg_catalog.jsonb_array_elements(p_layout -> 'columns') as entry(value))
      <> pg_catalog.jsonb_array_length(p_layout -> 'columns') then
    raise exception using errcode = '22023', message = 'Grid layout columns are invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- Serialize creation, updates and deletion of this scope, including when no row exists yet.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    scope.organization_id::text || ':' || scope.organization_account_id::text || ':' ||
    scope.application_root_id::text || ':' || p_page_id::text || ':' || p_placement_id::text,
    0
  ));

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
      revision = pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
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
      insert into vortex_platform.grid_views (
        tenant_id, organization_id, organization_account_id, application_root_id,
        page_id, placement_id, kind, query_id, revision, release_revision, layout,
        created_at, updated_at
      ) values (
        scope.tenant_id, scope.organization_id, scope.organization_account_id,
        scope.application_root_id, p_page_id, p_placement_id, 'current_layout', p_query_id,
        pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
        scope.release_revision, p_layout, written_at, written_at
      )
      returning * into stored;
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

reset role;

commit;
