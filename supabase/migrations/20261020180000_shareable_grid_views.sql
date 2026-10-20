-- #3023: shareable named views of a data grid in the one grid view store. A row is either a
-- person's current layout or a named view (personal, or shared with the organisation, roles or
-- groups). Both hold presentation configuration only, never row data, a cursor or a permission.
-- The store is preference metadata, so existing rows are removed rather than converted.

-- The unchanged helper belongs to the restricted record adapter. Grant execution as
-- that owner before creating the platform-owned view functions.
set local role vortex_record_adapter;
grant execute on function vortex_record.record_type_read_declaration_internal(jsonb, uuid, uuid) to vortex_owner;
reset role;

set local role vortex_owner;

delete from vortex_platform.grid_views;

alter table vortex_platform.grid_views
  drop constraint grid_views_pk,
  drop constraint grid_views_kind_valid,
  drop constraint grid_views_layout_bounded;
alter table vortex_platform.grid_views rename column layout to document;
alter table vortex_platform.grid_views
  add column view_id uuid not null,
  add column name text,
  add column scope text,
  add column share_organization boolean not null default false,
  add column share_role_ids uuid[] not null default '{}',
  add column share_group_ids uuid[] not null default '{}',
  add column based_on_view_id uuid;

alter table vortex_platform.grid_views
  add constraint grid_views_pk primary key (view_id),
  add constraint grid_views_kind_valid check (kind in ('current_layout', 'named_view')),
  add constraint grid_views_document_bounded check (
    pg_catalog.jsonb_typeof(document) = 'object'
    and pg_catalog.octet_length(document::text) <= 32768
  ),
  add constraint grid_views_shape_valid check (
    (kind = 'current_layout'
      and name is null and scope is null
      and not share_organization
      and share_role_ids = '{}' and share_group_ids = '{}')
    or (kind = 'named_view'
      and name is not null
      and pg_catalog.char_length(name) between 1 and 80
      and based_on_view_id is null
      and ((scope = 'personal'
          and not share_organization
          and share_role_ids = '{}' and share_group_ids = '{}')
        or (scope = 'shared'
          and (share_organization
            or pg_catalog.cardinality(share_role_ids) > 0
            or pg_catalog.cardinality(share_group_ids) > 0))))
  ),
  add constraint grid_views_based_on_fk foreign key (based_on_view_id)
    references vortex_platform.grid_views (view_id) on delete set null;

-- One current layout per person and placement; the named views of a placement are listed by it.
create unique index grid_views_one_current_layout on vortex_platform.grid_views (
  organization_id, organization_account_id, application_root_id, page_id, placement_id
) where kind = 'current_layout';
create index grid_views_placement_views on vortex_platform.grid_views (
  organization_id, application_root_id, page_id, placement_id
) where kind = 'named_view';

comment on table vortex_platform.grid_views is
  'Layouts and named views of data grid placements. A row is a person''s current layout or a named view that is personal or shared with the organisation, roles or groups; rows are read and written only by the protected grid view functions and are never business records.';

drop function vortex_platform.read_grid_views(uuid, uuid[]);
drop function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, jsonb);

insert into vortex_access.platform_permission_declarations (
  owner_kind, owner_id, permission_id, permission_key, action_kind, label, description,
  meaning_fingerprint, source_module_key, steward_minimum, first_revision
)
select 'platform', declaration.owner_id, 'ca1fb1ae-056c-4596-9c70-36a42c0de87b'::uuid,
  'platform.records.views.share', 'manage', 'Share table views',
  'Share saved table views and change views shared with you in the organisation.',
  'sha256:e27ea30745aee8351f5f0b62fb47319477c76c4cfa73cbaf8fa8edbdbb1c8e9d',
  declaration.source_module_key, false, 6
from vortex_access.platform_permission_declarations as declaration
where declaration.permission_key = 'platform.organization.permissions.read';

