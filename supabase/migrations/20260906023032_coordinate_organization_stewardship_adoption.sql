create table vortex_access.organization_stewardship_requirements (
  organization_id uuid primary key,
  original_organization_account_id uuid not null,
  original_role_id uuid not null,
  original_role_assignment_id uuid not null,
  original_delegation_authority_id uuid not null,
  revision bigint not null,
  adopted_by uuid not null,
  adopted_at timestamptz not null,
  adoption_correlation_id uuid not null,
  changed_by uuid not null,
  changed_at timestamptz not null,
  change_correlation_id uuid not null,
  constraint organization_stewardship_requirements_ids_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and original_organization_account_id <>
      '00000000-0000-0000-0000-000000000000'::uuid
    and original_role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and original_role_assignment_id <>
      '00000000-0000-0000-0000-000000000000'::uuid
    and original_delegation_authority_id <>
      '00000000-0000-0000-0000-000000000000'::uuid
    and adopted_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and adoption_correlation_id <>
      '00000000-0000-0000-0000-000000000000'::uuid
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <>
      '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_stewardship_requirements_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_stewardship_requirements_time_valid check (
    adopted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at >= adopted_at
  ),
  constraint organization_stewardship_requirements_organization_fk foreign key (
    organization_id
  ) references vortex_identity.organizations (organization_id),
  constraint organization_stewardship_requirements_account_fk foreign key (
    organization_id, original_organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id, organization_account_id
  ),
  constraint organization_stewardship_requirements_role_fk foreign key (
    organization_id, original_role_id
  ) references vortex_access.organization_roles (organization_id, role_id),
  constraint organization_stewardship_requirements_assignment_fk foreign key (
    organization_id, original_role_assignment_id
  ) references vortex_access.organization_role_assignments (
    organization_id, role_assignment_id
  ),
  constraint organization_stewardship_requirements_delegation_fk foreign key (
    organization_id, original_delegation_authority_id
  ) references vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id
  )
);

alter table vortex_access.organization_stewardship_requirements
  enable row level security;
alter table vortex_access.organization_stewardship_requirements
  force row level security;

create function vortex_access.protect_organization_stewardship_requirement()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirements cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization stewardship requirement revision is exhausted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.original_organization_account_id is distinct from
      old.original_organization_account_id
    or new.original_role_id is distinct from old.original_role_id
    or new.original_role_assignment_id is distinct from
      old.original_role_assignment_id
    or new.original_delegation_authority_id is distinct from
      old.original_delegation_authority_id
    or new.adopted_by is distinct from old.adopted_by
    or new.adopted_at is distinct from old.adopted_at
    or new.adoption_correlation_id is distinct from old.adoption_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirement transition is invalid';
  end if;

  return new;
end
$function$;

