create or replace function vortex_access.validate_organization_role_activation_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
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
    revision.activation_policy_revision, revision.activation_policy_fingerprint,
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
    and policy.policy_fingerprint = revision.activation_policy_fingerprint
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
    or role_fact.activation_policy_fingerprint <>
      new.activation_policy_fingerprint
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
      and continuity.application_root_id is not distinct from permission.application_root_id
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
      and continuity.meaning_fingerprint = permission.meaning_fingerprint
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
$function$;

revoke execute on function
  vortex_access.validate_organization_role_activation_insert()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_access.coordinate_organization_role_activation_change(
  p_operation text,
  p_organization_id uuid,
  p_role_activation_id uuid,
  p_expected_activation_revision bigint,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_requested_duration_seconds bigint,
  p_eligibility_source_kind text,
  p_role_assignment_id uuid,
  p_expected_role_assignment_revision bigint,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  activation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  activation_fact vortex_access.organization_role_activations%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  duration_cap_seconds numeric;
  source_seconds numeric;
  activation_expires_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in ('activate_role', 'revoke_role_activation')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_activation_id is null
    or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-activation change input is invalid';
  end if;

  if p_operation = 'activate_role' then
    if p_expected_activation_revision is not null
      or p_organization_account_id is null
      or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_requested_duration_seconds is null
      or p_requested_duration_seconds not between 1 and 9007199254740991
      or p_eligibility_source_kind is null
      or p_eligibility_source_kind not in ('direct', 'group')
      or p_role_assignment_id is null
      or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_assignment_revision is null
      or p_expected_role_assignment_revision not between 1 and 9007199254740991
      or (
        p_eligibility_source_kind = 'direct'
        and (
          p_membership_id is not null
          or p_expected_membership_revision is not null
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          p_membership_id is null
          or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_expected_membership_revision is null
          or p_expected_membership_revision not between 1 and 9007199254740991
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role activation input is invalid';
    end if;
  elsif p_expected_activation_revision is null
    or p_expected_activation_revision not between 1 and 9007199254740991
    or p_organization_account_id is not null
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_requested_duration_seconds is not null
    or p_eligibility_source_kind is not null
    or p_role_assignment_id is not null
    or p_expected_role_assignment_revision is not null
    or p_membership_id is not null
    or p_expected_membership_revision is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-activation revocation input is invalid';
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
      message = 'Organization role-activation change scope is unavailable';
  end if;

  if p_operation = 'activate_role' then
    if exists (
      select 1
      from vortex_access.organization_role_activations as stored_activation
      where stored_activation.organization_id = p_organization_id
        and stored_activation.role_activation_id = p_role_activation_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation is stale or unavailable';
    end if;

    select role.live_revision, revision.lifecycle, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      revision.activation_policy_fingerprint,
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
      and policy.policy_fingerprint = revision.activation_policy_fingerprint
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle not in ('active', 'acceptance_required')
      or role_fact.assignment_policy <> 'activation_required'
      or not exists (
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
        where permission.organization_id = p_organization_id
          and permission.role_id = p_role_id
          and permission.role_revision = p_expected_role_revision
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation role evidence is stale or unavailable';
    end if;

    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role activation account is stale or unavailable';
    end if;

    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;
    if not found
      or assignment_fact.role_id <> p_role_id
      or assignment_fact.assignment_kind <> 'eligible'
      or assignment_fact.revision <> p_expected_role_assignment_revision
      or assignment_fact.state <> 'live'
      or (
        p_eligibility_source_kind = 'direct'
        and (
          assignment_fact.assignee_kind <> 'organization_account'
          or assignment_fact.organization_account_id <> p_organization_account_id
        )
      )
      or (
        p_eligibility_source_kind = 'group'
        and assignment_fact.assignee_kind <> 'group'
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation eligibility is stale or unavailable';
    end if;

    if p_eligibility_source_kind = 'group' then
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = assignment_fact.group_id
        and organization_group.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization role activation Group is stale or unavailable';
      end if;

      select membership.* into membership_fact
      from vortex_access.organization_group_memberships as membership
      where membership.organization_id = p_organization_id
        and membership.membership_id = p_membership_id
      for update;
      if not found
        or membership_fact.group_id <> assignment_fact.group_id
        or membership_fact.organization_account_id <> p_organization_account_id
        or membership_fact.revision <> p_expected_membership_revision
        or membership_fact.state <> 'live' then
        raise exception using errcode = '40001',
          message = 'Organization role activation membership is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if assignment_fact.starts_at > checked_at
      or (
        assignment_fact.expires_at is not null
        and assignment_fact.expires_at <= checked_at
      )
      or (
        p_eligibility_source_kind = 'group'
        and (
          membership_fact.starts_at > checked_at
          or (
            membership_fact.expires_at is not null
            and membership_fact.expires_at <= checked_at
          )
        )
      ) then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    duration_cap_seconds := least(
      p_requested_duration_seconds::numeric,
      role_fact.maximum_activation_duration_seconds::numeric
    );
    if assignment_fact.expires_at is not null then
      source_seconds := extract(
        epoch from assignment_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      source_seconds := extract(
        epoch from membership_fact.expires_at - checked_at
      );
      duration_cap_seconds := least(
        duration_cap_seconds,
        source_seconds
      );
    end if;
    if duration_cap_seconds <= 0 then
      raise exception using errcode = '40001',
        message = 'Organization role activation source window is no longer current';
    end if;

    begin
      activation_expires_at := checked_at +
        (duration_cap_seconds::double precision * interval '1 second');
    exception
      when datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = '22023',
          message = 'Organization role activation duration is not representable';
    end;
    if assignment_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        assignment_fact.expires_at
      );
    end if;
    if p_eligibility_source_kind = 'group'
      and membership_fact.expires_at is not null then
      activation_expires_at := least(
        activation_expires_at,
        membership_fact.expires_at
      );
    end if;
    if activation_expires_at in (
      '-infinity'::timestamptz, 'infinity'::timestamptz
    ) or activation_expires_at <= checked_at then
      raise exception using errcode = '22023',
        message = 'Organization role activation duration is not representable';
    end if;

    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision, activation_policy_fingerprint,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      membership_id, membership_revision, state, activated_by, activated_at,
      expires_at, activation_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_activation_id, p_organization_account_id,
      p_role_id, 1, p_expected_role_revision,
      role_fact.authority_continuity_revision,
      role_fact.policy_continuity_revision, role_fact.activation_policy_id,
      role_fact.activation_policy_revision,
      role_fact.activation_policy_fingerprint, p_eligibility_source_kind,
      p_role_assignment_id, p_expected_role_assignment_revision,
      p_membership_id, p_expected_membership_revision, 'live', p_changed_by,
      checked_at, activation_expires_at, p_correlation_id, p_changed_by,
      checked_at, p_correlation_id, null, null, null
    ) returning * into activation_fact;
  else
    select stored_activation.* into activation_fact
    from vortex_access.organization_role_activations as stored_activation
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
    for update;

    if not found
      or activation_fact.revision <> p_expected_activation_revision
      or activation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
    if activation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role activation revision is exhausted';
    end if;

    operation_at := greatest(
      activation_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_activations as stored_activation
    set revision = activation_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where stored_activation.organization_id = p_organization_id
      and stored_activation.role_activation_id = p_role_activation_id
      and stored_activation.revision = p_expected_activation_revision
      and stored_activation.state = 'live'
    returning stored_activation.* into activation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-activation revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_activation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'roleActivationId', activation_fact.role_activation_id,
      'organizationId', activation_fact.organization_id,
      'organizationAccountId', activation_fact.organization_account_id,
      'roleId', activation_fact.role_id,
      'revision', activation_fact.revision,
      'historicalRoleRevision', activation_fact.historical_role_revision,
      'authorityContinuityRevision',
        activation_fact.authority_continuity_revision,
      'policyContinuityRevision', activation_fact.policy_continuity_revision,
      'activationPolicy', pg_catalog.jsonb_build_object(
        'activationPolicyId', activation_fact.activation_policy_id,
        'revision', activation_fact.activation_policy_revision,
        'fingerprint', activation_fact.activation_policy_fingerprint
      ),
      'eligibilitySource', case activation_fact.eligibility_source_kind
        when 'direct' then pg_catalog.jsonb_build_object(
          'kind', 'direct',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          )
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group',
          'eligibilityAssignment', pg_catalog.jsonb_build_object(
            'roleAssignmentId', activation_fact.role_assignment_id,
            'revision', activation_fact.role_assignment_revision
          ),
          'originatingMembership', pg_catalog.jsonb_build_object(
            'membershipId', activation_fact.membership_id,
            'revision', activation_fact.membership_revision
          )
        )
      end,
      'state', activation_fact.state,
      'activatedByActorId', activation_fact.activated_by,
      'activatedAt', activation_fact.activated_at,
      'expiresAt', activation_fact.expires_at,
      'activationCorrelationId', activation_fact.activation_correlation_id,
      'changedByActorId', activation_fact.changed_by,
      'changedAt', activation_fact.changed_at,
      'changeCorrelationId', activation_fact.change_correlation_id,
      'revokedByActorId', activation_fact.revoked_by,
      'revokedAt', activation_fact.revoked_at,
      'revocationCorrelationId', activation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_role_activation_change(
    text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
    bigint, uuid, bigint, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_role_activation_change(
  text, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, uuid,
  bigint, uuid, bigint, uuid, uuid
) is
  'Owner-only atomic individual role activation or terminal revocation. It changes Access once but grants no caller authority.';