create or replace function vortex_access.read_platform_permission_declaration_catalogue_internal(
  p_registration_revision bigint
)
returns table (
  declared_current_revision bigint,
  registration_revision bigint,
  source_version text,
  catalogue_fingerprint text,
  permission_id uuid,
  permission_key text,
  action_kind text,
  label text,
  description text,
  meaning_fingerprint text,
  steward_minimum boolean,
  first_revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with declarations as materialized (
    select declaration.*
    from vortex_access.platform_permission_declarations as declaration
    where declaration.owner_kind = 'platform'
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      and declaration.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ),
  valid as (
    select p_registration_revision = 6
      and pg_catalog.count(*) = 23
      and pg_catalog.count(distinct permission_id) = 23
      and pg_catalog.count(distinct permission_key) = 23
      and pg_catalog.count(*) filter (where action_kind = 'named') = 0
      and pg_catalog.bool_and(first_revision between 1 and 6)
      as is_valid
    from declarations
  )
  select 6::bigint, 6::bigint, '1.4.0'::text,
    'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538'::text,
    declaration.permission_id, declaration.permission_key,
    declaration.action_kind, declaration.label, declaration.description,
    declaration.meaning_fingerprint, declaration.steward_minimum,
    declaration.first_revision
  from declarations as declaration
  cross join valid
  where valid.is_valid
$function$;

alter function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  owner to vortex_owner;

revoke all on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint)
  to postgres;
comment on function vortex_access.read_platform_permission_declaration_catalogue_internal(bigint) is
  'Returns the trusted current platform permission declaration catalogue to the authorized postgres caller.';

create or replace function vortex_access.platform_permission_catalogue_revision_is_exact(
  p_organization_id uuid,
  p_registration_revision bigint
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
      as declaration
  ),
  entries as materialized (
    select entry.*
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      and entry.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and entry.registration_revision = 6
  )
  select coalesce(
    p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and p_registration_revision = 6
    and (select pg_catalog.count(*) from expected) = 23
    and (select pg_catalog.count(*) from entries) = 23
    and exists (
      select 1
      from vortex_access.permission_registrations as registration
      join vortex_access.permission_registration_revisions as history
        on history.organization_id = registration.organization_id
        and history.registration_kind = registration.registration_kind
        and history.registration_owner_id = registration.registration_owner_id
        and history.revision = registration.revision
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'platform'
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        and registration.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        and registration.state = 'active'
        and registration.revision = 6
        and registration.source_definition_key is null
        and registration.source_version = '1.4.0'
        and registration.source_revision is null
        and registration.validation_contract_version is null
        and registration.permission_catalogue_fingerprint =
          'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538'
        and registration.candidate_fingerprint = registration.permission_catalogue_fingerprint
        and registration.changed_by is not null
        and registration.change_correlation_id is not null
        and history.operation = 'platform_initialize'
        and row(history.state, history.source_definition_key, history.source_version,
          history.source_revision, history.validation_contract_version,
          history.permission_catalogue_fingerprint, history.candidate_fingerprint,
          history.changed_at, history.changed_by, history.change_correlation_id)
          is not distinct from row(registration.state, registration.source_definition_key,
          registration.source_version, registration.source_revision,
          registration.validation_contract_version,
          registration.permission_catalogue_fingerprint, registration.candidate_fingerprint,
          registration.changed_at, registration.changed_by, registration.change_correlation_id)
    )
    and not exists (
      select 1
      from vortex_access.permission_registration_revisions as history
      where history.organization_id = p_organization_id
        and history.registration_kind = 'platform'
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        and history.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
        and history.revision <> 6
    )
    and not exists (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.permission_key, entry.label, entry.description,
        entry.record_type_id, entry.record_scope, entry.field_policy,
        entry.action_kind, entry.named_action, entry.administrative,
        entry.source_kind, entry.source_definition_key, entry.source_root_id,
        entry.source_version, entry.source_revision,
        entry.source_validation_contract_version, entry.source_catalogue_fingerprint,
        entry.meaning_fingerprint
      from entries as entry
      except all
      select null::uuid, 'platform'::text,
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid,
        expected.permission_id, expected.permission_key, expected.label,
        expected.description, null::uuid, null::jsonb, null::jsonb,
        expected.action_kind, null::text, true, 'platform_catalogue'::text,
        null::text, null::uuid, expected.source_version, null::bigint,
        null::text, expected.catalogue_fingerprint, expected.meaning_fingerprint
      from expected
    )
    and (select pg_catalog.count(*) from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        and continuity.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid) = 23
    and not exists (
      select 1 from expected
      where not exists (
        select 1 from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id is null
          and continuity.registration_kind = 'platform'
          -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
          and continuity.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
          and continuity.owner_kind = 'platform'
          and continuity.owner_id = continuity.registration_owner_id
          and continuity.permission_id = expected.permission_id
          and continuity.meaning_fingerprint = expected.meaning_fingerprint
          and continuity.state = 'available'
          and continuity.continuity_revision > 0
          and continuity.last_processed_registration_revision = 6
      )
    ), false
  )
