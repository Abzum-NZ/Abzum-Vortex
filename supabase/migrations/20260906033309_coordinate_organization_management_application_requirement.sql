alter table vortex_access.organization_stewardship_requirements
  add column management_application_root_id uuid,
  add column management_role_id uuid,
  add column management_required_role_revision bigint,
  add constraint organization_stewardship_requirements_management_shape check (
    (
      management_application_root_id is null
      and management_role_id is null
      and management_required_role_revision is null
    ) or (
      management_application_root_id is not null
      and management_application_root_id <>
        '00000000-0000-0000-0000-000000000000'::uuid
      and management_role_id is not null
      and management_role_id <>
        '00000000-0000-0000-0000-000000000000'::uuid
      and management_required_role_revision is not null
      and management_required_role_revision between 1 and 9007199254740991
    )
  ),
  add constraint organization_stewardship_requirements_management_role_fk
    foreign key (organization_id, management_role_id)
    references vortex_access.organization_roles (organization_id, role_id),
  add constraint organization_stewardship_requirements_management_revision_fk
    foreign key (
      organization_id, management_role_id, management_required_role_revision
    ) references vortex_access.organization_role_revisions (
      organization_id, role_id, revision
    );

create or replace function vortex_access.protect_organization_stewardship_requirement()
returns trigger
language plpgsql
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

  if new.organization_id <> old.organization_id
    or new.original_organization_account_id <>
      old.original_organization_account_id
    or new.original_role_id <> old.original_role_id
    or new.original_role_assignment_id <> old.original_role_assignment_id
    or new.original_delegation_authority_id <>
      old.original_delegation_authority_id
    or new.adopted_by <> old.adopted_by
    or new.adopted_at <> old.adopted_at
    or new.adoption_correlation_id <> old.adoption_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or new.changed_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or new.changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or new.change_correlation_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or (
      old.management_application_root_id is not null
      and new.management_application_root_id is null
    )
    or (
      new.management_application_root_id is not null
      and not exists (
        select 1
        from vortex_access.organization_roles as role
        join vortex_access.organization_role_revisions as revision
          on revision.organization_id = role.organization_id
          and revision.role_id = role.role_id
          and revision.revision = new.management_required_role_revision
          and revision.role_kind = 'application'
          and revision.application_root_id = new.management_application_root_id
          and revision.lifecycle = 'active'
          and revision.assignment_policy = 'standing'
        where role.organization_id = new.organization_id
          and role.role_id = new.management_role_id
          and role.role_kind = 'application'
          and role.application_root_id = new.management_application_root_id
          and role.live_revision = new.management_required_role_revision
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Organization stewardship requirement transition is invalid';
  end if;

  return new;
end
$function$;

create or replace function vortex_access.organization_has_permanent_steward(
  p_organization_id uuid,
  p_checked_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with stewardship_requirement as (
    select requirement.management_application_root_id,
      requirement.management_role_id,
      requirement.management_required_role_revision
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ), current_platform_registration as (
    select registration.revision
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), required_platform_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_revision = registration.revision
  ), candidate_steward as (
    select account.organization_account_id
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
        from required_platform_permission as required
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
  select (select pg_catalog.count(*) from required_platform_permission) = 13
    and exists (
      select 1
      from candidate_steward as steward
      cross join stewardship_requirement as requirement
      where requirement.management_application_root_id is null
        or exists (
          select 1
          from vortex_access.organization_role_assignments as assignment
          join vortex_access.organization_roles as role
            on role.organization_id = assignment.organization_id
            and role.role_id = assignment.role_id
            and role.role_kind = 'application'
            and role.application_root_id =
              requirement.management_application_root_id
          join vortex_access.organization_role_revisions as current_revision
            on current_revision.organization_id = role.organization_id
            and current_revision.role_id = role.role_id
            and current_revision.revision = role.live_revision
            and current_revision.role_kind = 'application'
            and current_revision.application_root_id =
              requirement.management_application_root_id
            and current_revision.lifecycle in ('active', 'acceptance_required')
            and current_revision.assignment_policy = 'standing'
          join vortex_access.organization_role_revisions as required_revision
            on required_revision.organization_id = role.organization_id
            and required_revision.role_id = role.role_id
            and required_revision.revision =
              requirement.management_required_role_revision
            and required_revision.role_kind = 'application'
            and required_revision.application_root_id =
              requirement.management_application_root_id
            and required_revision.lifecycle = 'active'
            and required_revision.assignment_policy = 'standing'
          where assignment.organization_id = p_organization_id
            and assignment.role_id = requirement.management_role_id
            and assignment.assignee_kind = 'organization_account'
            and assignment.organization_account_id =
              steward.organization_account_id
            and assignment.group_id is null
            and assignment.assignment_kind = 'standing'
            and assignment.state = 'live'
            and assignment.starts_at <= p_checked_at
            and assignment.expires_at is null
            and exists (
              select 1
              from vortex_access.organization_role_permission_entries
                as required_permission
              where required_permission.organization_id = role.organization_id
                and required_permission.role_id = role.role_id
                and required_permission.role_revision =
                  requirement.management_required_role_revision
            )
            and not exists (
              select 1
              from vortex_access.organization_role_permission_entries
                as required_permission
              where required_permission.organization_id = role.organization_id
                and required_permission.role_id = role.role_id
                and required_permission.role_revision =
                  requirement.management_required_role_revision
                and not exists (
                  select 1
                  from vortex_access.organization_role_permission_entries
                    as current_permission
                  join vortex_access.permission_continuities as continuity
                    on continuity.organization_id = current_permission.organization_id
                    and continuity.application_root_id is not distinct from
                      current_permission.application_root_id
                    and continuity.owner_kind = current_permission.owner_kind
                    and continuity.owner_id = current_permission.owner_id
                    and continuity.permission_id = current_permission.permission_id
                    and continuity.state = 'available'
                    and continuity.continuity_revision =
                      current_permission.continuity_revision
                    and continuity.meaning_fingerprint =
                      current_permission.meaning_fingerprint
                  where current_permission.organization_id =
                      required_permission.organization_id
                    and current_permission.role_id = required_permission.role_id
                    and current_permission.role_revision = role.live_revision
                    and current_permission.application_root_id is not distinct from
                      required_permission.application_root_id
                    and current_permission.owner_kind = required_permission.owner_kind
                    and current_permission.owner_id = required_permission.owner_id
                    and current_permission.permission_id =
                      required_permission.permission_id
                    and current_permission.continuity_revision =
                      required_permission.continuity_revision
                    and current_permission.meaning_fingerprint =
                      required_permission.meaning_fingerprint
                )
            )
        )
    )
$function$;

create function vortex_access.coordinate_organization_management_application_requirement(
  p_operation text,
  p_organization_id uuid,
  p_expected_requirement_revision bigint,
  p_application_root_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
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
  current_requirement vortex_access.organization_stewardship_requirements%rowtype;
  changed_requirement vortex_access.organization_stewardship_requirements%rowtype;
  target_role record;
  operation_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in (
      'activate_management_application_requirement',
      'replace_management_application_requirement'
    )
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_requirement_revision is null
    or p_expected_requirement_revision not between 1 and 9007199254740991
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization management-application requirement input is invalid';
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
      message = 'Organization management-application requirement scope is unavailable';
  end if;

  select stored.* into current_requirement
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = p_organization_id
  for update;
  if not found
    or current_requirement.revision <> p_expected_requirement_revision then
    raise exception using errcode = '40001',
      message = 'Organization management-application requirement is stale or unavailable';
  end if;

  if current_requirement.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization stewardship requirement revision is exhausted';
  end if;

  if (p_operation = 'activate_management_application_requirement'
      and current_requirement.management_application_root_id is not null)
    or (p_operation = 'replace_management_application_requirement'
      and current_requirement.management_application_root_id is null) then
    raise exception using errcode = '40001',
      message = 'Organization management-application requirement state conflicts';
  end if;

  if current_requirement.management_application_root_id = p_application_root_id
    and current_requirement.management_role_id = p_role_id
    and current_requirement.management_required_role_revision =
      p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization management-application requirement is unchanged';
  end if;

  select role.role_id, role.live_revision,
    revision.lifecycle, revision.assignment_policy,
    pg_catalog.count(permission.entry_ordinal) as permission_count,
    pg_catalog.count(*) filter (
      where continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
        and continuity.meaning_fingerprint = permission.meaning_fingerprint
    ) as valid_permission_count
  into target_role
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_access.organization_role_permission_entries as permission
    on permission.organization_id = revision.organization_id
    and permission.role_id = revision.role_id
    and permission.role_revision = revision.revision
  left join vortex_access.permission_continuities as continuity
    on continuity.organization_id = permission.organization_id
    and continuity.application_root_id is not distinct from
      permission.application_root_id
    and continuity.owner_kind = permission.owner_kind
    and continuity.owner_id = permission.owner_id
    and continuity.permission_id = permission.permission_id
  where role.organization_id = p_organization_id
    and role.role_id = p_role_id
    and role.role_kind = 'application'
    and role.application_root_id = p_application_root_id
    and role.live_revision = p_expected_role_revision
    and revision.role_kind = 'application'
    and revision.application_root_id = p_application_root_id
    and revision.lifecycle = 'active'
    and revision.assignment_policy = 'standing'
  group by role.role_id, role.live_revision,
    revision.lifecycle, revision.assignment_policy;

  if not found
    or target_role.permission_count = 0
    or target_role.valid_permission_count <> target_role.permission_count then
    raise exception using errcode = '40001',
      message = 'Organization management application role is stale or unavailable';
  end if;

  operation_at := greatest(
    current_requirement.changed_at, pg_catalog.clock_timestamp()
  );

  update vortex_access.organization_stewardship_requirements as requirement
  set management_application_root_id = p_application_root_id,
    management_role_id = p_role_id,
    management_required_role_revision = p_expected_role_revision,
    revision = current_requirement.revision + 1,
    changed_by = p_changed_by,
    changed_at = operation_at,
    change_correlation_id = p_correlation_id
  where requirement.organization_id = p_organization_id
    and requirement.revision = current_requirement.revision
  returning requirement.* into strict changed_requirement;

  perform vortex_access.assert_organization_has_permanent_steward(
    p_organization_id
  );

  select increment.current_version into strict next_access_version
  from vortex_access.increment_organization_access_version(
      p_organization_id, p_changed_by, p_correlation_id,
      'stewardship_changed'
    ) as increment;

  return query select 'changed'::text, p_operation,
    pg_catalog.jsonb_build_object(
      'organizationId', changed_requirement.organization_id,
      'revision', changed_requirement.revision,
      'originalOrganizationAccountId',
        changed_requirement.original_organization_account_id,
      'originalRoleId', changed_requirement.original_role_id,
      'originalRoleAssignmentId',
        changed_requirement.original_role_assignment_id,
      'originalDelegationAuthorityId',
        changed_requirement.original_delegation_authority_id,
      'managementApplicationRootId',
        changed_requirement.management_application_root_id,
      'managementRoleId', changed_requirement.management_role_id,
      'requiredRoleRevision',
        changed_requirement.management_required_role_revision,
      'adoptedByActorId', changed_requirement.adopted_by,
      'adoptedAt', changed_requirement.adopted_at,
      'adoptionCorrelationId', changed_requirement.adoption_correlation_id,
      'changedByActorId', changed_requirement.changed_by,
      'changedAt', changed_requirement.changed_at,
      'changeCorrelationId', changed_requirement.change_correlation_id
    ), next_access_version, p_correlation_id;
end
$function$;

-- The complete application-access composition remains the only supported B2
-- writer. Keep its exact public signature while adding the final D2 safeguard.
alter function vortex_access.coordinate_application_access_change(
  text, bigint, jsonb, uuid, uuid, uuid, uuid
) rename to coordinate_application_access_without_stewardship_v1_internal;

create function vortex_access.coordinate_application_access_change(
  p_operation text,
  p_expected_revision bigint,
  p_prepared_templates jsonb,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  application_root_id uuid,
  registration_state text,
  registration_revision bigint,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_application_access_without_stewardship_v1_internal(
      p_operation, p_expected_revision, p_prepared_templates,
      p_organization_id, p_application_root_id, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.application_root_id,
    changed.registration_state, changed.registration_revision,
    changed.access_version, changed.correlation_id;
end
$function$;

revoke all on table vortex_access.organization_stewardship_requirements
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.protect_organization_stewardship_requirement(),
  vortex_access.organization_has_permanent_steward(uuid, timestamptz),
  vortex_access.coordinate_organization_management_application_requirement(
    text, uuid, bigint, uuid, uuid, bigint, uuid, uuid
  ),
  vortex_access.coordinate_application_access_change(
    text, bigint, jsonb, uuid, uuid, uuid, uuid
  ),
  vortex_access.coordinate_application_access_without_stewardship_v1_internal(
    text, bigint, jsonb, uuid, uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.coordinate_organization_management_application_requirement(
    text, uuid, bigint, uuid, uuid, bigint, uuid, uuid
  ) is
  'Owner-only changed activation or replacement of the exact stewardship management-application requirement.';
comment on function vortex_access.organization_has_permanent_steward(
  uuid, timestamptz
) is
  'Checks the current direct permanent stewardship invariant, including the exact management application requirement when active.';
comment on function vortex_access.coordinate_application_access_change(
  text, bigint, jsonb, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic application-access composition guarded by the adopted organisation stewardship invariant.';
comment on function
  vortex_access.coordinate_application_access_without_stewardship_v1_internal(
    text, bigint, jsonb, uuid, uuid, uuid, uuid
  ) is
  'Internal application-access implementation retained only behind the stewardship safeguard.';
