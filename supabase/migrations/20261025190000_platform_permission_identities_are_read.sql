-- Functions read the platform permission catalogue instead of carrying its identities: the owner
-- identity and each permission's identity come from vortex_access.platform_permission_declarations
-- through platform_permission_owner_id() and platform_permission_id(key). The 27 functions that
-- held the literals are re-created with the same behaviour.
set role vortex_owner;

create or replace function vortex_access.platform_permission_owner_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  owner_ids uuid[];
begin
  select pg_catalog.array_agg(distinct declaration.owner_id) into owner_ids
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform';
  if owner_ids is null or pg_catalog.cardinality(owner_ids) <> 1 then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue has no single owner';
  end if;
  return owner_ids[1];
end
$function$;

alter function vortex_access.platform_permission_owner_id() owner to vortex_owner;
revoke all on function vortex_access.platform_permission_owner_id()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.platform_permission_owner_id() to vortex_owner;
comment on function vortex_access.platform_permission_owner_id() is
  'The owner identity of the platform permission catalogue, read from its declarations.';

create or replace function vortex_access.platform_permission_id(p_permission_key text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_id uuid;
begin
  select declaration.permission_id into found_id
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.permission_key = p_permission_key;
  if found_id is null then
    raise exception using errcode = '55000',
      message = 'Platform permission is not declared';
  end if;
  return found_id;
end
$function$;

alter function vortex_access.platform_permission_id(text) owner to vortex_owner;
revoke all on function vortex_access.platform_permission_id(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.platform_permission_id(text) to vortex_owner;
comment on function vortex_access.platform_permission_id(text) is
  'The identity of one declared platform permission, by its key.';

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
  platform_owner_id constant uuid := vortex_access.platform_permission_owner_id();
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

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', p_organization_id::text, true
  );

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

create or replace function vortex_access.coordinate_private_organization_role_authority_change(
  p_prepared_evidence jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  candidate jsonb;
  operation_name text;
  operation_key text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  authority_before jsonb;
  authority_after jsonb;
  policy_choice jsonb;
  policy_changed boolean;
  decision record;
  changed record;
  activity_result text;
begin
  if p_prepared_evidence is null
    or pg_catalog.jsonb_typeof(p_prepared_evidence) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_prepared_evidence -> 'candidate')
      is distinct from 'object'
    or vortex_platform.is_non_nil_uuid(p_activity_id::text) is not true then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;

  candidate := p_prepared_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision'
  )
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId')
      is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string'
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'roleId') then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  if target_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if exists (
      select 1 from vortex_access.organization_roles as stored
      where stored.organization_id = context_organization_id
        and stored.role_id = target_role_id
    ) then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := pg_catalog.jsonb_build_object('kind', 'none');
  else
    if pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
        is distinct from 'number'
      or (candidate ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (candidate ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    expected_role_revision :=
      (candidate ->> 'expectedRoleRevision')::numeric::bigint;
    select identity.* into role_identity
    from vortex_access.organization_roles as identity
    where identity.organization_id = context_organization_id
      and identity.role_id = target_role_id
    for update of identity;
    if not found or role_identity.live_revision is distinct from expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority change is stale or unavailable';
    end if;
    authority_before := vortex_access.private_current_role_management_scope(
      context_organization_id, target_role_id, expected_role_revision
    );
  end if;

  -- Installation acceptance changes the supplied permissions, never the organization's local
  -- role settings. Compare the complete policy choice, including the immutable activation-policy
  -- revision, under the same Access lock as the write. Changing settings uses role management.
  if operation_name = 'accept_application_role_revision' and (
    candidate -> 'key' is distinct from pg_catalog.to_jsonb(current_revision.role_key)
    or candidate -> 'label' is distinct from pg_catalog.to_jsonb(current_revision.label)
    or candidate -> 'description' is distinct from pg_catalog.to_jsonb(current_revision.description)
    or candidate -> 'privilegeClassification' is distinct from
      pg_catalog.to_jsonb(current_revision.privilege_classification)
    or candidate -> 'assignmentPolicy' is distinct from case current_revision.assignment_policy
      when 'standing' then pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'existing',
          'reference', pg_catalog.jsonb_build_object(
            'activationPolicyId', current_revision.activation_policy_id,
            'revision', current_revision.activation_policy_revision
          )
        )
      )
    end
  ) then
    raise exception using errcode = 'V3151',
      message = 'Accepting application role changes must keep the role settings. Use Manage roles to change its name, description, classification or assignment and activation settings.';
  end if;

  if operation_name = 'revise_metadata_policy' then
    policy_choice := candidate -> 'assignmentPolicy';
    if pg_catalog.jsonb_typeof(policy_choice) is distinct from 'object'
      or pg_catalog.jsonb_typeof(policy_choice -> 'kind') is distinct from 'string'
      or policy_choice ->> 'kind' not in ('standing', 'activation_required') then
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_choice ->> 'kind' = 'standing' then
      policy_changed := current_revision.assignment_policy <> 'standing';
    elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
      policy_changed := true;
    elsif policy_choice #>> '{activationPolicy,selection}' = 'existing'
      and vortex_platform.is_non_nil_uuid(
        policy_choice #>> '{activationPolicy,reference,activationPolicyId}'
      )
      and pg_catalog.jsonb_typeof(
        policy_choice #> '{activationPolicy,reference,revision}'
      ) = 'number'
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric between
        1 and 9007199254740991
      and (policy_choice #>>
        '{activationPolicy,reference,revision}')::numeric =
        pg_catalog.trunc((policy_choice #>>
          '{activationPolicy,reference,revision}')::numeric) then
      policy_changed := current_revision.assignment_policy <> 'activation_required'
        or current_revision.activation_policy_id is distinct from
          (policy_choice #>>
            '{activationPolicy,reference,activationPolicyId}')::uuid
        or current_revision.activation_policy_revision is distinct from
          (policy_choice #>> '{activationPolicy,reference,revision}')::numeric::bigint;
    else
      raise exception using errcode = '22023',
        message = 'Private Organization role-authority input is invalid';
    end if;
    if policy_changed is not true then
      raise exception using errcode = '40001',
        message = 'Private Organization role-authority candidate changes no authority';
    end if;
    authority_after := authority_before;
  else
    authority_after := vortex_access.private_management_scope_from_permission_evidence(
      candidate -> 'permissions'
    );
  end if;

  if authority_before ->> 'kind' = 'none'
    and authority_after ->> 'kind' = 'none' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority scope is unavailable';
  end if;

  -- Accepting an application's role template or role revision is part of installing or upgrading
  -- that application, so it needs the installation permission (Manage applications) instead of
  -- role management; the delegated scope over every permission and the recent sign-in stay.
  operation_key := 'platform.organization.roles.' || operation_name;
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', case
          when operation_name in ('accept_new_application_role', 'accept_application_role_revision')
            then vortex_access.platform_permission_id('platform.organization.applications.manage')
          else vortex_access.platform_permission_id('platform.organization.roles.manage')
        end
      ),
      'recentAuthentication', case
        when operation_name in (
          'create_custom_from_template', 'accept_new_application_role',
          'accept_application_role_revision'
        ) then pg_catalog.jsonb_build_object(
          'kind', 'primary', 'maximumAgeSeconds', 900
        )
        else pg_catalog.jsonb_build_object('kind', 'none')
      end,
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', authority_before,
        'after', authority_after
      )
    )
  ) as evaluated;
  if decision.operation_key is distinct from operation_key
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  if decision.outcome = 'refused' and decision.reason_code = 'authentication_unsatisfied' then
    raise exception using errcode = 'V3150',
      message = 'Organization role-authority change requires recent primary authentication';
  end if;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Private Organization role-authority change is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_role_change(
    p_prepared_evidence, context_account_id, context_correlation_id
  ) as result;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.role ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, operation_name,
    array[target_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization role-authority Activity is stale';
  end if;

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Private Organization role-authority input is invalid';
end
$function$;

revoke execute on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_private_organization_role_authority_change(jsonb, uuid) is
  'Owner-only authority-establishing role composition. It checks exact current/candidate permission scope, then reuses canonical role evidence, manifests, stewardship and Activity without exposing a grant endpoint.';

alter function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid) to postgres;