$function$;

revoke all on function
  vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint) is
  'Owner-only assertion for the current platform catalogue registration, entries and continuities.';

alter function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  owner to vortex_owner;

grant execute on function vortex_access.platform_permission_catalogue_revision_is_exact(uuid, bigint)
  to postgres;

create or replace function vortex_access.initialize_platform_permission_catalogue(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  organization_id uuid,
  registration_revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_registration vortex_access.permission_registrations%rowtype;
  resulting_version bigint;
  expected_count bigint;
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  catalogue_fingerprint constant text :=
    'sha256:60d2c42cab03723fda56198083a70e8703792587546379372334d99609b15538';
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Platform permission registration input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Platform permission registration scope is unavailable';
  end if;

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', p_organization_id::text, true
  );

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
  for update;
  if found then
    if not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, 6
    ) then
      raise exception using errcode = '55000',
        message = 'Platform permission registration evidence is invalid';
    end if;
    return query select p_organization_id, 6::bigint, version.current_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return;
  end if;

  select pg_catalog.count(*) into expected_count
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6);
  if expected_count <> 23 then
    raise exception using errcode = '55000',
      message = 'Platform permission declarations are invalid';
  end if;

  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 6,
    'active', 'platform_initialize', null, '1.4.0', null, null,
    catalogue_fingerprint, catalogue_fingerprint, operation_at, p_changed_by,
    p_correlation_id
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    record_scope, field_policy, action_kind, named_action, administrative,
    source_kind, source_definition_key, source_root_id, source_version,
    source_revision, source_validation_contract_version,
    source_catalogue_fingerprint, meaning_fingerprint
  )
  select p_organization_id, 'platform', platform_owner_id, 6,
    null, 'platform', platform_owner_id, declaration.permission_id,
    declaration.permission_key, declaration.label, declaration.description,
    null, null, null, declaration.action_kind, null, true,
    'platform_catalogue', null, null, declaration.source_version,
    null, null, declaration.catalogue_fingerprint,
    declaration.meaning_fingerprint
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
    as declaration;

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state, revision,
    source_definition_key, source_version, source_revision,
    validation_contract_version, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'platform', platform_owner_id, 'active', 6,
    null, '1.4.0', null, null, catalogue_fingerprint,
    catalogue_fingerprint, operation_at, p_changed_by, p_correlation_id
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select p_organization_id, null, 'platform', platform_owner_id,
    declaration.permission_id, 'platform', platform_owner_id, 'available',
    1, declaration.meaning_fingerprint, 6, operation_at
  from vortex_access.read_platform_permission_declaration_catalogue_internal(6)
    as declaration;

  if not vortex_access.platform_permission_catalogue_revision_is_exact(
    p_organization_id, 6
  ) then
    raise exception using errcode = '55000',
      message = 'Platform permission registration evidence is invalid';
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'application_access_changed'
  ) as incremented;
  return query select p_organization_id, 6::bigint, resulting_version;
end
$function$;

revoke all on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid) is
  'Owner-only initializer for the current platform permission catalogue.';

