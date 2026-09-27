-- #1419: replace historical in-place SQL body patches with complete definitions.
-- Every body below is the original full definition after its historical patches,
-- in migration order, with no change to runtime behaviour.

begin;
set local role postgres;

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
  stewardship vortex_access.organization_stewardship_requirements%rowtype;
  platform_registration vortex_access.permission_registrations%rowtype;
  continuity_count bigint;
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

  if found then
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

    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
    select published.access_version into next_access_version
    from vortex_access.initialize_platform_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    ) as published;

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

  select registration.* into platform_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.state = 'active'
  for update;
  if not found
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, platform_registration.revision
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform'
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  select pg_catalog.count(*) into continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id is null
    and continuity.registration_kind = 'platform';

  if continuity_count = 0 then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id, state,
      continuity_revision, meaning_fingerprint,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, null, entry.owner_kind, entry.owner_id,
      entry.permission_id, 'platform', entry.registration_owner_id,
      'available', 1, entry.meaning_fingerprint, entry.registration_revision,
      pg_catalog.clock_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_revision = platform_registration.revision
    order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;
  elsif continuity_count <> 13 or exists (
    select 1
    from vortex_access.permission_continuities as continuity
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id is null
      and continuity.registration_kind = 'platform'
      and not exists (
        select 1
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = continuity.organization_id
          and entry.registration_kind = 'platform'
          and entry.registration_revision = platform_registration.revision
          and entry.application_root_id is null
          and entry.owner_kind = continuity.owner_kind
          and entry.owner_id = continuity.owner_id
          and entry.permission_id = continuity.permission_id
          and entry.registration_owner_id = continuity.registration_owner_id
          and entry.meaning_fingerprint = continuity.meaning_fingerprint
          and continuity.state = 'available'
      )
  ) or exists (
    select 1
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_revision = platform_registration.revision
      and not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = entry.organization_id
          and continuity.application_root_id is null
          and continuity.registration_kind = 'platform'
          and continuity.registration_owner_id = entry.registration_owner_id
          and continuity.owner_kind = entry.owner_kind
          and continuity.owner_id = entry.owner_id
          and continuity.permission_id = entry.permission_id
          and continuity.state = 'available'
          and continuity.meaning_fingerprint = entry.meaning_fingerprint
      )
  ) then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity evidence is incomplete';
  end if;

  checked_at := pg_catalog.clock_timestamp();

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, derived_application_root_id, derived_source_role_id,
    derived_source_definition_key, derived_source_release_revision,
    derived_source_release_version,
    derived_source_validation_contract_version,
    derived_source_content_fingerprint,
    derived_source_resolution_fingerprint,
    derived_source_template_fingerprint, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_role_id, 'custom', p_role_key, null, null,
    null, null, null, null, null, null, null, null, null, 1,
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
    and continuity.state = 'available'
    and continuity.meaning_fingerprint = entry.meaning_fingerprint
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and entry.registration_revision = platform_registration.revision
  order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', null, 'active', 'privileged',
    'standing', 1, 1, null, null, null, p_role_key, p_role_label,
    p_role_description, null, null, null, null, null, null, null, null,
    null, null, null, p_changed_by, checked_at, p_correlation_id
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
    scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_delegation_authority_id, 'organization_account',
    p_organization_account_id, null, 'organization_catalogue', null, null, 1,
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

  select published.access_version into next_access_version
  from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id, p_changed_by, p_correlation_id
  ) as published;

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
  'Owner-only atomic first-steward adoption or exact unchanged replay. It creates the fixed platform-management facts once and changes Access once.';
revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create or replace function vortex_access.organization_group_reduction_authority(
  p_organization_id uuid,
  p_group_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  affected_permissions jsonb;
begin
  -- The protected caller already holds the organization Access-version update
  -- lock used by every supported assignment, delegation and role writer. That
  -- makes this complete retained-fact read stable without another lock order.
  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    left join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
      and (role_revision.lifecycle is null
        or role_revision.lifecycle not in ('unavailable', 'acceptance_required', 'retired'))
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
      )
  ) then
    raise exception using errcode = '40001',
      message = 'Organization Group retained authority is stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
      and role_revision.lifecycle in ('unavailable', 'acceptance_required', 'retired')
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
      )
  ) then
    return pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  end if;

  if exists (
    select 1
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = p_organization_id
      and delegation.holder_kind = 'group'
      and delegation.group_id = p_group_id
      and delegation.state = 'live'
      and delegation.scope_kind = 'organization_catalogue'
  ) then
    return pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', reference.application_root_id,
      'ownerKind', reference.owner_kind,
      'ownerId', reference.owner_id,
      'permissionId', reference.permission_id
    )) order by reference.application_root_id nulls first,
      reference.owner_kind collate "C", reference.owner_id,
      reference.permission_id
  )
  into affected_permissions
  from (
    select permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = role.organization_id
      and permission.role_id = role.role_id
      and permission.role_revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
    union
    select case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid else null end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid
    from vortex_access.organization_delegation_authorities as delegation
    cross join lateral pg_catalog.jsonb_array_elements(
      delegation.bounded_permissions
    ) as permission(value)
    where delegation.organization_id = p_organization_id
      and delegation.holder_kind = 'group'
      and delegation.group_id = p_group_id
      and delegation.state = 'live'
      and delegation.scope_kind = 'bounded'
  ) as reference;

  if affected_permissions is null then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', affected_permissions
  );
end
$function$;

comment on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) is
  'Private complete retained Group assignment/delegation scope derivation for protected reductions; a zero-permission unavailable, acceptance_required or retired role contributes organisation-catalogue authority.';
revoke execute on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create or replace function vortex_access.recent_authentication_deadline_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_requirement jsonb
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  requirement_kind_value text := p_requirement ->> 'kind';
  requirement_maximum_age_value bigint := case
    when requirement_kind_value = 'none' then null
    else (p_requirement ->> 'maximumAgeSeconds')::numeric::bigint
  end;
  evidence_at timestamptz;
  satisfied boolean;
  deadline timestamptz;
begin
  if requirement_kind_value = 'none' then
    return context_expires_value;
  end if;

  evidence_at := case requirement_kind_value
    when 'primary' then (p_context ->> 'primaryAuthenticatedAt')::timestamptz
    when 'multi_factor' then (p_context ->> 'multiFactorAuthenticatedAt')::timestamptz
  end;

  satisfied := evidence_at is not null
    and evidence_at <= p_checked_at
    and extract(epoch from (p_checked_at - evidence_at)) <
      requirement_maximum_age_value::numeric;

  if satisfied is not true then
    return null;
  end if;

  deadline := context_expires_value;
  if requirement_maximum_age_value::numeric <
    extract(epoch from (context_expires_value - evidence_at)) then
    deadline := evidence_at +
      (requirement_maximum_age_value::double precision * interval '1 second');
  end if;

  return deadline;
end
$function$;

comment on function
  vortex_access.recent_authentication_deadline_internal(jsonb, timestamptz, jsonb) is
  'Private recent-authentication deadline evidence; null means the requirement is unsatisfied. No row or record authority.';
revoke execute on function
  vortex_access.recent_authentication_deadline_internal(jsonb, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

create or replace function vortex_access.reactivate_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account reactivation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'reactivate_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'reactivate_organization_account'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_organization_account_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Account reactivation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'reactivate_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_account_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account reactivation is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'active'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'active' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account reactivation result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    changed.state_change_correlation_id, scope.organization_account_id,
    scope.tenant_id, 'reactivate_organization_account', p_duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, changed.changed_at
  );
  return query select 'accepted'::text, 'reactivate_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected suspended-or-closed-to-active account command using the existing guarded owner and accepted receipt.';
revoke execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

create or replace function vortex_access.close_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closure command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'close_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'close_organization_account'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_organization_account_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Account closure receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'close_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_account_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('active', 'suspended')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closure is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'closed'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closed' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closure result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    changed.state_change_correlation_id, scope.organization_account_id,
    scope.tenant_id, 'close_organization_account', p_duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, changed.changed_at
  );
  return query select 'accepted'::text, 'close_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-or-suspended-to-closed account command; closure is not deletion.';
revoke execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

create or replace function vortex_access.suspend_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account suspension command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'suspend_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = scope.organization_account_id
    and stored.tenant_id = scope.tenant_id
    and stored.operation_key = 'suspend_organization_account'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(receipt.subject_ids) <> 2
      or not scope.organization_id = any(receipt.subject_ids)
      or not p_organization_account_id = any(receipt.subject_ids) then
      raise exception using errcode = '42501', message = 'Account suspension receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'suspend_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, p_organization_account_id)],
      receipt.receipt_id, receipt.accepted_at,
      receipt.subject_revisions[pg_catalog.array_position(receipt.subject_ids, scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state <> 'active' or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account suspension is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'suspended'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'suspended' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account suspension result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    changed.state_change_correlation_id, scope.organization_account_id,
    scope.tenant_id, 'suspend_organization_account', p_duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, changed.changed_at
  );
  return query select 'accepted'::text, 'suspend_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-to-suspended account command using the existing guarded owner and accepted receipt.';
revoke execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

create or replace function vortex_access.lock_active_record_ownership_target_internal(
  p_kind text,
  p_target_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  matched boolean;
begin
  if p_kind is null
    or p_kind not in ('organization_account', 'group')
    or p_target_id is null
    or p_target_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_kind = 'organization_account' then
    select true into matched
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where account.organization_id = (context_value ->> 'organizationId')::uuid
      and account.organization_account_id = p_target_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
    for share of account, projection;
  else
    select true into matched
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
      and organization_group.group_id = p_target_id
      and organization_group.state = 'active'
    for share of organization_group;
  end if;
  return coalesce(matched, false);
end
$function$;

comment on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) is
  'Private exact active same-organisation account or Group target check for the fixed Record ownership-transfer operation.';
revoke all on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) to vortex_record_adapter;