create or replace function vortex_access.coordinate_role_change_without_stewardship_internal(
  p_evidence jsonb,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
  created_activation_policy jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  candidate jsonb;
  operation_name text;
  target_organization_id uuid;
  target_role_id uuid;
  expected_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_role_key text;
  target_label text;
  target_description text;
  target_privilege_classification text;
  target_assignment_policy text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_activation_policy_id uuid;
  target_activation_policy_revision bigint;
  target_application_root_id uuid;
  target_source_role_id uuid;
  target_source_definition_key text;
  target_source_release_revision bigint;
  target_source_release_version text;
  target_source_validation_contract_version text;
  target_accepted_registration_revision bigint;
  target_template_continuity_revision bigint;
  target_role_revision bigint;
  candidate_permissions jsonb;
  canonical_permissions jsonb;
  current_permissions jsonb;
  permission_count bigint;
  template_source jsonb;
  live_permissions jsonb;
  selected_template_count bigint;
  policy_choice jsonb;
  policy_value jsonb;
  policy_reference jsonb;
  manifest jsonb;
  canonical_assignments jsonb;
  manifest_required boolean := false;
  authority_broadened boolean := false;
  permissions_changed boolean := false;
  configured_state_changed boolean := false;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  maximum_policy_revision bigint;
  operation_at timestamptz;
  next_access_version bigint;
  role_result jsonb;
  policy_result jsonb;
begin
  if p_evidence is null
    or pg_catalog.jsonb_typeof(p_evidence) is distinct from 'object'
    or p_evidence - array[
      'contractVersion', 'candidate', 'affectedAssignmentManifest'
    ]::text[] <> '{}'::jsonb
    or not (p_evidence ?& array['contractVersion', 'candidate'])
    or p_evidence ->> 'contractVersion' is distinct from '1.0.0'
    or pg_catalog.jsonb_typeof(p_evidence -> 'candidate') is distinct from 'object'
    or (p_evidence ? 'affectedAssignmentManifest' and
      pg_catalog.jsonb_typeof(p_evidence -> 'affectedAssignmentManifest')
        is distinct from 'object')
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
  end if;

  candidate := p_evidence -> 'candidate';
  operation_name := candidate ->> 'operation';
  if operation_name is null or operation_name not in (
    'create_custom', 'create_custom_from_template',
    'accept_new_application_role', 'revise_metadata_policy',
    'revise_custom_permissions', 'accept_application_role_revision',
    'retire_role'
  ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change operation is invalid';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'operation') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'roleId') is distinct from 'string' then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;
  target_organization_id := (candidate ->> 'organizationId')::uuid;
  target_role_id := (candidate ->> 'roleId')::uuid;
  if target_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or candidate ->> 'organizationId' <> target_organization_id::text
    or candidate ->> 'roleId' <> target_role_id::text then
    raise exception using errcode = '22023',
      message = 'Organization role-change identity is invalid';
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    if candidate ? 'expectedRoleRevision' then
      raise exception using errcode = '22023',
        message = 'A role creation cannot carry an expected revision';
    end if;
  elsif pg_catalog.jsonb_typeof(candidate -> 'expectedRoleRevision')
      is distinct from 'number'
    or (candidate ->> 'expectedRoleRevision')::numeric < 1
    or (candidate ->> 'expectedRoleRevision')::numeric > 9007199254740991
    or (candidate ->> 'expectedRoleRevision')::numeric <>
      pg_catalog.trunc((candidate ->> 'expectedRoleRevision')::numeric) then
    raise exception using errcode = '22023',
      message = 'Expected role revision is invalid';
  else
    expected_role_revision := (candidate ->> 'expectedRoleRevision')::numeric::bigint;
  end if;

  if operation_name = 'retire_role' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
    ]::text[] <> '{}'::jsonb
      or not (candidate ?& array[
        'operation', 'organizationId', 'roleId', 'expectedRoleRevision'
      ]) then
      raise exception using errcode = '22023',
        message = 'Role retirement shape is invalid';
    end if;
  else
    if not (candidate ?& array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'description') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'privilegeClassification')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'assignmentPolicy')
        is distinct from 'object'
      or pg_catalog.char_length(candidate ->> 'key') not between 1 and 40
      or candidate ->> 'key' !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or candidate ->> 'label' <> pg_catalog.btrim(candidate ->> 'label')
      or pg_catalog.char_length(candidate ->> 'label') not between 1 and 60
      or candidate ->> 'description' <> pg_catalog.btrim(candidate ->> 'description')
      or pg_catalog.char_length(candidate ->> 'description') not between 1 and 1000
      or candidate ->> 'privilegeClassification' not in ('standard', 'privileged') then
      raise exception using errcode = '22023',
        message = 'Role configuration shape is invalid';
    end if;
    target_role_key := candidate ->> 'key';
    target_label := candidate ->> 'label';
    target_description := candidate ->> 'description';
    target_privilege_classification := candidate ->> 'privilegeClassification';
  end if;

  if operation_name in (
    'create_custom', 'revise_custom_permissions', 'create_custom_from_template',
    'accept_new_application_role', 'accept_application_role_revision'
  ) then
    if pg_catalog.jsonb_typeof(candidate -> 'permissions') is distinct from 'array'
      or pg_catalog.jsonb_array_length(candidate -> 'permissions') = 0 then
      raise exception using errcode = '22023',
        message = 'Role permission evidence is invalid';
    end if;
    candidate_permissions := candidate -> 'permissions';
  elsif candidate ? 'permissions' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry permissions';
  end if;

  if operation_name in (
    'create_custom_from_template', 'accept_new_application_role',
    'accept_application_role_revision'
  ) then
    if not (candidate ?& array[
      'templateSource', 'sourceRoleId', 'templateContinuityRevision'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'templateSource') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate -> 'sourceRoleId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'templateContinuityRevision')
        is distinct from 'number'
      or (candidate ->> 'templateContinuityRevision')::numeric < 1
      or (candidate ->> 'templateContinuityRevision')::numeric > 9007199254740991
      or (candidate ->> 'templateContinuityRevision')::numeric <>
        pg_catalog.trunc((candidate ->> 'templateContinuityRevision')::numeric) then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;
    template_source := candidate -> 'templateSource';
    target_source_role_id := (candidate ->> 'sourceRoleId')::uuid;
    target_template_continuity_revision :=
      (candidate ->> 'templateContinuityRevision')::numeric::bigint;
  elsif candidate ? 'templateSource'
    or candidate ? 'sourceRoleId'
    or candidate ? 'templateContinuityRevision' then
    raise exception using errcode = '22023',
      message = 'This role-change intent cannot carry template evidence';
  end if;

  if operation_name = 'create_custom' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom role shape is invalid';
    end if;
  elsif operation_name in ('create_custom_from_template', 'accept_new_application_role') then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'assignmentPolicy', 'templateSource',
      'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'New template role shape is invalid';
    end if;
  elsif operation_name = 'revise_metadata_policy' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Role metadata shape is invalid';
    end if;
  elsif operation_name = 'revise_custom_permissions' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom permission shape is invalid';
    end if;
  elsif operation_name = 'accept_application_role_revision' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification', 'assignmentPolicy',
      'templateSource', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Application acceptance shape is invalid';
    end if;
  end if;

  if operation_name <> 'retire_role' then
    policy_choice := candidate -> 'assignmentPolicy';
    if policy_choice ->> 'kind' = 'standing' then
      if policy_choice <> pg_catalog.jsonb_build_object('kind', 'standing') then
        raise exception using errcode = '22023', message = 'Standing policy shape is invalid';
      end if;
      target_assignment_policy := 'standing';
    elsif policy_choice ->> 'kind' = 'activation_required'
      and policy_choice - array['kind', 'activationPolicy']::text[] = '{}'::jsonb
      and policy_choice ?& array['kind', 'activationPolicy']
      and pg_catalog.jsonb_typeof(policy_choice -> 'activationPolicy') = 'object' then
      target_assignment_policy := 'activation_required';
      if policy_choice #>> '{activationPolicy,selection}' = 'existing' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'reference']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'reference'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,reference}') <>
            'object' then
          raise exception using errcode = '22023',
            message = 'Existing activation policy shape is invalid';
        end if;
        policy_reference := policy_choice #> '{activationPolicy,reference}';
        if policy_reference - array[
          'activationPolicyId', 'revision'
        ]::text[] <> '{}'::jsonb
          or not (policy_reference ?& array[
            'activationPolicyId', 'revision'
          ])
          or pg_catalog.jsonb_typeof(policy_reference -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_reference -> 'revision') <> 'number'
          or (policy_reference ->> 'revision')::numeric < 1
          or (policy_reference ->> 'revision')::numeric > 9007199254740991
          or (policy_reference ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_reference ->> 'revision')::numeric) then
          raise exception using errcode = '22023',
            message = 'Existing activation policy evidence is invalid';
        end if;
        target_activation_policy_id := (policy_reference ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_reference ->> 'revision')::numeric::bigint;
      elsif policy_choice #>> '{activationPolicy,selection}' = 'new' then
        if (policy_choice -> 'activationPolicy') - array['selection', 'policy']::text[] <>
            '{}'::jsonb
          or not ((policy_choice -> 'activationPolicy') ?& array['selection', 'policy'])
          or pg_catalog.jsonb_typeof(policy_choice #> '{activationPolicy,policy}') <> 'object' then
          raise exception using errcode = '22023',
            message = 'New activation policy shape is invalid';
        end if;
        policy_value := policy_choice #> '{activationPolicy,policy}';
        if policy_value - array[
          'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
          'reasonRequired', 'recentAuthentication', 'requiredCallerExecutionBindingId'
        ]::text[] <> '{}'::jsonb
          or not (policy_value ?& array[
            'activationPolicyId', 'revision', 'maximumActivationDurationSeconds',
            'reasonRequired', 'recentAuthentication'
          ])
          or pg_catalog.jsonb_typeof(policy_value -> 'activationPolicyId') <> 'string'
          or pg_catalog.jsonb_typeof(policy_value -> 'revision') <> 'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'maximumActivationDurationSeconds') <>
            'number'
          or pg_catalog.jsonb_typeof(policy_value -> 'reasonRequired') <> 'boolean'
          or pg_catalog.jsonb_typeof(policy_value -> 'recentAuthentication') <> 'object'
          or (
            policy_value ? 'requiredCallerExecutionBindingId'
            and (
              pg_catalog.jsonb_typeof(policy_value -> 'requiredCallerExecutionBindingId') <>
                'string'
              or not vortex_platform.is_non_nil_uuid(
                policy_value ->> 'requiredCallerExecutionBindingId'
              )
            )
          )
          or (policy_value ->> 'revision')::numeric < 1
          or (policy_value ->> 'revision')::numeric > 9007199254740991
          or (policy_value ->> 'revision')::numeric <>
            pg_catalog.trunc((policy_value ->> 'revision')::numeric)
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric < 1
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric >
            9007199254740991
          or (policy_value ->> 'maximumActivationDurationSeconds')::numeric <>
            pg_catalog.trunc(
              (policy_value ->> 'maximumActivationDurationSeconds')::numeric
            ) then
          raise exception using errcode = '22023',
            message = 'New activation policy evidence is invalid';
        end if;
        if policy_value #>> '{recentAuthentication,kind}' = 'none' then
          if policy_value -> 'recentAuthentication' <>
            pg_catalog.jsonb_build_object('kind', 'none') then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        elsif policy_value #>> '{recentAuthentication,kind}' in ('primary', 'multi_factor') then
          if (policy_value -> 'recentAuthentication') - array[
            'kind', 'maximumAgeSeconds'
          ]::text[] <> '{}'::jsonb
            or not ((policy_value -> 'recentAuthentication') ?& array[
              'kind', 'maximumAgeSeconds'
            ])
            or pg_catalog.jsonb_typeof(
              policy_value #> '{recentAuthentication,maximumAgeSeconds}'
            ) <> 'number'
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric < 1
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric >
              9007199254740991
            or (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric <>
              pg_catalog.trunc(
                (policy_value #>> '{recentAuthentication,maximumAgeSeconds}')::numeric
              ) then
            raise exception using errcode = '22023',
              message = 'Recent authentication policy is invalid';
          end if;
        else
          raise exception using errcode = '22023',
            message = 'Recent authentication policy is invalid';
        end if;
        target_activation_policy_id := (policy_value ->> 'activationPolicyId')::uuid;
        target_activation_policy_revision :=
          (policy_value ->> 'revision')::numeric::bigint;
      else
        raise exception using errcode = '22023',
          message = 'Activation-required policy selection is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Assignment policy is invalid';
    end if;
  end if;

  if candidate_permissions is not null then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array[
          'kind', 'applicationRootId', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'kind', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision', 'meaningFingerprint'
        ])
        or item.value ->> 'kind' is distinct from 'exact'
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'acceptedRegistrationRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'continuityRevision')
          is distinct from 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'catalogueFingerprint')
          is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'meaningFingerprint')
          is distinct from 'string'
        or item.value ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or item.value ->> 'meaningFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        or (item.value ->> 'acceptedRegistrationRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'acceptedRegistrationRevision')::numeric <>
          pg_catalog.trunc(
            (item.value ->> 'acceptedRegistrationRevision')::numeric
          )
        or (item.value ->> 'continuityRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'continuityRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'continuityRevision')::numeric)
        or (
          item.value ->> 'ownerKind' = 'platform'
          and item.value ? 'applicationRootId'
        )
        or (
          item.value ->> 'ownerKind' in ('application', 'module')
          and pg_catalog.jsonb_typeof(item.value -> 'applicationRootId')
            is distinct from 'string'
        )
    ) then
      raise exception using errcode = '22023', message = 'Role permission entry is invalid';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'kind', 'exact',
        'applicationRootId', case
          when item.value ? 'applicationRootId'
            then (item.value ->> 'applicationRootId')::uuid
          else null
        end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid,
        'acceptedRegistrationRevision',
          (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
        'catalogueFingerprint', item.value ->> 'catalogueFingerprint',
        'continuityRevision',
          (item.value ->> 'continuityRevision')::numeric::bigint,
        'meaningFingerprint', item.value ->> 'meaningFingerprint'
      )) order by
        case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end nulls last,
        (item.value ->> 'ownerKind') collate "C",
        (item.value ->> 'ownerId')::uuid,
        (item.value ->> 'permissionId')::uuid
    ) into canonical_permissions
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);

    if canonical_permissions is distinct from candidate_permissions then
      raise exception using errcode = '22023',
        message = 'Role permissions must use canonical unique identity order';
    end if;
    select pg_catalog.count(*), pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      case when item.value ? 'applicationRootId'
        then (item.value ->> 'applicationRootId')::uuid else null end,
      item.value ->> 'ownerKind',
      (item.value ->> 'ownerId')::uuid,
      (item.value ->> 'permissionId')::uuid
    ))
    into permission_count, selected_template_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value);
    if permission_count <> selected_template_count then
      raise exception using errcode = '22023',
        message = 'Role permission identities must be unique';
    end if;
  end if;

  if template_source is not null then
    if template_source - array[
      'applicationRootId', 'registrationRevision', 'catalogueFingerprint'
    ]::text[] <> '{}'::jsonb
      or not (template_source ?& array[
        'applicationRootId', 'registrationRevision', 'catalogueFingerprint'
      ])
      or pg_catalog.jsonb_typeof(template_source -> 'applicationRootId') <> 'string'
      or vortex_platform.is_non_nil_uuid(template_source ->> 'applicationRootId') is not true
      or pg_catalog.jsonb_typeof(template_source -> 'registrationRevision') <> 'number'
      or (template_source ->> 'registrationRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'registrationRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'registrationRevision')::numeric)
      or pg_catalog.jsonb_typeof(template_source -> 'catalogueFingerprint') <> 'string'
      or target_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Application role-template evidence is invalid';
    end if;

    target_accepted_registration_revision :=
      (template_source ->> 'registrationRevision')::numeric::bigint;
    target_application_root_id := (template_source ->> 'applicationRootId')::uuid;

    -- The evidence names the registration; the source release and the role's live permissions
    -- are read from it here, exactly as the preparation read them.
    select registration.source_definition_key, registration.source_revision,
      registration.source_version, registration.validation_contract_version
    into target_source_definition_key, target_source_release_revision,
      target_source_release_version, target_source_validation_contract_version
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
      and registration.permission_catalogue_fingerprint =
        template_source ->> 'catalogueFingerprint';
    if not found then
      raise exception using errcode = '40001',
        message = 'Prepared application registration is stale or unavailable';
    end if;

    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      target_organization_id, target_application_root_id,
      target_accepted_registration_revision, target_source_role_id
    );
    if live_permissions is null or pg_catalog.jsonb_array_length(live_permissions) = 0 then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;
  end if;

  manifest := p_evidence -> 'affectedAssignmentManifest';

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = target_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization role-change scope is unavailable';
  end if;

  if candidate_permissions is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on registration.organization_id = target_organization_id
      and registration.registration_kind = case
        when item.value ->> 'ownerKind' = 'platform' then 'platform'
        else 'application'
      end
      and registration.registration_owner_id = case
        when item.value ->> 'ownerKind' = 'platform'
          then vortex_access.platform_permission_owner_id()
        else (item.value ->> 'applicationRootId')::uuid
      end
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
      and registration.state = 'active'
    order by registration.registration_kind collate "C",
      registration.registration_owner_id
    for update of registration;

    perform 1
    from vortex_access.permission_continuities as continuity
    join pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id
    for update of continuity;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as item(value)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
      and continuity.state = 'available'
      and continuity.continuity_revision =
        (item.value ->> 'continuityRevision')::numeric::bigint
      and continuity.meaning_fingerprint = item.value ->> 'meaningFingerprint'
    join vortex_access.permission_registrations as registration
      on registration.organization_id = continuity.organization_id
      and registration.registration_kind = continuity.registration_kind
      and registration.registration_owner_id = continuity.registration_owner_id
      and registration.state = 'active'
      and registration.revision =
        (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint
      and registration.permission_catalogue_fingerprint =
        item.value ->> 'catalogueFingerprint'
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = continuity.organization_id
      and catalogue.registration_kind = continuity.registration_kind
      and catalogue.registration_owner_id = continuity.registration_owner_id
      and catalogue.registration_revision = registration.revision
      and catalogue.owner_kind = continuity.owner_kind
      and catalogue.owner_id = continuity.owner_id
      and catalogue.permission_id = continuity.permission_id
      and catalogue.application_root_id is not distinct from continuity.application_root_id
      and catalogue.meaning_fingerprint = continuity.meaning_fingerprint;
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions) then
      raise exception using errcode = '40001',
        message = 'Role permission evidence is stale or unavailable';
    end if;
  end if;

  if template_source is not null then
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = target_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.revision = target_accepted_registration_revision
      and registration.state = 'active'
    ;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application registration is stale or unavailable';
    end if;

    perform 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = target_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.continuity_revision = target_template_continuity_revision
      and continuity.last_processed_registration_revision =
        target_accepted_registration_revision
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Application role template is stale or unavailable';
    end if;

    select pg_catalog.count(*) into permission_count
    from pg_catalog.jsonb_array_elements(candidate_permissions) as permission(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(live_permissions) as live(value)
      where (live.value ->> 'applicationRootId')::uuid =
          (permission.value ->> 'applicationRootId')::uuid
        and live.value ->> 'ownerKind' = permission.value ->> 'ownerKind'
        and (live.value ->> 'ownerId')::uuid =
          (permission.value ->> 'ownerId')::uuid
        and (live.value ->> 'permissionId')::uuid =
          (permission.value ->> 'permissionId')::uuid
        and live.value ->> 'meaningFingerprint' =
          permission.value ->> 'meaningFingerprint'
    );
    if permission_count <> pg_catalog.jsonb_array_length(candidate_permissions)
      or (
        operation_name in ('accept_new_application_role', 'accept_application_role_revision')
        and permission_count <>
          pg_catalog.jsonb_array_length(live_permissions)
      ) then
      raise exception using errcode = '40001',
        message = 'Role permissions do not match the current application template';
    end if;
  end if;

  if operation_name in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if found then
      raise exception using errcode = '40001',
        message = 'Organization role identity already exists';
    end if;

    target_role_revision := 1;
    target_policy_continuity_revision := 1;
    target_authority_continuity_revision := 1;
    target_role_kind := case
      when operation_name = 'accept_new_application_role' then 'application'
      else 'custom'
    end;
    target_lifecycle := 'active';
    operation_at := pg_catalog.clock_timestamp();

    insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, derived_application_root_id, derived_source_role_id,
      derived_source_definition_key, derived_source_release_revision,
      derived_source_release_version, derived_source_validation_contract_version,
      live_revision, created_by, created_at
    ) values (
      target_organization_id, target_role_id, target_role_kind, target_role_key,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      case when target_role_kind = 'application' then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_application_root_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_role_id else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_definition_key else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_revision else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_release_version else null end,
      case when operation_name = 'create_custom_from_template'
        then target_source_validation_contract_version else null end,
      1, p_changed_by, operation_at
    );

    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;

    if operation_name = 'create_custom_from_template' then
      target_application_root_id := null;
      target_source_role_id := null;
      target_source_definition_key := null;
      target_source_release_revision := null;
      target_source_release_version := null;
      target_source_validation_contract_version := null;
      target_accepted_registration_revision := null;
      target_template_continuity_revision := null;
    end if;
  else
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
    for update;
    if not found or role_identity.live_revision <> expected_role_revision then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale or unavailable';
    end if;
    if role_identity.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = role_identity.live_revision;
    if not found then
      raise exception using errcode = '23514',
        message = 'Current organization role revision is unavailable';
    end if;
    if current_revision.lifecycle = 'retired' then
      raise exception using errcode = '40001',
        message = 'A retired organization role is terminal';
    end if;
    if operation_name = 'revise_custom_permissions'
      and role_identity.role_kind <> 'custom' then
      raise exception using errcode = '40001',
        message = 'Custom role permission revision requires a custom role';
    end if;
    if operation_name = 'accept_application_role_revision'
      and (
        role_identity.role_kind <> 'application'
        or role_identity.application_root_id <> target_application_root_id
        or role_identity.source_role_id <> target_source_role_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application role acceptance targets the wrong role source';
    end if;
    target_role_revision := role_identity.live_revision + 1;
  end if;

  if operation_at is null then
    operation_at := pg_catalog.clock_timestamp();
  end if;
  if operation_name not in (
    'create_custom', 'create_custom_from_template', 'accept_new_application_role'
  ) then
    target_role_kind := role_identity.role_kind;
    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    target_lifecycle := case
      when operation_name = 'retire_role' then 'retired'
      else current_revision.lifecycle
    end;
    target_privilege_classification := case
      when operation_name = 'retire_role' then current_revision.privilege_classification
      else target_privilege_classification
    end;
    target_assignment_policy := case
      when operation_name = 'retire_role' then current_revision.assignment_policy
      else target_assignment_policy
    end;
    if operation_name = 'retire_role' then
      target_role_key := current_revision.role_key;
      target_label := current_revision.label;
      target_description := current_revision.description;
      target_activation_policy_id := current_revision.activation_policy_id;
      target_activation_policy_revision := current_revision.activation_policy_revision;
    end if;
    target_source_definition_key := current_revision.source_definition_key;
    target_source_release_revision := current_revision.source_release_revision;
    target_source_release_version := current_revision.source_release_version;
    target_source_validation_contract_version :=
      current_revision.source_validation_contract_version;
    target_accepted_registration_revision := current_revision.accepted_registration_revision;
    target_template_continuity_revision := current_revision.template_continuity_revision;
  elsif operation_name = 'revise_custom_permissions' then
    target_lifecycle := 'active';
    target_source_definition_key := null;
    target_source_release_revision := null;
    target_source_release_version := null;
    target_source_validation_contract_version := null;
    target_accepted_registration_revision := null;
    target_template_continuity_revision := null;
  elsif operation_name = 'accept_application_role_revision' then
    target_lifecycle := 'active';
  end if;

  if operation_name <> 'retire_role' then
    if target_assignment_policy = 'standing' then
      target_activation_policy_id := null;
      target_activation_policy_revision := null;
    elsif policy_value is null then
      perform 1
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id
        and policy.revision = target_activation_policy_revision;
      if not found then
        raise exception using errcode = '40001',
          message = 'Existing role activation policy is stale or unavailable';
      end if;
    else
      select pg_catalog.max(policy.revision) into maximum_policy_revision
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = target_organization_id
        and policy.role_id = target_role_id
        and policy.activation_policy_id = target_activation_policy_id;
      if maximum_policy_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'New role activation policy revision is exhausted';
      end if;
      if (maximum_policy_revision is null and target_activation_policy_revision <> 1)
        or (maximum_policy_revision is not null
          and target_activation_policy_revision <> maximum_policy_revision + 1) then
        raise exception using errcode = '40001',
          message = 'New role activation policy revision is stale or invalid';
      end if;
    end if;
  end if;

  if current_revision.organization_id is not null then
    if current_revision.assignment_policy = target_assignment_policy
      and current_revision.activation_policy_id is not distinct from
        target_activation_policy_id
      and current_revision.activation_policy_revision is not distinct from
        target_activation_policy_revision then
      target_policy_continuity_revision := current_revision.policy_continuity_revision;
    else
      if current_revision.policy_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role policy continuity is exhausted';
      end if;
      target_policy_continuity_revision :=
        current_revision.policy_continuity_revision + 1;
    end if;
  end if;

  if current_revision.organization_id is not null then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      ),
      '[]'::jsonb
    ) into current_permissions
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision;
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    candidate_permissions := current_permissions;
  end if;
  permissions_changed := current_revision.organization_id is not null
    and candidate_permissions is distinct from current_permissions;

  if operation_name = 'revise_custom_permissions' and not permissions_changed then
    raise exception using errcode = '40001',
      message = 'Explicit custom permission revision must change the accepted set';
  end if;
  if operation_name = 'accept_application_role_revision'
    and current_revision.lifecycle = 'active'
    and not permissions_changed
    and current_revision.source_definition_key is not distinct from
      target_source_definition_key
    and current_revision.source_release_revision is not distinct from
      target_source_release_revision
    and current_revision.source_release_version is not distinct from
      target_source_release_version
    and current_revision.source_validation_contract_version is not distinct from
      target_source_validation_contract_version
    and current_revision.accepted_registration_revision is not distinct from
      target_accepted_registration_revision
    and current_revision.template_continuity_revision is not distinct from
      target_template_continuity_revision then
    raise exception using errcode = '40001',
      message = 'Explicit application acceptance must change accepted source evidence';
  end if;

  if current_revision.organization_id is not null then
    configured_state_changed :=
      current_revision.role_key is distinct from target_role_key
      or current_revision.label is distinct from target_label
      or current_revision.description is distinct from target_description
      or current_revision.privilege_classification is distinct from
        target_privilege_classification
      or current_revision.assignment_policy is distinct from target_assignment_policy
      or current_revision.activation_policy_id is distinct from target_activation_policy_id
      or current_revision.activation_policy_revision is distinct from
        target_activation_policy_revision
      or current_revision.lifecycle is distinct from target_lifecycle
      or permissions_changed
      or current_revision.source_definition_key is distinct from target_source_definition_key
      or current_revision.source_release_revision is distinct from
        target_source_release_revision
      or current_revision.source_release_version is distinct from target_source_release_version
      or current_revision.source_validation_contract_version is distinct from
        target_source_validation_contract_version
      or current_revision.accepted_registration_revision is distinct from
        target_accepted_registration_revision
      or current_revision.template_continuity_revision is distinct from
        target_template_continuity_revision;
    if not configured_state_changed then
      raise exception using errcode = '40001',
        message = 'Organization role candidate does not change configured state';
    end if;
  end if;

  if current_revision.organization_id is not null then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(candidate_permissions) as proposed(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(current_permissions) as existing(value)
        where existing.value -> 'applicationRootId' is not distinct from
            proposed.value -> 'applicationRootId'
          and existing.value ->> 'ownerKind' = proposed.value ->> 'ownerKind'
          and existing.value ->> 'ownerId' = proposed.value ->> 'ownerId'
          and existing.value ->> 'permissionId' = proposed.value ->> 'permissionId'
          and existing.value ->> 'continuityRevision' =
            proposed.value ->> 'continuityRevision'
          and existing.value ->> 'meaningFingerprint' =
            proposed.value ->> 'meaningFingerprint'
      )
    ) into authority_broadened;

    manifest_required :=
      current_revision.assignment_policy <> target_assignment_policy
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if authority_broadened
      or (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if current_revision.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision + 1;
    else
      target_authority_continuity_revision :=
        current_revision.authority_continuity_revision;
    end if;
  end if;

  if manifest_required then
    if manifest is null
      or manifest - array[
        'organizationId', 'roleId', 'assignments'
      ]::text[] <> '{}'::jsonb
      or not (manifest ?& array['organizationId', 'roleId', 'assignments'])
      or pg_catalog.jsonb_typeof(manifest -> 'organizationId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'roleId') <> 'string'
      or pg_catalog.jsonb_typeof(manifest -> 'assignments') <> 'array'
      or (manifest ->> 'organizationId')::uuid <> target_organization_id
      or (manifest ->> 'roleId')::uuid <> target_role_id then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest shape is invalid';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(manifest -> 'assignments') as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or item.value - array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'roleAssignmentId', 'expectedRevision', 'assignee'
        ])
        or pg_catalog.jsonb_typeof(item.value -> 'roleAssignmentId') <> 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'expectedRevision') <> 'number'
        or pg_catalog.jsonb_typeof(item.value -> 'assignee') <> 'object'
        or (item.value ->> 'expectedRevision')::numeric not between
          1 and 9007199254740991
        or (item.value ->> 'expectedRevision')::numeric <>
          pg_catalog.trunc((item.value ->> 'expectedRevision')::numeric)
        or not (
          (
            item.value #>> '{assignee,kind}' = 'organization_account'
            and (item.value -> 'assignee') - array[
              'kind', 'organizationAccountId'
            ]::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array[
              'kind', 'organizationAccountId'
            ]
            and pg_catalog.jsonb_typeof(
              item.value #> '{assignee,organizationAccountId}'
            ) = 'string'
          )
          or (
            item.value #>> '{assignee,kind}' = 'group'
            and (item.value -> 'assignee') - array['kind', 'groupId']::text[] = '{}'::jsonb
            and (item.value -> 'assignee') ?& array['kind', 'groupId']
            and pg_catalog.jsonb_typeof(item.value #> '{assignee,groupId}') = 'string'
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Affected assignment manifest entry is invalid';
    end if;

    perform 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live'
    order by assignment.role_assignment_id
    for update;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roleAssignmentId', assignment.role_assignment_id,
          'expectedRevision', assignment.revision,
          'assignee', case
            when assignment.assignee_kind = 'organization_account' then
              pg_catalog.jsonb_build_object(
                'kind', 'organization_account',
                'organizationAccountId', assignment.organization_account_id
              )
            else pg_catalog.jsonb_build_object(
              'kind', 'group', 'groupId', assignment.group_id
            )
          end
        ) order by assignment.role_assignment_id
      ),
      '[]'::jsonb
    ) into canonical_assignments
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = target_organization_id
      and assignment.role_id = target_role_id
      and assignment.state = 'live';

    if manifest -> 'assignments' is distinct from canonical_assignments then
      raise exception using errcode = '40001',
        message = 'Affected assignment manifest is stale or incomplete';
    end if;
  elsif manifest is not null then
    raise exception using errcode = '22023',
      message = 'This role change must not carry an affected assignment manifest';
  end if;

  if operation_name in ('revise_metadata_policy', 'retire_role') then
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select permission.organization_id, permission.role_id, target_role_revision,
      permission.entry_ordinal, permission.role_kind,
      permission.role_application_root_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision, permission.catalogue_fingerprint,
      permission.continuity_revision, permission.meaning_fingerprint
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = current_revision.revision
    order by permission.entry_ordinal;
  else
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select target_organization_id, target_role_id, target_role_revision,
      item.ordinality, target_role_kind,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      continuity.application_root_id, continuity.owner_kind,
      continuity.owner_id, continuity.permission_id,
      continuity.registration_kind, continuity.registration_owner_id,
      (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      item.value ->> 'catalogueFingerprint',
      (item.value ->> 'continuityRevision')::numeric::bigint,
      item.value ->> 'meaningFingerprint'
    from pg_catalog.jsonb_array_elements(candidate_permissions) with ordinality
      as item(value, ordinality)
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = target_organization_id
      and continuity.application_scope_id = coalesce(case when item.value ? 'applicationRootId'
          then (item.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (item.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
      and continuity.owner_kind = item.value ->> 'ownerKind'
      and continuity.owner_id = (item.value ->> 'ownerId')::uuid
      and continuity.permission_id = (item.value ->> 'permissionId')::uuid
    order by item.ordinality;
  end if;

  -- A named required caller must be a current, active execution binding of this organisation;
  -- it is read without a lock because binding writers lock the binding before the access version.
  if policy_value ? 'requiredCallerExecutionBindingId' and not exists (
    select 1
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id =
        (policy_value ->> 'requiredCallerExecutionBindingId')::uuid
      and binding.organization_id = target_organization_id
      and binding.is_current
      and binding.state = 'active'
  ) then
    raise exception using errcode = '22023',
      message = 'Required caller execution binding is unavailable';
  end if;

  if policy_value is not null then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds, required_caller_execution_binding_id,
      changed_by, changed_at, change_correlation_id
    ) values (
      target_organization_id, target_role_id, target_activation_policy_id,
      target_activation_policy_revision,
      (policy_value ->> 'maximumActivationDurationSeconds')::numeric::bigint,
      (policy_value ->> 'reasonRequired')::boolean,
      policy_value #>> '{recentAuthentication,kind}',
      case when policy_value #>> '{recentAuthentication,kind}' = 'none' then null
        else (policy_value #>>
          '{recentAuthentication,maximumAgeSeconds}')::numeric::bigint end,
      (policy_value ->> 'requiredCallerExecutionBindingId')::uuid,
      p_changed_by, operation_at, p_correlation_id
    );
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
    target_organization_id, target_role_id, target_role_revision,
    target_role_kind, target_application_root_id, target_lifecycle,
    target_privilege_classification, target_assignment_policy,
    target_policy_continuity_revision, target_authority_continuity_revision,
    target_activation_policy_id, target_activation_policy_revision,
    target_role_key, target_label,
    target_description, target_source_definition_key,
    target_source_release_revision, target_source_release_version,
    target_source_validation_contract_version, target_accepted_registration_revision,
    target_template_continuity_revision,
    p_changed_by, operation_at, p_correlation_id
  );

  if current_revision.organization_id is not null then
    update vortex_access.organization_roles as stored
    set live_revision = target_role_revision,
      role_key = target_role_key
    where stored.organization_id = target_organization_id
      and stored.role_id = target_role_id
      and stored.live_revision = expected_role_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision changed concurrently';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    target_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_catalogue_changed'
  ) as version;

  select pg_catalog.jsonb_build_object(
    'roleId', revision.role_id,
    'organizationId', revision.organization_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'kind', revision.role_kind,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'assignmentPolicy', case
      when revision.assignment_policy = 'standing' then
        pg_catalog.jsonb_build_object('kind', 'standing')
      else pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'activationPolicyId', revision.activation_policy_id,
          'revision', revision.activation_policy_revision
        )
      )
    end,
    'policyContinuityRevision', revision.policy_continuity_revision,
    'authorityContinuityRevision', revision.authority_continuity_revision,
    'lifecycle', revision.lifecycle,
    'permissions', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        )) order by permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ), '[]'::jsonb),
    'createdByActorId', identity.created_by,
    'createdAt', identity.created_at,
    'changedByActorId', revision.changed_by,
    'changedAt', revision.changed_at,
    'changeCorrelationId', revision.change_correlation_id
  ) || case
    when revision.role_kind = 'application' then pg_catalog.jsonb_build_object(
      'applicationRootId', identity.application_root_id,
      'source', pg_catalog.jsonb_build_object(
        'applicationRootId', identity.application_root_id,
        'sourceRoleId', identity.source_role_id,
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'definitionKey', revision.source_definition_key,
          'rootId', identity.application_root_id,
          'releaseRevision', revision.source_release_revision,
          'releaseVersion', revision.source_release_version,
          'validationContractVersion', revision.source_validation_contract_version,
          'contentFingerprint', source_release.content_fingerprint,
          'resolutionFingerprint', source_release.resolution_fingerprint
        ),
        'sourceCatalogueFingerprint', registration.permission_catalogue_fingerprint,
        'acceptedRegistrationRevision', revision.accepted_registration_revision,
        'templateContinuityRevision', revision.template_continuity_revision
      )
    )
    when identity.derived_application_root_id is not null then
      pg_catalog.jsonb_build_object(
        'derivedFromTemplate', pg_catalog.jsonb_build_object(
          'applicationRootId', identity.derived_application_root_id,
          'sourceRoleId', identity.derived_source_role_id,
          'sourceRelease', pg_catalog.jsonb_build_object(
            'kind', 'application',
            'definitionKey', identity.derived_source_definition_key,
            'rootId', identity.derived_application_root_id,
            'releaseRevision', identity.derived_source_release_revision,
            'releaseVersion', identity.derived_source_release_version,
            'validationContractVersion',
              identity.derived_source_validation_contract_version
          )
        )
      )
    else '{}'::jsonb
  end
  into role_result
  from vortex_access.organization_roles as identity
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = identity.organization_id
    and revision.role_id = identity.role_id
    and revision.revision = identity.live_revision
  left join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = revision.organization_id
    and registration.registration_kind = revision.source_registration_kind
    and registration.registration_owner_id = revision.application_root_id
    and registration.revision = revision.accepted_registration_revision
  left join vortex_definition.releases as source_release
    on source_release.root_id = revision.application_root_id
    and source_release.release_revision = revision.source_release_revision
    and source_release.release_version = revision.source_release_version
    and source_release.validation_contract_version = revision.source_validation_contract_version
  where identity.organization_id = target_organization_id
    and identity.role_id = target_role_id;

  if policy_value is not null then
    select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationId', policy.organization_id,
      'roleId', policy.role_id,
      'activationPolicyId', policy.activation_policy_id,
      'revision', policy.revision,
      'maximumActivationDurationSeconds', policy.maximum_activation_duration_seconds,
      'reasonRequired', policy.reason_required,
      'recentAuthentication', case
        when policy.authentication_requirement = 'none' then
          pg_catalog.jsonb_build_object('kind', 'none')
        else pg_catalog.jsonb_build_object(
          'kind', policy.authentication_requirement,
          'maximumAgeSeconds', policy.authentication_maximum_age_seconds
        )
      end,
      'requiredCallerExecutionBindingId', policy.required_caller_execution_binding_id,
      'changedByActorId', policy.changed_by,
      'changedAt', policy.changed_at,
      'changeCorrelationId', policy.change_correlation_id
    )) into policy_result
    from vortex_access.organization_role_activation_policy_revisions as policy
    where policy.organization_id = target_organization_id
      and policy.role_id = target_role_id
      and policy.activation_policy_id = target_activation_policy_id
      and policy.revision = target_activation_policy_revision;
  end if;

  return query select 'changed'::text, operation_name, role_result,
    policy_result, next_access_version, p_correlation_id;