alter function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  owner to vortex_owner;

grant execute on function vortex_access.initialize_platform_permission_catalogue(uuid, uuid, uuid)
  to postgres;

create or replace function vortex_platform.grid_view_document_valid_internal(
  p_document jsonb,
  p_kind text
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_document is not null
    and pg_catalog.jsonb_typeof(p_document) = 'object'
    and pg_catalog.octet_length(p_document::text) <= 32768
    -- A current layout holds the arrangement only; a named view adds the query state.
    and not exists (
      select 1 from pg_catalog.jsonb_object_keys(p_document) as supplied(key)
      where supplied.key <> all (case p_kind
        when 'current_layout' then array['columns', 'density']
        else array['columns', 'density', 'sort', 'filters', 'search'] end)
    )
    and pg_catalog.jsonb_typeof(p_document -> 'columns') = 'array'
    and pg_catalog.jsonb_array_length(p_document -> 'columns') between 1 and 200
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value)
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
    and exists (
      select 1 from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value)
      where entry.value -> 'visible' = 'true'::jsonb
    )
    and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
      from pg_catalog.jsonb_array_elements(p_document -> 'columns') as entry(value))
      = pg_catalog.jsonb_array_length(p_document -> 'columns')
    and (not p_document ? 'density' or (
      pg_catalog.jsonb_typeof(p_document -> 'density') = 'string'
      and p_document ->> 'density' in ('compact', 'comfortable')))
    and (not p_document ? 'sort' or (
      pg_catalog.jsonb_typeof(p_document -> 'sort') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'sort') between 1 and 20
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'sort') as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or entry.value - array['fieldId', 'direction'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
          or coalesce(entry.value ->> 'direction' <> all (array['ascending', 'descending']), true)
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
        from pg_catalog.jsonb_array_elements(p_document -> 'sort') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'sort')))
    and (not p_document ? 'filters' or (
      pg_catalog.jsonb_typeof(p_document -> 'filters') = 'array'
      and pg_catalog.jsonb_array_length(p_document -> 'filters') between 1 and 50
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_document -> 'filters') as entry(value)
        where pg_catalog.jsonb_typeof(entry.value) <> 'object'
          or entry.value - array['fieldId', 'filter'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(entry.value -> 'fieldId') is distinct from 'string'
          or not vortex_platform.is_non_nil_uuid(entry.value ->> 'fieldId')
          or pg_catalog.jsonb_typeof(entry.value -> 'filter') is distinct from 'string'
          or pg_catalog.char_length(entry.value ->> 'filter') not between 1 and 4000
      )
      and (select pg_catalog.count(distinct pg_catalog.lower(entry.value ->> 'fieldId'))
        from pg_catalog.jsonb_array_elements(p_document -> 'filters') as entry(value))
        = pg_catalog.jsonb_array_length(p_document -> 'filters')))
    and (not p_document ? 'search' or (
      pg_catalog.jsonb_typeof(p_document -> 'search') = 'string'
      and pg_catalog.char_length(p_document ->> 'search') between 1 and 200)), false)
$function$;

revoke all on function vortex_platform.grid_view_document_valid_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_document_valid_internal(jsonb, text) is
  'Whether a grid view document holds only the arrangement and, for a named view, the query state the platform stores; owner-only.';

alter function vortex_platform.grid_view_document_valid_internal(jsonb, text) owner to vortex_owner;

create or replace function vortex_platform.grid_view_may_share_internal()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decided text;
begin
  select decision.outcome into decided
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.records.views.share',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.records.views.share'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as decision;
  return decided = 'eligible';
end
$function$;

revoke all on function vortex_platform.grid_view_may_share_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_may_share_internal() owner to vortex_owner;