create or replace function vortex_connection.resolve_connection_instance_readiness(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_connection_instance_id uuid,
  p_destination_key text,
  p_expected_revision bigint,
  p_expected_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_org_id uuid;
  context_app_id uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  now_ts timestamptz := pg_catalog.statement_timestamp();
begin
  -- 1. Validate parameter shapes (all mandatory)
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_connection_instance_id is null or p_connection_instance_id = nil_uuid
    or p_application_root_id is null or p_application_root_id = nil_uuid
    or p_destination_key is null
    or pg_catalog.char_length(p_destination_key) not between 1 and 80
    or p_destination_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_expected_fingerprint is null
    or p_expected_fingerprint !~ '^[a-f0-9]{64}$' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_parameters'
    );
  end if;

  -- 2. Validate request context binding
  context_value := vortex_context.current_context();
  context_org_id := vortex_context.organization_id();
  if context_org_id is null or context_org_id <> p_organization_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'organization_mismatch'
    );
  end if;

  -- Connection instances strictly require permanent application scope (not organisation-shared)
  if context_value ? 'applicationRootId' then
    context_app_id := (context_value ->> 'applicationRootId')::uuid;
    if context_app_id is distinct from p_application_root_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused',
        'reasonCode', 'application_mismatch'
      );
    end if;
  end if;

  -- 3. Read connection instance row under FOR SHARE lock
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = p_organization_id
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_unavailable'
    );
  end if;

  -- 4. Check active state and health outcome
  if conn_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_not_active',
      'currentState', conn_row.state
    );
  end if;

  if conn_row.last_health_outcome <> 'healthy' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_unhealthy',
      'currentHealthOutcome', conn_row.last_health_outcome
    );
  end if;

  -- 5. Check token expiry if set
  if conn_row.token_expires_at is not null
    and (not pg_catalog.isfinite(conn_row.token_expires_at)
      or conn_row.token_expires_at <= now_ts) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_token_expired'
    );
  end if;

  -- 6. Check destination key
  if conn_row.destination_key <> p_destination_key then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'destination_mismatch'
    );
  end if;

  -- 7. Mandatory revision freshness check
  if conn_row.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_revision',
      'currentRevision', conn_row.revision
    );
  end if;

  -- 8. Mandatory destination fingerprint freshness check
  if conn_row.destination_fingerprint <> p_expected_fingerprint then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_fingerprint'
    );
  end if;

  -- 9. Lock the exact application grant and its permanent root for the decision.
  perform 1
  from vortex_connection.connection_application_grants as grant_entry
  join vortex_definition.roots as app_root
    on app_root.root_id = grant_entry.application_root_id
    and app_root.organization_id = grant_entry.organization_id
    and app_root.kind = 'application'
  where grant_entry.connection_instance_id = p_connection_instance_id
    and grant_entry.application_root_id = p_application_root_id
    and grant_entry.organization_id = p_organization_id
  for share of grant_entry, app_root;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'grant_unauthorized'
    );
  end if;

  -- 10. Return authoritative owner-projected readiness evidence
  return pg_catalog.jsonb_build_object(
    'outcome', 'ready',
    'connectionInstanceId', conn_row.connection_instance_id,
    'organizationId', conn_row.organization_id,
    'applicationRootId', p_application_root_id,
    'destinationKey', conn_row.destination_key,
    'destinationFingerprint', conn_row.destination_fingerprint,
    'revision', conn_row.revision,
    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'tokenExpiresAt', pg_catalog.to_jsonb(conn_row.token_expires_at),
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );
end
$function$;

comment on function vortex_connection.resolve_connection_instance_readiness(
  uuid, uuid, uuid, text, bigint, text
) is
  '#408: Authoritative owner-projected Connection-instance readiness resolver. Fails closed on inactive, unhealthy, expired, mismatched destination, ungranted application, or stale revision/fingerprint.';
revoke all on function
  vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text) to vortex_request, vortex_runtime;
grant execute on function vortex_connection.resolve_connection_instance_readiness(
  uuid, uuid, uuid, text, bigint, text
) to vortex_record_owner;

create or replace function vortex_connection.read_active_connection_evidence(
  p_connection_instance_id uuid
)
returns table (
  connection_instance_id uuid,
  destination_key text,
  destination_fingerprint text,
  organization_id uuid,
  authorized_application_ids uuid[],
  state text,
  revision bigint,
  last_health_outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_org_id uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  locked_authorized_application_ids uuid[];
begin
  context_org_id := vortex_context.organization_id();

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = context_org_id
    and conn.state = 'active'
    and conn.last_health_outcome = 'healthy'
    and (conn.token_expires_at is null
      or (pg_catalog.isfinite(conn.token_expires_at)
        and conn.token_expires_at > pg_catalog.statement_timestamp()))
  for share;

  if not found then
    return;
  end if;

  select pg_catalog.array_agg(
    locked_grant.application_root_id order by locked_grant.application_root_id
  )
  into locked_authorized_application_ids
  from (
    select grant_entry.application_root_id
    from vortex_connection.connection_application_grants as grant_entry
    join vortex_definition.roots as app_root
      on app_root.root_id = grant_entry.application_root_id
      and app_root.organization_id = grant_entry.organization_id
      and app_root.kind = 'application'
    where grant_entry.connection_instance_id = conn_row.connection_instance_id
      and grant_entry.organization_id = conn_row.organization_id
    for share of grant_entry, app_root
  ) as locked_grant;

  if locked_authorized_application_ids is null then
    return;
  end if;

  return query
  select
    conn_row.connection_instance_id,
    conn_row.destination_key,
    conn_row.destination_fingerprint,
    conn_row.organization_id,
    locked_authorized_application_ids,
    conn_row.state,
    conn_row.revision,
    conn_row.last_health_outcome;
end
$function$;

comment on function vortex_connection.read_active_connection_evidence(uuid) is
  '#408: Reads active healthy Connection instance evidence scoped to current context organization.';
revoke all on function
  vortex_connection.read_active_connection_evidence(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.read_active_connection_evidence(uuid) to vortex_request, vortex_runtime;

create or replace function vortex_connection.register_connection_instance_internal(
  p_connection_instance_id uuid,
  p_organization_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  administration_context jsonb;
begin
  -- Validate administration context for target organization
  administration_context := vortex_connection.validated_administration_context(p_organization_id);

  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection registration requires non-nil administrator activity ID';
  end if;

  insert into vortex_connection.connection_instances (
    connection_instance_id,
    organization_id,
    connection_type_id,
    connection_type_version,
    destination_key,
    destination_fingerprint,
    state,
    last_health_outcome,
    revision,
    administrator_activity_id,
    token_expires_at,
    created_at,
    updated_at
  ) values (
    p_connection_instance_id,
    p_organization_id,
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    'pending',
    'unknown',
    1,
    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_registered',
    operation_at
  );
end
$function$;

comment on function vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamp with time zone) is null;
revoke all on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, uuid, timestamptz) to vortex_runtime;

create or replace function vortex_connection.grant_connection_application_internal(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  app_org_id uuid;
  app_kind text;
  administration_context jsonb;
  inserted_connection_instance_id uuid;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection grant requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  -- Resolve and lock application root
  select root.organization_id, root.kind into app_org_id, app_kind
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = '23503',
      message = 'Referenced application root is unavailable';
  end if;

  if app_kind <> 'application' then
    raise exception using
      errcode = '23514',
      message = 'Referenced root must be of kind application';
  end if;

  if app_org_id <> conn_row.organization_id then
    raise exception using
      errcode = '23514',
      message = 'Referenced application root organization does not match connection organization';
  end if;

  insert into vortex_connection.connection_application_grants (
    connection_instance_id,
    application_root_id,
    organization_id,
    granted_at
  ) values (
    p_connection_instance_id,
    p_application_root_id,
    conn_row.organization_id,
    operation_at
  )
  on conflict (connection_instance_id, application_root_id) do nothing
  returning connection_instance_id into inserted_connection_instance_id;

  if inserted_connection_instance_id is null then
    raise exception using
      errcode = '23514',
      message = 'Connection application grant already exists';
  end if;

  perform vortex_connection.append_application_grant_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    p_application_root_id,
    'connection_application_granted',
    operation_at
  );
end
$function$;

comment on function vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) is null;
revoke all on function
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid) to vortex_runtime;

create or replace function vortex_connection.revoke_connection_application_internal(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_administrator_activity_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  administration_context jsonb;
  locked_application_root_id uuid;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection grant revocation requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance not found';
  end if;

  select grant_entry.application_root_id into locked_application_root_id
  from vortex_connection.connection_application_grants as grant_entry
  where grant_entry.connection_instance_id = p_connection_instance_id
    and grant_entry.application_root_id = p_application_root_id
    and grant_entry.organization_id = conn_row.organization_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Connection application grant not found';
  end if;

  delete from vortex_connection.connection_application_grants
  where connection_instance_id = p_connection_instance_id
    and application_root_id = locked_application_root_id;

  perform vortex_connection.append_application_grant_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    p_application_root_id,
    'connection_application_revoked',
    operation_at
  );
end
$function$;

comment on function vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) is null;
revoke all on function
  vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.revoke_connection_application_internal(uuid, uuid, uuid) to vortex_runtime;

create or replace function vortex_connection.record_connection_health_check_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_administrator_activity_id uuid default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  conn_row vortex_connection.connection_instances%rowtype;
  next_state text;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_new_health_outcome not in ('healthy', 'unhealthy') then
    raise exception using
      errcode = '22023',
      message = 'Invalid health outcome: must be healthy or unhealthy';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires a valid expected revision';
  end if;

  if p_administrator_activity_id is null
    or p_administrator_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection health update requires non-nil administrator activity ID';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  -- Lock row for update
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;

  -- Terminal revocation check
  if conn_row.state = 'revoked' then
    raise exception using
      errcode = '42501',
      message = 'Connection instance is revoked; revocation is terminal and cannot transition via health check';
  end if;

  -- Explicit monotonic state transition matrix
  if p_new_health_outcome = 'healthy' then
    next_state := 'active';
  else
    next_state := 'unhealthy';
  end if;

  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = next_state,
      revision = revision + 1,
      administrator_activity_id = p_administrator_activity_id,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_health_recorded',
    operation_at
  );

  return new_revision;
end
$function$;

comment on function vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) is null;
revoke all on function
  vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.record_connection_health_check_internal(uuid, bigint, text, uuid) to vortex_runtime;

create or replace function vortex_connection.revoke_connection_instance_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection revocation requires a valid expected revision';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection revocation failed: revision mismatch or not found';
  end if;

  if conn_row.state = 'revoked' then
    raise exception using
      errcode = '23514',
      message = 'Connection revocation requires a non-revoked source state';
  end if;

  update vortex_connection.connection_instances
  set state = 'revoked',
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_revoked',
    operation_at
  );

  return new_revision;
end
$function$;

comment on function vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) is null;
revoke all on function
  vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.revoke_connection_instance_internal(uuid, bigint, uuid) to vortex_runtime;

create or replace function vortex_connection.reauthorize_connection_instance_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_administrator_activity_id uuid,
  p_destination_fingerprint text default null,
  p_token_expires_at timestamptz default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  new_revision bigint;
  administration_context jsonb;