create function vortex_access.coordinate_organization_stewardship_adoption(
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

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;

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

create trigger organization_stewardship_requirements_protect_change
before update or delete on vortex_access.organization_stewardship_requirements
for each row execute function
  vortex_access.protect_organization_stewardship_requirement();

create function vortex_access.organization_has_permanent_steward(
  p_organization_id uuid,
  p_checked_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with current_platform_registration as (
    select registration.revision
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), required_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_revision = registration.revision
  )
  select (select pg_catalog.count(*) from required_permission) = 13
    and exists (
      select 1
      from vortex_identity.organization_accounts as account
      join vortex_identity.identity_projections as identity
        on identity.identity_id = account.identity_id
        and identity.state = 'active'
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = account.organization_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = account.organization_account_id
        and assignment.group_id is null
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= p_checked_at
        and assignment.expires_at is null
      join vortex_access.organization_roles as role
        on role.organization_id = assignment.organization_id
        and role.role_id = assignment.role_id
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
        and revision.lifecycle = 'active'
        and revision.assignment_policy = 'standing'
      join vortex_access.organization_delegation_authorities as delegation
        on delegation.organization_id = account.organization_id
        and delegation.holder_kind = 'organization_account'
        and delegation.organization_account_id = account.organization_account_id
        and delegation.group_id is null
        and delegation.scope_kind = 'organization_catalogue'
        and delegation.state = 'live'
        and delegation.starts_at <= p_checked_at
        and delegation.expires_at is null
      where account.organization_id = p_organization_id
        and account.state = 'active'
        and not exists (
          select 1
          from required_permission as required
          where not exists (
            select 1
            from vortex_access.organization_role_permission_entries as permission
            join vortex_access.permission_continuities as continuity
              on continuity.organization_id = permission.organization_id
              and continuity.application_root_id is not distinct from
                permission.application_root_id
              and continuity.owner_kind = permission.owner_kind
              and continuity.owner_id = permission.owner_id
              and continuity.permission_id = permission.permission_id
              and continuity.state = 'available'
              and continuity.continuity_revision = permission.continuity_revision
              and continuity.meaning_fingerprint = permission.meaning_fingerprint
            where permission.organization_id = role.organization_id
              and permission.role_id = role.role_id
              and permission.role_revision = role.live_revision
              and permission.application_root_id is not distinct from
                required.application_root_id
              and permission.owner_kind = required.owner_kind
              and permission.owner_id = required.owner_id
              and permission.permission_id = required.permission_id
              and permission.meaning_fingerprint = required.meaning_fingerprint
          )
        )
    )
$function$;

create function vortex_access.assert_organization_has_permanent_steward(
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  checked_at timestamptz;
begin
  if not exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ) then
    return;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  if not vortex_access.organization_has_permanent_steward(
    p_organization_id, checked_at
  ) then
    raise exception using errcode = '23514',
      message = 'An adopted organization requires a permanent steward';
  end if;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic first-steward adoption or exact unchanged replay. It creates the fixed platform-management facts once and changes Access once.';
comment on function vortex_access.organization_has_permanent_steward(
  uuid, timestamptz
) is
  'Checks the narrow current direct permanent stewardship invariant for an adopted organisation.';
comment on function vortex_access.assert_organization_has_permanent_steward(
  uuid
) is
  'Refuses a completed owner mutation that would leave an adopted organisation without a qualifying permanent steward.';

-- Existing owner-only writers remain the only mutation paths. Their original
-- implementations are retained behind private names; these same-signature
-- boundaries add the final stewardship invariant without adding authority.

alter function vortex_access.coordinate_organization_role_change(
  jsonb, uuid, uuid
) rename to coordinate_role_change_without_stewardship_v1_internal;

create function vortex_access.coordinate_organization_role_change(
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
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_role_change_without_stewardship_v1_internal(
      p_evidence, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.role ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
end
$function$;

alter function vortex_access.coordinate_organization_role_assignment_change(
  text, uuid, uuid, bigint, uuid, bigint, text, uuid, uuid, text,
  timestamptz, timestamptz, uuid, uuid
) rename to coordinate_assignment_change_without_stewardship_v1_internal;

create function vortex_access.coordinate_organization_role_assignment_change(
  p_operation text,
  p_organization_id uuid,
  p_role_assignment_id uuid,
  p_expected_assignment_revision bigint,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_assignee_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_assignment_kind text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  role_assignment_id uuid,
  role_id uuid,
  assignee_kind text,
  organization_account_id uuid,
  group_id uuid,
  assignment_kind text,
  revision bigint,
  starts_at timestamptz,
  expires_at timestamptz,
  state text,
  granted_by_actor_id uuid,
  granted_at timestamptz,
  grant_correlation_id uuid,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  revoked_by_actor_id uuid,
  revoked_at timestamptz,
  revocation_correlation_id uuid,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(
      p_operation, p_organization_id, p_role_assignment_id,
      p_expected_assignment_revision, p_role_id, p_expected_role_revision,
      p_assignee_kind, p_organization_account_id, p_group_id,
      p_assignment_kind, p_starts_at, p_expires_at, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.role_assignment_id, changed.role_id,
    changed.assignee_kind, changed.organization_account_id, changed.group_id,
    changed.assignment_kind, changed.revision, changed.starts_at,
    changed.expires_at, changed.state, changed.granted_by_actor_id,
    changed.granted_at, changed.grant_correlation_id,
    changed.changed_by_actor_id, changed.changed_at,
    changed.change_correlation_id, changed.revoked_by_actor_id,
    changed.revoked_at, changed.revocation_correlation_id,
    changed.access_version, changed.correlation_id;
end
$function$;

alter function
  vortex_access.coordinate_organization_delegation_authority_change(
    text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text,
    timestamptz, timestamptz, uuid, uuid
  ) rename to coordinate_delegation_change_without_stewardship_v1_internal;

create function vortex_access.coordinate_organization_delegation_authority_change(
  p_operation text,
  p_organization_id uuid,
  p_delegation_authority_id uuid,
  p_expected_delegation_revision bigint,
  p_holder_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_scope_kind text,
  p_bounded_permissions jsonb,
  p_scope_fingerprint text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  delegation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(
      p_operation, p_organization_id, p_delegation_authority_id,
      p_expected_delegation_revision, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, p_scope_fingerprint, p_starts_at,
      p_expires_at, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.delegation ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation,
    changed.delegation, changed.access_version, changed.correlation_id;
end
$function$;

alter function vortex_access.change_organization_account_state(
  uuid, bigint, text
) rename to change_account_state_without_stewardship_v1_internal;

create function vortex_access.change_organization_account_state(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_state text
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  identity_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  invitation_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  changed record;
  checked jsonb;
  target_organization_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();

  select account.organization_id into target_organization_id
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid;

  if found then
    -- Access owns the composition and governance lock. The lower-level
    -- Identity writer remains unchanged and has no dependency on Access.
    perform 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = target_organization_id
    for update;
  end if;

  select result.* into strict changed
  from vortex_access.change_account_state_without_stewardship_v1_internal(
      p_organization_account_id, p_expected_revision, p_state
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.organization_account_id,
    changed.organization_id, changed.identity_id, changed.display_name,
    changed.state, changed.language, changed.time_zone,
    changed.invitation_id, changed.activated_at, changed.suspended_at,
    changed.closed_at, changed.changed_at, changed.state_changed_at,
    changed.state_changed_by, changed.state_change_correlation_id,
    changed.revision, changed.access_version;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.coordinate_organization_role_change(jsonb, uuid, uuid),
  vortex_access.coordinate_role_change_without_stewardship_v1_internal(
    jsonb, uuid, uuid
  ),
  vortex_access.coordinate_organization_role_assignment_change(
    text, uuid, uuid, bigint, uuid, bigint, text, uuid, uuid, text,
    timestamptz, timestamptz, uuid, uuid
  ),
  vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(
      text, uuid, uuid, bigint, uuid, bigint, text, uuid, uuid, text,
      timestamptz, timestamptz, uuid, uuid
    ),
  vortex_access.coordinate_organization_delegation_authority_change(
    text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text,
    timestamptz, timestamptz, uuid, uuid
  ),
  vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(
      text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text,
      timestamptz, timestamptz, uuid, uuid
    )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.change_organization_account_state(uuid, bigint, text),
  vortex_access.change_account_state_without_stewardship_v1_internal(
      uuid, bigint, text
    )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke all on table vortex_access.organization_stewardship_requirements
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.protect_organization_stewardship_requirement(),
  vortex_access.organization_has_permanent_steward(uuid, timestamptz),
  vortex_access.assert_organization_has_permanent_steward(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on table vortex_access.organization_stewardship_requirements is
  'Private immutable original evidence for an explicitly adopted organisation stewardship requirement.';
comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic first-steward adoption or exact unchanged replay. It creates the fixed platform-management facts once and changes Access once.';
comment on function vortex_access.organization_has_permanent_steward(
  uuid, timestamptz
) is
  'Checks the narrow current direct permanent stewardship invariant for an adopted organisation.';
comment on function vortex_access.assert_organization_has_permanent_steward(
  uuid
) is
  'Refuses a completed owner mutation that would leave an adopted organisation without a qualifying permanent steward.';
comment on function vortex_access.change_organization_account_state(
  uuid, bigint, text
) is
  'Owner-only account lifecycle mutation guarded by the adopted organisation stewardship invariant.';

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic first-steward adoption or exact unchanged replay. It creates the fixed platform-management facts once and changes Access once.';
comment on function vortex_access.organization_has_permanent_steward(
  uuid, timestamptz
) is
  'Checks the narrow current direct permanent stewardship invariant for an adopted organisation.';
comment on function vortex_access.assert_organization_has_permanent_steward(
  uuid
) is
  'Refuses a completed owner mutation that would leave an adopted organisation without a qualifying permanent steward.';