create or replace function vortex_platform.grid_view_viewer_targets_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns table (role_ids uuid[], group_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $function$
  with groups as (
    select membership.group_id
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as member_group
      on member_group.organization_id = membership.organization_id
      and member_group.group_id = membership.group_id
      and member_group.state = 'active'
    where membership.organization_id = p_organization_id
      and membership.organization_account_id = p_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= pg_catalog.statement_timestamp()
      and (membership.expires_at is null or membership.expires_at > pg_catalog.statement_timestamp())
  ), roles as (
    select assignment.role_id
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as assigned_role
      on assigned_role.organization_id = assignment.organization_id
      and assigned_role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = assigned_role.organization_id
      and revision.role_id = assigned_role.role_id
      and revision.revision = assigned_role.live_revision
      and revision.lifecycle in ('active', 'acceptance_required')
    where assignment.organization_id = p_organization_id
      and assignment.state = 'live'
      and assignment.assignment_kind = 'standing'
      and assignment.starts_at <= pg_catalog.statement_timestamp()
      and (assignment.expires_at is null or assignment.expires_at > pg_catalog.statement_timestamp())
      and (assigned_role.application_root_id is null
        or assigned_role.application_root_id = p_application_root_id)
      and ((assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = p_organization_account_id)
        or (assignment.assignee_kind = 'group'
          and assignment.group_id in (select member.group_id from groups as member)))
  )
  select
    coalesce((select pg_catalog.array_agg(distinct held.role_id) from roles as held), '{}'::uuid[]),
    coalesce((select pg_catalog.array_agg(member.group_id) from groups as member), '{}'::uuid[])
$function$;

revoke all on function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid) is
  'The roles of the application and the groups the account holds now, which decide the shared grid views it sees; owner-only.';

alter function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid)
  owner to vortex_owner;

create or replace function vortex_platform.grid_view_visible_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid,
  p_page_id uuid,
  p_placement_id uuid,
  p_view_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_platform.grid_views as candidate
    cross join lateral vortex_platform.grid_view_viewer_targets_internal(
      p_organization_id, p_organization_account_id, p_application_root_id
    ) as targets
    where candidate.view_id = p_view_id
      and candidate.organization_id = p_organization_id
      and candidate.application_root_id = p_application_root_id
      and candidate.page_id = p_page_id
      and candidate.placement_id = p_placement_id
      and candidate.kind = 'named_view'
      and (candidate.organization_account_id = p_organization_account_id
        or (candidate.scope = 'shared'
          and (candidate.share_organization
            or candidate.share_role_ids && targets.role_ids
            or candidate.share_group_ids && targets.group_ids)))
  )
$function$;

revoke all on function vortex_platform.grid_view_visible_internal(uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_visible_internal(uuid, uuid, uuid, uuid, uuid, uuid) is
  'Whether the account owns the named grid view or it is shared with them now; owner-only.';

alter function vortex_platform.grid_view_visible_internal(uuid, uuid, uuid, uuid, uuid, uuid)
  owner to vortex_owner;

create or replace function vortex_platform.grid_view_document_for_viewer_internal(
  p_query_id uuid, p_document jsonb, p_installation jsonb, p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type_id uuid;
  declaration jsonb;
  eligibility jsonb;
  readable text[] := '{}'::text[];
  filters jsonb;
  omitted integer;
  document jsonb := p_document;
begin
  if not (p_document ? 'filters') then
    return pg_catalog.jsonb_build_object('document', document, 'hiddenFilters', 0);
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Resolve only releases pinned by this validated installation, including record-type listings.
  select target.record_type_id into record_type_id
  from (
    select distinct (query.value #>> '{recordType,recordTypeId}')::uuid as record_type_id
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as binding(value)
    join vortex_definition.releases as release
      on release.root_id = (binding.value ->> 'moduleRootId')::uuid
      and release.release_revision = (binding.value ->> 'moduleReleaseRevision')::bigint
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,queries}'
    ) as query(value)
    where (query.value ->> 'queryId')::uuid = p_query_id
    union
    select p_query_id
    where p_plan -> 'recordTypes' ? pg_catalog.lower(p_query_id::text)
  ) as target;
  if record_type_id is not null then
    declaration := vortex_record.record_type_read_declaration_internal(
      p_plan, record_type_id, (context_value ->> 'applicationRootId')::uuid
    );
    if declaration is not null then
      -- Reuse the query engine's current field bounds, including direct-share restrictions.
      eligibility := vortex_access.resolve_record_read_field_bounds_internal(declaration);
      select coalesce(pg_catalog.array_agg(pg_catalog.lower(field.value)), '{}'::text[])
      into readable
      from pg_catalog.jsonb_array_elements_text(eligibility -> 'readableFieldIds') as field(value);
    end if;
  end if;
  select coalesce(pg_catalog.jsonb_agg(filter.value order by filter.ordinal), '[]'::jsonb)
  into filters
  from pg_catalog.jsonb_array_elements(p_document -> 'filters')
    with ordinality as filter(value, ordinal)
  where pg_catalog.lower(filter.value ->> 'fieldId') = any(readable);
  omitted := pg_catalog.jsonb_array_length(p_document -> 'filters') - pg_catalog.jsonb_array_length(filters);
  document := document - 'filters';
  if pg_catalog.jsonb_array_length(filters) > 0 then
    document := document || pg_catalog.jsonb_build_object('filters', filters);
  end if;
  return pg_catalog.jsonb_build_object('document', document, 'hiddenFilters', omitted);
end
$function$;

revoke all on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb)
  owner to vortex_owner;