begin
  if p_administrator_activity_id is null or p_administrator_activity_id = nil_uuid then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires non-nil administrator activity ID';
  end if;

  if p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using
      errcode = '22023',
      message = 'Connection reauthorization requires a valid expected revision';
  end if;

  if p_destination_fingerprint is not null and p_destination_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Invalid destination fingerprint: must be 64 lowercase hex characters';
  end if;

  -- Validate administration context before locking, then bind the lock to the
  -- context organisation so a foreign or missing identifier is indistinguishable.
  administration_context := vortex_connection.validated_administration_context(vortex_context.organization_id());

  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = (administration_context ->> 'organizationId')::uuid
  for update;

  if not found or conn_row.revision <> p_expected_revision then
    raise exception using
      errcode = 'P0002',
      message = 'Connection reauthorization failed: revision mismatch or not found';
  end if;

  if conn_row.state <> 'revoked' then
    raise exception using
      errcode = '23514',
      message = 'Connection reauthorization requires revoked source state';
  end if;

  update vortex_connection.connection_instances
  set state = 'pending',
      last_health_outcome = 'unknown',
      destination_fingerprint = coalesce(p_destination_fingerprint, destination_fingerprint),
      token_expires_at = p_token_expires_at,
      administrator_activity_id = p_administrator_activity_id,
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  perform vortex_connection.append_connection_instance_activity_internal(
    administration_context,
    p_administrator_activity_id,
    p_connection_instance_id,
    'connection_reauthorized',
    operation_at
  );

  return new_revision;
end
$function$;

comment on function vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamp with time zone) is null;
revoke all on function
  vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function
  vortex_connection.reauthorize_connection_instance_internal(uuid, bigint, uuid, text, timestamptz) to vortex_runtime;

create or replace function vortex_access.capability_reservation_request_context(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (
  request_organization_id uuid,
  correlation_id uuid,
  request_expires_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  established_organization_id uuid;
  effective_organization_id uuid;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text)) then
    raise exception using errcode = '22023', message = 'Capability reservation scope is invalid';
  end if;
  established_organization_id := (established ->> 'organizationId')::uuid;
  effective_organization_id := coalesce(p_organization_id, established_organization_id);
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or effective_organization_id is distinct from established_organization_id
    or vortex_context.is_non_nil_uuid(established ->> 'correlationId') is distinct from true then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  if effective_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = effective_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  return query select effective_organization_id,
    (established ->> 'correlationId')::uuid,
    (established ->> 'expiresAt')::timestamptz;
end
$function$;

comment on function vortex_access.capability_reservation_request_context(uuid, uuid) is null;
revoke execute on function
  vortex_access.capability_reservation_request_context(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create or replace function vortex_access.reserve_capability_quantity(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_claim jsonb, p_requested_quantity numeric, p_duplicate_key uuid
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  effective record;
  protected_context record;
  balance record;
  existing_command vortex_access.capability_reservation_commands%rowtype;
  command_fingerprint text;
  reservation_id uuid;
  expires_at timestamptz;
  safe_result jsonb;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_claim is null or pg_catalog.jsonb_typeof(p_policy_claim) <> 'object'
    or not vortex_access.capability_policy_quantity_is_valid(p_requested_quantity)
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability reservation command is invalid';
  end if;
  select locked.* into effective
  from vortex_access.lock_effective_capability_policy(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at
  ) as locked;
  if effective.correlation_id is null then
    select context.* into strict protected_context
    from vortex_access.capability_reservation_request_context(
      p_tenant_id, p_organization_id
    ) as context;
  else
    protected_context := effective;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'reserve_capability_quantity', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_claim::text,
      p_requested_quantity::text), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_duplicate_key::text), 650)
  );
  select stored.* into existing_command
  from vortex_access.capability_reservation_commands as stored
  where stored.tenant_id = p_tenant_id
    and stored.request_organization_id
      is not distinct from protected_context.request_organization_id
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if existing_command.operation_kind <> 'reserve'
      or existing_command.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability reservation duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      existing_command.result, '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  if effective.assignment_id is null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'requestedQuantity', p_requested_quantity::text,
      'reasonCode', 'capability_not_assigned',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, result,
      correlation_id, accepted_at
    ) values (
      p_tenant_id, protected_context.request_organization_id, p_duplicate_key,
      'reserve', command_fingerprint, safe_result,
      protected_context.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  if balance.available_quantity < p_requested_quantity then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', effective.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
      'assignmentId', effective.assignment_id,
      'assignmentRevision', effective.assignment_revision,
      'appliedScope', effective.applied_scope,
      'requestedQuantity', p_requested_quantity::text,
      'reasonCode', 'insufficient_capacity',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', effective.correlation_id,
      'balance', pg_catalog.jsonb_build_object(
        'policyLimit', balance.policy_quantity_limit::text,
        'activeReservedQuantity', balance.active_reserved_quantity::text,
        'consumedQuantity', balance.consumed_quantity::text,
        'releasedQuantity', balance.released_quantity::text,
        'availableQuantity', balance.available_quantity::text)
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, result,
      correlation_id, accepted_at
    ) values (
      p_tenant_id, effective.request_organization_id, p_duplicate_key,
      'reserve', command_fingerprint, safe_result,
      effective.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  expires_at := least(evaluated_at + interval '300 seconds',
    effective.request_expires_at,
    coalesce(effective.assignment_expires_at, 'infinity'::timestamptz));
  if expires_at <= evaluated_at then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', effective.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
      'assignmentId', effective.assignment_id,
      'assignmentRevision', effective.assignment_revision,
      'appliedScope', effective.applied_scope,
      'requestedQuantity', p_requested_quantity::text, 'reasonCode', 'policy_stale',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', effective.correlation_id
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, result,
      correlation_id, accepted_at
    ) values (
      p_tenant_id, effective.request_organization_id, p_duplicate_key,
      'reserve', command_fingerprint, safe_result,
      effective.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  reservation_id := pg_catalog.gen_random_uuid();
  insert into vortex_access.capability_reservations (
    reservation_id, tenant_id, request_organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    applied_scope, policy_quantity_limit, reserved_quantity,
    consumed_quantity, released_quantity, state, created_at, expires_at,
    updated_at, reserve_duplicate_key, correlation_id
  ) values (
    reservation_id, p_tenant_id, effective.request_organization_id,
    p_capability_key, p_unit, effective.policy_id, effective.policy_revision,
    effective.assignment_id, effective.assignment_revision,
    effective.applied_scope, effective.quantity_limit, p_requested_quantity,
    0, 0, 'active', evaluated_at, expires_at, evaluated_at,
    p_duplicate_key, effective.correlation_id
  );
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'reserved', 'status', 'accepted', 'reservationId', reservation_id,
    'tenantId', p_tenant_id, 'organizationId', effective.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
    'assignmentId', effective.assignment_id,
    'assignmentRevision', effective.assignment_revision,
    'appliedScope', effective.applied_scope,
    'reservedQuantity', p_requested_quantity::text,
    'reservedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt', pg_catalog.to_char(expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', effective.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)
  ));
  insert into vortex_access.capability_reservation_commands (
    tenant_id, request_organization_id, duplicate_key,
    operation_kind, command_fingerprint, reservation_id,
    result, correlation_id, accepted_at
  ) values (
    p_tenant_id, effective.request_organization_id, p_duplicate_key,
    'reserve', command_fingerprint, reservation_id,
    safe_result, effective.correlation_id, evaluated_at
  );
  return query select safe_result;
end
$function$;

comment on function vortex_access.reserve_capability_quantity(
  uuid, uuid, text, text, jsonb, numeric, uuid
) is
  'Resolves and locks current organisation-preferred policy, then atomically reserves or records a safe refusal.';
revoke execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid) to vortex_request;

create or replace function vortex_access.release_capability_reservation(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid,
  p_assignment_revision bigint, p_reservation_id uuid, p_duplicate_key uuid,
  p_quantity numeric default null
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  protected_context record;
  target vortex_access.capability_reservations%rowtype;
  existing_command vortex_access.capability_reservation_commands%rowtype;
  command_fingerprint text;
  remaining numeric;
  release_amount numeric;
  new_released numeric;
  new_remaining numeric;
  new_state text;
  balance record;
  safe_result jsonb;
  refusal_reason text;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision not between 1 and 9007199254740991
    or p_reservation_id is null or not vortex_context.is_non_nil_uuid(p_reservation_id::text)
    or (p_quantity is not null
      and not vortex_access.capability_policy_quantity_is_valid(p_quantity))
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability release command is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'release_capability_reservation', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, p_assignment_revision::text,
      p_reservation_id::text, coalesce(p_quantity::text, 'all')), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_duplicate_key::text), 650)
  );
  select stored.* into existing_command
  from vortex_access.capability_reservation_commands as stored
  where stored.tenant_id = p_tenant_id
    and stored.request_organization_id
      is not distinct from protected_context.request_organization_id
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if existing_command.operation_kind <> 'release'
      or existing_command.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability release duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      existing_command.result, '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  select reservation.* into target
  from vortex_access.capability_reservations as reservation
  where reservation.reservation_id = p_reservation_id for update;
  if not found
    or target.tenant_id <> p_tenant_id
    or target.request_organization_id is distinct from protected_context.request_organization_id
    or target.capability_key <> p_capability_key or target.unit <> p_unit
    or target.policy_id <> p_policy_id or target.policy_revision <> p_policy_revision
    or target.assignment_id <> p_assignment_id
    or target.assignment_revision <> p_assignment_revision then
    refusal_reason := 'reservation_unavailable';
  elsif target.state <> 'active' or target.expires_at <= evaluated_at then
    if target.state = 'active' then
      update vortex_access.capability_reservations as reservation
      set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
      where reservation.reservation_id = p_reservation_id;
    end if;
    refusal_reason := 'reservation_stale';
  else
    remaining := target.reserved_quantity - target.consumed_quantity - target.released_quantity;
    release_amount := coalesce(p_quantity, remaining);
    if release_amount <= 0 or release_amount > remaining then
      refusal_reason := 'insufficient_reserved_quantity';
    end if;
  end if;
  if refusal_reason is not null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'reservationId', p_reservation_id,
      'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'reasonCode', refusal_reason,
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, reservation_id,
      result, correlation_id, accepted_at
    ) values (
      p_tenant_id, protected_context.request_organization_id, p_duplicate_key,
      'release', command_fingerprint,
      case when target.reservation_id is null then null else target.reservation_id end,
      safe_result, protected_context.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  new_released := target.released_quantity + release_amount;
  new_remaining := remaining - release_amount;
  new_state := case when new_remaining = 0 then 'released' else 'active' end;
  update vortex_access.capability_reservations as reservation
  set released_quantity = new_released, state = new_state,
      released_at = evaluated_at, updated_at = evaluated_at
  where reservation.reservation_id = p_reservation_id;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    target.tenant_id, target.request_organization_id, target.capability_key, target.unit,
    target.applied_scope,
    case when target.applied_scope = 'organization'
      then target.request_organization_id else null::uuid end,
    target.policy_id, target.policy_revision, target.assignment_id,
    target.assignment_revision, target.policy_quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'released', 'status', 'accepted', 'reservationId', p_reservation_id,
    'tenantId', p_tenant_id, 'organizationId', target.request_organization_id,
    'capabilityKey', target.capability_key, 'unit', target.unit,
    'policyId', target.policy_id, 'policyRevision', target.policy_revision,
    'assignmentId', target.assignment_id,
    'assignmentRevision', target.assignment_revision,
    'appliedScope', target.applied_scope, 'releasedAmount', release_amount::text,
    'totalReleasedQuantity', new_released::text,
    'remainingReservedQuantity', new_remaining::text,
    'reservationState', new_state,
    'releasedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', protected_context.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)
  ));
  insert into vortex_access.capability_reservation_commands (
    tenant_id, request_organization_id, duplicate_key,
    operation_kind, command_fingerprint, reservation_id,
    result, correlation_id, accepted_at
  ) values (
    p_tenant_id, protected_context.request_organization_id, p_duplicate_key,
    'release', command_fingerprint, p_reservation_id,
    safe_result, protected_context.correlation_id, evaluated_at
  );
  return query select safe_result;
