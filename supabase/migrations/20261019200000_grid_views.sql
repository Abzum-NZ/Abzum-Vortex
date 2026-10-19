-- #3020: a person's own layout of a data grid placement (column order, widths, shown columns and
-- density), kept per organisation account, application installation, page and placement. It is UI
-- preference metadata, never a business record and never row data or a cursor. Named and shared
-- views (#3023) add further kinds to the same table.

-- The referenced tables belong to postgres; the layout table's owner may reference them so a
-- removed account or installation removes its layouts.
grant references (organization_id, organization_account_id)
  on vortex_identity.organization_accounts to vortex_owner;
grant references (organization_id, root_id) on vortex_definition.roots to vortex_owner;

set local role vortex_owner;

-- Revisions never repeat after reset/recreate, so an old tab cannot overwrite a newer layout.
create sequence vortex_platform.grid_view_revision_seq as bigint
  minvalue 1 maxvalue 9007199254740991 no cycle;
revoke all on sequence vortex_platform.grid_view_revision_seq
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

create table vortex_platform.grid_views (
  tenant_id uuid not null,
  organization_id uuid not null,
  organization_account_id uuid not null,
  application_root_id uuid not null,
  page_id uuid not null,
  placement_id uuid not null,
  kind text not null,
  query_id uuid not null,
  revision bigint not null,
  release_revision bigint not null,
  layout jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint grid_views_pk primary key (
    organization_id, organization_account_id, application_root_id, page_id, placement_id, kind
  ),
  constraint grid_views_kind_valid check (kind in ('current_layout')),
  constraint grid_views_revisions_valid check (
    revision between 1 and 9007199254740991
    and release_revision between 1 and 9007199254740991
  ),
  constraint grid_views_layout_bounded check (
    pg_catalog.jsonb_typeof(layout) = 'object'
    and pg_catalog.octet_length(layout::text) <= 16384
  ),
  constraint grid_views_times_valid check (updated_at >= created_at),
  constraint grid_views_account_fk foreign key (organization_id, organization_account_id)
    references vortex_identity.organization_accounts (organization_id, organization_account_id)
    on delete cascade,
  constraint grid_views_installation_fk foreign key (organization_id, application_root_id)
    references vortex_definition.roots (organization_id, root_id)
    on delete cascade
);
alter table vortex_platform.grid_views enable row level security;
alter table vortex_platform.grid_views force row level security;
revoke all on vortex_platform.grid_views
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
create policy grid_views_owner_operations on vortex_platform.grid_views
  to vortex_owner using (true) with check (true);
comment on table vortex_platform.grid_views is
  'A person''s own layouts of data grid placements. Rows are keyed by organisation account, application installation, page and placement, are read and written only by the protected grid layout functions, and are never business records.';

create or replace function vortex_platform.grid_view_scope_internal()
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  application_root_id uuid,
  release_revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  installation jsonb;
begin
  -- The actor and the installation come only from the validated request context: a grid layout
  -- belongs to the person's own organisation account in the one application the request selected.
  checked := vortex_access.validated_human_request_context();
  if not (checked ?& array['tenantId', 'organizationAccountId', 'applicationRootId'])
    or not vortex_platform.is_non_nil_uuid(checked ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(checked ->> 'applicationRootId') then
    raise exception using errcode = '42501', message = 'Grid layout scope is unavailable';
  end if;

  installation := vortex_definition.read_current_active_installation();
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or (installation ->> 'organizationId')::uuid
      is distinct from (checked ->> 'organizationId')::uuid
    or (installation ->> 'applicationRootId')::uuid
      is distinct from (checked ->> 'applicationRootId')::uuid
    or pg_catalog.jsonb_typeof(installation -> 'applicationReleaseRevision')
      is distinct from 'number' then
    raise exception using errcode = '42501', message = 'Grid layout scope is unavailable';
  end if;

  return query select
    (checked ->> 'tenantId')::uuid,
    (checked ->> 'organizationId')::uuid,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'applicationRootId')::uuid,
    (installation ->> 'applicationReleaseRevision')::bigint;
end
$function$;

revoke all on function vortex_platform.grid_view_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_scope_internal() is
  'Resolves the validated human request scope and the active Application installation a grid layout belongs to; owner-only.';

alter function vortex_platform.grid_view_scope_internal() owner to vortex_owner;

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
        or entry.value - array['fieldId', 'visible', 'width'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
        or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
        or pg_catalog.jsonb_typeof(entry.value -> 'visible') is distinct from 'boolean'
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
    'layout', case when found then stored.layout end
  );
end
$function$;

revoke all on function vortex_platform.reset_grid_view(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.reset_grid_view(uuid, uuid, bigint) to vortex_request;

comment on function vortex_platform.reset_grid_view(uuid, uuid, bigint) is
  'Removes the current person''s layout of one grid placement at the expected revision, or returns the stored layout as a conflict.';

alter function vortex_platform.reset_grid_view(uuid, uuid, bigint) owner to vortex_owner;

reset role;