comment on function vortex_platform.grid_view_document_for_viewer_internal(uuid, jsonb, jsonb, jsonb) is
  'Removes saved filter values outside the current reader permission field policy before a selected document leaves the database; owner-only, with a count for the omission notice.';

create or replace function vortex_platform.read_grid_views(
  p_page_id uuid,
  p_placement_ids uuid[],
  p_selected_view_ids uuid[],
  p_default_views jsonb
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
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_ids is null
    or pg_catalog.cardinality(p_placement_ids) not between 1 and 500
    or pg_catalog.array_position(p_placement_ids, null) is not null
    or p_selected_view_ids is null
    or pg_catalog.cardinality(p_selected_view_ids) > 500
    or pg_catalog.array_position(p_selected_view_ids, null) is not null
    or p_default_views is null
    or pg_catalog.jsonb_typeof(p_default_views) is distinct from 'array'
 then
    raise exception using errcode = '22023', message = 'Grid view read is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_default_views) > 10000 or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    where pg_catalog.jsonb_typeof(supplied.value) is distinct from 'object'
      or supplied.value - array['viewId', 'queryId', 'document'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(supplied.value -> 'viewId') is distinct from 'string'
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

  installation := vortex_definition.read_current_active_installation();
  if exists (select 1 from vortex_platform.grid_views as selected
    where selected.organization_id = scope.organization_id
      and selected.application_root_id = scope.application_root_id
      and selected.view_id = any(p_selected_view_ids) and selected.document ? 'filters')
    or exists (select 1 from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
      where supplied.value -> 'document' ? 'filters') then
    access_plan := vortex_record.resolve_installation_access_plan_internal(installation);
  end if;

  -- The person's current layouts and every named view they may see, for all the page's grids, in
  -- one bounded read. Only the views the address selected carry their document.
  return pg_catalog.jsonb_build_object(
    'defaultDocuments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('viewId', supplied.value ->> 'viewId')
        || vortex_platform.grid_view_document_for_viewer_internal(
          (supplied.value ->> 'queryId')::uuid, supplied.value -> 'document', installation, access_plan
        )
      )
      from pg_catalog.jsonb_array_elements(p_default_views) as supplied(value)
    ), '[]'::jsonb),
    'roleKeys', coalesce((
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
    ), '[]'::jsonb),
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
        then vortex_platform.grid_view_document_for_viewer_internal(
          listed.query_id, listed.document, installation, access_plan
        ) else '{}'::jsonb end
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
  'Reads the current person''s current layouts and visible named views, and narrows authored default documents through the same current field bounds, in one bounded call.';

alter function vortex_platform.read_grid_views(uuid, uuid[], uuid[], jsonb) owner to vortex_owner;