end
$function$;

comment on function vortex_access.release_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
) is
  'Releases an exact unexpired reservation and records the canonical refreshed balance in its immutable duplicate-protected outcome.';
revoke execute on function
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
  ) to vortex_request;

create or replace function vortex_access.begin_organization_account_closing_for_administration(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
  closing_at timestamptz,
  revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  target record;
  changed record;
  resulting_version bigint;
begin
  if p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closing command is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;

  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;

  if not found or target.state not in ('active', 'suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closing is stale or unavailable';
  end if;

  select result.* into strict changed
  from vortex_identity.begin_organization_account_closing(
    p_organization_account_id, p_expected_revision
  ) as result;

  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closing' or changed.revision <> p_expected_revision + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    scope.organization_id,
    scope.organization_account_id,
    changed.state_change_correlation_id,
    'organization_account_closed'
  ) as incremented;

  if resulting_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(scope.organization_id);

  return query select changed.organization_account_id, changed.organization_id,
    changed.state, changed.closing_at, changed.revision, resulting_version;
end
$function$;

comment on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) is
  'Protected one-way active/suspended/closed-to-closing account command under accounts.manage; deletion is a separate, later fence.';
revoke all on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) to vortex_request;

create or replace function vortex_file.reserve_file_upload(
  p_file_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_original_safe_display_name text,
  p_extension text,
  p_storage_key text,
  p_uploaded_by jsonb,
  p_maximum_bytes bigint,
  p_max_files integer,
  p_existing_attachment_count integer,
  p_replacing_file_id uuid,
  p_capability_reservation_id uuid,
  p_one_time_id uuid,
  p_policy_fingerprint text,
  p_grant_expires_at timestamptz,
  p_upload_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  in_flight_count bigint;
  existing_count bigint;
  reserved vortex_file.file_records%rowtype;
begin
  if request_actor is null
    or p_organization_id is distinct from (established ->> 'organizationId')::uuid
    or p_application_root_id is distinct from (established ->> 'applicationRootId')::uuid
    or p_uploaded_by is distinct from request_actor then
    raise exception using errcode = '42501', message = 'File upload scope is unavailable';
  end if;

  if p_file_id is null
    or p_owner_record_type_id is null
    or p_owner_record_id is null
    or p_owner_field_id is null
    or p_maximum_bytes is null or p_maximum_bytes < 1
    or p_maximum_bytes > vortex_file.upload_maximum_bytes_limit()
    or p_max_files is null or p_max_files < 1
    or p_existing_attachment_count is null or p_existing_attachment_count < 0
    or p_capability_reservation_id is null
    or p_one_time_id is null
    or p_policy_fingerprint is null
    or p_grant_expires_at is null
    or p_grant_expires_at <= evaluated_at
    or p_grant_expires_at > evaluated_at + interval '65 seconds'
    or p_upload_expires_at is null
    or p_upload_expires_at < p_grant_expires_at
    or p_upload_expires_at > evaluated_at + interval '24 hours 5 minutes' then
    raise exception using errcode = '22023', message = 'File upload reservation is invalid';
  end if;

  -- Admissions to one attachment field are serialised so concurrent uploads
  -- cannot together exceed its file count.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.upload_field', p_organization_id::text,
      p_owner_record_type_id::text, p_owner_record_id::text, p_owner_field_id::text), 652)
  );

  perform 1
  from vortex_access.capability_reservations as funding
  where funding.reservation_id = p_capability_reservation_id
    and funding.tenant_id = (established ->> 'tenantId')::uuid
    and funding.request_organization_id = p_organization_id
    and funding.correlation_id = (established ->> 'correlationId')::uuid
    and funding.state = 'active'
    and funding.expires_at > evaluated_at
    and funding.reserved_quantity - funding.consumed_quantity - funding.released_quantity > 0
  for update;
  if not found then
    if not exists (
      select 1 from vortex_file.upload_reservations as retried
      where retried.capability_reservation_id = p_capability_reservation_id
        and retried.file_id = p_file_id
    ) then
      perform vortex_file.append_file_activity_internal(
        'file_upload_refused', p_organization_id);
    end if;
    return vortex_file.upload_refusal('capability_refused');
  end if;

  if exists (
    select 1 from vortex_file.upload_reservations as reservation
    where reservation.capability_reservation_id = p_capability_reservation_id
  ) then
    if not exists (
      select 1 from vortex_file.upload_reservations as retried
      where retried.capability_reservation_id = p_capability_reservation_id
        and retried.file_id = p_file_id
    ) then
      perform vortex_file.append_file_activity_internal(
        'file_upload_refused', p_organization_id);
    end if;
    return vortex_file.upload_refusal('capability_refused');
  end if;

  select pg_catalog.count(*) into existing_count
  from vortex_file.file_records as attached
  where attached.organization_id = p_organization_id
    and attached.owner_record_type_id = p_owner_record_type_id
    and attached.owner_record_id = p_owner_record_id
    and attached.owner_field_id = p_owner_field_id
    and attached.lifecycle_state = 'active';

  if p_replacing_file_id is not null and (
    existing_count < 1
    or not exists (
      select 1 from vortex_file.file_records as replaced
      where replaced.file_id = p_replacing_file_id
        and replaced.organization_id = p_organization_id
        and replaced.owner_record_type_id = p_owner_record_type_id
        and replaced.owner_record_id = p_owner_record_id
        and replaced.owner_field_id = p_owner_field_id
        and replaced.lifecycle_state = 'active'
    )
  ) then
    return vortex_file.upload_refusal('replacement_file_not_found');
  end if;

  select pg_catalog.count(*) into in_flight_count
  from vortex_file.upload_reservations as reservation
  join vortex_file.file_records as uploaded
    on uploaded.file_id = reservation.file_id
  where reservation.organization_id = p_organization_id
    and reservation.owner_record_type_id = p_owner_record_type_id
    and reservation.owner_record_id = p_owner_record_id
    and reservation.owner_field_id = p_owner_field_id
    and reservation.upload_expires_at > evaluated_at
    and uploaded.lifecycle_state in ('pending', 'uploaded', 'scanning');

  if existing_count
    - (case when p_replacing_file_id is null then 0 else 1 end)
    + in_flight_count >= p_max_files then
    return vortex_file.upload_refusal('field_capacity_exceeded');
  end if;

  insert into vortex_file.file_records (
    file_id, organization_id, application_root_id,
    owner_record_type_id, owner_record_id, owner_field_id,
    owning_attachment_references, lifecycle_state, original_safe_display_name,
    detected_media_type, extension, size_bytes, checksum,
    storage_key, bucket_id, scanner_name, scanner_version, scanner_result,
    preview_references, uploaded_by, legal_hold, created_at
  ) values (
    p_file_id, p_organization_id, p_application_root_id,
    p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    '{}'::uuid[], 'pending', p_original_safe_display_name,
    'application/octet-stream', p_extension, 0, 'sha256:' || pg_catalog.repeat('0', 64),
    p_storage_key, 'private_files', 'vortex_file_preflight', '1', 'pending',
    '[]'::jsonb, request_actor, false, evaluated_at
  )
  returning * into reserved;

  insert into vortex_file.upload_reservations (
    file_id, organization_id, owner_record_type_id, owner_record_id, owner_field_id,
    uploaded_by, maximum_bytes, capability_reservation_id, replacing_file_id,
    correlation_id, upload_expires_at, revision, created_at, updated_at, max_files
  ) values (
    p_file_id, p_organization_id, p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    request_actor, p_maximum_bytes, p_capability_reservation_id, p_replacing_file_id,
    (established ->> 'correlationId')::uuid, p_upload_expires_at, 1, evaluated_at, evaluated_at,
    p_max_files
  );

  insert into vortex_file.upload_grants (
    one_time_id, file_id, organization_id, actor, maximum_bytes,
    policy_fingerprint, expires_at, created_at
  ) values (
    p_one_time_id, p_file_id, p_organization_id, request_actor, p_maximum_bytes,
    p_policy_fingerprint, p_grant_expires_at, evaluated_at
  );

  perform vortex_file.append_file_activity_internal(
    'file_upload_admitted', p_file_id);

  return pg_catalog.jsonb_build_object(
    'outcome', 'reserved',
    'fileRecord', vortex_file.upload_file_record(reserved)
  );
end
$function$;

comment on function vortex_file.reserve_file_upload(
  uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
  uuid, uuid, uuid, text, timestamptz, timestamptz
) is
  'Reserves a pending file, its capacity binding and its first grant under a lock on the owning attachment field.';