exception
  when invalid_text_representation or invalid_parameter_value then
    raise exception using errcode = '22023',
      message = 'Organization role-change evidence is invalid';
end
$function$;

revoke execute on function
  vortex_access.coordinate_role_change_without_stewardship_internal(
    jsonb, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_role_change_without_stewardship_internal(
  jsonb, uuid, uuid
) is
  'Owner-only atomic seven-intent role governance composition. It verifies exact evidence and manifests, changes Access once, and grants no caller authority.';

grant execute on function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) to postgres;

alter function vortex_access.coordinate_role_change_without_stewardship_internal(jsonb, uuid, uuid) owner to vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) RETURNS TABLE(tenant_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  decision record;
  operation_value text;
  organization_tenant_id uuid;
begin
  if p_mode is null or p_mode not in ('grant', 'revoke', 'read') then
    raise exception using errcode = '22023', message = 'Flow execution binding authority mode is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (context_value ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  operation_value := case p_mode
    when 'grant' then 'platform.organization.execution_bindings.grant'
    when 'revoke' then 'platform.organization.execution_bindings.revoke'
    else 'platform.organization.execution_bindings.read'
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object(
        'actionKind', case when p_mode = 'read' then 'read' else 'manage' end),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', case when p_mode = 'read'
          then vortex_access.platform_permission_id('platform.organization.assignments.read')
          else vortex_access.platform_permission_id('platform.organization.assignments.manage')
        end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', case p_mode
        when 'grant' then pg_catalog.jsonb_build_object(
          'kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'none'),
          'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'))
        when 'revoke' then pg_catalog.jsonb_build_object(
          'kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
          'after', pg_catalog.jsonb_build_object('kind', 'none'))
        else pg_catalog.jsonb_build_object('kind', 'permission')
      end
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from p_organization_id
    or decision.organization_account_id is distinct from p_actor_organization_account_id
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  select organization.tenant_id into organization_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
    and organization.state = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  return query select organization_tenant_id,
    decision.access_version,
    decision.correlation_id;
end
$$;

alter function vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) FROM PUBLIC;

grant execute on function vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) to postgres;

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
  platform_owner_id constant uuid := vortex_access.platform_permission_owner_id();
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

CREATE OR REPLACE FUNCTION vortex_access.lock_application_installation_authority() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  permission_decision record;
  delegation_decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Application installation scope is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Application installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application installation delegation is unavailable';
  end if;

  return query select permission_decision.organization_id,
    permission_decision.organization_account_id, permission_decision.access_version,
    permission_decision.correlation_id;
end
$$;

alter function vortex_access.lock_application_installation_authority() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.lock_application_installation_authority() IS 'Access-owned lock and current authority decision for one protected Application installation lifecycle transaction.';

REVOKE ALL ON FUNCTION vortex_access.lock_application_installation_authority() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.lock_application_installation_authority() TO vortex_owner;

grant execute on function vortex_access.lock_application_installation_authority() to postgres;