create or replace function vortex_platform.write_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_query_id uuid,
  p_expected_revision bigint,
  p_based_on_view_id uuid,
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
    or (p_based_on_view_id is not null
      and not vortex_platform.is_non_nil_uuid(p_based_on_view_id::text))
    or not vortex_platform.grid_view_document_valid_internal(p_layout, 'current_layout') then

    raise exception using errcode = '22023', message = 'Grid layout write is invalid';
  end if;


  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- The layout may derive from a view only when that view is one this person may see.
  if p_based_on_view_id is not null and not vortex_platform.grid_view_visible_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id,
    p_page_id, p_placement_id, p_based_on_view_id
  ) then
    raise exception using errcode = '42501', message = 'Grid view is unavailable';
  end if;

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
      'layout', case when held_found then stored.document end
    );
  end if;

  if held_found then
    update vortex_platform.grid_views as held
    set query_id = p_query_id,
      revision = pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
      release_revision = scope.release_revision,
      based_on_view_id = p_based_on_view_id,
      document = p_layout,
      updated_at = written_at
    where held.view_id = stored.view_id
    returning held.* into stored;
  else
    insert into vortex_platform.grid_views (
      view_id, tenant_id, organization_id, organization_account_id, application_root_id,
      page_id, placement_id, kind, query_id, revision, release_revision, based_on_view_id,
      document, created_at, updated_at
    ) values (
      pg_catalog.gen_random_uuid(), scope.tenant_id, scope.organization_id,
      scope.organization_account_id, scope.application_root_id, p_page_id, p_placement_id,
      'current_layout', p_query_id,
      pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
      scope.release_revision, p_based_on_view_id, p_layout, written_at, written_at
    )
    returning * into stored;
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', stored.revision);
end
$function$;

revoke all on function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, uuid, jsonb)
  to vortex_request;

comment on function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, uuid, jsonb) is
  'Writes the current person''s current layout of one grid placement at the expected revision (none for a first write), noting the view it derives from, or returns the stored layout as a conflict.';

alter function vortex_platform.write_grid_view(uuid, uuid, uuid, bigint, uuid, jsonb)
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

create or replace function vortex_platform.save_grid_view(
  p_page_id uuid,
  p_placement_id uuid,
  p_query_id uuid,
  p_view_id uuid,
  p_expected_revision bigint,
  p_name text,
  p_document jsonb
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
  owned_count bigint;
  written_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_page_id is null or not vortex_platform.is_non_nil_uuid(p_page_id::text)
    or p_placement_id is null or not vortex_platform.is_non_nil_uuid(p_placement_id::text)
    or p_query_id is null or not vortex_platform.is_non_nil_uuid(p_query_id::text)
    or (p_view_id is null) <> (p_expected_revision is null)
    or (p_view_id is not null and not vortex_platform.is_non_nil_uuid(p_view_id::text))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990)
    -- A new view needs a name and a document; a change may leave either as it is.
    or (p_view_id is null and (p_name is null or p_document is null))
    or (p_name is not null and (p_name <> pg_catalog.btrim(p_name)
      or pg_catalog.char_length(p_name) not between 1 and 80))
    or (p_document is not null
      and not vortex_platform.grid_view_document_valid_internal(p_document, 'named_view')) then
    raise exception using errcode = '22023', message = 'Grid view save is invalid';
  end if;

  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    scope.organization_id::text || ':' || scope.application_root_id::text || ':' ||
    p_page_id::text || ':' || p_placement_id::text || ':views',
    0
  ));

  if p_view_id is null then
    select pg_catalog.count(*) into owned_count
    from vortex_platform.grid_views as owned
    where owned.organization_id = scope.organization_id
      and owned.organization_account_id = scope.organization_account_id
      and owned.application_root_id = scope.application_root_id
      and owned.page_id = p_page_id
      and owned.placement_id = p_placement_id
      and owned.kind = 'named_view';
    if owned_count >= 50 then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;
    insert into vortex_platform.grid_views (
      view_id, tenant_id, organization_id, organization_account_id, application_root_id,
      page_id, placement_id, kind, query_id, revision, release_revision, name, scope,
      document, created_at, updated_at
    ) values (
      pg_catalog.gen_random_uuid(), scope.tenant_id, scope.organization_id,
      scope.organization_account_id, scope.application_root_id, p_page_id, p_placement_id,
      'named_view', p_query_id,
      pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
      scope.release_revision, p_name, 'personal', p_document, written_at, written_at
    )
    returning * into stored;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
  end if;

  -- Only a view the person owns or that is shared with them can be named at all.
  if not vortex_platform.grid_view_visible_internal(
    scope.organization_id, scope.organization_account_id, scope.application_root_id,
    p_page_id, p_placement_id, p_view_id
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  select held.* into stored
  from vortex_platform.grid_views as held
  where held.view_id = p_view_id
    and held.organization_id = scope.organization_id
  for update;
  held_found := found;
  if not held_found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  -- Only the owner, or someone who may share table views, changes a view.
  if stored.organization_account_id <> scope.organization_account_id
    and not vortex_platform.grid_view_may_share_internal() then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;

  if stored.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'revision', stored.revision,
      'name', stored.name,
      'queryId', stored.query_id
    );
  end if;

  update vortex_platform.grid_views as held
  set query_id = case when p_document is null then held.query_id else p_query_id end,
    name = coalesce(p_name, held.name),
    document = coalesce(p_document, held.document),
    revision = pg_catalog.nextval('vortex_platform.grid_view_revision_seq'::regclass),
    release_revision = scope.release_revision,
    updated_at = written_at
  where held.view_id = stored.view_id
  returning held.* into stored;

  return pg_catalog.jsonb_build_object(
    'outcome', 'saved', 'viewId', stored.view_id, 'revision', stored.revision);