revoke execute on function
  vortex_file.reserve_file_upload(
    uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
    uuid, uuid, uuid, text, timestamptz, timestamptz
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_file.reserve_file_upload(
    uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb, bigint, integer, integer,
    uuid, uuid, uuid, text, timestamptz, timestamptz
  ) to vortex_request;

create or replace function vortex_file.renew_file_upload(
  p_file_id uuid,
  p_expected_revision bigint,
  p_previous_one_time_id uuid,
  p_new_one_time_id uuid,
  p_policy_fingerprint text,
  p_grant_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
  current_grant_id uuid;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found then
    return vortex_file.upload_refusal('file_not_found');
  end if;
  if request_actor is null or reservation.uploaded_by is distinct from request_actor then
    return vortex_file.upload_refusal('caller_not_authorized');
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id;
  if uploaded.lifecycle_state <> 'pending' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;

  select current_grant.one_time_id into current_grant_id
  from vortex_file.upload_grants as current_grant
  where current_grant.file_id = p_file_id
    and current_grant.superseded_at is null
  for update;
  if reservation.revision is distinct from p_expected_revision
    or current_grant_id is distinct from p_previous_one_time_id then
    return vortex_file.upload_refusal('grant_mismatch');
  end if;

  if p_new_one_time_id is null
    or p_policy_fingerprint is null
    or p_grant_expires_at is null
    or p_grant_expires_at <= evaluated_at
    or p_grant_expires_at > evaluated_at + interval '65 seconds'
    or p_grant_expires_at > reservation.upload_expires_at then
    raise exception using errcode = '22023', message = 'File upload renewal is invalid';
  end if;

  update vortex_file.upload_grants
  set superseded_at = evaluated_at
  where one_time_id = p_previous_one_time_id;

  insert into vortex_file.upload_grants (
    one_time_id, file_id, organization_id, actor, maximum_bytes,
    policy_fingerprint, expires_at, created_at
  ) values (
    p_new_one_time_id, p_file_id, reservation.organization_id, reservation.uploaded_by,
    reservation.maximum_bytes, p_policy_fingerprint, p_grant_expires_at, evaluated_at
  );

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  return pg_catalog.jsonb_build_object('outcome', 'renewed');
end
$function$;

comment on function vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) is
  'Supersedes the current grant of a pending upload with a new short-lived grant for its uploader.';
revoke execute on function
  vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_file.renew_file_upload(uuid, bigint, uuid, uuid, text, timestamptz) to vortex_request;

create or replace function vortex_file.record_file_upload_outcome(
  p_file_id uuid,
  p_expected_revision bigint,
  p_detected_media_type text,
  p_size_bytes bigint,
  p_checksum text,
  p_scanner_name text,
  p_scanner_version text,
  p_scanner_result text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
begin
  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found then
    return vortex_file.upload_refusal('file_not_found');
  end if;
  if request_actor is null or reservation.uploaded_by is distinct from request_actor then
    return vortex_file.upload_refusal('caller_not_authorized');
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id
  for update;
  if uploaded.lifecycle_state <> 'pending' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;
  if reservation.revision is distinct from p_expected_revision then
    return vortex_file.upload_refusal('revision_conflict');
  end if;

  -- Bytes beyond the admitted reservation are never accepted as clean.
  if p_scanner_result is null
    or p_scanner_result not in ('clean', 'quarantined', 'refused')
    or p_size_bytes is null or p_size_bytes < 0
    or (p_scanner_result = 'clean' and p_size_bytes > reservation.maximum_bytes)
    or p_scanner_name is null
    or p_scanner_version is null then
    raise exception using errcode = '22023', message = 'File upload outcome is invalid';
  end if;

  update vortex_file.file_records
  set
    detected_media_type = p_detected_media_type,
    size_bytes = p_size_bytes,
    checksum = p_checksum,
    scanner_name = p_scanner_name,
    scanner_version = p_scanner_version,
    scanner_result = p_scanner_result,
    lifecycle_state = case when p_scanner_result = 'clean' then 'scanning' else 'quarantined' end
  where file_id = p_file_id
  returning * into uploaded;

  update vortex_file.upload_grants
  set superseded_at = evaluated_at
  where file_id = p_file_id
    and superseded_at is null;

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recorded',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );
end
$function$;

comment on function vortex_file.record_file_upload_outcome(
  uuid, bigint, text, bigint, text, text, text, text
) is
  'Records trusted inspection and the safety result of a pending upload, leaving it scanning or quarantined.';
revoke execute on function
  vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_file.record_file_upload_outcome(uuid, bigint, text, bigint, text, text, text, text) to vortex_request;

create or replace function vortex_file.activate_uploaded_file(
  p_file_id uuid,
  p_expected_revision bigint,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_attachment_reference_id uuid,
  p_replacing_file_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_file.upload_validated_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  reservation vortex_file.upload_reservations%rowtype;
  uploaded vortex_file.file_records%rowtype;
  attached_count bigint;
begin
  if p_attachment_reference_id is null
    or not vortex_context.is_non_nil_uuid(p_attachment_reference_id::text) then
    raise exception using errcode = '22023', message = 'File activation is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      'vortex_file.upload_field', (established ->> 'organizationId')::uuid::text,
      p_owner_record_type_id::text, p_owner_record_id::text, p_owner_field_id::text), 652)
  );

  select stored.* into reservation
  from vortex_file.upload_reservations as stored
  where stored.file_id = p_file_id
    and stored.organization_id = (established ->> 'organizationId')::uuid
  for update;
  if not found then
    return vortex_file.upload_refusal('file_not_found');
  end if;
  if request_actor is null or reservation.uploaded_by is distinct from request_actor then
    perform vortex_file.append_file_activity_internal(
      'file_activation_refused', p_file_id);
    return vortex_file.upload_refusal('caller_not_authorized');
  end if;
  if reservation.owner_record_type_id is distinct from p_owner_record_type_id
    or reservation.owner_record_id is distinct from p_owner_record_id
    or reservation.owner_field_id is distinct from p_owner_field_id then
    return vortex_file.upload_refusal('owner_mismatch');
  end if;

  select stored.* into strict uploaded
  from vortex_file.file_records as stored
  where stored.file_id = p_file_id
  for update;

  if uploaded.lifecycle_state = 'active'
    and p_attachment_reference_id = any (uploaded.owning_attachment_references) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'activated',
      'fileRecord', vortex_file.upload_file_record(uploaded)
    );
  end if;
  if uploaded.lifecycle_state <> 'scanning' or uploaded.scanner_result <> 'clean' then
    return vortex_file.upload_refusal('invalid_lifecycle_state');
  end if;
  if reservation.upload_expires_at <= evaluated_at then
    return vortex_file.upload_refusal('upload_expired');
  end if;
  if reservation.revision is distinct from p_expected_revision then
    return vortex_file.upload_refusal('revision_conflict');
  end if;
  if reservation.replacing_file_id is distinct from p_replacing_file_id then
    return vortex_file.upload_refusal('replacement_file_not_found');
  end if;
  if p_replacing_file_id is not null then
    perform 1
    from vortex_file.file_records as replaced
    where replaced.file_id = p_replacing_file_id
      and replaced.organization_id = reservation.organization_id
      and replaced.owner_record_type_id = reservation.owner_record_type_id
      and replaced.owner_record_id = reservation.owner_record_id
      and replaced.owner_field_id = reservation.owner_field_id
      and replaced.lifecycle_state = 'active'
    for share;
    if not found then
      return vortex_file.upload_refusal('replacement_file_not_found');
    end if;
  end if;

  if reservation.max_files is not null then
    select pg_catalog.count(*) into attached_count
    from vortex_file.file_records as attached
    where attached.organization_id = reservation.organization_id
      and attached.owner_record_type_id = reservation.owner_record_type_id
      and attached.owner_record_id = reservation.owner_record_id
      and attached.owner_field_id = reservation.owner_field_id
      and attached.lifecycle_state = 'active'
      and attached.file_id <> p_file_id
      and attached.file_id is distinct from p_replacing_file_id;
    if attached_count >= reservation.max_files then
      raise exception using errcode = '23514',
        message = 'Attachment field already holds its maximum number of files';
    end if;
  end if;

  update vortex_file.file_records
  set
    lifecycle_state = 'active',
    activated_at = evaluated_at,
    owning_attachment_references = pg_catalog.array_append(
      owning_attachment_references, p_attachment_reference_id
    )
  where file_id = p_file_id
  returning * into uploaded;

  update vortex_file.upload_reservations
  set revision = revision + 1, updated_at = evaluated_at
  where file_id = p_file_id;

  perform vortex_file.append_file_activity_internal(
    'file_activated', p_file_id);

  return pg_catalog.jsonb_build_object(
    'outcome', 'activated',
    'fileRecord', vortex_file.upload_file_record(uploaded)
  );
end
$function$;

comment on function vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) is
  'Activates a clean scanned upload inside the record save that attaches it.';
revoke execute on function
  vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function
  vortex_file.activate_uploaded_file(uuid, bigint, uuid, uuid, uuid, uuid, uuid) to vortex_request;

