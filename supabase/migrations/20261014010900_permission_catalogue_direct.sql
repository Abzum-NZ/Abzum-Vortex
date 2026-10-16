set local role vortex_owner;

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
      and pg_catalog.count(*) = 22
      and pg_catalog.count(distinct permission_id) = 22
      and pg_catalog.count(distinct permission_key) = 22
      and pg_catalog.count(*) filter (where action_kind = 'named') = 0
      and pg_catalog.bool_and(first_revision between 1 and 6)
      as is_valid
    from declarations
  )
  select 6::bigint, 6::bigint, '1.4.0'::text,
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b'::text,
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
    and (select pg_catalog.count(*) from expected) = 22
    and (select pg_catalog.count(*) from entries) = 22
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
          'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b'
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
        and continuity.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid) = 22
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
    'sha256:1e5cceb04465d940f163ec926af7423efc9b37788551b00766d768fe9089195b';
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
  if expected_count <> 22 then
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

create or replace function vortex_access.coordinate_organization_stewardship_adoption(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_role_key text,
  p_role_label text,
  p_role_description text,
  p_role_assignment_id uuid,
  p_delegation_authority_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  requirement jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  stewardship vortex_access.organization_stewardship_requirements%rowtype;
  platform_registration vortex_access.permission_registrations%rowtype;
  is_replay boolean;
  expected_count bigint;
  expected_metadata_exact boolean;
  continuity_count bigint;
  distinct_continuity_count bigint;
  granted_count bigint;
  checked_at timestamptz;
  next_access_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_delegation_authority_id is null
    or p_delegation_authority_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_key is null
    or pg_catalog.char_length(p_role_key) not between 1 and 40
    or p_role_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_role_label is null
    or p_role_label is distinct from pg_catalog.btrim(p_role_label)
    or pg_catalog.char_length(p_role_label) not between 1 and 60
    or p_role_description is null
    or p_role_description is distinct from pg_catalog.btrim(p_role_description)
    or pg_catalog.char_length(p_role_description) not between 1 and 1000
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization stewardship adoption input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization stewardship adoption scope is unavailable';
  end if;

  select stored.* into stewardship
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = p_organization_id
  for update;

  is_replay := found;
  if is_replay then
    if stewardship.original_organization_account_id <>
        p_organization_account_id
      or stewardship.original_role_id <> p_role_id
      or stewardship.original_role_assignment_id <> p_role_assignment_id
      or stewardship.original_delegation_authority_id <>
        p_delegation_authority_id
      or stewardship.adopted_by <> p_changed_by
      or stewardship.adoption_correlation_id <> p_correlation_id then
      raise exception using errcode = '40001',
        message = 'Organization stewardship adoption conflicts with existing evidence';
    end if;
  end if;

  if not is_replay then
    perform 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update of account;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization stewardship account is stale or unavailable';
    end if;

    if exists (
      select 1 from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
        and (role.role_id = p_role_id or role.role_key = p_role_key)
    ) or exists (
      select 1 from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = p_organization_id
        and assignment.role_assignment_id = p_role_assignment_id
    ) or exists (
      select 1
      from vortex_access.organization_delegation_authorities as delegation
      where delegation.organization_id = p_organization_id
        and delegation.delegation_authority_id = p_delegation_authority_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization stewardship grant identity is unavailable';
    end if;
  end if;

  select registration.* into platform_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.state = 'active'
  for update;
  if not found
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, platform_registration.revision
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- The private producer supplies the whole selected catalogue and its target.
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(
      platform_registration.revision
    ) as declaration
  )
  select pg_catalog.count(*),
    coalesce(
      pg_catalog.count(*) > 0
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_id)
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_key)
      and pg_catalog.count(distinct expected.declared_current_revision) = 1
      and pg_catalog.count(distinct expected.registration_revision) = 1
      and pg_catalog.count(distinct expected.source_version) = 1
      and pg_catalog.count(distinct expected.catalogue_fingerprint) = 1
      and pg_catalog.bool_and(
        expected.registration_revision = platform_registration.revision
        and expected.declared_current_revision = platform_registration.revision
        and expected.source_version = platform_registration.source_version
        and expected.catalogue_fingerprint =
          platform_registration.permission_catalogue_fingerprint
        and expected.catalogue_fingerprint =
          platform_registration.candidate_fingerprint
      ),
      false
    )
  into expected_count, expected_metadata_exact
  from expected;
  if not expected_metadata_exact then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- Lock the complete fixed registration-owner set, including invalid roots.
  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  select pg_catalog.count(*), pg_catalog.count(distinct continuity.permission_id)
  into continuity_count, distinct_continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;

  if continuity_count <> expected_count
    or distinct_continuity_count <> expected_count
    or exists (
      select 1
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
        and not exists (
          select 1
          from vortex_access.permission_catalogue_entries as entry
          where entry.organization_id = continuity.organization_id
            and entry.registration_kind = continuity.registration_kind
            and entry.registration_owner_id = platform_owner_id
            and entry.registration_revision = platform_registration.revision
            and entry.application_root_id is null
            and entry.owner_kind = 'platform'
            and entry.owner_id = platform_owner_id
            and entry.owner_kind = continuity.owner_kind
            and entry.owner_id = continuity.owner_id
            and entry.permission_id = continuity.permission_id
            and entry.meaning_fingerprint = continuity.meaning_fingerprint
            and continuity.application_root_id is null
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) or exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = platform_registration.revision
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = entry.organization_id
            and continuity.application_root_id is null
            and continuity.registration_kind = 'platform'
            and continuity.registration_owner_id = platform_owner_id
            and continuity.owner_kind = 'platform'
            and continuity.owner_id = platform_owner_id
            and continuity.owner_kind = entry.owner_kind
            and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.meaning_fingerprint = entry.meaning_fingerprint
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity evidence is incomplete';
  end if;

  if is_replay then
    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
    select version.current_version into next_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
    return query select 'unchanged'::text,
      'adopt_organization_stewardship'::text,
      pg_catalog.jsonb_build_object(
        'organizationId', stewardship.organization_id,
        'originalOrganizationAccountId',
          stewardship.original_organization_account_id,
        'originalRoleId', stewardship.original_role_id,
        'originalRoleAssignmentId', stewardship.original_role_assignment_id,
        'originalDelegationAuthorityId',
          stewardship.original_delegation_authority_id,
        'revision', stewardship.revision,
        'adoptedByActorId', stewardship.adopted_by,
        'adoptedAt', stewardship.adopted_at,
        'adoptionCorrelationId', stewardship.adoption_correlation_id,
        'changedByActorId', stewardship.changed_by,
        'changedAt', stewardship.changed_at,
        'changeCorrelationId', stewardship.change_correlation_id
      ), next_access_version, p_correlation_id;
    return;
  end if;

  checked_at := pg_catalog.clock_timestamp();

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, derived_application_root_id, derived_source_role_id,
    derived_source_definition_key, derived_source_release_revision,
    derived_source_release_version,
    derived_source_validation_contract_version, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_role_id, 'custom', p_role_key, null, null,
    null, null, null, null, null, null, 1,
    p_changed_by, checked_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select p_organization_id, p_role_id, 1,
    pg_catalog.row_number() over (
      order by entry.owner_kind collate "C", entry.owner_id,
        entry.permission_id
    ),
    'custom', null, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    entry.registration_revision,
    platform_registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is null
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.registration_owner_id = entry.registration_owner_id
    and continuity.state = 'available'
    and continuity.continuity_revision > 0
    and continuity.last_processed_registration_revision =
      platform_registration.revision
    and continuity.meaning_fingerprint = entry.meaning_fingerprint
  where entry.organization_id = p_organization_id
    and entry.application_root_id is null
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = platform_registration.revision
    and entry.owner_kind = 'platform'
    and entry.owner_id = platform_owner_id
  order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;

  get diagnostics granted_count = row_count;
  if granted_count <> expected_count or (
    select pg_catalog.count(distinct grant_entry.permission_id)
    from vortex_access.organization_role_permission_entries as grant_entry
    where grant_entry.organization_id = p_organization_id
      and grant_entry.role_id = p_role_id
      and grant_entry.role_revision = 1
  ) <> expected_count then
    raise exception using errcode = '55000',
      message = 'Platform permission stewardship grant evidence is incomplete';
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', null, 'active', 'privileged',
    'standing', 1, 1, null, null, p_role_key, p_role_label,
    p_role_description, null, null, null, null, null, null,
    p_changed_by, checked_at, p_correlation_id
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_role_assignment_id, p_role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_delegation_authority_id, 'organization_account',
    p_organization_account_id, null, 'organization_catalogue', null, 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_stewardship_requirements (
    organization_id, original_organization_account_id, original_role_id,
    original_role_assignment_id, original_delegation_authority_id, revision,
    adopted_by, adopted_at, adoption_correlation_id, changed_by, changed_at,
    change_correlation_id
  ) values (
    p_organization_id, p_organization_account_id, p_role_id,
    p_role_assignment_id, p_delegation_authority_id, 1, p_changed_by,
    checked_at, p_correlation_id, p_changed_by, checked_at, p_correlation_id
  ) returning * into stewardship;

  perform vortex_access.assert_organization_has_permanent_steward(
    p_organization_id
  );

  perform 1
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;

  select version.current_version into next_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
  return query select 'changed'::text,
    'adopt_organization_stewardship'::text,
    pg_catalog.jsonb_build_object(
      'organizationId', stewardship.organization_id,
      'originalOrganizationAccountId',
        stewardship.original_organization_account_id,
      'originalRoleId', stewardship.original_role_id,
      'originalRoleAssignmentId', stewardship.original_role_assignment_id,
      'originalDelegationAuthorityId',
        stewardship.original_delegation_authority_id,
      'revision', stewardship.revision,
      'adoptedByActorId', stewardship.adopted_by,
      'adoptedAt', stewardship.adopted_at,
      'adoptionCorrelationId', stewardship.adoption_correlation_id,
      'changedByActorId', stewardship.changed_by,
      'changedAt', stewardship.changed_at,
      'changeCorrelationId', stewardship.change_correlation_id
    ), next_access_version, p_correlation_id;
end
$function$;

comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic whole-current-catalogue first-steward adoption or exact unchanged replay. It preserves original grants and validates complete availability.';

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.coordinate_organization_stewardship_adoption(uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid) to postgres;

drop function vortex_access.initialize_platform_permission_catalogue_v1_4_0(uuid, uuid, uuid);
drop function vortex_access.initialize_platform_permission_catalogue_v1(uuid, uuid, uuid);
drop function vortex_access.adopt_builder_permission_catalogue(uuid, uuid, uuid);
drop function vortex_access.adopt_security_and_support_operator_permission_catalogue(uuid, uuid, uuid);
drop function vortex_access.adopt_connection_administration_permission_catalogue(uuid, uuid, uuid);
drop function vortex_access.adopt_shipped_platform_permission_catalogue(uuid, bigint, text, text, uuid, uuid);
drop function vortex_access.revise_platform_permission_catalogue_metadata(uuid, bigint, text, text, uuid, uuid);
drop function vortex_access.platform_permission_catalogue_revision_is_exact_v1_0_1(uuid, bigint);

reset role;