end
$function$;

revoke all on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  to vortex_request;

comment on function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb) is
  'Creates a named grid view of the current person, or renames or replaces one at the expected revision (the owner, or someone who may share table views), or returns the stored revision as a conflict.';

alter function vortex_platform.save_grid_view(uuid, uuid, uuid, uuid, bigint, text, jsonb)
  owner to vortex_owner;

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

create or replace function vortex_platform.list_grid_view_share_targets(
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
  select context.* into strict scope from vortex_platform.grid_view_scope_internal() as context;

  -- Only someone who may share table views is offered who to share with.
  if not vortex_platform.grid_view_may_share_internal() then
    return pg_catalog.jsonb_build_object('outcome', 'forbidden');
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'roles', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'roleId', listed.role_id, 'label', listed.label) order by listed.label, listed.role_id)
      from (
        select target_role.role_id, revision.label
        from vortex_access.organization_roles as target_role
        join vortex_access.organization_role_revisions as revision
          on revision.organization_id = target_role.organization_id
          and revision.role_id = target_role.role_id
          and revision.revision = target_role.live_revision
        where target_role.organization_id = scope.organization_id
          and (target_role.application_root_id is null
            or target_role.application_root_id = scope.application_root_id)
          and revision.lifecycle in ('active', 'acceptance_required')
        order by revision.label, target_role.role_id
        limit 200
      ) as listed
    ), '[]'::jsonb),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'groupId', listed.group_id, 'label', listed.label) order by listed.label, listed.group_id)
      from (
        select target_group.group_id, target_group.label
        from vortex_access.organization_groups as target_group
        where target_group.organization_id = scope.organization_id
          and target_group.state = 'active'
        order by target_group.label, target_group.group_id
        limit 200
      ) as listed
    ), '[]'::jsonb)
  );
end
$function$;

revoke all on function vortex_platform.list_grid_view_share_targets()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_platform.list_grid_view_share_targets() to vortex_request;

comment on function vortex_platform.list_grid_view_share_targets() is
  'Lists the roles of the application and the groups a table view can be shared with, for someone who may share table views.';

alter function vortex_platform.list_grid_view_share_targets() owner to vortex_owner;

reset role;