CREATE OR REPLACE FUNCTION vortex_access.lock_record_lifecycle_policy_authority() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint, correlation_id uuid, application_root_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy authority changed';
  end if;

  context_value := vortex_access.validated_human_request_context();

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (context_value ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;

  return query select decision.organization_id, decision.organization_account_id,
    decision.access_version, decision.correlation_id,
    case
      when context_value ? 'applicationRootId'
        then (context_value ->> 'applicationRootId')::uuid
      else null
    end;
end
$$;

alter function vortex_access.lock_record_lifecycle_policy_authority() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() IS 'Access-owned lock and current authority decision for one protected record-type lifecycle policy transaction.';

REVOKE ALL ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() TO vortex_owner;

grant execute on function vortex_access.lock_record_lifecycle_policy_authority() to postgres;

create or replace function vortex_access.organization_runtime_settings_manage_is_current()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
begin
  context_value := vortex_access.validated_human_request_context();
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.update',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.runtime_settings.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  return decision.outcome = 'eligible'
    and decision.operation_key = 'platform.organization.runtime_settings.update'
    and decision.organization_id = (context_value ->> 'organizationId')::uuid
    and decision.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and decision.access_version = (context_value ->> 'accessVersion')::bigint
    and decision.correlation_id = (context_value ->> 'correlationId')::uuid;
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or invalid_text_representation then
    return false;
end
$function$;

revoke all on function vortex_access.organization_runtime_settings_manage_is_current()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.organization_runtime_settings_manage_is_current()
  to vortex_record_adapter;

comment on function vortex_access.organization_runtime_settings_manage_is_current() is
  'Checks the verified request for the current platform.organization.runtime_settings.manage permission and returns only the exact eligibility result.';

alter function vortex_access.organization_runtime_settings_manage_is_current() owner to vortex_owner;

grant execute on function vortex_access.organization_runtime_settings_manage_is_current() to postgres;

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
      and entry.registration_owner_id = vortex_access.platform_permission_owner_id()
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
        and registration.registration_owner_id = vortex_access.platform_permission_owner_id()
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
        and history.registration_owner_id = vortex_access.platform_permission_owner_id()
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
        vortex_access.platform_permission_owner_id(),
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
        and continuity.registration_owner_id = vortex_access.platform_permission_owner_id()) = 23
    and not exists (
      select 1 from expected
      where not exists (
        select 1 from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id is null
          and continuity.registration_kind = 'platform'
          and continuity.registration_owner_id = vortex_access.platform_permission_owner_id()
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

create or replace function vortex_access.read_guarded_platform_permission_minimum_internal()
returns table (
  permission_id uuid,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select declaration.permission_id, declaration.meaning_fingerprint
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.owner_id = vortex_access.platform_permission_owner_id()
    and declaration.steward_minimum
  order by declaration.permission_id
$function$;
alter function vortex_access.read_guarded_platform_permission_minimum_internal() owner to vortex_owner;


revoke all on function vortex_access.read_guarded_platform_permission_minimum_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.read_guarded_platform_permission_minimum_internal()
  to postgres;
comment on function vortex_access.read_guarded_platform_permission_minimum_internal() is
  'Returns the complete guarded platform permanent-steward permission identity and meaning set only to the authorized postgres caller.';
alter function vortex_access.read_guarded_platform_permission_minimum_internal()
  owner to vortex_owner;

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
      and declaration.owner_id = vortex_access.platform_permission_owner_id()
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

create or replace function vortex_access.update_own_profile(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_language text,
  p_time_zone text,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_account_id uuid,
  account_summary jsonb,
  correlation_id uuid,
  accepted_at timestamptz,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  decision record;
  changed record;
  activity_result text;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account profile command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization account profile update is unavailable';
  end if;

  if p_organization_account_id = context_account_id then
    -- The own-account path needs no permission, so it is only for the person themself: a
    -- delegated or support context acting for them is refused like any unavailable change.
    if context_value ? 'delegatedContext' or context_value ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Organization account profile update is unavailable';
    end if;
  else
    select evaluated.* into strict decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.accounts.update_profile',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.accounts.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    if decision.outcome = 'refused'
      and decision.operation_key = 'platform.organization.accounts.update_profile'
      and decision.target_kind = 'organization'
      and decision.target_application_root_id is null
      and decision.organization_id = context_organization_id
      and decision.organization_account_id = context_account_id
      and decision.access_version = context_access_version
      and decision.correlation_id = context_correlation_id
      and decision.reason_code in (
        'permission_unavailable', 'permission_not_effective',
        'authentication_unsatisfied', 'delegation_insufficient'
      ) then
      activity_result := vortex_record.append_organization_activity_entry(
        context_organization_id, p_activity_id, decision.checked_at,
        'organization_account', context_account_id, 'update_organization_account_profile',
        array[p_organization_account_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
        context_correlation_id, 'refused'
      );
      if activity_result is distinct from 'inserted' then
        raise exception using errcode = '40001',
          message = 'Organization account profile refusal Activity is stale';
      end if;
      return query select 'refused'::text, 'update_own_profile'::text,
        context_organization_id, p_organization_account_id, null::jsonb,
        context_correlation_id, decision.checked_at, context_access_version;
      return;
    end if;

    if decision.outcome is distinct from 'eligible'
      or decision.operation_key is distinct from
        'platform.organization.accounts.update_profile'
      or decision.target_kind is distinct from 'organization'
      or decision.target_application_root_id is not null
      or decision.organization_id is distinct from context_organization_id
      or decision.organization_account_id is distinct from context_account_id
      or decision.access_version is distinct from context_access_version
      or decision.correlation_id is distinct from context_correlation_id then
      raise exception using errcode = '42501',
        message = 'Organization account profile update is unavailable';
    end if;
  end if;

  select updated.* into strict changed
  from vortex_identity.update_organization_account_profile_internal(
    context_organization_id, p_organization_account_id, p_expected_revision,
    p_display_name, p_language, p_time_zone
  ) as updated;
  if changed.organization_id is distinct from context_organization_id
    or changed.organization_account_id is distinct from p_organization_account_id
    or changed.revision is distinct from p_expected_revision + 1 then
    raise exception using errcode = '42501',
      message = 'Organization account profile result is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'update_organization_account_profile',
    array[p_organization_account_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization account profile Activity is stale';
  end if;

  return query select 'accepted'::text, 'update_own_profile'::text,
    context_organization_id, p_organization_account_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'organizationAccountId', changed.organization_account_id,
      'displayName', changed.display_name,
      'state', changed.state,
      'language', changed.language,
      'timeZone', changed.time_zone,
      'revision', changed.revision
    )),
    context_correlation_id, changed.changed_at, context_access_version;
end
$function$;

revoke all on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) to vortex_request;

comment on function vortex_access.update_own_profile(
  uuid, bigint, text, text, text, uuid
) is
  'Protected profile update for one active organisation account: a person may change their own display name, language and time zone, and may change another account only with platform.organization.accounts.manage. The actor and organisation come only from the validated request context; the account revision is exact and Access version is never changed.';

alter function vortex_access.update_own_profile(p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.update_own_profile(p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text, p_activity_id uuid) to postgres;

create or replace function vortex_definition.append_release(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_release jsonb
)
returns table (
  root_id uuid,
  release_revision bigint,
  release_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  dependency_manifest jsonb,
  published_at timestamptz,
  published_by uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  human_publication boolean;
  original_context jsonb;
  locked_access_version bigint;
  permission_key text;
  permission_id uuid;
  permission_decision record;
  checked_at timestamptz;
  permission_deadline timestamptz;
  context_organization_id uuid;
  context_actor_id uuid;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  supplied_dependency jsonb;
  supplied_kind text;
  supplied_reference text;
  supplied_version text;
  supplied_content_fingerprint text;
  supplied_target_root_id uuid;
  supplied_target_release_revision bigint;
  supplied_catalogue_item_id uuid;
  supplied_entry jsonb;
  supplied_owner_kind text;
  supplied_owner_id_key text;
  supplied_expected_keys text[];
  dependency_count integer := 0;
  inserted_dependency_count integer := 0;
  expected_history_revision bigint;
  release_version_value text;
  compilation_output_value jsonb;
  application_address_value jsonb;
  application_experience_value jsonb;
  record_content_value jsonb;
  resolution_snapshot_value jsonb;
  content_fingerprint_value text;
  resolution_fingerprint_value text;
  validation_contract_version_value text;
  impact_reasons_value jsonb;
  release_note_value text;
  dependency_manifest_value jsonb;
  permissions_value jsonb;
begin
  human_publication := vortex_platform.current_context() ->> 'callerKind' = 'human';
  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context ->> 'callerKind' is distinct from 'human'
      or checked_context ? 'applicationRootId'
      or checked_context ? 'delegatedContext' or checked_context ? 'supportContext' then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
    original_context := checked_context;
    permission_deadline := (checked_context ->> 'expiresAt')::timestamptz;
    -- Access precedes root/draft locks, as in ordinary draft creation and saving. A shared lock
    -- pins the authority checked below until commit (an access change must wait for it) while
    -- other requests of the organisation, concurrent publications included, go on; the root
    -- lock below orders publications of one root.
    select version.current_version into locked_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked_context ->> 'organizationId')::uuid
    for share;
    if not found or locked_access_version
      is distinct from (checked_context ->> 'accessVersion')::bigint then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_actor_id := case when human_publication
    then (checked_context ->> 'organizationAccountId')::uuid
    else (checked_context ->> 'systemActorId')::uuid end;

  if human_publication then
    foreach permission_key in array array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] loop
      permission_id := case permission_key
        when 'platform.organization.definition_drafts.manage'
          then vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
        else vortex_access.platform_permission_id('platform.organization.definition_releases.manage')
      end;
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            'ownerKind', 'platform', 'ownerId', vortex_access.platform_permission_owner_id(),
            'permissionId', permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      checked_at := pg_catalog.clock_timestamp();
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from permission_key
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_release) is distinct from 'object'
    or exists (
      select 1
      from pg_catalog.jsonb_object_keys(p_release) as supplied(key)
      where supplied.key not in (
        'releaseVersion', 'compilationOutput', 'resolutionSnapshot', 'contentFingerprint',
        'resolutionFingerprint', 'validationContractVersion',
        'impactReasons', 'releaseNote', 'dependencies'
      )
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_release)
    ) <> 9 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has an invalid request shape';
  end if;

  release_version_value := p_release ->> 'releaseVersion';
  compilation_output_value := p_release -> 'compilationOutput';
  resolution_snapshot_value := p_release -> 'resolutionSnapshot';
  content_fingerprint_value := p_release ->> 'contentFingerprint';
  resolution_fingerprint_value := p_release ->> 'resolutionFingerprint';
  validation_contract_version_value := p_release ->> 'validationContractVersion';
  impact_reasons_value := p_release -> 'impactReasons';
  release_note_value := p_release ->> 'releaseNote';
  dependency_manifest_value := p_release -> 'dependencies';

  if release_version_value !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or pg_catalog.jsonb_typeof(compilation_output_value) is distinct from 'object'
    or pg_catalog.jsonb_typeof(resolution_snapshot_value) is distinct from 'object'
    or content_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or resolution_fingerprint_value !~ '^sha256:[a-f0-9]{64}$'
    or validation_contract_version_value !~
      '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
    or pg_catalog.jsonb_typeof(impact_reasons_value) is distinct from 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(impact_reasons_value) as reason(value)
      where pg_catalog.jsonb_typeof(reason.value) is distinct from 'object'
    )
    or release_note_value is null
    or release_note_value <> pg_catalog.btrim(release_note_value)
    or pg_catalog.char_length(release_note_value) not between 1 and 2000
    or pg_catalog.jsonb_typeof(dependency_manifest_value) is distinct from 'array'
    or pg_catalog.jsonb_array_length(dependency_manifest_value) > 10000 then
    raise exception using
      errcode = '22023',
      message = 'Definition release append has invalid release evidence';
  end if;

  select root.* into root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
  for update;

  if not found then
    return;
  end if;

  select draft.* into draft_row
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id
  for update;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'A Definition root requires its current draft';
  end if;

  if root_row.organization_id <> context_organization_id then
    raise exception using
      errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;

  -- A Module release is internal to its owning Application's publication: a person publishes
  -- only an ordinary Application, and the Modules an ordinary Application owns.
  if human_publication and (root_row.kind not in ('application', 'module')
    or (root_row.kind = 'application'
      and root_row.application_origin_kind is distinct from 'ordinary')
    or (root_row.kind = 'module' and not exists (
      select 1
      from vortex_definition.roots as owner_root
      where owner_root.root_id = root_row.owner_application_root_id
        and owner_root.organization_id = root_row.organization_id
        and owner_root.kind = 'application'
        and owner_root.application_origin_kind = 'ordinary'
    ))) then
    raise exception using errcode = '42501',
      message = 'Definition publication authority is unavailable';
  end if;

  if compilation_output_value ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'key' is distinct from root_row.key
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'canonical' -> 'envelope' ->> 'organizationId'
      is distinct from root_row.organization_id::text then
    raise exception using
      errcode = '23514',
      message = 'Definition canonical release content does not belong to the locked root';
  end if;

  if compilation_output_value ->> 'resolutionFingerprint' is distinct from resolution_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'kind' is distinct from root_row.kind
    or compilation_output_value -> 'artifact' ->> 'rootId' is distinct from p_root_id::text
    or compilation_output_value -> 'artifact' ->> 'definitionKey' is distinct from root_row.key
    or compilation_output_value -> 'artifact' ->> 'exactVersion' is distinct from release_version_value
    or compilation_output_value -> 'artifact' ->> 'contentFingerprint'
      is distinct from content_fingerprint_value
    or compilation_output_value -> 'artifact' ->> 'resolutionFingerprint'
      is distinct from resolution_fingerprint_value then
    raise exception using
      errcode = '23514',
      message = 'Definition compilation output does not match immutable release evidence';
  end if;

  if resolution_snapshot_value ->> 'fingerprint' is distinct from resolution_fingerprint_value
    or pg_catalog.jsonb_typeof(resolution_snapshot_value -> 'definitions') is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(resolution_snapshot_value -> 'definitions') as definition(value)
      where definition.value ->> 'kind' = root_row.kind
        and definition.value ->> 'key' = root_row.key
        and definition.value ->> 'rootId' = p_root_id::text
        and definition.value ->> 'exactVersion' = release_version_value
    ) then
    raise exception using
      errcode = '23514',
      message = 'Definition resolution snapshot does not match release evidence';
  end if;

  if draft_row.draft_revision <> p_expected_draft_revision
    or draft_row.source_fingerprint <> p_expected_source_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'Definition release append is stale or source evidence was substituted';
  end if;

  expected_history_revision := root_row.current_release_revision;
  if expected_history_revision is null then
    if exists (select 1 from vortex_definition.releases as release where release.root_id = p_root_id) then
      raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
    end if;
  elsif not exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision = expected_history_revision
  ) or exists (
    select 1 from vortex_definition.releases as release
    where release.root_id = p_root_id and release.release_revision > expected_history_revision
  ) then
    raise exception using errcode = '23514', message = 'Definition root current release pointer does not match immutable release history';
  end if;

  if root_row.current_release_revision is distinct from expected_history_revision then
    raise exception using
      errcode = '23514',
      message = 'Definition root current release pointer does not match immutable release history';
  end if;


  if exists (
    select 1
    from vortex_definition.releases as release
    where release.root_id = p_root_id
      and release.release_revision = draft_row.draft_revision
  ) then
    raise exception using
      errcode = '23505',
      message = 'Definition draft revision is already published';
  end if;

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    dependency_count := dependency_count + 1;
    if pg_catalog.jsonb_typeof(supplied_dependency) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Definition dependency has an invalid shape';
    end if;

    supplied_kind := supplied_dependency ->> 'kind';
    if supplied_kind = 'module' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseRevision', 'releaseVersion',
          'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 6 then
        raise exception using errcode = '22023', message = 'Module dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_target_root_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_target_release_revision := (supplied_dependency ->> 'releaseRevision')::bigint;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_target_root_id is null
        or supplied_target_root_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_target_release_revision not between 1 and 9007199254740991
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_target_root_id = p_root_id
        or not exists (
          select 1
          from vortex_definition.releases as target_release
          join vortex_definition.roots as target_root on target_root.root_id = target_release.root_id
          where target_release.root_id = supplied_target_root_id
            and target_release.release_revision = supplied_target_release_revision
            and target_release.release_version = supplied_version
            and target_release.content_fingerprint = supplied_content_fingerprint
            and target_root.organization_id = context_organization_id
            and target_root.kind = 'module'
            and target_root.key = supplied_reference
        ) then
        raise exception using errcode = '23514', message = 'Module dependency does not identify an exact same-organization module release';
      end if;
    elsif supplied_kind = 'connection_type' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'key', 'rootId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 5 then
        raise exception using errcode = '22023', message = 'Connection type dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'key';
      supplied_catalogue_item_id := (supplied_dependency ->> 'rootId')::uuid;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_reference !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or pg_catalog.char_length(supplied_reference) not between 3 and 120
        or supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Connection type dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_block' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'blockId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform block dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'blockId';
      supplied_catalogue_item_id := case
        when supplied_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then supplied_reference::uuid
        else null
      end;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      if supplied_catalogue_item_id is null
        or supplied_catalogue_item_id = '00000000-0000-0000-0000-000000000000'::uuid
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform block dependency has invalid evidence';
      end if;
    elsif supplied_kind = 'platform_theme' then
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
        where supplied.key not in (
          'kind', 'catalogueThemeId', 'releaseVersion', 'contentFingerprint'
        )
      ) or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency)) <> 4 then
        raise exception using errcode = '22023', message = 'Platform theme dependency has an invalid shape';
      end if;
      supplied_reference := supplied_dependency ->> 'catalogueThemeId';
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or supplied_reference = '00000000-0000-0000-0000-000000000000'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
        raise exception using errcode = '22023', message = 'Platform theme dependency has invalid evidence';
      end if;
    elsif supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      -- Flow targets are contained by, or pinned for, one exact Application
      -- release. Each entry has exactly its contract shape, and its owner is
      -- this release, an exact pinned Module release in this same manifest, or
      -- a protected platform service operation verified before append.
      if root_row.kind is distinct from 'application' then
        raise exception using errcode = '23514',
          message = 'Flow target dependencies belong only to an Application release';
      end if;
      supplied_owner_kind := case supplied_kind
        when 'protected_operation' then supplied_dependency #>> '{operation,owner,kind}'
        when 'module_query' then 'module'
        else 'application'
      end;
      supplied_expected_keys := pg_catalog.array_cat(
        array['kind', 'releaseVersion', 'contentFingerprint']::text[],
        case supplied_kind
          when 'application_flow' then
            array['applicationRootId', 'flowId', 'resolutionFingerprint']::text[]
          when 'application_flow_node' then
            array[
              'applicationRootId', 'flowId', 'nodeId', 'operations', 'grantable',
              'resolutionFingerprint'
            ]::text[]
          when 'application_query' then
            array['applicationRootId', 'queryId', 'resolutionFingerprint']::text[]
          when 'module_query' then
            array['moduleRootId', 'queryId', 'declaredRequirement', 'resolutionFingerprint']::text[]
          when 'application_form' then
            array['applicationRootId', 'formId', 'resolutionFingerprint']::text[]
          when 'application_workflow' then
            array['applicationRootId', 'workflowId', 'resolutionFingerprint']::text[]
          when 'application_action' then
            array['applicationRootId', 'actionId', 'resolutionFingerprint']::text[]
          when 'protected_operation' then array['operation', 'resolutionFingerprint']::text[]
        end
      );
      if exists (
          select 1
          from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
          where supplied.key <> all (supplied_expected_keys)
        )
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency))
          <> pg_catalog.cardinality(supplied_expected_keys)
        or exists (
          select 1
          from pg_catalog.unnest(supplied_expected_keys) as expected(key)
          where expected.key not in (
            'operation', 'declaredRequirement', 'operations', 'grantable'
          )
            and pg_catalog.jsonb_typeof(supplied_dependency -> expected.key) is distinct from 'string'
        )
        or (
          supplied_kind = 'module_query'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'declaredRequirement')
            is distinct from 'object'
        )
        or (
          supplied_kind = 'protected_operation'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operation') is distinct from 'object'
            or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,owner}')
              is distinct from 'object'
            or supplied_owner_kind is null
            or supplied_owner_kind not in ('application', 'module', 'platform_service')
          )
        )
        or (
          supplied_kind = 'application_flow_node'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operations') is distinct from 'array'
            or pg_catalog.jsonb_typeof(supplied_dependency -> 'grantable') is distinct from 'boolean'
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has an invalid shape';
      end if;
      if supplied_kind = 'protected_operation' then
        supplied_owner_id_key := case supplied_owner_kind
          when 'application' then 'applicationRootId'
          when 'module' then 'moduleRootId'
          else 'serviceId'
        end;
        if exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation') as operation_key(key)
            where operation_key.key not in ('owner', 'operationId')
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation')) <> 2
          or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,operationId}')
            is distinct from 'string'
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}') as owner_key(key)
            where owner_key.key not in ('kind', supplied_owner_id_key)
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}')) <> 2
          or pg_catalog.jsonb_typeof(
            supplied_dependency -> 'operation' -> 'owner' -> supplied_owner_id_key
          ) is distinct from 'string' then
          raise exception using errcode = '22023',
            message = 'Definition flow target dependency has an invalid shape';
        end if;
      end if;

      if supplied_kind = 'application_flow_node' then
        if (supplied_dependency ->> 'grantable')::boolean is distinct from
            (pg_catalog.jsonb_array_length(supplied_dependency -> 'operations') > 0) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references have an invalid grantability shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where pg_catalog.jsonb_typeof(operation.value) is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'owner') is distinct from 'object'
            or pg_catalog.jsonb_typeof(operation.value -> 'operationId') is distinct from 'string'
            or pg_catalog.jsonb_typeof(operation.value #> '{owner,kind}') is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          where (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value)) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value) as operation_key(key)
              where operation_key.key not in ('owner', 'operationId')
            )
            or operation.value #>> '{owner,kind}' not in ('application', 'module')
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(operation.value -> 'owner')) <> 2
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(operation.value -> 'owner') as owner_key(key)
              where owner_key.key not in (
                'kind',
                case operation.value #>> '{owner,kind}'
                  when 'application' then 'applicationRootId'
                  else 'moduleRootId'
                end
              )
            )
            or pg_catalog.jsonb_typeof(
              operation.value -> 'owner' -> case operation.value #>> '{owner,kind}'
                when 'application' then 'applicationRootId'
                else 'moduleRootId'
              end
            ) is distinct from 'string'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid owner shape';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where owner.owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or owner.owner_id = '00000000-0000-0000-0000-000000000000'
            or (operation.value ->> 'operationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            or operation.value ->> 'operationId' = '00000000-0000-0000-0000-000000000000'
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation reference has an invalid identifier';
        end if;

        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations') as operation(value)
          cross join lateral (
            select case operation.value #>> '{owner,kind}'
              when 'application' then operation.value #>> '{owner,applicationRootId}'
              else operation.value #>> '{owner,moduleRootId}'
            end as owner_id
          ) as owner
          where (
              operation.value #>> '{owner,kind}' = 'application'
              and owner.owner_id is distinct from p_root_id::text
            )
            or (
              operation.value #>> '{owner,kind}' = 'module'
              and not exists (
                select 1
                from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
                where pinned.value ->> 'kind' = 'module'
                  and pg_catalog.lower(pinned.value ->> 'rootId') = owner.owner_id
              )
            )
        ) then
          raise exception using errcode = '23514',
            message = 'Definition flow node operation reference does not belong to this release or a pinned Module';
        end if;

        if exists (
          select 1
          from (
            select
              pg_catalog.lag(ordered.reference_key) over (order by ordered.ordinality) as previous_reference_key,
              ordered.reference_key
            from (
              select
                operation.ordinality,
                (operation.value #>> '{owner,kind}') || ':' ||
                  case operation.value #>> '{owner,kind}'
                    when 'application' then operation.value #>> '{owner,applicationRootId}'
                    else operation.value #>> '{owner,moduleRootId}'
                  end || ':' || (operation.value ->> 'operationId') as reference_key
              from pg_catalog.jsonb_array_elements(supplied_dependency -> 'operations')
                with ordinality as operation(value, ordinality)
            ) as ordered
          ) as adjacent
          where adjacent.previous_reference_key is not null
            and adjacent.previous_reference_key collate "C" >= adjacent.reference_key collate "C"
        ) then
          raise exception using errcode = '22023',
            message = 'Definition flow node operation references must be unique and canonically sorted';
        end if;
      end if;

      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference is null
        or pg_catalog.char_length(supplied_reference) not between 1 and 500
        or supplied_reference ~ '[[:space:]]'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or (
          supplied_dependency ? 'resolutionFingerprint'
          and supplied_dependency ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has invalid evidence';
      end if;

      if (
          supplied_owner_kind = 'application'
          and (
            case when supplied_kind = 'protected_operation'
              then supplied_dependency #>> '{operation,owner,applicationRootId}'
              else supplied_dependency ->> 'applicationRootId'
            end is distinct from p_root_id::text
            or supplied_version is distinct from release_version_value
            or supplied_dependency ->> 'resolutionFingerprint'
              is distinct from resolution_fingerprint_value
          )
        )
        or (
          supplied_owner_kind = 'module'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
            where pinned.value ->> 'kind' = 'module'
              and pinned.value ->> 'rootId' = case when supplied_kind = 'protected_operation'
                then supplied_dependency #>> '{operation,owner,moduleRootId}'
                else supplied_dependency ->> 'moduleRootId'
              end
              and pinned.value ->> 'releaseVersion' = supplied_version
              and pinned.value ->> 'resolutionFingerprint' =
                supplied_dependency ->> 'resolutionFingerprint'
          )
        ) then
        raise exception using errcode = '23514',
          message = 'Flow target dependency does not identify this release or an exact pinned module release';
      end if;
    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;

    if exists (
      select 1
      from vortex_definition.release_dependencies as existing
      where existing.root_id = p_root_id
        and existing.release_revision = draft_row.draft_revision
        and existing.dependency_kind = supplied_kind
        and existing.dependency_reference = supplied_reference
        and (
          supplied_kind <> 'platform_block'
          or existing.dependency_version = supplied_version
        )
    ) then
      raise exception using errcode = '23505', message = 'Definition dependency manifest repeats a subject';
    end if;
  end loop;

  if exists (
    select 1
    from (
      select
        supplied.value ->> 'kind' as dependency_kind,
        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then
            (supplied.value ->> 'blockId') || '@' || (supplied.value ->> 'releaseVersion')
          when 'module' then supplied.value ->> 'key'
          when 'connection_type' then supplied.value ->> 'key'
          else vortex_definition.flow_target_dependency_reference(supplied.value)
        end as dependency_reference,
        pg_catalog.count(*) as duplicate_count
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as supplied(value)
      group by 1, 2
    ) as grouped
    where grouped.dependency_reference is null or grouped.duplicate_count <> 1
  ) then
    raise exception using errcode = '22023', message = 'Definition dependency manifest repeats or omits a subject';
  end if;

  -- An Application release is written last in its publication. It pins every inline Module it
  -- owns at that Module's current release, appended earlier in the same publication when it
  -- changed, and every Module it uses at the release its owning Application's current release
  -- pins, so one Application's publication never moves another's.
  if root_row.kind = 'application' and (
    exists (
      select 1
      from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
      join vortex_definition.roots as target_root
        on target_root.root_id = (dependency.value ->> 'rootId')::uuid
      where dependency.value ->> 'kind' = 'module'
        and case
          when target_root.owner_application_root_id = p_root_id then
            target_root.current_release_revision
              is distinct from (dependency.value ->> 'releaseRevision')::bigint
          else not exists (
            select 1
            from vortex_definition.roots as owner_root
            join vortex_definition.release_dependencies as pin
              on pin.root_id = owner_root.root_id
              and pin.release_revision = owner_root.current_release_revision
            where owner_root.root_id = target_root.owner_application_root_id
              and pin.dependency_kind = 'module'
              and pin.target_root_id = target_root.root_id
              and pin.target_release_revision = (dependency.value ->> 'releaseRevision')::bigint
          )
        end
    )
    or exists (
      select 1
      from vortex_definition.roots as owned_root
      join pg_catalog.jsonb_array_elements(
        coalesce(draft_row.draft_source #> '{body,modules}', '[]'::jsonb)
      ) as inline_module(value) on inline_module.value ->> 'key' = owned_root.key
      where owned_root.owner_application_root_id = p_root_id
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
          where dependency.value ->> 'kind' = 'module'
            and (dependency.value ->> 'rootId')::uuid = owned_root.root_id
        )
    )
  ) then
    raise exception using errcode = '23514',
      message = 'An Application release must pin its own Modules at their current release and used Modules at their owner''s current pin';
  end if;

  -- Field policy is an immutable part of a newly published permission. Validate
  -- it at the one supported release-write boundary so trusted callers cannot
  -- store a release the compiler would refuse. Existing releases are untouched.
  if root_row.kind in ('module', 'application') then
    permissions_value := coalesce(
      compilation_output_value #> '{canonical,content,permissions}',
      '[]'::jsonb
    );

    if pg_catalog.jsonb_typeof(permissions_value) is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition release permissions are unavailable for field-policy validation';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      where (
        permission.value ->> 'recordTypeId' is null
        and permission.value ? 'fieldPolicy'
      ) or (
        permission.value ->> 'recordTypeId' is not null
        and (
          not permission.value ? 'fieldPolicy'
          or not vortex_access.permission_field_policy_is_valid(
            permission.value -> 'fieldPolicy'
          )
        )
      )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy has invalid record ownership or shape';
    end if;

    if exists (
      with module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(
          case
            when root_row.kind = 'module'
              and pg_catalog.jsonb_typeof(
                compilation_output_value #> '{canonical,content,recordTypes}'
              ) = 'array'
            then compilation_output_value #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
      ), pinned_module_record_types as (
        select record_type.value
        from pg_catalog.jsonb_array_elements(dependency_manifest_value) as dependency(value)
        join vortex_definition.releases as module_release
          on module_release.root_id = (dependency.value ->> 'rootId')::uuid
          and module_release.release_revision =
            (dependency.value ->> 'releaseRevision')::bigint
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(
              module_release.compilation_output #> '{canonical,content,recordTypes}'
            ) = 'array'
            then module_release.compilation_output #> '{canonical,content,recordTypes}'
            else '[]'::jsonb
          end
        ) as record_type(value)
        where root_row.kind = 'application'
          and dependency.value ->> 'kind' = 'module'
      ), available_record_types as (
        select value from module_record_types
        union all
        select value from pinned_module_record_types
      ), available_record_type_counts as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.count(*) as record_type_count
        from available_record_types as record_type(value)
        group by pg_catalog.lower(record_type.value ->> 'recordTypeId')
      ), available_fields as (
        select
          pg_catalog.lower(record_type.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value ->> 'fieldId') as field_id
        from available_record_types as record_type(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          case
            when pg_catalog.jsonb_typeof(record_type.value -> 'fields') = 'array'
            then record_type.value -> 'fields'
            else '[]'::jsonb
          end
        ) as field(value)
      ), policy_fields as (
        select
          pg_catalog.lower(permission.value ->> 'recordTypeId') as record_type_id,
          pg_catalog.lower(field.value) as field_id
        from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
        cross join lateral pg_catalog.jsonb_array_elements_text(
          (permission.value #> '{fieldPolicy,readableFieldIds}')
          || (permission.value #> '{fieldPolicy,changeableFieldIds}')
        ) as field(value)
        where permission.value ->> 'recordTypeId' is not null
      )
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as permission(value)
      left join available_record_type_counts as record_type_count
        on record_type_count.record_type_id =
          pg_catalog.lower(permission.value ->> 'recordTypeId')
      where permission.value ->> 'recordTypeId' is not null
        and (
          record_type_count.record_type_count is distinct from 1
          or exists (
            select 1
            from policy_fields as policy_field
            where policy_field.record_type_id =
                pg_catalog.lower(permission.value ->> 'recordTypeId')
              and not exists (
                select 1
                from available_fields as available_field
                where available_field.record_type_id = policy_field.record_type_id
                  and available_field.field_id = policy_field.field_id
              )
          )
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Definition release field policy names a field outside its exact record type';
    end if;
  end if;

  if root_row.kind = 'application' then
    if pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,pages}')
        is distinct from 'array'
      or pg_catalog.jsonb_typeof(compilation_output_value #> '{canonical,content,roles}')
        is distinct from 'array' then
      raise exception using errcode = 'XX001',
        message = 'Published Application address metadata is malformed';
    end if;
    application_address_value := pg_catalog.jsonb_build_object(
      'kind', compilation_output_value -> 'kind',
      'name', compilation_output_value #> '{canonical,content,name}',
      'icon', compilation_output_value #> '{canonical,content,icon}',
      'homePageId', compilation_output_value #> '{canonical,content,homePageId}',
      'pages', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'pageId', page.value -> 'pageId',
            'key', page.value -> 'key',
            'accessPermissionKey', page.value -> 'accessPermissionKey'
          ) order by page.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,pages}'
        ) with ordinality as page(value, ordinality)
      ), '[]'::jsonb),
      'roles', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'roleId', role.value -> 'roleId',
            'key', role.value -> 'key',
            'homePageId', role.value -> 'homePageId'
          ) order by role.ordinality
        )
        from pg_catalog.jsonb_array_elements(
          compilation_output_value #> '{canonical,content,roles}'
        ) with ordinality as role(value, ordinality)
      ), '[]'::jsonb)
    );
    application_experience_value := pg_catalog.jsonb_build_object(
      'experiences', coalesce(
        compilation_output_value #> '{canonical,content,experiences}', '[]'::jsonb
      ),
      'resolvedExperiences', case
        when pg_catalog.jsonb_typeof(
          compilation_output_value #> '{canonical,content,experiences}'
        ) = 'array' then coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'state', experience.value ->> 'state', 'page', page.value
            ) order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,experiences}'
          ) as experience(value)
          join pg_catalog.jsonb_array_elements(
            compilation_output_value #> '{canonical,content,pages}'
          ) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb)
        else '[]'::jsonb
      end,
      'shells', compilation_output_value #> '{canonical,content,shells}',
      'theme', compilation_output_value #> '{canonical,content,theme}'
    );
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(item.key, item.value), '{}'::jsonb)
  into record_content_value
  from pg_catalog.jsonb_each(
    compilation_output_value #> '{canonical,content}'
  ) as item(key, value)
  where item.key in ('recordTypes', 'permissions', 'actions', 'events');

  -- A save runs only the BeforeSave flows, so only those travel with the record content.
  record_content_value := record_content_value || pg_catalog.jsonb_build_object(
    'flows', coalesce((
      select pg_catalog.jsonb_agg(flow.value order by flow.ordinality)
      from pg_catalog.jsonb_array_elements(
        coalesce(compilation_output_value #> '{canonical,content,flows}', '[]'::jsonb)
      ) with ordinality as flow(value, ordinality)
      where exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          coalesce(flow.value -> 'triggers', '[]'::jsonb)
        ) as trigger(value)
        where trigger.value ->> 'type' = 'BeforeSave'
      )
    ), '[]'::jsonb)
  );

  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
    content_fingerprint, resolution_fingerprint, validation_contract_version,
    impact_reasons, release_note, published_at, published_by,
    application_address, application_experience, record_content
  ) values (
    p_root_id, draft_row.draft_revision, release_version_value, draft_row.draft_source,
    draft_row.source_fingerprint, draft_row.source_contract_version, compilation_output_value,
    resolution_snapshot_value,
    content_fingerprint_value, resolution_fingerprint_value, validation_contract_version_value,
    impact_reasons_value, release_note_value, operation_at,
    context_actor_id, application_address_value, application_experience_value,
    record_content_value
  );

  for supplied_dependency in
    select item.value
    from pg_catalog.jsonb_array_elements(dependency_manifest_value) as item(value)
  loop
    supplied_kind := supplied_dependency ->> 'kind';
    supplied_reference := case supplied_kind
      when 'platform_theme' then supplied_dependency ->> 'catalogueThemeId'
      when 'platform_block' then supplied_dependency ->> 'blockId'
      else supplied_dependency ->> 'key'
    end;
    supplied_version := supplied_dependency ->> 'releaseVersion';
    supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
    supplied_target_root_id := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'rootId')::uuid else null end;
    supplied_target_release_revision := case when supplied_kind = 'module'
      then (supplied_dependency ->> 'releaseRevision')::bigint else null end;
    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;
    supplied_entry := null;
    if supplied_kind in (
      'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
    end if;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id, dependency_entry
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id,
      supplied_entry
    );
    inserted_dependency_count := inserted_dependency_count + 1;
  end loop;

  if inserted_dependency_count <> dependency_count then
    raise exception using errcode = '23514', message = 'Definition dependency manifest was not stored one-for-one';
  end if;

  perform 1
  from vortex_definition.reachable_module_dependency_edges(
    p_root_id, draft_row.draft_revision
  );

  update vortex_definition.roots as root
  set current_release_revision = draft_row.draft_revision
  where root.root_id = p_root_id
    and root.current_release_revision is not distinct from expected_history_revision;

  if not found then
    raise exception using errcode = '40001', message = 'Definition current release pointer changed during publication';
  end if;

  if human_publication then
    checked_context := vortex_access.validated_human_request_context();
    if checked_context is distinct from original_context then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  if human_publication then
    foreach permission_key in array array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.definition_releases.manage'
    ] loop
      permission_id := case permission_key
        when 'platform.organization.definition_drafts.manage'
          then vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
        else vortex_access.platform_permission_id('platform.organization.definition_releases.manage')
      end;
      select evaluated.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', permission_key,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            'ownerKind', 'platform', 'ownerId', vortex_access.platform_permission_owner_id(),
            'permissionId', permission_id
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object('kind', 'permission')
        )
      ) as evaluated;
      checked_at := pg_catalog.clock_timestamp();
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from permission_key
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.reason_code is not null
        or permission_decision.organization_id
          is distinct from (checked_context ->> 'organizationId')::uuid
        or permission_decision.organization_account_id
          is distinct from (checked_context ->> 'organizationAccountId')::uuid
        or permission_decision.access_version is distinct from locked_access_version
        or permission_decision.correlation_id
          is distinct from (checked_context ->> 'correlationId')::uuid
        or permission_decision.checked_at is null or permission_decision.checked_at > checked_at
        or permission_decision.valid_until is null or permission_decision.valid_until <= checked_at
        or (checked_context ->> 'issuedAt')::timestamptz > checked_at
        or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
        raise exception using errcode = '42501',
          message = 'Definition publication authority is unavailable';
      end if;
      permission_deadline := least(permission_deadline, permission_decision.valid_until);
    end loop;
    if permission_deadline <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Definition publication authority is unavailable';
    end if;
  end if;

  return query
  select
    release.root_id,
    release.release_revision,
    release.release_version,
    release.content_fingerprint,
    release.resolution_fingerprint,
    coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module', 'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type', 'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    release.published_at,
    release.published_by
  from vortex_definition.releases as release
  where release.root_id = p_root_id
    and release.release_revision = draft_row.draft_revision;
