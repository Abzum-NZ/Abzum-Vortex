CREATE OR REPLACE FUNCTION vortex_access.validate_organization_role_activation_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  statement_started_at timestamptz := pg_catalog.statement_timestamp();
  validation_time timestamptz := pg_catalog.clock_timestamp();
  role_fact record;
  current_assignment record;
  current_membership record;
begin
  if new.revision <> 1
    or new.state <> 'live'
    or new.activated_at < statement_started_at
    or new.activated_at > validation_time
    or new.expires_at <= validation_time then
    raise exception using errcode = '23514',
      message = 'A new role activation requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.organization_account_id
      and account.state = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires an active same-organization account';
  end if;

  select role.live_revision, revision.lifecycle, revision.assignment_policy,
    revision.authority_continuity_revision,
    revision.policy_continuity_revision, revision.activation_policy_id,
    revision.activation_policy_revision,
    policy.maximum_activation_duration_seconds
  into role_fact
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  join vortex_access.organization_role_activation_policy_revisions as policy
    on policy.organization_id = revision.organization_id
    and policy.role_id = revision.role_id
    and policy.activation_policy_id = revision.activation_policy_id
    and policy.revision = revision.activation_policy_revision
  where role.organization_id = new.organization_id
    and role.role_id = new.role_id;

  if not found
    or role_fact.live_revision <> new.historical_role_revision
    or role_fact.lifecycle not in ('active', 'acceptance_required')
    or role_fact.assignment_policy <> 'activation_required'
    or role_fact.authority_continuity_revision <>
      new.authority_continuity_revision
    or role_fact.policy_continuity_revision <> new.policy_continuity_revision
    or role_fact.activation_policy_id <> new.activation_policy_id
    or role_fact.activation_policy_revision <> new.activation_policy_revision
    or extract(epoch from (new.expires_at - new.activated_at)) >
      role_fact.maximum_activation_duration_seconds then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current role and policy evidence';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_role_permission_entries as permission
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
    where permission.organization_id = new.organization_id
      and permission.role_id = new.role_id
      and permission.role_revision = new.historical_role_revision
  ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires nonempty current retained authority';
  end if;

  select assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state
  into current_assignment
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = new.organization_id
    and assignment.role_assignment_id = new.role_assignment_id;

  if not found
    or current_assignment.role_id <> new.role_id
    or current_assignment.assignment_kind <> 'eligible'
    or current_assignment.revision <> new.role_assignment_revision
    or current_assignment.state <> 'live'
    or current_assignment.starts_at > validation_time
    or (
      current_assignment.expires_at is not null
      and current_assignment.expires_at <= validation_time
    )
    or (
      current_assignment.expires_at is not null
      and new.expires_at > current_assignment.expires_at
    ) then
    raise exception using errcode = '23514',
      message = 'A role activation requires exact current eligible assignment evidence';
  end if;

  if new.eligibility_source_kind = 'direct' then
    if current_assignment.assignee_kind <> 'organization_account'
      or current_assignment.organization_account_id <>
        new.organization_account_id then
      raise exception using errcode = '23514',
        message = 'A direct activation requires matching account eligibility';
    end if;
  elsif new.eligibility_source_kind = 'group' then
    if current_assignment.assignee_kind <> 'group' then
      raise exception using errcode = '23514',
        message = 'A Group activation requires Group eligibility';
    end if;

    select membership.group_id, membership.organization_account_id,
      membership.revision, membership.starts_at, membership.expires_at,
      membership.state
    into current_membership
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = new.organization_id
      and membership.membership_id = new.membership_id;

    if not found
      or current_membership.group_id <> current_assignment.group_id
      or current_membership.organization_account_id <>
        new.organization_account_id
      or current_membership.revision <> new.membership_revision
      or current_membership.state <> 'live'
      or current_membership.starts_at > validation_time
      or (
        current_membership.expires_at is not null
        and current_membership.expires_at <= validation_time
      )
      or (
        current_membership.expires_at is not null
        and new.expires_at > current_membership.expires_at
      ) then
      raise exception using errcode = '23514',
        message = 'A Group activation requires exact current membership evidence';
    end if;
  end if;

  return new;
end
$$;

alter function vortex_access.validate_organization_role_activation_insert() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_role_activation_insert() FROM PUBLIC;

grant execute on function vortex_access.validate_organization_role_activation_insert() to postgres;