create or replace function vortex_access.record_metering_event(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_allocation_owner text,
  p_operation_id uuid,
  p_capability_key text,
  p_quantity numeric,
  p_unit text,
  p_source text,
  p_dimensions jsonb,
  p_occurred_at timestamptz,
  p_source_event_id uuid,
  p_duplicate_protection_key text,
  p_correlation_id uuid,
  p_corrects_metering_event_id uuid,
  p_correction_direction text
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  accepted_at_value timestamptz := pg_catalog.clock_timestamp();
  established jsonb;
  existing vortex_access.metering_events%rowtype;
  corrected vortex_access.metering_events%rowtype;
  corrected_remaining numeric;
  metering_event_id uuid;
  command_fingerprint text;
  safe_event jsonb;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_allocation_owner is null
    or p_allocation_owner not in ('local', 'federated_source', 'federated_recipient')
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_source is null
    or p_source not in ('web', 'workflow', 'interface', 'connection', 'federation', 'system')
    or not vortex_access.metering_event_dimensions_are_valid(p_dimensions)
    or p_occurred_at is null
    or p_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_source_event_id is not null
      and not vortex_context.is_non_nil_uuid(p_source_event_id::text))
    or p_duplicate_protection_key is null
    or p_duplicate_protection_key <> pg_catalog.btrim(p_duplicate_protection_key)
    or pg_catalog.length(p_duplicate_protection_key) not between 16 and 200
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or (p_corrects_metering_event_id is not null
      and not vortex_context.is_non_nil_uuid(p_corrects_metering_event_id::text))
    or ((p_corrects_metering_event_id is null) <> (p_correction_direction is null))
    or (p_correction_direction is not null
      and p_correction_direction not in ('increase', 'decrease')) then
    raise exception using errcode = '22023', message = 'Metering event command is invalid';
  end if;
  if (p_source = 'federation'
      and p_allocation_owner not in ('federated_source', 'federated_recipient'))
    or (p_source <> 'federation' and p_allocation_owner <> 'local') then
    raise exception using errcode = '22023', message = 'Metering event allocation is invalid';
  end if;
  established := vortex_context.current_context();
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (established ->> 'organizationId')::uuid is distinct from p_organization_id
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  -- Corrections and non-web sources are system operations. A human, federated
  -- or public request context can never fabricate system/federation usage or
  -- reduce recorded usage.
  if (established ->> 'callerKind') is distinct from 'system'
    and (p_source <> 'web' or p_corrects_metering_event_id is not null) then
    raise exception using errcode = '42501',
      message = 'Metering event authority is unavailable';
  end if;
  -- Key-share locks keep the attributed scope present without serialising the
  -- tenant's other writes behind every metered operation.
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  if p_organization_id is not null then
    perform 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and organization.state = 'active'
    for key share;
    if not found then
      raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
    end if;
  end if;
  -- The fingerprint covers the metered fact, not the delivering request, so a
  -- redelivery under a new correlation replays instead of conflicting.
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'record_metering_event', p_tenant_id::text,
      coalesce(p_organization_id::text, ''), p_allocation_owner,
      p_operation_id::text, p_capability_key, p_quantity::text, p_unit,
      p_source, p_dimensions::text,
      pg_catalog.to_char(p_occurred_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      coalesce(p_source_event_id::text, ''),
      p_duplicate_protection_key,
      coalesce(p_corrects_metering_event_id::text, ''),
      coalesce(p_correction_direction, '')), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', 'duplicate',
      p_tenant_id::text, p_duplicate_protection_key), 751)
  );
  select stored.* into existing
  from vortex_access.metering_events as stored
  where stored.tenant_id = p_tenant_id
    and stored.duplicate_protection_key = p_duplicate_protection_key;
  if found then
    if existing.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Metering event duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_build_object(
      'status', 'replayed', 'event', existing.result
    );
    return;
  end if;
  -- Second lock, always taken after the duplicate lock: an original serialises
  -- on its final operation identity, a correction on the event it corrects.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      case when p_corrects_metering_event_id is null then
        pg_catalog.concat_ws(E'\x1f', 'operation', p_tenant_id::text,
          p_operation_id::text, p_capability_key, p_unit)
      else
        pg_catalog.concat_ws(E'\x1f', 'correction', p_tenant_id::text,
          p_corrects_metering_event_id::text)
      end, 751)
  );
  if p_corrects_metering_event_id is null then
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.operation_id = p_operation_id
        and stored.capability_key = p_capability_key
        and stored.unit = p_unit
        and stored.corrects_metering_event_id is null
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
  else
    select stored.* into corrected
    from vortex_access.metering_events as stored
    where stored.tenant_id = p_tenant_id
      and stored.metering_event_id = p_corrects_metering_event_id;
    -- A correction targets an original event with the same attribution,
    -- allocation, capability and unit, so it never moves usage elsewhere.
    if not found
      or corrected.corrects_metering_event_id is not null
      or corrected.organization_id is distinct from p_organization_id
      or corrected.allocation_owner <> p_allocation_owner
      or corrected.capability_key <> p_capability_key
      or corrected.unit <> p_unit then
      raise exception using errcode = '22023', message = 'Metering correction target is unavailable';
    end if;
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id
        and stored.operation_id = p_operation_id
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
    if p_correction_direction = 'decrease' then
      select corrected.quantity + coalesce(pg_catalog.sum(
          case stored.correction_direction
            when 'increase' then stored.quantity
            else -stored.quantity
          end), 0)
      into corrected_remaining
      from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id;
      if p_quantity > corrected_remaining then
        raise exception using errcode = '22023',
          message = 'Metering correction exceeds the recorded quantity';
      end if;
    end if;
  end if;
  metering_event_id := pg_catalog.gen_random_uuid();
  safe_event := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'meteringEventId', metering_event_id,
    'operationId', p_operation_id,
    'tenantId', p_tenant_id,
    'organizationId', p_organization_id,
    'allocationOwner', p_allocation_owner,
    'capabilityKey', p_capability_key,
    'quantity', p_quantity::float8,
    'unit', p_unit,
    'occurredAt', pg_catalog.to_char(p_occurred_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source', p_source,
    'sourceEventId', p_source_event_id,
    'dimensions', p_dimensions,
    'duplicateProtectionKey', p_duplicate_protection_key,
    'correlationId', p_correlation_id,
    'correctsMeteringEventId', p_corrects_metering_event_id,
    'correctionDirection', p_correction_direction,
    'acceptedAt', pg_catalog.to_char(accepted_at_value at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));
  insert into vortex_access.metering_events (
    metering_event_id, operation_id, tenant_id, organization_id,
    allocation_owner, capability_key, quantity, unit, source, dimensions,
    occurred_at, source_event_id, duplicate_protection_key,
    command_fingerprint, correlation_id, corrects_metering_event_id,
    correction_direction, accepted_at, result
  ) values (
    metering_event_id, p_operation_id, p_tenant_id, p_organization_id,
    p_allocation_owner, p_capability_key, p_quantity, p_unit, p_source,
    p_dimensions, p_occurred_at, p_source_event_id, p_duplicate_protection_key,
    command_fingerprint, p_correlation_id, p_corrects_metering_event_id,
    p_correction_direction, accepted_at_value, safe_event
  );
  return query select pg_catalog.jsonb_build_object(
    'status', 'accepted', 'event', safe_event
  );
end
$function$;

comment on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid, text
) is
  'Appends exactly one immutable metering event for a committed operation or replays the original event for a repeated duplicate key.';
revoke execute on function
  vortex_access.record_metering_event(
    uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
    uuid, text, uuid, uuid, text
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid, text
) to vortex_request;

reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.canonical_record_value_matches(
  p_value jsonb,
  p_field_type text,
  p_database_value_type text
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  -- Canonical exact decimal text: no exponent, no leading zero, no trailing
  -- fractional zero, and no negative zero -- exactly what
  -- `normalizeExactDecimal` emits (contracts/src/exact-decimal.ts:49-72).
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
  uuid_pattern constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  nil_uuid_text constant text := '00000000-0000-0000-0000-000000000000';
  date_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  date_time_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  value_text text;
begin
  if p_value is null then
    return false;
  end if;
  -- A JSON null clears the column, whatever the declared type.
  if pg_catalog.jsonb_typeof(p_value) = 'null' then
    return true;
  end if;

  if p_field_type = 'money'
    or (p_field_type in ('calculation', 'total') and p_database_value_type = 'json') then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['amount', 'currency']::text[] = '{}'::jsonb
      and p_value ?& array['amount', 'currency']
      and pg_catalog.jsonb_typeof(p_value -> 'amount') = 'string'
      and (p_value ->> 'amount') ~ canonical_decimal
      and pg_catalog.jsonb_typeof(p_value -> 'currency') = 'string'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$';
  elsif p_field_type = 'link_to_person' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['organizationAccountId']::text[] = '{}'::jsonb
      and p_value ? 'organizationAccountId'
      and pg_catalog.jsonb_typeof(p_value -> 'organizationAccountId') = 'string'
      and (p_value ->> 'organizationAccountId') ~ uuid_pattern
      and pg_catalog.lower(p_value ->> 'organizationAccountId') <> nil_uuid_text;
  elsif p_field_type = 'several_choices' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
      );
  elsif p_field_type = 'attachment' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
          or (member.value #>> '{}') !~ uuid_pattern
          or pg_catalog.lower(member.value #>> '{}') = nil_uuid_text
      );
  elsif p_field_type = 'table' then
    return pg_catalog.jsonb_typeof(p_value) = 'array';
  elsif p_field_type = 'formatted_text' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and pg_catalog.jsonb_typeof(p_value -> 'blocks') = 'array';
  end if;

  -- Every remaining field type is decided by its storage type.
  if p_database_value_type = 'decimal' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ canonical_decimal;
  elsif p_database_value_type = 'integer' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    return value_text ~ '^-?(?:0|[1-9][0-9]*)$'
      and value_text::numeric between -9223372036854775808 and 9223372036854775807;
  elsif p_database_value_type = 'boolean' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_database_value_type = 'date' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    if value_text !~ date_pattern then
      return false;
    end if;
    begin
      perform value_text::date;
    exception when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation then
      return false;
    end;
    return true;
  elsif p_database_value_type = 'timestamp_with_time_zone' then
    -- The instant is stored; the offset it arrived with is not preserved, and
    -- the read codec returns UTC `Z`. The pattern requires an explicit offset,
    -- so the stored instant never depends on the session time zone.
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    if value_text !~ date_time_pattern then
      return false;
    end if;
    begin
      perform value_text::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation then
      return false;
    end;
    return true;
  elsif p_database_value_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_database_value_type = 'json' then
    return true;
  end if;
  return false;
end
$function$;

comment on function vortex_record.canonical_record_value_matches(jsonb, text, text) is
  'Private pure check that one value is the canonical V2 shape for its declared field type; never raises and decides no authority.';
revoke all on function vortex_record.canonical_record_value_matches(jsonb, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

create or replace function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, proposed_facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);

  -- The write: the typed columns, the next concurrency number, and the change
  -- stamp from the verified context and the installed binding. Owner columns
  -- and lifecycle state are not writable here.
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ', '),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed record change adapter: locks the row, refuses a stale concurrency number, decides the update on the old and the proposed row, enforces the changeable-field bound over the submitted fields next to the write, and returns the readable projection. Owner-only; #47''s fixed save writer is its caller.';
revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