end
$function$;

revoke execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.append_release(uuid, bigint, text, jsonb)
  to vortex_request;
comment on function vortex_definition.append_release(uuid, bigint, text, jsonb) is
  'Atomically validates and records one compiled Definition release with exact field-policy ownership, pinned dependencies and canonical flow operations; retains System publication and permits ordinary human Application and Module publication only under locked current draft/release permissions and original account attribution, then advances only its root pointer.';

alter function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) owner to vortex_owner;

grant execute on function vortex_definition.append_release(p_root_id uuid, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_release jsonb) to postgres;

create or replace function vortex_definition.assert_preview_installation_authority_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  checked_context jsonb;
begin
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.definition_drafts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  checked_context := vortex_access.validated_human_request_context();
  if permission_decision.outcome is distinct from 'eligible'
    or checked_context is null
    or (checked_context ->> 'organizationId')::uuid
      is distinct from permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid
      is distinct from permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint
      is distinct from permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid
      is distinct from permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Preview installation authority is unavailable';
  end if;
  return checked_context;
end
$function$;

alter function vortex_definition.assert_preview_installation_authority_internal() owner to vortex_owner;

revoke all on function vortex_definition.assert_preview_installation_authority_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.assert_preview_installation_authority_internal()
  to vortex_owner;
comment on function vortex_definition.assert_preview_installation_authority_internal() is
  'Validates the current human request context and definition-draft management permission for private preview installation operations.';

create or replace function vortex_definition.provision_module_contribution_storage(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_expected_binding_revision bigint,
  p_contribution_mode text,
  p_contributions jsonb
)
returns table (
  state text,
  changed boolean,
  binding_revision bigint,
  application_root_id uuid,
  application_release_revision bigint,
  module_root_id uuid,
  module_release_revision bigint,
  contribution_ids uuid[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  application_release vortex_definition.releases%rowtype;
  stored_binding vortex_definition.installation_bindings%rowtype;
  provision record;
  retire_contributions boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision not between 1 and 9007199254740991
    or (p_expected_binding_revision is not null
      and p_expected_binding_revision not between 1 and 9007199254740991)
    or p_contribution_mode is null
    or p_contribution_mode not in ('attach', 'detach')
    or pg_catalog.jsonb_typeof(p_contributions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_contributions) < 1
    or pg_catalog.jsonb_array_length(p_contributions) > 100 then
    raise exception using errcode = '22023',
      message = 'Module contribution storage command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501', message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001', message = 'Module installation context changed';
  end if;

  -- The binding identity is locked before its stored lineage can change, exactly
  -- as the installation storage provisioner does.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_definition.binding:' || permission_decision.organization_id::text || ':' ||
        p_application_root_id::text || ':' || p_module_root_id::text,
      0
    )
  );

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_application_root_id
    and release.release_revision = p_application_release_revision
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;
  if application_release.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('application'))
    or application_release.compilation_output #>> '{kind}' <> 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}'
      <> all (vortex_definition.accepted_contract_version('application')) then
    raise exception using errcode = '23514', message = 'Exact Application release is unavailable';
  end if;
  if not exists (
    select 1
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as edge
    where edge.target_root_id = p_module_root_id
      and edge.target_release_revision = p_module_release_revision
  ) then
    raise exception using errcode = '23514',
      message = 'Exact application Module binding is unavailable';
  end if;

  select binding.* into stored_binding
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = permission_decision.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = p_module_root_id
  for update;
  if not found
    or stored_binding.application_release_revision <> p_application_release_revision
    or stored_binding.module_release_revision <> p_module_release_revision
    or (p_expected_binding_revision is not null
      and stored_binding.binding_revision <> p_expected_binding_revision)
    or (p_contribution_mode = 'attach' and stored_binding.state = 'detached') then
    raise exception using errcode = '40001',
      message = 'Module installation binding changed';
  end if;

  -- Every target is the exact dependency release this Application release
  -- pins; an attach also needs the target's own storage installed here.
  if exists (
    with edges as (
      select edge.target_root_id, edge.target_release_revision
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as edge
    )
    select 1
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    where not exists (
      select 1
      from edges
      join vortex_definition.releases as release
        on release.root_id = edges.target_root_id
        and release.release_revision = edges.target_release_revision
      where edges.target_root_id::text = pg_catalog.lower(item.value ->> 'targetModuleRootId')
        and edges.target_root_id <> p_module_root_id
        and release.release_version = item.value ->> 'targetModuleReleaseVersion'
        and (
          p_contribution_mode = 'detach'
          or exists (
            select 1
            from vortex_definition.installation_bindings as target_binding
            where target_binding.organization_id = permission_decision.organization_id
              and target_binding.application_root_id = p_application_root_id
              and target_binding.module_root_id = edges.target_root_id
              and target_binding.module_release_revision = edges.target_release_revision
              and target_binding.state <> 'detached'
          )
        )
    )
  ) then
    raise exception using errcode = '23514',
      message = 'Exact application target Module binding is unavailable';
  end if;

  -- Contributed field mappings live on shared target storage. One lock per
  -- contributor serialises attach and detach across organisations, so a
  -- detach sees every committed installation that still uses the mappings.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex_definition.contribution:' || p_module_root_id::text, 0)
  );

  if p_contribution_mode = 'attach' then
    select storage.* into strict provision
    from vortex_record.provision_exact_module_contributions(
      p_module_root_id, p_module_release_revision, p_contributions
    ) as storage;
    return query select 'attached'::text, provision.changed,
      stored_binding.binding_revision, stored_binding.application_root_id,
      stored_binding.application_release_revision, stored_binding.module_root_id,
      stored_binding.module_release_revision, provision.contribution_ids;
    return;
  end if;

  -- Another live installation of the contributor keeps its mappings active;
  -- the last one retires them. Columns and values are retained either way.
  retire_contributions := not exists (
    select 1
    from vortex_definition.installation_bindings as other_binding
    where other_binding.module_root_id = p_module_root_id
      and other_binding.state <> 'detached'
      and (other_binding.organization_id, other_binding.application_root_id)
        <> (permission_decision.organization_id, p_application_root_id)
  );
  select storage.* into strict provision
  from vortex_record.detach_exact_module_contributions(
    p_module_root_id, p_module_release_revision, p_contributions, retire_contributions
  ) as storage;
  return query select 'detached'::text, provision.changed,
    stored_binding.binding_revision, stored_binding.application_root_id,
    stored_binding.application_release_revision, stored_binding.module_root_id,
    stored_binding.module_release_revision, provision.contribution_ids;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Module contribution evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module contribution evidence is ambiguous';
end
$function$;