create or replace function vortex_record.total_inputs_readable_internal(
  p_loaded jsonb,
  p_target_record_type_id uuid,
  p_target_record_id uuid,
  p_total_field jsonb,
  p_seen_derived_field_keys jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  contract_value jsonb;
  source_projection jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  required_field_id text;
begin
  contract_value := vortex_record.total_dependency_contract_internal(
    p_loaded -> 'facts' -> 'recordTypes', p_loaded -> 'facts' -> 'relationships',
    p_target_record_type_id, p_total_field
  );
  if contract_value is null
    or pg_catalog.jsonb_typeof(p_seen_derived_field_keys) <> 'array' then
    return false;
  end if;
  for edge_row in
    select edge.* from vortex_record.relationship_edges as edge
    where edge.relationship_id = (contract_value ->> 'relationshipId')::uuid
      and edge.from_storage_contract_id =
        (contract_value ->> 'sourceStorageContractId')::uuid
      and edge.to_storage_contract_id =
        (p_loaded -> 'facts' -> 'binding' ->> 'storageContractId')::uuid
      and edge.to_record_id = p_target_record_id
      and edge.to_organisation_id = (p_loaded -> 'context' ->> 'organizationId')::uuid
      and edge.from_application_root_id is not distinct from case
        when contract_value ->> 'sourceStorageScope' = 'application_contained'
          then (p_loaded -> 'context' ->> 'applicationRootId')::uuid
        else null end
      and edge.to_application_root_id is not distinct from case
        when p_loaded -> 'facts' -> 'binding' ->> 'storageScope' = 'application_contained'
          then (p_loaded -> 'context' ->> 'applicationRootId')::uuid
        else null end
  loop
    source_projection := vortex_record.read_derived_field_ids_for_exact_record_internal(
      (contract_value ->> 'sourceRecordTypeId')::uuid,
      edge_row.from_record_id,
      contract_value -> 'sourceFieldIds',
      p_seen_derived_field_keys
    );
    if source_projection is null then
      if vortex_record.relationship_total_source_is_retained_internal(
        p_loaded -> 'facts',
        (contract_value ->> 'sourceRecordTypeId')::uuid,
        edge_row.from_record_id,
        (p_loaded -> 'context' ->> 'organizationId')::uuid,
        (p_loaded -> 'context' ->> 'applicationRootId')::uuid
      ) then
        continue;
      end if;
      return false;
    end if;
    for required_field_id in
      select item.value from pg_catalog.jsonb_array_elements_text(
        contract_value -> 'sourceFieldIds'
      ) as item(value)
    loop
      if not (source_projection ? required_field_id) then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end
$function$;

comment on function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) is null;
revoke all on function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.total_inputs_readable_internal(jsonb, uuid, uuid, jsonb, jsonb) to vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_record.load_named_action_facts_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  p_action_kind text := 'named';
  action_context jsonb;
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  installation jsonb;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_owner_id = nil_uuid
    or p_action_release_revision not between 1 and 9007199254740991
    or p_action_id is null or p_action_id = nil_uuid
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- Step 2: the exact active installation. Its reader owns the pin-set and
  -- active-binding rules; this adapter consumes them and adds none.
  installation := vortex_module.read_current_active_installation();

  -- Step 3: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token <> 'record_data'
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and storage_contract_value = any (provision.storage_contract_ids)
        ) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(pg_catalog.timezone(''UTC'', %I), ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = context_application_root_id
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', context_application_root_id,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the exact named declaration resolved from the installed owner.
  required_permissions := action_context #> '{declaration,requiredPermissions}';
  declaration := action_context -> 'declaration';

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_meta ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );
  target_fact := record_fact;

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;

      load_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(
           ''recordScope'', pg_catalog.jsonb_build_object(
             ''storageScope'', %L,
             ''organizationId'', stored.organisation_id,
             ''moduleRootId'', %L::uuid,
             ''recordTypeId'', %L::uuid,
             ''storageContractId'', %L::uuid,
             ''recordId'', stored.record_id
           ) || case when %L = ''application_contained''
             then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
             else ''{}''::jsonb end,
           ''lifecycleState'', stored.lifecycle_state,
           ''fieldValues'', pg_catalog.jsonb_build_object(%s)
         ) || case
           when stored.owner_organisation_account_id is not null
             then pg_catalog.jsonb_build_object(
               ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
           when stored.owner_group_id is not null
             then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'moduleRootId', meta.value -> 'moduleRootId',
          'recordTypeId', meta.value -> 'recordTypeId',
          'storageContractId', meta.value -> 'storageContractId',
          'storageScope', meta.value -> 'storageScope',
          'ownershipMode', meta.value -> 'ownershipMode',
          'validationContractVersion', meta.value -> 'validationContractVersion',
          'fields', meta.value -> 'fields'
        ) || case
          when meta.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by meta.key collate "C"
      )
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'table', target_table,
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'actionContext', action_context,
    'fieldValues', target_fact -> 'fieldValues'
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

comment on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) is
  'Private static named-action facts loader reusing the complete existing Access record-scope closure without requiring ordinary read or update authority.';
revoke all on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.load_named_action_facts_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) to vortex_record_adapter;

create or replace function vortex_record.write_named_action_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  existing_other boolean;
  target_locked boolean;
  update_sql text;
  changed_rows integer;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_subject_record_type_id is null or p_subject_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    delete from vortex_record.relationship_edges as edge
    where edge.relationship_id = p_relationship_id
      and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
      and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
      and edge.from_record_id = p_source_record_id;
    update_sql := pg_catalog.format(
      'update record_data.%I as stored set %I = null
       where stored.organisation_id = $1 and stored.record_id = $2',
      source_meta ->> 'table', field_column ->> 'token'
    );
    execute update_sql using (source_context ->> 'organizationId')::uuid, p_source_record_id;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Relationship source record changed';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;

  target_locked := false;
  execute pg_catalog.format(
    'select true from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active'' for share',
    target_meta ->> 'table'
  ) into target_locked using
    (source_context ->> 'organizationId')::uuid, target_record_id;
  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The one substitution. Executing a permitted named action must not require
  -- ordinary read authority on its own subject (#50 section 4), so when the
  -- selected target is exactly this command's subject the decision is taken on
  -- the installed named declaration instead. The loader re-resolves the active
  -- installation, the owner kind/id/release revision, the action id and the
  -- action's declared subject record type, and the Access evaluation binds the
  -- organization, application, record type, record and the actor's current
  -- authority. Every other target keeps the ordinary read check unchanged.
  if target_type_id = p_subject_record_type_id and target_record_id = p_subject_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := vortex_record.load_record_access_facts_internal(
      target_type_id, 'read', target_record_id, null
    );
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := vortex_access.evaluate_organization_record_access_internal(
    target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
  );
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  delete from vortex_record.relationship_edges as edge
  where edge.relationship_id = p_relationship_id
    and edge.from_organisation_id = (source_context ->> 'organizationId')::uuid
    and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and edge.from_record_id = p_source_record_id;
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    p_relationship_id,
    (source_context ->> 'organizationId')::uuid,
    (source_context ->> 'organizationId')::uuid,
    source_application_root_id, target_application_root_id,
    (source_meta ->> 'storageContractId')::uuid, p_source_record_id,
    (target_meta ->> 'storageContractId')::uuid, target_record_id
  );

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb
     where stored.organisation_id = $1 and stored.record_id = $2',
    source_meta ->> 'table', field_column ->> 'token'
  );
  execute update_sql using (source_context ->> 'organizationId')::uuid,
    p_source_record_id, p_target_value;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

comment on function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge writer: identical to the ordinary edge writer except that the command subject is authorised by re-evaluating the exact installed named action rather than ordinary read.';
revoke all on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) to vortex_record_adapter;

create or replace function vortex_record.list_offboarding_owned_records_internal(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_after_storage_contract_id uuid,
  p_after_record_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_record_id uuid;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  lifecycle_state_value text;
  classification_value text;
  item_value jsonb;
  items jsonb := '[]'::jsonb;
  counts jsonb := '{}'::jsonb;
  item_count integer := 0;
  has_more boolean := false;
  last_storage_contract_id uuid;
  last_record_id uuid;
  candidate_sql text;
begin
  if p_source_organization_account_id is null
    or p_source_organization_account_id = nil_uuid
    or p_target_id is null
    or p_target_id = nil_uuid
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_limit is null
    or p_limit not between 1 and 50
    or ((p_after_storage_contract_id is null) <> (p_after_record_id is null)) then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  installation := vortex_module.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
      select (value #>> '{}')::uuid
      from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
    )
      and catalogue.state = 'active'
      and catalogue.storage_scope = 'application_contained'
      and catalogue.record_type_definition ->> 'ownershipMode' = 'organization_account'
      and (
        p_after_storage_contract_id is null
        or catalogue.storage_contract_id >= p_after_storage_contract_id
      )
    order by catalogue.storage_contract_id
  loop
    if p_after_storage_contract_id is not null
      and catalogue_row.storage_contract_id = p_after_storage_contract_id
      and p_after_record_id is null then
      continue;
    end if;

    candidate_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id = $2
         and stored.owner_organisation_account_id = $3%s
       order by stored.record_id',
      catalogue_row.physical_table_token,
      case
        when p_after_storage_contract_id = catalogue_row.storage_contract_id
          then ' and stored.record_id > $4'
        else ''
      end
    );

    for candidate_record_id in execute candidate_sql
      using organization_id_value, application_root_id_value,
        p_source_organization_account_id, p_after_record_id
    loop
      -- Once the page is full, continue only until a further disclosed record
      -- establishes that the returned keyset cursor has another visible page.
      begin
        loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
          catalogue_row.record_type_id, candidate_record_id, null, installation
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
          continue;
        end if;

        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', candidate_record_id, loaded -> 'facts'
        );
        if decision ->> 'outcome' <> 'allowed' then
          continue;
        end if;

        select item.value into record_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate_record_id;
        select item.value into record_type_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
        where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
        if record_fact is null or record_type_fact is null
          or record_type_fact ->> 'ownershipMode' <> 'organization_account' then
          continue;
        end if;

        lifecycle_state_value := record_fact ->> 'lifecycleState';
        classification_value := case
          when p_target_kind <> 'organization_account'
            or lifecycle_state_value = 'removal_pending'
            then 'refused_incompatible'
          else 'transferable'
        end;
      exception
        when others then
          -- Candidate failures carry record-specific detail. They are treated
          -- exactly like a refused access decision: absent from the response.
          -- Cancellation, resource, operator and internal failures are not
          -- record specific: swallowing one would present a truncated scan as a
          -- complete page, so those classes keep propagating to the caller.
          if pg_catalog.left(returned_sqlstate, 2)
            in ('40', '53', '57', '58', 'XX') then
            raise;
          end if;
          continue;
      end;

      if item_count >= p_limit then
        has_more := true;
        exit;
      end if;

      item_value := pg_catalog.jsonb_build_object(
        'storageContractId', catalogue_row.storage_contract_id,
        'recordTypeId', catalogue_row.record_type_id,
        'recordId', candidate_record_id,
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'lifecycleState', lifecycle_state_value,
        'installationState', installation -> 'installationState',
        'classification', classification_value
      );
      items := items || pg_catalog.jsonb_build_array(item_value);
      counts := counts || pg_catalog.jsonb_build_object(
        pg_catalog.lower(catalogue_row.record_type_id::text),
        coalesce(counts -> pg_catalog.lower(catalogue_row.record_type_id::text),
          pg_catalog.jsonb_build_object(
            'recordTypeId', catalogue_row.record_type_id,
            'transferable', 0,
            'refusedIncompatible', 0
          )) || pg_catalog.jsonb_build_object(
            case classification_value
              when 'transferable' then 'transferable'
              else 'refusedIncompatible'
            end,
            coalesce((counts -> pg_catalog.lower(catalogue_row.record_type_id::text)
              ->> case classification_value
                when 'transferable' then 'transferable'
                else 'refusedIncompatible'
              end)::integer, 0) + 1
          )
      );
      item_count := item_count + 1;
      last_storage_contract_id := catalogue_row.storage_contract_id;
      last_record_id := candidate_record_id;
    end loop;
    exit when has_more;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'section', pg_catalog.jsonb_build_object(
      'kind', 'application', 'applicationRootId', application_root_id_value
    ),
    'installationState', installation -> 'installationState',
    'items', items,
    'perRecordType', coalesce((
      select pg_catalog.jsonb_agg(entry.value order by entry.value ->> 'recordTypeId')
      from pg_catalog.jsonb_each(counts) as entry(key, value)
    ), '[]'::jsonb)
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'next', pg_catalog.jsonb_build_object(
      'storageContractId', last_storage_contract_id,
      'recordId', last_record_id
    )
  ) else '{}'::jsonb end;