alter function vortex_definition.provision_module_contribution_storage(uuid,bigint,uuid,bigint,bigint,text,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.provision_module_contribution_storage(
  uuid, bigint, uuid, bigint, bigint, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.provision_module_contribution_storage(
  uuid, bigint, uuid, bigint, bigint, text, jsonb
) to vortex_request;
comment on function vortex_definition.provision_module_contribution_storage(
  uuid, bigint, uuid, bigint, bigint, text, jsonb
) is 'Protected exact-release contributor storage attach or detach; attaches the resolved additive bindings to their target storage, or retires them while retaining every column and value.';

-- The latest published version of one ordinary Application of the request's organisation, for a
-- person who may manage the organisation's application installations. Installing and upgrading are
-- anchored to it; no draft right is needed.
create or replace function vortex_definition.read_application_latest_release(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
  latest jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application latest release selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context is null
    or checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application latest release authority is unavailable';
  end if;

  select pg_catalog.jsonb_build_object(
    'definitionKey', root.key,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'releaseNote', release.release_note
  ) into latest
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application'
    and root.application_origin_kind = 'ordinary';
  return latest;
end
$function$;

revoke all on function vortex_definition.read_application_latest_release(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.read_application_latest_release(uuid)
  to vortex_request, postgres;
comment on function vortex_definition.read_application_latest_release(uuid) is
  'Returns the latest published version of one ordinary Application of the request organisation to a caller holding platform.organization.applications.manage, or null when it has none.';
alter function vortex_definition.read_application_latest_release(uuid) owner to vortex_owner;

create or replace function vortex_definition.read_application_release_adoption_release_set(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Application release adoption release-set command is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption release-set context is unavailable';
  end if;

  -- The exact release evidence is only revealed to a caller who may manage this
  -- organisation's application installations, decided by the same Access
  -- evaluator every other platform-permission check uses.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption release-set authority is unavailable';
  end if;

  -- The same protected projection the ordinary human bound-release read returns;
  -- this caller has already proved installation-management authority above.
  return vortex_definition.read_application_bound_release_set(p_application_release_revision);
end
$function$;

revoke all on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint)
  to vortex_request;

comment on function vortex_definition.read_application_release_adoption_release_set(uuid, bigint) is
  'Returns the exact bound Application and Module release set for one root and revision to a caller holding platform.organization.applications.manage in the validated human application context.';
alter function vortex_definition.read_application_release_adoption_release_set(uuid, bigint) owner to vortex_owner;

create or replace function vortex_definition.read_application_release_adoption_target(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  permission_decision record;
  target_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application release adoption target command is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if not checked_context ? 'applicationRootId'
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption target context is unavailable';
  end if;

  -- The offered target is only revealed to a caller who may manage this
  -- organisation's application installations. The decision is made by the same
  -- Access evaluator every other platform-permission check uses.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Application release adoption target authority is unavailable';
  end if;

  -- Only an application this organisation has installed offers an adoption
  -- target. Module owns installation facts: its fixed Module-owned reader
  -- refuses an organisation/application scope with no complete active
  -- installation, so this function never reads Module storage directly.
  perform vortex_definition.read_active_installation_for_scope_internal(
    permission_decision.organization_id,
    p_application_root_id
  );

  -- Publication advances the root pointer but never touches the installation,
  -- so the offered target is the discovery pointer, not the active release.
  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'applicationRootId', root.root_id,
    'currentReleaseRevision', root.current_release_revision,
    'currentReleaseVersion', release.release_version
  )
  into target_value
  from vortex_definition.roots as root
  left join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.root_id = p_application_root_id
    and root.kind = 'application'
    and root.organization_id = permission_decision.organization_id;

  if target_value is null then
    raise exception using errcode = 'P0002',
      message = 'Application release adoption target is unavailable';
  end if;

  return target_value;
end
$function$;

revoke all on function vortex_definition.read_application_release_adoption_target(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;

grant execute on function vortex_definition.read_application_release_adoption_target(uuid)
  to vortex_request;

comment on function vortex_definition.read_application_release_adoption_target(uuid) is
  'Returns the published-current release identity an organisation with an installed application may deliberately adopt, for a caller holding platform.organization.applications.manage.';
alter function vortex_definition.read_application_release_adoption_target(uuid) owner to vortex_owner;

create or replace function vortex_definition.read_first_install_application_release_set(
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  initial_context jsonb;
  permission_decision record;
  locked_access_version bigint;
  origin_kind text;
  application_evidence jsonb;
  module_evidence jsonb;
  pin_count bigint;
  completion_time timestamptz;
  permission_deadline timestamptz;
  pass integer;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'First installation release selector is invalid';
  end if;

  initial_context := vortex_access.validated_human_request_context();
  if initial_context is null
    or initial_context ->> 'callerKind' is distinct from 'human'
    or initial_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;

  -- The normal HUMAN org request has acquired Access before this store read.
  -- Retain the same lock even for a direct protected request-role invocation.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = (initial_context ->> 'organizationId')::uuid
  for share;
  if not found or locked_access_version
    is distinct from (initial_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;
  permission_deadline := (initial_context ->> 'expiresAt')::timestamptz;

  for pass in 1..2 loop
    select evaluated.* into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.applications.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;
    checked_context := vortex_access.validated_human_request_context();
    completion_time := pg_catalog.clock_timestamp();
    if checked_context is distinct from initial_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key
        is distinct from 'platform.organization.applications.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id
        is distinct from (initial_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id
        is distinct from (initial_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from locked_access_version
      or permission_decision.correlation_id
        is distinct from (initial_context ->> 'correlationId')::uuid
      or permission_decision.checked_at is null
      or not pg_catalog.isfinite(permission_decision.checked_at)
      or permission_decision.checked_at > completion_time
      or permission_decision.valid_until is null
      or not pg_catalog.isfinite(permission_decision.valid_until)
      or permission_decision.valid_until <= completion_time
      or permission_deadline is null
      or not pg_catalog.isfinite(permission_deadline)
      or permission_deadline <= completion_time
      or (initial_context ->> 'issuedAt')::timestamptz > completion_time then
      raise exception using errcode = '42501',
        message = 'First installation release authority is unavailable';
    end if;
    permission_deadline := least(permission_deadline, permission_decision.valid_until);

    if pass = 1 then
      select root.application_origin_kind into origin_kind
      from vortex_definition.roots as root
      where root.root_id = p_application_root_id
        and root.organization_id = (initial_context ->> 'organizationId')::uuid
        and root.kind = 'application'
      for share;
      if not found or origin_kind is distinct from 'ordinary' then
        raise exception using errcode = 'P0002',
          message = 'First installation release is unavailable';
      end if;

      application_evidence := vortex_definition.project_consumer_release_evidence(
        'application', p_application_root_id, p_application_release_revision
      );
      if application_evidence is null then
        raise exception using errcode = 'P0002',
          message = 'First installation release is unavailable';
      end if;

      -- One authoritative immutable closure; no caller pins or current/latest lookup.
      select pg_catalog.count(*), coalesce(pg_catalog.jsonb_agg(
        vortex_definition.project_consumer_release_evidence(
          'module', pin.target_root_id, pin.target_release_revision
        ) order by pin.target_root_id
      ), '[]'::jsonb)
      into pin_count, module_evidence
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as pin;
      if pin_count > 10000
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(module_evidence) as entry(value)
          where entry.value is null or entry.value = 'null'::jsonb
            or entry.value ->> 'kind' is distinct from 'module'
            or (entry.value ->> 'organizationId')::uuid
              is distinct from (initial_context ->> 'organizationId')::uuid
        ) then
        raise exception using errcode = '23514',
          message = 'First installation release evidence is incomplete';
      end if;
    end if;
  end loop;

  if permission_deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'First installation release authority is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'correlationId', initial_context -> 'correlationId',
    'application', application_evidence,
    'modules', module_evidence
  );
end
$function$;

revoke all on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.read_first_install_application_release_set(uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_first_install_application_release_set(uuid, bigint) is
  'Returns the exact same-organization ordinary published Application and complete immutable Module pin closure to an org-only HUMAN who may manage application installations, before Application permission registration; grants no installation or mutation authority.';

alter function vortex_definition.read_first_install_application_release_set(p_application_root_id uuid, p_application_release_revision bigint) owner to vortex_owner;

create or replace function vortex_definition.read_restore_release_evidence(
  p_kind text,
  p_root_id uuid,
  p_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  initial_human_context jsonb;
  final_human_context jsonb;
  raw_context jsonb;
  release_evidence jsonb;
  human_current_draft jsonb;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  permission_decision record;
  completion_at timestamptz;
  human_restore boolean := false;
begin
  raw_context := vortex_platform.current_context();
  human_restore := raw_context ->> 'callerKind' = 'human';
  if human_restore then
    if p_kind is null
      or p_kind is distinct from 'application'
      or p_root_id is null
      or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_release_revision is null
      or p_release_revision not between 1 and 9007199254740991 then
      raise exception using
        errcode = '22023',
        message = 'Definition restore evidence has an invalid selector';
    end if;

    initial_human_context := vortex_access.validated_human_request_context();
    if initial_human_context ->> 'callerKind' is distinct from 'human'
      or initial_human_context ->> 'channel' is distinct from 'web'
      or initial_human_context ? 'applicationRootId'
      or initial_human_context ? 'delegatedContext'
      or initial_human_context ? 'supportContext' then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if checked_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select root.*
    into root_row
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'application'
    for update;
    if not found
      or root_row.application_origin_kind is distinct from 'ordinary'
      or root_row.current_release_revision is null then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select draft.*
    into draft_row
    from vortex_definition.drafts as draft
    where draft.root_id = root_row.root_id
    for update;
    if not found then
      raise exception using
        errcode = '23503',
        message = 'A Definition root requires its current draft';
    end if;
  else
    checked_context := vortex_definition.validated_system_context();
  end if;

  if p_kind is null
    or p_kind not in ('module', 'application')
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_release_revision is null
    or p_release_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Definition restore evidence has an invalid selector';
  end if;

  select pg_catalog.jsonb_build_object(
    'organizationId', root.organization_id,
    'kind', root.kind,
    'key', root.key,
    'rootId', root.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'authoredSource', release.authored_source,
    'sourceFingerprint', release.authored_source_fingerprint,
    'sourceContractVersion', release.source_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint,
    'validationContractVersion', release.validation_contract_version,
    'compilationOutput', release.compilation_output,
    'resolutionSnapshot', release.resolution_snapshot,
    'dependencyManifest', coalesce((
      select pg_catalog.jsonb_agg(
        case dependency.dependency_kind
          when 'module' then pg_catalog.jsonb_build_object(
            'kind', 'module',
            'key', dependency.dependency_reference,
            'rootId', dependency.target_root_id,
            'releaseRevision', dependency.target_release_revision,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'connection_type' then pg_catalog.jsonb_build_object(
            'kind', 'connection_type',
            'key', dependency.dependency_reference,
            'rootId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_block' then pg_catalog.jsonb_build_object(
            'kind', 'platform_block',
            'blockId', dependency.catalogue_item_id,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint
          )
          else dependency.dependency_entry
        end
        order by
          dependency.dependency_kind collate "C",
          dependency.dependency_reference collate "C",
          dependency.dependency_version collate "C"
      )
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
    ), '[]'::jsonb),
    'moduleDependencyTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'rootId', target.root_id,
          'releaseRevision', target.release_revision,
          'releaseVersion', target.release_version,
          'contentFingerprint', target.content_fingerprint,
          'resolutionFingerprint', target.resolution_fingerprint
        )
        order by
          dependency.dependency_reference collate "C",
          target.root_id,
          target.release_revision
      )
      from vortex_definition.release_dependencies as dependency
      join vortex_definition.releases as target
        on target.root_id = dependency.target_root_id
        and target.release_revision = dependency.target_release_revision
      where dependency.root_id = release.root_id
        and dependency.release_revision = release.release_revision
        and dependency.dependency_kind = 'module'
    ), '[]'::jsonb),
    'identityEvidence', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'definitionKey', root.key,
          'ownerScope', alias.owner_scope,
          'scope', alias.scope,
          'kind', alias.kind,
          'componentOwner', alias.component_owner,
          'alias', alias.alias,
          'identifier', alias.identity_id
        )
        order by
          alias.scope collate "C",
          alias.kind collate "C",
          alias.component_owner collate "C",
          alias.alias collate "C"
      )
      from vortex_definition.source_identity_aliases as alias
      where alias.root_id = root.root_id
    ), '[]'::jsonb)
  )
  into release_evidence
  from vortex_definition.roots as root
  join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = p_release_revision
      and (not human_restore or release.release_revision <= root_row.current_release_revision)
  where root.root_id = p_root_id
    and root.kind = p_kind
    and root.organization_id = (checked_context ->> 'organizationId')::uuid;

  if human_restore and release_evidence is not null then
    human_current_draft := pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'rootId', draft_row.root_id,
      'draftRevision', draft_row.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft_row.draft_source,
      'sourceContractVersion', draft_row.source_contract_version,
      'sourceFingerprint', draft_row.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft_row.updated_at,
      'updatedBy', draft_row.updated_by
    ) || case
      when draft_row.restored_from_release_revision is not null then pg_catalog.jsonb_build_object(
        'restoredFromReleaseRevision', draft_row.restored_from_release_revision,
        'restoredFromSourceFingerprint', draft_row.restored_from_source_fingerprint,
        'restoredBy', draft_row.restored_by,
        'restoredAt', draft_row.restored_at,
        'restoreCorrelationId', draft_row.restore_correlation_id
      )
      else '{}'::jsonb
    end;

    release_evidence := release_evidence || pg_catalog.jsonb_build_object(
      'humanDraftSnapshot', pg_catalog.jsonb_build_object(
        'draftRevision', draft_row.draft_revision,
        'sourceFingerprint', draft_row.source_fingerprint,
        'anchorReleaseRevision', root_row.current_release_revision
      ),
      'humanCurrentDraft', human_current_draft
    );

    final_human_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if final_human_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select evaluated.*
    into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.definition_drafts.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    final_human_context := vortex_access.validated_human_request_context();
    completion_at := pg_catalog.clock_timestamp();
    if final_human_context is distinct from initial_human_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from 'platform.organization.definition_drafts.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id is distinct from (initial_human_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id is distinct from (initial_human_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from (initial_human_context ->> 'accessVersion')::bigint
      or permission_decision.correlation_id is distinct from (initial_human_context ->> 'correlationId')::uuid
      or permission_decision.reason_code is not null
      or permission_decision.checked_at is null
      or permission_decision.checked_at > completion_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= completion_at
      or (initial_human_context ->> 'issuedAt')::timestamptz > completion_at
      or (initial_human_context ->> 'expiresAt')::timestamptz <= completion_at
      or draft_row.updated_at > completion_at
      or (draft_row.restored_at is not null and draft_row.restored_at > completion_at) then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;
  end if;

  return release_evidence;
end
$function$;

revoke execute on function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_restore_release_evidence(text, uuid, bigint)
  to vortex_request;
comment on function vortex_definition.read_restore_release_evidence(text, uuid, bigint) is
  'Returns narrow private evidence needed to verify one immutable source before restoring its draft.';

alter function vortex_definition.read_restore_release_evidence(p_kind text, p_root_id uuid, p_release_revision bigint) owner to vortex_owner;

create or replace function vortex_definition.restore_release_draft(
  p_kind text,
  p_root_id uuid,
  p_target_release_revision bigint,
  p_expected_draft_revision bigint,
  p_expected_source_fingerprint text,
  p_identity_requirements jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  restored_draft jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  raw_context jsonb;
  initial_human_context jsonb;
  final_human_context jsonb;
  root_row vortex_definition.roots%rowtype;
  draft_row vortex_definition.drafts%rowtype;
  selected_release vortex_definition.releases%rowtype;
  permission_decision record;
  completion_at timestamptz;
  requested_identity_count bigint;
  snapshot_identity_count bigint;
  matched_identity_count bigint;
  unique_identity_count bigint;
begin
  raw_context := vortex_platform.current_context();
  if raw_context ->> 'callerKind' = 'human' then
    if p_kind is distinct from 'application'
      or p_root_id is null
      or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_target_release_revision is null
      or p_target_release_revision not between 1 and 9007199254740991
      or p_expected_draft_revision is null
      or p_expected_draft_revision not between 1 and 9007199254740991
      or p_expected_source_fingerprint is null
      or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array' then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;
    if pg_catalog.jsonb_array_length(p_identity_requirements) < 1 then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    initial_human_context := vortex_access.validated_human_request_context();
    if initial_human_context ->> 'callerKind' is distinct from 'human'
      or initial_human_context ->> 'channel' is distinct from 'web'
      or initial_human_context ? 'applicationRootId'
      or initial_human_context ? 'delegatedContext'
      or initial_human_context ? 'supportContext' then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if checked_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select root.*
    into root_row
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind = 'application'
    for update;
    if not found
      or root_row.application_origin_kind is distinct from 'ordinary'
      or root_row.current_release_revision is null
      or p_target_release_revision > root_row.current_release_revision then
      return null;
    end if;

    select draft.*
    into draft_row
    from vortex_definition.drafts as draft
    where draft.root_id = root_row.root_id
    for update;
    if not found then
      raise exception using
        errcode = '23503',
        message = 'A Definition root requires its current draft';
    end if;
    if draft_row.draft_revision is distinct from p_expected_draft_revision
      or draft_row.draft_revision >= 9007199254740991 then
      return null;
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_typeof(requirement.value) is distinct from 'object'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where not (requirement.value ?& array[
          'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
        ])
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(requirement.value) as supplied(key)
          where supplied.key <> all (array[
            'definitionKey', 'ownerScope', 'scope', 'kind', 'componentOwner', 'aliases'
          ])
        )
        or pg_catalog.jsonb_typeof(requirement.value -> 'definitionKey') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'definitionKey') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'ownerScope') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'ownerScope') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'scope') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'scope') not between 1 and 500
        or pg_catalog.jsonb_typeof(requirement.value -> 'kind') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'kind') not between 1 and 60
        or pg_catalog.jsonb_typeof(requirement.value -> 'componentOwner') is distinct from 'string'
        or pg_catalog.char_length(requirement.value ->> 'componentOwner') not between 1 and 240
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_typeof(requirement.value -> 'aliases') is distinct from 'array'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
      where pg_catalog.jsonb_array_length(requirement.value -> 'aliases') < 1
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements(requirement.value -> 'aliases') as alias_value(value)
          where pg_catalog.jsonb_typeof(alias_value.value) is distinct from 'string'
            or pg_catalog.char_length(alias_value.value #>> '{}') not between 1 and 500
        )
    ) then
      raise exception using
        errcode = '22023',
        message = 'Definition restore has invalid verified evidence';
    end if;

    select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(requirement.value -> 'aliases')), 0)
    into requested_identity_count
    from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value);

    select release_row.*
    into selected_release
    from vortex_definition.releases as release_row
    where release_row.root_id = root_row.root_id
      and release_row.release_revision = p_target_release_revision
      and release_row.authored_source_fingerprint = p_expected_source_fingerprint
      and release_row.release_revision <= root_row.current_release_revision;
    if not found then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(selected_release.resolution_snapshot) is distinct from 'object'
      or pg_catalog.jsonb_typeof(selected_release.resolution_snapshot -> 'identities') is distinct from 'array' then
      raise exception using
        errcode = '23514',
        message = 'Definition restore identity evidence is inconsistent';
    end if;
    select count(*)::bigint
    into snapshot_identity_count
    from pg_catalog.jsonb_array_elements(
      selected_release.resolution_snapshot -> 'identities'
    ) as snapshot(value)
    where snapshot.value ->> 'definitionKey' = root_row.key;

    select
      count(*)::bigint,
      count(distinct pg_catalog.jsonb_build_array(
        requirement.value ->> 'definitionKey',
        requirement.value ->> 'ownerScope',
        requirement.value ->> 'scope',
        requirement.value ->> 'kind',
        requirement.value ->> 'componentOwner',
        requested_alias.alias
      )::text)::bigint
    into matched_identity_count, unique_identity_count
    from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
    cross join pg_catalog.jsonb_array_elements_text(requirement.value -> 'aliases') as requested_alias(alias)
    join pg_catalog.jsonb_array_elements(
      selected_release.resolution_snapshot -> 'identities'
    ) as snapshot(value)
      on snapshot.value ->> 'definitionKey' = root_row.key
      and snapshot.value ->> 'definitionKey' = requirement.value ->> 'definitionKey'
      and snapshot.value ->> 'scope' = requirement.value ->> 'scope'
      and snapshot.value ->> 'kind' = requirement.value ->> 'kind'
      and snapshot.value ->> 'componentOwner' = requirement.value ->> 'componentOwner'
      and snapshot.value ->> 'alias' = requested_alias.alias
    join vortex_definition.source_identity_aliases as existing_alias
      on existing_alias.root_id = root_row.root_id
      and existing_alias.owner_scope = requirement.value ->> 'ownerScope'
      and existing_alias.scope = requirement.value ->> 'scope'
      and existing_alias.kind = requirement.value ->> 'kind'
      and existing_alias.component_owner = requirement.value ->> 'componentOwner'
      and existing_alias.alias = requested_alias.alias
      and existing_alias.identity_id::text = (snapshot.value ->> 'identifier');

    if requested_identity_count < 1
      or requested_identity_count <> snapshot_identity_count
      or matched_identity_count <> requested_identity_count
      or unique_identity_count <> requested_identity_count
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_identity_requirements) as requirement(value)
        where requirement.value ->> 'definitionKey' is distinct from root_row.key
      ) then
      raise exception using
        errcode = '23514',
        message = 'Definition restore identity evidence is inconsistent';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    update vortex_definition.drafts as draft
    set
      draft_revision = draft.draft_revision + 1,
      draft_source = selected_release.authored_source,
      identity_requirements = p_identity_requirements,
      source_contract_version = selected_release.source_contract_version,
      source_fingerprint = selected_release.authored_source_fingerprint,
      restored_from_release_revision = selected_release.release_revision,
      restored_from_source_fingerprint = selected_release.authored_source_fingerprint,
      restored_by = (checked_context ->> 'organizationAccountId')::uuid,
      restored_at = operation_at,
      restore_correlation_id = (checked_context ->> 'correlationId')::uuid,
      updated_at = operation_at,
      updated_by = (checked_context ->> 'organizationAccountId')::uuid
    where draft.root_id = root_row.root_id
      and draft.draft_revision = p_expected_draft_revision
      and draft.draft_revision < 9007199254740991
    returning pg_catalog.jsonb_build_object(
      'organizationId', root_row.organization_id,
      'kind', root_row.kind,
      'key', root_row.key,
      'rootId', draft.root_id,
      'draftRevision', draft.draft_revision,
      'publishedRevision', root_row.current_release_revision,
      'source', draft.draft_source,
      'sourceContractVersion', draft.source_contract_version,
      'sourceFingerprint', draft.source_fingerprint,
      'createdAt', root_row.created_at,
      'createdBy', root_row.created_by,
      'updatedAt', draft.updated_at,
      'updatedBy', draft.updated_by,
      'restoredFromReleaseRevision', draft.restored_from_release_revision,
      'restoredFromSourceFingerprint', draft.restored_from_source_fingerprint,
      'restoredBy', draft.restored_by,
      'restoredAt', draft.restored_at,
      'restoreCorrelationId', draft.restore_correlation_id
    ) into restored_draft;
    if not found then
      return null;
    end if;

    final_human_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
    if final_human_context - 'draftWriteDeadline' is distinct from initial_human_context then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    select evaluated.*
    into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.definition_drafts.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    final_human_context := vortex_access.validated_human_request_context();
    completion_at := pg_catalog.clock_timestamp();
    if final_human_context is distinct from initial_human_context
      or permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from 'platform.organization.definition_drafts.manage'
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id is distinct from (initial_human_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id is distinct from (initial_human_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from (initial_human_context ->> 'accessVersion')::bigint
      or permission_decision.correlation_id is distinct from (initial_human_context ->> 'correlationId')::uuid
      or permission_decision.reason_code is not null
      or permission_decision.checked_at is null
      or permission_decision.checked_at > completion_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= completion_at
      or (initial_human_context ->> 'issuedAt')::timestamptz > completion_at
      or (initial_human_context ->> 'expiresAt')::timestamptz <= completion_at
      or operation_at > completion_at then
      raise exception using
        errcode = '42501',
        message = 'Definition restore authority is unavailable';
    end if;

    return restored_draft;
  end if;

  checked_context := vortex_definition.validated_system_context();

  if p_kind is null
    or p_kind is distinct from 'application'
    or p_root_id is null
    or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_release_revision is null
    or p_target_release_revision not between 1 and 9007199254740991
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_source_fingerprint is null
    or p_expected_source_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_identity_requirements) < 1 then
    raise exception using
      errcode = '22023',
      message = 'Definition restore has invalid verified evidence';
  end if;

  with selected_release as (
    select
      root.root_id,
      root.organization_id,
      root.kind,
      root.key,
      root.current_release_revision,
      root.created_at,
      root.created_by,
      release.release_revision,
      release.authored_source,
      release.authored_source_fingerprint,
      release.source_contract_version
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_target_release_revision
      and release.authored_source_fingerprint = p_expected_source_fingerprint
    where root.root_id = p_root_id
      and root.kind = p_kind
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
  ),
  updated_draft as (
    update vortex_definition.drafts as draft
    set
      draft_revision = draft.draft_revision + 1,
      draft_source = selected.authored_source,
      identity_requirements = p_identity_requirements,
      source_contract_version = selected.source_contract_version,
      source_fingerprint = selected.authored_source_fingerprint,
      restored_from_release_revision = selected.release_revision,
      restored_from_source_fingerprint = selected.authored_source_fingerprint,
      restored_by = (checked_context ->> 'systemActorId')::uuid,
      restored_at = operation_at,
      restore_correlation_id = (checked_context ->> 'correlationId')::uuid,
      updated_at = operation_at,
      updated_by = (checked_context ->> 'systemActorId')::uuid
    from selected_release as selected
    where draft.root_id = selected.root_id
      and draft.draft_revision = p_expected_draft_revision
      and draft.draft_revision < 9007199254740991
    returning
      draft.root_id,
      draft.draft_revision,
      draft.draft_source,
      draft.source_contract_version,
      draft.source_fingerprint,
      draft.restored_from_release_revision,
      draft.restored_from_source_fingerprint,
      draft.restored_by,
      draft.restored_at,
      draft.restore_correlation_id,
      draft.updated_at,
      draft.updated_by
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', selected.organization_id,
    'kind', selected.kind,
    'key', selected.key,
    'rootId', updated.root_id,
    'draftRevision', updated.draft_revision,
    'publishedRevision', selected.current_release_revision,
    'source', updated.draft_source,
    'sourceContractVersion', updated.source_contract_version,
    'sourceFingerprint', updated.source_fingerprint,
    'createdAt', selected.created_at,
    'createdBy', selected.created_by,
    'updatedAt', updated.updated_at,
    'updatedBy', updated.updated_by,
    'restoredFromReleaseRevision', updated.restored_from_release_revision,
    'restoredFromSourceFingerprint', updated.restored_from_source_fingerprint,
    'restoredBy', updated.restored_by,
    'restoredAt', updated.restored_at,
    'restoreCorrelationId', updated.restore_correlation_id
  )
  into restored_draft
  from updated_draft as updated
  join selected_release as selected on selected.root_id = updated.root_id;

  return restored_draft;
end
$function$;

revoke execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) to vortex_request;

comment on function vortex_definition.restore_release_draft(text, uuid, bigint, bigint, text, jsonb) is
  'Conditionally restores one verified immutable authored source into the expected draft revision without allocating identities or moving a release pointer.';

alter function vortex_definition.restore_release_draft(p_kind text, p_root_id uuid, p_target_release_revision bigint, p_expected_draft_revision bigint, p_expected_source_fingerprint text, p_identity_requirements jsonb) owner to vortex_owner;

create or replace function vortex_definition.validated_builder_draft_write_context_internal(
  p_root_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  checked_context jsonb;
  locked_access_version bigint;
  origin_kind text := 'ordinary';
  root_kind text;
  permission_key text;
  permission_keys text[] := array['platform.organization.definition_drafts.manage'];
  permission_id uuid;
  permission_decision record;
  checked_at timestamptz;
  permission_deadline timestamptz;
begin
  -- Only the existing trusted create/save definers can call this private guard.
  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;
  permission_deadline := (checked_context ->> 'expiresAt')::timestamptz;

  -- A shared lock pins the authority checked below until commit; the root lock orders writes.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = (checked_context ->> 'organizationId')::uuid
  for share;
  if not found or locked_access_version
    is distinct from (checked_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;

  if p_root_id is not null then
    select root.kind, root.application_origin_kind into root_kind, origin_kind
    from vortex_definition.roots as root
    where root.root_id = p_root_id
      and root.organization_id = (checked_context ->> 'organizationId')::uuid
    for update;
    -- Only an Application is drafted: a Module is edited inside its owning Application.
    if not found or root_kind is distinct from 'application'
      or origin_kind is null
      or origin_kind not in ('ordinary', 'platform_system_application') then
      raise exception using errcode = '42501',
        message = 'Definition draft write authority is unavailable';
    end if;
  end if;

  if origin_kind = 'platform_system_application' then
    permission_keys := array[
      'platform.organization.definition_drafts.manage',
      'platform.organization.system_applications.manage'
    ];
  end if;
  foreach permission_key in array permission_keys loop
    permission_id := case permission_key
      when 'platform.organization.definition_drafts.manage'
        then vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
      else vortex_access.platform_permission_id('platform.organization.system_applications.manage')
    end;
    select evaluated.* into strict permission_decision
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', permission_key,
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', vortex_access.platform_permission_owner_id(),
          'permissionId', permission_id
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as evaluated;

    checked_at := pg_catalog.clock_timestamp();
    if permission_decision.outcome is distinct from 'eligible'
      or permission_decision.operation_key is distinct from permission_key
      or permission_decision.target_kind is distinct from 'organization'
      or permission_decision.target_application_root_id is not null
      or permission_decision.organization_id
        is distinct from (checked_context ->> 'organizationId')::uuid
      or permission_decision.organization_account_id
        is distinct from (checked_context ->> 'organizationAccountId')::uuid
      or permission_decision.access_version is distinct from locked_access_version
      or permission_decision.correlation_id
        is distinct from (checked_context ->> 'correlationId')::uuid
      or permission_decision.checked_at is null
      or permission_decision.checked_at > checked_at
      or permission_decision.valid_until is null
      or permission_decision.valid_until <= checked_at
      or (checked_context ->> 'issuedAt')::timestamptz > checked_at
      or (checked_context ->> 'expiresAt')::timestamptz <= checked_at then
      raise exception using errcode = '42501',
        message = 'Definition draft write authority is unavailable';
    end if;
    permission_deadline := least(permission_deadline, permission_decision.valid_until);
  end loop;

  if permission_deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Definition draft write authority is unavailable';
  end if;

  -- The caller can enforce this captured deadline after its writes without repeating permission
  -- evaluation. Access-version and root locks prevent the underlying grants from changing.
  return checked_context || pg_catalog.jsonb_build_object(
    'draftWriteDeadline', permission_deadline
  );
end
$function$;
alter function vortex_definition.validated_builder_draft_write_context_internal(uuid) owner to vortex_owner;


revoke all on function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  to postgres;

comment on function vortex_definition.validated_builder_draft_write_context_internal(uuid) is
  'Private live human Application draft guard for the existing create/save function owner; locks Access and classified roots and rechecks exact current permissions and deadlines.';

alter function vortex_definition.validated_builder_draft_write_context_internal(uuid)
  owner to vortex_owner;

create or replace function vortex_definition.validated_builder_evidence_read_context_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller_context jsonb;
  checked_context jsonb;
  permission_decision record;
begin
  caller_context := vortex_platform.current_context();
  if caller_context ->> 'callerKind' = 'system' then
    return vortex_definition.validated_system_context();
  end if;

  if caller_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Definition evidence read authority is unavailable';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.definition_drafts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.definition_drafts.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  checked_context := vortex_access.validated_human_request_context();
  if permission_decision.outcome is distinct from 'eligible'
    or checked_context is null
    or checked_context ->> 'callerKind' is distinct from 'human'
    or (checked_context ->> 'organizationId')::uuid
      is distinct from permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid
      is distinct from permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint
      is distinct from permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid
      is distinct from permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Definition evidence read authority is unavailable';
  end if;

  return checked_context;
end
$function$;

revoke all on function vortex_definition.validated_builder_evidence_read_context_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.validated_builder_evidence_read_context_internal() is
  'Returns the validated current system or human context for Definition evidence reads; human requests require definition-draft management permission.';

alter function vortex_definition.validated_builder_evidence_read_context_internal() owner to vortex_owner;

grant execute on function vortex_definition.validated_builder_evidence_read_context_internal() to postgres;

create or replace function vortex_definition.write_installation_runtime_bundle(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_pin_fingerprint text,
  p_parts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  selected_organization_id uuid;
  part_item jsonb;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  content_text text;
  content_bytes bytea;
  sha256_value text;
  total_size_value bigint := 0;
  parts_manifest jsonb;
  inserted_rows bigint;
  stored_bundle vortex_definition.installation_runtime_bundles%rowtype;
  expected_module_bindings jsonb;
  prepared_source jsonb;
  source_manifest jsonb;
  section_payloads jsonb := '{}'::jsonb;
  section_text text;
  application_content jsonb;
  expected_modules jsonb;
  expected_trigger_index jsonb;
  expected_access_plan jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 2
    or p_pin_fingerprint is null or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_parts is null or pg_catalog.jsonb_typeof(p_parts) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_parts) < pg_catalog.cardinality(expected_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Module installation context changed';
  end if;
  selected_organization_id := permission_decision.organization_id;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_application_release_revision
    where root.root_id = p_application_root_id
      and root.organization_id = selected_organization_id
      and root.kind = 'application'
      and release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      )
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' =
        p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (
        vortex_definition.accepted_contract_version('application')
      )
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation Application release is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', binding.module_root_id,
      'moduleReleaseRevision', binding.module_release_revision,
      'bindingRevision', binding.binding_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into expected_module_bindings
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned';
  prepared_source := vortex_definition.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or (prepared_source ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or (prepared_source ->> 'applicationReleaseRevision')::bigint is distinct from p_application_release_revision
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Installation runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  for section_value in
    select required.section
    from pg_catalog.unnest(expected_sections) as required(section)
  loop
    select pg_catalog.string_agg(item.value ->> 'content', '' order by
      (item.value ->> 'ordinal')::integer)
    into section_text
    from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    where item.value ->> 'section' = section_value;
    if section_text is null then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is unavailable';
    end if;
    begin
      section_payloads := section_payloads || pg_catalog.jsonb_build_object(
        section_value, section_text::jsonb
      );
    exception when others then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is invalid';
    end;
  end loop;
  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  if application_content is null then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle Application content is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'identity', pg_catalog.jsonb_build_object(
        'kind', module.value -> 'kind',
        'organizationId', module.value -> 'organizationId',
        'rootId', module.value -> 'rootId',
        'definitionKey', module.value -> 'key',
        'releaseRevision', module.value -> 'releaseRevision',
        'releaseVersion', module.value -> 'releaseVersion',
        'validationContractVersion', module.value -> 'validationContractVersion',
        'contentFingerprint', module.value -> 'contentFingerprint',
        'resolutionFingerprint', module.value -> 'resolutionFingerprint',
        'dependencyManifest', module.value -> 'dependencyManifest'
      ),
      'content', module.value #> '{compilationOutput,canonical,content}'
    ) order by (module.value ->> 'rootId') collate "C"), '[]'::jsonb)
  into expected_modules
  from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'flowId', flow.value -> 'id', 'trigger', trigger.value
    ) order by (flow.value ->> 'id') collate "C", (trigger.value ->> 'id') collate "C"), '[]'::jsonb)
  into expected_trigger_index
  from pg_catalog.jsonb_array_elements(application_content -> 'flows') as flow(value)
  cross join lateral pg_catalog.jsonb_array_elements(flow.value -> 'triggers') as trigger(value);
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  if section_payloads -> 'navigation' is distinct from application_content -> 'navigation'
    or section_payloads -> 'flows' is distinct from pg_catalog.jsonb_build_object(
      'flows', application_content -> 'flows',
      'flowBindings', application_content -> 'flowBindings'
    )
    or section_payloads -> 'trigger_index' is distinct from expected_trigger_index
    or section_payloads -> 'theme' is distinct from application_content -> 'theme'
    or section_payloads -> 'component_registry' is distinct from application_content -> 'platformBlockDependencies'
    or section_payloads -> 'tool_bundle' is distinct from prepared_source #> '{application,compilationOutput,toolBundle}'
    or section_payloads -> 'access_plan' is distinct from expected_access_plan
    or section_payloads #> '{pages,application,identity}' is distinct from (
      pg_catalog.jsonb_build_object(
        'kind', prepared_source #> '{application,kind}',
        'organizationId', prepared_source #> '{application,organizationId}',
        'rootId', prepared_source #> '{application,rootId}',
        'definitionKey', prepared_source #> '{application,key}',
        'releaseRevision', prepared_source #> '{application,releaseRevision}',
        'releaseVersion', prepared_source #> '{application,releaseVersion}',
        'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
        'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
        'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}',
        'dependencyManifest', prepared_source #> '{application,dependencyManifest}',
        'platformCompatibilityVersion',
          prepared_source #> '{application,compilationOutput,platformCompatibilityVersion}'
      )
    )
    or section_payloads #> '{pages,application,content}' is distinct from
      application_content - array[
        'navigation', 'flows', 'flowBindings', 'theme',
        'platformBlockDependencies', 'shells', 'pages'
      ]::text[]
    or section_payloads #> '{pages,application,shells}' is distinct from application_content -> 'shells'
    or section_payloads #> '{pages,application,pages}' is distinct from application_content -> 'pages'
    or section_payloads #> '{pages,modules}' is distinct from expected_modules
    or pg_catalog.jsonb_typeof(section_payloads #> '{pages,resolvedCompositions}') is distinct from 'array'
    or pg_catalog.jsonb_array_length(section_payloads #> '{pages,resolvedCompositions}') <>
      pg_catalog.jsonb_array_length(application_content -> 'pages') then
    raise exception using errcode = '23514',
      message = 'Installation runtime bundle sections do not match current immutable source';
  end if;
  for part_item in
    select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(part_item) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    if not (part_item ?& array['section', 'ordinal', 'byteSize', 'sha256', 'content'])
      or part_item - array['section', 'ordinal', 'byteSize', 'sha256', 'content'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(part_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'sha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'content') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;

    section_value := part_item ->> 'section';
    if not (section_value = any (expected_sections))
      or (part_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(part_item ->> 'ordinal') > 10
      or (part_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(part_item ->> 'byteSize') > 7 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    ordinal_value := (part_item ->> 'ordinal')::bigint;
    byte_size_value := (part_item ->> 'byteSize')::bigint;
    content_text := part_item ->> 'content';
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part exceeds its limit';
    end if;

    content_bytes := pg_catalog.convert_to(content_text, 'UTF8');
    if pg_catalog.octet_length(content_bytes) <> byte_size_value then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part size is invalid';
    end if;
    sha256_value := 'sha256:' || pg_catalog.encode(
      extensions.digest(content_bytes, 'sha256'), 'hex'
    );
    if (part_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$'
      or sha256_value <> (part_item ->> 'sha256') then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part fingerprint is invalid';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle is too large';
    end if;
  end loop;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle sections are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', item.value ->> 'section',
      'ordinal', (item.value ->> 'ordinal')::integer,
      'byteSize', (item.value ->> 'byteSize')::bigint,
      'sha256', item.value ->> 'sha256'
    ) order by pg_catalog.array_position(
      expected_sections, item.value ->> 'section'
    ), (item.value ->> 'ordinal')::integer
  )
  into parts_manifest
  from pg_catalog.jsonb_array_elements(p_parts) as item(value);

  insert into vortex_definition.installation_runtime_bundles (
    organization_id, application_root_id, application_release_revision,
    bundle_format_version, pin_fingerprint, source_manifest, parts, total_size_bytes
  ) values (
    selected_organization_id, p_application_root_id, p_application_release_revision,
    p_bundle_format_version, p_pin_fingerprint, source_manifest, parts_manifest, total_size_value
  ) on conflict (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ) do nothing;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    select stored.* into stored_bundle
    from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation runtime bundle changed concurrently';
    end if;
    if stored_bundle.pin_fingerprint <> p_pin_fingerprint
      or stored_bundle.source_manifest is distinct from source_manifest
      or stored_bundle.parts is distinct from parts_manifest
      or stored_bundle.total_size_bytes is distinct from total_size_value
      or (select pg_catalog.count(*) from vortex_definition.installation_runtime_bundle_parts as part
        where part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version)
        <> pg_catalog.jsonb_array_length(p_parts)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        left join vortex_definition.installation_runtime_bundle_parts as part
          on part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version
          and part.section = item.value ->> 'section'
          and part.ordinal = (item.value ->> 'ordinal')::integer
        where part.content_bytes is distinct from pg_catalog.convert_to(item.value ->> 'content', 'UTF8')
      ) then
      raise exception using errcode = '23505',
        message = 'Installation runtime bundle pin fingerprint differs';
    end if;
  else
    for part_item in
      select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    loop
      insert into vortex_definition.installation_runtime_bundle_parts (
        organization_id, application_root_id, application_release_revision,
        bundle_format_version, section, ordinal, content_bytes
      ) values (
        selected_organization_id, p_application_root_id, p_application_release_revision,
        p_bundle_format_version, part_item ->> 'section',
        (part_item ->> 'ordinal')::integer,
        pg_catalog.convert_to(part_item ->> 'content', 'UTF8')
      );
    end loop;

    select stored.* into strict stored_bundle
    from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle evidence is ambiguous';
end
$function$;

alter function vortex_definition.write_installation_runtime_bundle(uuid,bigint,integer,text,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) to vortex_request;
comment on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) is
  'Atomically stores one immutable runtime bundle for an authorised exact Application release and pin fingerprint.';


create or replace function vortex_platform.assert_connection_administration_authority(
  p_context jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  operation_value constant text := 'platform.organization.connections.manage';
  failure_sqlstate text;
  failure_message text;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.connections.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from (p_context ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (p_context ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (p_context ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (p_context ->> 'correlationId')::uuid then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  end if;
exception
  -- Only a refused permission decision is the safe denial; any other failure
  -- is a defect and keeps its SQLSTATE and message.
  when sqlstate '42501' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  when others then
    get stacked diagnostics failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise warning 'Connection administration authority check failed: SQLSTATE %, %',
      failure_sqlstate, failure_message;
    raise;
end
$function$;

revoke all on function vortex_platform.assert_connection_administration_authority(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_platform.assert_connection_administration_authority(jsonb) is null;
alter function vortex_platform.assert_connection_administration_authority(jsonb) owner to vortex_owner;

create or replace function vortex_record.read_organization_activity_aggregates(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_group_by text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  groups jsonb;
  total bigint;
  truncated boolean;
begin
  if p_group_by is null
    or p_group_by <> all (array['action', 'actorKind', 'source', 'outcome'])
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ])) then
    raise exception using errcode = '22023',
      message = 'Activity history aggregate selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.permissions.read')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*
    from vortex_record.organization_activity_entries as entry
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  grouped as (
    select case p_group_by
        when 'action' then filtered.action
        when 'actorKind' then filtered.actor_kind
        when 'source' then filtered.source
        when 'outcome' then filtered.outcome
      end as value,
      pg_catalog.count(*)::bigint as entry_count
    from filtered
    group by 1
  ),
  ranked as (
    select grouped.value, grouped.entry_count,
      pg_catalog.row_number() over (
        order by grouped.entry_count desc, grouped.value
      ) as ordinal
    from grouped
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('value', ranked.value, 'count', ranked.entry_count)
        order by ranked.entry_count desc, ranked.value
      ) filter (where ranked.ordinal <= 100),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.sum(ranked.entry_count), 0),
    pg_catalog.count(*) > 100
  into groups, total, truncated
  from ranked;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'total', total,
    'groups', groups,
    'truncated', truncated
  );
end
$function$;
alter function vortex_record.read_organization_activity_aggregates(timestamp with time zone,timestamp with time zone,text,uuid,text,uuid,text,text,text) owner to vortex_owner;


revoke execute on function vortex_record.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) to vortex_request;

comment on function vortex_record.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) is
  'Returns bounded group counts over the same protected Activity filters and projection as read_organization_activity_page.';

alter function vortex_record.read_organization_activity_aggregates(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, text
) owner to vortex_owner;

create or replace function vortex_record.read_organization_activity_page(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_page_size integer,
  p_after_occurred_at timestamptz,
  p_after_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  entries jsonb;
  has_more boolean := false;
  last_occurred_at timestamptz;
  last_activity_id uuid;
begin
  if p_page_size is null or p_page_size not between 1 and 200
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ]))
    or (p_after_occurred_at is null) <> (p_after_activity_id is null)
    or (p_after_occurred_at is not null
      and p_after_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_after_activity_id is not null
      and p_after_activity_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Activity history page selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.permissions.read')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*, authority.authority_kind,
      authority.assignment_id as authority_assignment_id
    from vortex_record.organization_activity_entries as entry
    left join vortex_record.organization_activity_super_administrator_authority as authority
      on authority.organization_id = entry.organization_id
      and authority.activity_id = entry.activity_id
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  ordered as (
    select filtered.*
    from filtered
    where p_after_occurred_at is null
      or (filtered.occurred_at, filtered.activity_id)
        < (p_after_occurred_at, p_after_activity_id)
    order by filtered.occurred_at desc, filtered.activity_id desc
    limit p_page_size + 1
  ),
  numbered as (
    select ordered.*,
      pg_catalog.row_number() over (
        order by ordered.occurred_at desc, ordered.activity_id desc
      ) as ordinal
    from ordered
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'activityId', numbered.activity_id,
          'occurredAt', numbered.occurred_at,
          'actorKind', numbered.actor_kind,
          'actorId', numbered.actor_id,
          'action', numbered.action,
          'subjectIds', pg_catalog.to_jsonb(numbered.subject_ids),
          'source', numbered.source,
          'correlationId', numbered.correlation_id,
          'outcome', numbered.outcome
        ) || case
          when numbered.authority_assignment_id is not null then pg_catalog.jsonb_build_object(
            'authority', pg_catalog.jsonb_build_object(
              'kind', numbered.authority_kind,
              'assignmentId', numbered.authority_assignment_id
            )
          )
          else '{}'::jsonb
        end || case
          when audit_projection then pg_catalog.jsonb_build_object(
            'changedFieldIds', pg_catalog.to_jsonb(numbered.changed_field_ids)
          )
          else '{}'::jsonb
        end
        order by numbered.ordinal
      ) filter (where numbered.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.max(numbered.ordinal) > p_page_size, false),
    (pg_catalog.array_agg(numbered.occurred_at order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1],
    (pg_catalog.array_agg(numbered.activity_id order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1]
  into entries, has_more, last_occurred_at, last_activity_id
  from numbered;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'entries', entries,
    'next', case
      when has_more then pg_catalog.jsonb_build_object(
        'occurredAt', last_occurred_at,
        'activityId', last_activity_id
      )
      else null
    end
  );
end
$function$;
alter function vortex_record.read_organization_activity_page(timestamp with time zone,timestamp with time zone,text,uuid,text,uuid,text,text,integer,timestamp with time zone,uuid) owner to vortex_owner;


revoke execute on function vortex_record.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) to vortex_request;

comment on function vortex_record.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) is
  'Returns one bounded newest-first keyset page of the caller''s own organisation Activity, or the organisation-wide audit projection when the actor holds the organisation access-administration read authority.';

alter function vortex_record.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) owner to vortex_owner;

reset role;