end
$function$;

comment on function vortex_record.list_offboarding_owned_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) is
  'Private application-contained account-offboarding inventory; denied candidate records are omitted without identity or count disclosure, and a non-record failure propagates instead of truncating a page silently.';
revoke all on function vortex_record.list_offboarding_owned_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

-- The owner has no final EXECUTE grant. Lend it for CREATE OR REPLACE and revoke it below.
grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_record_adapter;

create or replace function vortex_record.list_offboarding_owned_records(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_section_kind text,
  p_after_storage_contract_id uuid default null,
  p_after_record_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  inventory jsonb;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  if p_section_kind = 'organization_shared' then
    inventory := vortex_record.list_offboarding_owned_shared_records_internal(
      p_source_organization_account_id, p_target_kind, p_target_id,
      p_after_storage_contract_id, p_after_record_id, p_limit
    );
    return inventory || pg_catalog.jsonb_build_object('accessVersion', scope.access_version);
  end if;
  if p_section_kind is distinct from 'application' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory section is invalid';
  end if;

  inventory := vortex_record.list_offboarding_owned_records_internal(
    p_source_organization_account_id, p_target_kind, p_target_id,
    p_after_storage_contract_id, p_after_record_id, p_limit
  );
  return inventory || pg_catalog.jsonb_build_object('accessVersion', scope.access_version);
end
$function$;

comment on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) is
  'Protected account-offboarding inventory: accounts.manage once and per-record exact transfer disclosure for the application-contained and organisation-shared sections.';
revoke all on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.list_offboarding_owned_records(
  uuid, text, uuid, text, uuid, uuid, integer
) to vortex_request;

create or replace function vortex_record.list_offboarding_owned_shared_records_internal(
  p_source_organization_account_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_after_storage_contract_id uuid,
  p_after_record_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  organization_id_value uuid;
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_record_id uuid;
  contract_affected_applications jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  lifecycle_state_value text;
  classification_value text;
  item_value jsonb;
  items jsonb := '[]'::jsonb;
  counts jsonb := '{}'::jsonb;
  item_count integer := 0;
  has_more boolean := false;
  last_storage_contract_id uuid;
  last_record_id uuid;
  candidate_sql text;
begin
  if p_source_organization_account_id is null
    or p_source_organization_account_id = nil_uuid
    or p_target_id is null
    or p_target_id = nil_uuid
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_limit is null
    or p_limit not between 1 and 50
    or ((p_after_storage_contract_id is null) <> (p_after_record_id is null)) then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Offboarding inventory requires an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  installation := vortex_module.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
      select (value #>> '{}')::uuid
      from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
    )
      and catalogue.state = 'active'
      and catalogue.storage_scope = 'organization_shared'
      and catalogue.record_type_definition ->> 'ownershipMode' = 'organization_account'
      and (
        p_after_storage_contract_id is null
        or catalogue.storage_contract_id >= p_after_storage_contract_id
      )
    order by catalogue.storage_contract_id
  loop
    if p_after_storage_contract_id is not null
      and catalogue_row.storage_contract_id = p_after_storage_contract_id
      and p_after_record_id is null then
      continue;
    end if;

    -- The affected applications of a contract are a property of the contract,
    -- not of the page: every record disclosed from it carries the complete set.
    contract_affected_applications :=
      vortex_module.read_offboarding_inventory_contract_applications_internal(
        catalogue_row.storage_contract_id
      );

    -- A shared row has no application column value: the storage scope's own
    -- check constraint requires it to be null.
    candidate_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id is null
         and stored.owner_organisation_account_id = $2%s
       order by stored.record_id',
      catalogue_row.physical_table_token,
      case
        when p_after_storage_contract_id = catalogue_row.storage_contract_id
          then ' and stored.record_id > $3'
        else ''
      end
    );

    for candidate_record_id in execute candidate_sql
      using organization_id_value, p_source_organization_account_id, p_after_record_id
    loop
      -- Once the page is full, continue only until a further disclosed record
      -- establishes that the returned keyset cursor has another visible page.
      begin
        loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
          catalogue_row.record_type_id, candidate_record_id, null, installation
        );
        if loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
          continue;
        end if;

        decision := vortex_access.evaluate_organization_record_access_internal(
          loaded -> 'declaration', candidate_record_id, loaded -> 'facts'
        );
        if decision ->> 'outcome' <> 'allowed' then
          continue;
        end if;

        select item.value into record_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
        where (item.value -> 'recordScope' ->> 'recordId')::uuid = candidate_record_id;
        select item.value into record_type_fact
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
        where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
        if record_fact is null or record_type_fact is null
          or record_type_fact ->> 'ownershipMode' <> 'organization_account' then
          continue;
        end if;

        lifecycle_state_value := record_fact ->> 'lifecycleState';
        classification_value := case
          when p_target_kind <> 'organization_account'
            or lifecycle_state_value = 'removal_pending'
            then 'refused_incompatible'
          else 'transferable'
        end;
      exception
        when others then
          -- Candidate failures carry record-specific detail. They are treated
          -- exactly like a refused access decision: absent from the response.
          -- Cancellation, resource, operator and internal failures are not
          -- record specific: swallowing one would present a truncated scan as a
          -- complete page, so those classes keep propagating to the caller.
          if pg_catalog.left(returned_sqlstate, 2)
            in ('40', '53', '57', '58', 'XX') then
            raise;
          end if;
          continue;
      end;

      if item_count >= p_limit then
        has_more := true;
        exit;
      end if;

      item_value := pg_catalog.jsonb_build_object(
        'storageContractId', catalogue_row.storage_contract_id,
        'recordTypeId', catalogue_row.record_type_id,
        'recordId', candidate_record_id,
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'lifecycleState', lifecycle_state_value,
        'installationState', installation -> 'installationState',
        'classification', classification_value,
        'storageScope', 'organization_shared',
        'affectedApplications', contract_affected_applications
      );
      items := items || pg_catalog.jsonb_build_array(item_value);
      counts := counts || pg_catalog.jsonb_build_object(
        pg_catalog.lower(catalogue_row.record_type_id::text),
        coalesce(counts -> pg_catalog.lower(catalogue_row.record_type_id::text),
          pg_catalog.jsonb_build_object(
            'recordTypeId', catalogue_row.record_type_id,
            'storageScope', 'organization_shared',
            'transferable', 0,
            'refusedIncompatible', 0,
            'affectedApplications', contract_affected_applications
          )) || pg_catalog.jsonb_build_object(
            case classification_value
              when 'transferable' then 'transferable'
              else 'refusedIncompatible'
            end,
            coalesce((counts -> pg_catalog.lower(catalogue_row.record_type_id::text)
              ->> case classification_value
                when 'transferable' then 'transferable'
                else 'refusedIncompatible'
              end)::integer, 0) + 1
          )
      );
      item_count := item_count + 1;
      last_storage_contract_id := catalogue_row.storage_contract_id;
      last_record_id := candidate_record_id;
    end loop;
    exit when has_more;
  end loop;

  -- `perRecordType` and `pageAffectedApplications` describe the records
  -- disclosed on this page only. A section-wide total would have to count
  -- records the caller may not read, so the inventory never presents one.
  return pg_catalog.jsonb_build_object(
    'outcome', 'listed',
    'section', pg_catalog.jsonb_build_object('kind', 'organization_shared'),
    'installationState', installation -> 'installationState',
    'items', items,
    'perRecordType', coalesce((
      select pg_catalog.jsonb_agg(entry.value order by entry.value ->> 'recordTypeId')
      from pg_catalog.jsonb_each(counts) as entry(key, value)
    ), '[]'::jsonb),
    'pageAffectedApplications', coalesce((
      select pg_catalog.jsonb_agg(distinct application.value order by application.value)
      from pg_catalog.jsonb_each(counts) as entry(key, value),
      lateral pg_catalog.jsonb_array_elements_text(
        entry.value -> 'affectedApplications'
      ) as application(value)
    ), '[]'::jsonb)
  ) || case when has_more then pg_catalog.jsonb_build_object(
    'next', pg_catalog.jsonb_build_object(
      'storageContractId', last_storage_contract_id,
      'recordId', last_record_id
    )
  ) else '{}'::jsonb end;
end
$function$;

comment on function vortex_record.list_offboarding_owned_shared_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) is
  'Private organisation-shared account-offboarding inventory; denied candidate records are omitted without identity or count disclosure, and a non-record failure propagates instead of truncating a page silently.';
revoke all on function vortex_record.list_offboarding_owned_shared_records_internal(
  uuid, text, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;

create or replace function vortex_record.lock_record_recovery_policy_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
begin
  if p_organization_id is null or p_storage_contract_id is null then
    return null;
  end if;
  select stored.* into policy_row
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = p_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for share;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'policyRevision', policy_row.policy_revision,
    'action', policy_row.action,
    'recoveryWindowDays', policy_row.policy_body -> 'recoveryWindowDays'
  );
end
$function$;

comment on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) is null;
revoke all on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid) to vortex_record_adapter;

reset role;

commit;
