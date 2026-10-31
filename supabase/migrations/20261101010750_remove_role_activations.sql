-- DT-3: role activations are gone. Nothing can create a role activation, an eligible role
-- assignment or a role activation policy, so every role assignment is standing and every role is
-- assigned directly. The activation table and its policy revisions, the activation writers,
-- readers and triggers, the role_activations protected read model (with the IAM system-projection
-- storage contract that pointed at it), and the columns organization_role_revisions.assignment_policy,
-- activation_policy_id, activation_policy_revision and organization_role_assignments.assignment_kind
-- go. Every role writer and reader stops carrying them; signatures that took p_assignment_kind or
-- returned created_activation_policy are dropped and recreated.

set role vortex_owner;

drop function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid);
drop function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid);
drop function vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid);
drop function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid);
drop function vortex_access.coordinate_private_organization_role_authority_change(p_prepared_evidence jsonb, p_activity_id uuid);
drop function vortex_access.coordinate_role_change_without_stewardship_internal(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid);

CREATE OR REPLACE FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) RETURNS TABLE(outcome text, organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  target_organization_id uuid;
  invitation vortex_identity.organization_invitations%rowtype;
  accepted record;
  resulting_version bigint;
  role_intent record;
  role_fact record;
  checked_at timestamptz;
  prior_account_state text;
  access_transition text := 'unchanged';
begin
  if p_invitation_id is null
    or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
    or p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_display_name is not null and (
      p_display_name is distinct from pg_catalog.btrim(p_display_name)
      or pg_catalog.char_length(p_display_name) not between 1 and 120
    )) then
    raise exception using errcode = '22023',
      message = 'Invitation acceptance input is invalid';
  end if;

  select candidate.organization_id into target_organization_id
  from vortex_identity.organization_invitations as candidate
  where candidate.invitation_id = p_invitation_id;

  if not found then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

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
    if exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = target_organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;


  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', target_organization_id::text, true
  );

  select candidate.* into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.organization_id = target_organization_id
    and candidate.invitation_id = p_invitation_id
  for update;

  if not found or invitation.revoked_at is not null or invitation.accepted_at is not null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  if invitation.invited_email <> p_verified_email then
    return query select 'wrong_address'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;
  checked_at := pg_catalog.clock_timestamp();
  if invitation.expires_at <= checked_at then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;
  for role_intent in
    select intent."roleId" as role_id, intent."roleRevision" as role_revision
    from pg_catalog.jsonb_to_recordset(invitation.role_intents)
      as intent("roleId" uuid, "roleRevision" bigint)
    order by intent."roleId"
  loop
    select role.live_revision, revision.lifecycle into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = target_organization_id and role.role_id = role_intent.role_id
    for update of role;
    if not found or role_fact.live_revision <> role_intent.role_revision
      or role_fact.lifecycle <> 'active' then
    return query select 'role_changed'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
    end if;
    if not vortex_access.check_organization_invitation_role_authority_internal(
      target_organization_id, invitation.invited_by_organization_account_id, role_intent.role_id, checked_at
    ) then
    return query select 'inviter_not_allowed'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(invitation.role_intents) = 0 then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  select account.state into prior_account_state
  from vortex_identity.organization_accounts as account
  where account.organization_id = target_organization_id and account.identity_id = p_identity_id
  for update;
  if not found then
    access_transition := 'activated';
  elsif prior_account_state <> 'active' then
    access_transition := 'reactivated';
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation(
    p_invitation_id,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome = 'accepted' and access_transition <> 'unchanged' then
    select incremented.current_version into resulting_version
    from vortex_access.increment_organization_access_version(
      accepted.organization_id,
      accepted.organization_account_id,
      p_correlation_id,
      case access_transition
        when 'activated' then 'organization_account_activated'
        when 'reactivated' then 'organization_account_reactivated'
      end
    ) as incremented;

  elsif accepted.outcome = 'accepted' then
    select version.current_version into resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = accepted.organization_id;

    if not found then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
  end if;

  if accepted.outcome = 'accepted' then
    for role_intent in
      select intent."roleId" as role_id, intent."roleRevision" as role_revision
      from pg_catalog.jsonb_to_recordset(invitation.role_intents)
        as intent("roleId" uuid, "roleRevision" bigint)
      order by intent."roleId"
    loop
      if not exists (
        select 1 from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = target_organization_id
          and assignment.role_id = role_intent.role_id
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = accepted.organization_account_id
          and assignment.state = 'live'
          and (assignment.expires_at is null or assignment.expires_at > checked_at)
      ) then
        select changed.access_version into resulting_version
        from vortex_access.coordinate_organization_role_assignment_change(
          'grant', target_organization_id, pg_catalog.gen_random_uuid(), null,
          role_intent.role_id, role_intent.role_revision, 'organization_account',
          accepted.organization_account_id, null,
          checked_at, null, invitation.invited_by_organization_account_id, p_correlation_id
        ) as changed;
      end if;
    end loop;
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id,
    accepted.organization_id, accepted.identity_id, accepted.display_name,
    accepted.state, accepted.language, accepted.time_zone,
    accepted.invitation_id, accepted.activated_at, accepted.suspended_at,
    accepted.closed_at, accepted.changed_at, accepted.state_changed_at,
    accepted.state_changed_by, accepted.state_change_correlation_id,
    accepted.revision, resulting_version;
end
$_$;

alter function vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) IS 'Runtime acceptance of an invitation by the signed-in person whose verified email it names, under the organization access-version lock.';

REVOKE ALL ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) TO vortex_runtime;

grant execute on function vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) to postgres;

create or replace function vortex_access.appoint_organization_steward_for_administration(
  p_organization_account_id uuid,
  p_expected_account_revision bigint
)
returns table (
  outcome text,
  organization_id uuid,
  appointment_summary jsonb,
  access_version bigint, refusal_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  platform_owner_id uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_channel text;
  locked_access_version bigint;
  stewardship_requirement vortex_access.organization_stewardship_requirements%rowtype;
  target_account vortex_identity.organization_accounts%rowtype;
  steward_role vortex_access.organization_roles%rowtype;
  steward_role_revision vortex_access.organization_role_revisions%rowtype;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  decision record;
  role_decision record;
  version_change record;
  affected_permissions jsonb;
  guarded_minimum jsonb;
  current_guarded_minimum jsonb;
  catalogue_declaration jsonb;
  existing_steward_role_id uuid;
  existing_role_assignment_id uuid;
  existing_delegation_authority_id uuid;
  steward_role_is_qualified boolean;
  generated_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  generated_delegation_authority_id uuid := pg_catalog.gen_random_uuid();
  activity_id uuid;
  activity_result text;
  appointment_starts_at timestamptz;
  authorization_checked_at timestamptz;
  result_summary jsonb;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_account_revision is null
    or p_expected_account_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization steward appointment input is invalid';
  end if;

  platform_owner_id := (vortex_access.required_platform_permission('platform.organization.assignments.manage') ->> 'ownerId')::uuid;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_channel := vortex_platform.channel();

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
      message = 'Organization steward appointment is unavailable';
  end if;

  select requirement.* into stewardship_requirement
  from vortex_access.organization_stewardship_requirements as requirement
  where requirement.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  catalogue_declaration := pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    );
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null
    or decision.valid_until is null
    or decision.checked_at > pg_catalog.clock_timestamp()
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or decision.valid_until <= decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  select account.* into target_account
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
  where account.organization_id = context_organization_id
    and account.organization_account_id = p_organization_account_id
    and account.state = 'active'
    and identity.state = 'active'
  for update of account, identity;
  if not found or p_organization_account_id = context_account_id then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, appointment_starts_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, null::text;
    return;
  end if;
  -- Match the target against the same live minimum used by the permanent-steward
  -- safeguard. The original adoption role may have changed or another role may
  -- already qualify the target.
  with required_declaration as materialized (
    select declaration.permission_id
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id,
      registration.revision as registration_revision
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = registration.organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        platform_owner_id
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        context_organization_id, registration.revision
      )
      and entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = platform_owner_id
  ), qualifying_role as (
    select role.role_id
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = context_organization_id
      and revision.lifecycle = 'active'
      and (select pg_catalog.count(*) from required_declaration) > 0
      and (select pg_catalog.count(distinct permission_id) from required_declaration)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(distinct permission_id) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(*) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and not exists (
        select 1 from required_permission as required
        where not exists (
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
            and continuity.last_processed_registration_revision = required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
        )
      )
  ), current_steward as (
    select assignment.role_assignment_id,
      delegation.delegation_authority_id, role.role_id
    from vortex_access.organization_role_assignments as assignment
    join qualifying_role as role on role.role_id = assignment.role_id
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = assignment.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = p_organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= appointment_starts_at
      and delegation.expires_at is null
    where assignment.organization_id = context_organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.group_id is null
      and assignment.state = 'live'
      and assignment.starts_at <= appointment_starts_at
      and assignment.expires_at is null
    order by assignment.role_assignment_id, delegation.delegation_authority_id
    limit 1
  )
  select exists (
      select 1 from qualifying_role as role
      where role.role_id = stewardship_requirement.original_role_id
    ), current_steward_result.role_assignment_id,
    current_steward_result.delegation_authority_id,
    current_steward_result.role_id,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'permissionId', declaration.permission_id
    ) order by declaration.permission_id) from required_declaration as declaration)
  into steward_role_is_qualified, existing_role_assignment_id,
    existing_delegation_authority_id, existing_steward_role_id, guarded_minimum
  from (select 1) as anchor
  left join current_steward as current_steward_result on true;
  if existing_role_assignment_id is null and steward_role_is_qualified is not true then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select role.* into steward_role
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = coalesce(
      existing_steward_role_id, stewardship_requirement.original_role_id
    )
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select revision.* into steward_role_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = steward_role.role_id
    and revision.revision = steward_role.live_revision
  for share;
  if not found
    or steward_role_revision.lifecycle is distinct from 'active' then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Bind the complete role grant, including every permission beyond the minimum.
  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind, 'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = steward_role.role_id
      and permission.role_revision = steward_role.live_revision
  ) as reference;
  if affected_permissions is null then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Refresh catalogue authority under all initial locks, without changing context.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  select evaluated.* into strict role_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        )
      )
    )
  ) as evaluated;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null or decision.valid_until is null
    or decision.checked_at > authorization_checked_at
    or decision.valid_until <= authorization_checked_at
    or decision.valid_until <= decision.checked_at
    or role_decision.outcome is distinct from 'eligible'
    or role_decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or role_decision.target_kind is distinct from 'organization'
    or role_decision.target_application_root_id is not null
    or role_decision.organization_id is distinct from context_organization_id
    or role_decision.organization_account_id is distinct from context_account_id
    or role_decision.access_version is distinct from context_access_version
    or role_decision.correlation_id is distinct from context_correlation_id
    or role_decision.reason_code is not null
    or role_decision.checked_at is null or role_decision.valid_until is null
    or role_decision.checked_at > authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= role_decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or role_decision.valid_until <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  if target_account.revision is distinct from p_expected_account_revision then
    return query select 'conflict'::text, context_organization_id,
      null::jsonb, context_access_version, null::text;
    return;
  end if;
  if existing_role_assignment_id is not null then
    perform vortex_access.assert_organization_has_permanent_steward(
      context_organization_id
    );
    if vortex_access.validated_human_request_context() is distinct from context_value
      or decision.valid_until <= pg_catalog.clock_timestamp()
      or role_decision.valid_until <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Organization steward appointment is unavailable';
    end if;
    result_summary := pg_catalog.jsonb_build_object(
      'organizationAccountId', p_organization_account_id,
      'roleAssignmentId', existing_role_assignment_id,
      'delegationAuthorityId', existing_delegation_authority_id
    );
    return query select 'unchanged'::text, context_organization_id,
      result_summary, context_access_version, null::text;
    return;
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    context_organization_id, generated_role_assignment_id, steward_role.role_id,
    'organization_account', p_organization_account_id, null, 1,
    appointment_starts_at, null, 'live', context_account_id, appointment_starts_at,
    context_correlation_id, context_account_id, appointment_starts_at,
    context_correlation_id, null, null, null
  ) returning * into assignment_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward role grant is stale or unavailable';
  end if;
  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at, revocation_correlation_id
  ) values (
    context_organization_id, generated_delegation_authority_id,
    'organization_account', p_organization_account_id, null,
    'organization_catalogue', null, 1, appointment_starts_at, null, 'live',
    context_account_id, appointment_starts_at, context_correlation_id,
    context_account_id, appointment_starts_at, context_correlation_id, null, null, null
  ) returning * into delegation_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation grant is stale or unavailable';
  end if;

  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, assignment_fact.changed_at,
    'organization_account', context_account_id, 'grant_role_assignment',
    array[assignment_fact.role_assignment_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward role Activity is stale';
  end if;
  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, delegation_fact.changed_at,
    'organization_account', context_account_id, 'grant_delegation',
    array[delegation_fact.delegation_authority_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation Activity is stale';
  end if;

  if not exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      join vortex_access.organization_roles as role
        on role.organization_id = assignment.organization_id
        and role.role_id = assignment.role_id
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      join vortex_access.organization_delegation_authorities as delegation
        on delegation.organization_id = assignment.organization_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = assignment.organization_id
        and account.organization_account_id = assignment.organization_account_id
      join vortex_identity.identity_projections as identity
        on identity.identity_id = account.identity_id
      where assignment.organization_id = context_organization_id
        and assignment.role_assignment_id = generated_role_assignment_id
        and assignment.role_id = stewardship_requirement.original_role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.group_id is null
        and assignment.revision = 1
        and assignment.state = 'live'
        and assignment.starts_at = appointment_starts_at
        and assignment.expires_at is null
        and assignment.granted_by = context_account_id
        and assignment.granted_at = appointment_starts_at
        and assignment.grant_correlation_id = context_correlation_id
        and assignment.changed_by = context_account_id
        and assignment.changed_at = appointment_starts_at
        and assignment.change_correlation_id = context_correlation_id
        and assignment.revoked_by is null and assignment.revoked_at is null
        and assignment.revocation_correlation_id is null
        and role.live_revision = steward_role.live_revision
        and revision.lifecycle = 'active'
        and delegation.delegation_authority_id = generated_delegation_authority_id
        and delegation.holder_kind = 'organization_account'
        and delegation.organization_account_id = p_organization_account_id
        and delegation.group_id is null
        and delegation.scope_kind = 'organization_catalogue'
        and delegation.bounded_permissions is null
        and delegation.revision = 1
        and delegation.state = 'live'
        and delegation.starts_at = appointment_starts_at
        and delegation.expires_at is null
        and delegation.granted_by = context_account_id
        and delegation.granted_at = appointment_starts_at
        and delegation.grant_correlation_id = context_correlation_id
        and delegation.changed_by = context_account_id
        and delegation.changed_at = appointment_starts_at
        and delegation.change_correlation_id = context_correlation_id
        and delegation.revoked_by is null and delegation.revoked_at is null
        and delegation.revocation_correlation_id is null
        and account.state = 'active'
        and identity.state = 'active'
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(guarded_minimum) as required(value)
          where not exists (
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
              join vortex_access.permission_registrations as registration
              on registration.organization_id = permission.organization_id
              and registration.registration_kind = 'platform'
              and registration.registration_owner_id =
                platform_owner_id
              and registration.state = 'active'
              and continuity.last_processed_registration_revision = registration.revision
            join vortex_access.permission_catalogue_entries as entry
              on entry.organization_id = registration.organization_id
              and entry.registration_kind = registration.registration_kind
              and entry.registration_owner_id = registration.registration_owner_id
              and entry.registration_revision = registration.revision
              and entry.application_root_id is null
              and entry.owner_kind = 'platform'
              and entry.owner_id = platform_owner_id
              and entry.permission_id = permission.permission_id
            where permission.organization_id = role.organization_id
              and permission.role_id = role.role_id
              and permission.role_revision = role.live_revision
              and permission.application_root_id is null
              and permission.owner_kind = 'platform'
              and permission.owner_id = platform_owner_id
              and permission.permission_id = (required.value ->> 'permissionId')::uuid
          )
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment result is stale or unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(
    context_organization_id
  );
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select changed.* into strict version_change
  from vortex_access.increment_organization_access_version(
    context_organization_id, context_account_id, context_correlation_id,
    'stewardship_changed'
  ) as changed;
  if version_change.organization_id is distinct from context_organization_id
    or version_change.current_version is distinct from context_access_version + 1
    or version_change.changed_by is distinct from context_account_id
    or version_change.change_correlation_id is distinct from context_correlation_id
    or version_change.change_reason is distinct from 'stewardship_changed' then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment version is stale or unavailable';
  end if;
  result_summary := pg_catalog.jsonb_build_object(
    'organizationAccountId', p_organization_account_id,
    'roleAssignmentId', generated_role_assignment_id,
    'delegationAuthorityId', generated_delegation_authority_id
  );
  return query select 'changed'::text, context_organization_id,
    result_summary, version_change.current_version, null::text;
end
$function$;

revoke execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
to vortex_request;

comment on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint) is
  'Verified human request entry: atomically appoints another active same-organisation account to the current steward role and catalogue delegation under the original context with one Access increment, safe target-revision conflict and no public operation binding.';

alter function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.appoint_organization_steward_for_administration(p_organization_account_id uuid, p_expected_account_revision bigint) to postgres;

create or replace function vortex_access.assign_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_assignee_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  assignment_summary jsonb,
  access_version bigint, refusal_reason text
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
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  existing_assignment_id uuid;
  summary_assignment_id uuid;
  changed_at_value timestamptz;
  changed_access_version bigint;
  checked_at timestamptz;
  activity_result text;
begin
  p_starts_at := coalesce(p_starts_at, now());

  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_assignee_kind is null
    or p_assignee_kind not in ('organization_account', 'group')
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or (
      p_assignee_kind = 'organization_account'
      and (
        p_organization_account_id is null
        or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
        or p_group_id is not null
      )
    )
    or (
      p_assignee_kind = 'group'
      and (
        p_group_id is null
        or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
        or p_organization_account_id is not null
      )
    )
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment assignment input is invalid';
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
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment assignment is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle <> 'acceptance_required'
    and revision_fact.lifecycle <> 'active' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = p_role_id
      and permission.role_revision = role_fact.live_revision
  ) as reference;
  if affected_permissions is not null then
    authority_after := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif revision_fact.lifecycle = 'acceptance_required' then
    authority_after := pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment authority is stale or unavailable';
  end if;

  authority_requirement := pg_catalog.jsonb_build_object(
    'kind', 'delegated_management',
    'before', pg_catalog.jsonb_build_object('kind', 'none'),
    'after', authority_after
  );

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_assignments.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment assignment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment assignment is unavailable';
  end if;

  -- Named only to a caller already eligible to assign the role, so its lifecycle is not disclosed.
  if revision_fact.lifecycle = 'acceptance_required' then
    raise exception using errcode = 'V3144',
      message = 'Organization role revision requires acceptance before assignment';
  end if;

  -- One live assignment of a role per assignee: the same role assigned again to the same assignee
  -- with an overlapping live period returns the assignment already in force instead of a second row.
  select existing.role_assignment_id into existing_assignment_id
  from vortex_access.organization_role_assignments as existing
  where existing.organization_id = context_organization_id
    and existing.role_id = p_role_id
    and existing.assignee_kind = p_assignee_kind
    and existing.organization_account_id is not distinct from p_organization_account_id
    and existing.group_id is not distinct from p_group_id
    and existing.state = 'live'
    and existing.role_assignment_id <> p_role_assignment_id
    and existing.starts_at < coalesce(p_expires_at, 'infinity'::timestamptz)
    and coalesce(existing.expires_at, 'infinity'::timestamptz) > p_starts_at
  order by existing.starts_at, existing.role_assignment_id
  limit 1;

  if existing_assignment_id is null then
    select result.* into strict changed
    from vortex_access.coordinate_organization_role_assignment_change(
      'grant', context_organization_id, p_role_assignment_id, null,
      p_role_id, p_expected_role_revision, p_assignee_kind,
      p_organization_account_id, p_group_id,
      p_starts_at, p_expires_at, context_account_id, context_correlation_id
    ) as result;
    summary_assignment_id := p_role_assignment_id;
    changed_at_value := changed.changed_at;
    changed_access_version := changed.access_version;
  else
    summary_assignment_id := existing_assignment_id;
    changed_at_value := pg_catalog.clock_timestamp();
    changed_access_version := context_access_version;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = summary_assignment_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed_at_value,
    'organization_account', context_account_id,
    case when existing_assignment_id is null
      then 'grant_role_assignment' else 'role_already_assigned' end,
    array[summary_assignment_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment assignment Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed_access_version, null::text;
end
$function$;

revoke execute on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, timestamptz, timestamptz, uuid)
to vortex_request;

comment on function vortex_access.assign_organization_role_assignment_for_administration(uuid, uuid, bigint, text, uuid, uuid, timestamptz, timestamptz, uuid) is
  'Standalone request entry: performs grant_role_assignment after fixed protected checks of the caller current authority, the delegation subset and the target organisation account, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.assign_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_activity_id uuid) to postgres;

create or replace function vortex_access.change_application_installation_access(
  p_activity_id uuid,
  p_application_root_id uuid,
  p_change text,
  p_prepared_templates jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  current_registration vortex_access.permission_registrations%rowtype;
  registration_found boolean;
  coordinated_operation text;
  expected_revision bigint;
  changed record;
  assignment_to_revoke record;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change is null
    or p_change not in ('prepare', 'withdraw')
    or (p_change = 'prepare' and p_prepared_templates is null)
    or (p_change = 'withdraw' and p_prepared_templates is not null) then
    raise exception using errcode = '22023',
      message = 'Application installation access command is invalid';
  end if;

  -- Locks the organisation Access version and proves current installation
  -- authority. Every registration writer takes that lock first, so the
  -- registration read below cannot change before the coordinator rechecks it.
  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;
  perform vortex_access.validated_human_request_context();

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = authority.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id;
  registration_found := found;

  if p_change = 'withdraw' then
    if not registration_found then
      raise exception using errcode = 'P0002',
        message = 'Application permission registration is unavailable';
    end if;
    if current_registration.state = 'withdrawn' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unchanged',
        'operation', 'withdraw',
        'organizationId', authority.organization_id,
        'applicationRootId', p_application_root_id,
        'registrationState', current_registration.state,
        'registrationRevision', current_registration.revision,
        'accessVersion', authority.access_version
      );
    end if;
    coordinated_operation := 'withdraw';
    expected_revision := current_registration.revision;
  elsif not registration_found then
    coordinated_operation := 'register';
    expected_revision := null;
  elsif current_registration.state = 'withdrawn' then
    coordinated_operation := 'reactivate';
    expected_revision := current_registration.revision;
  else
    coordinated_operation := 'update';
    expected_revision := current_registration.revision;
  end if;

  -- The coordinator validates the prepared candidate against the stored
  -- Application and Module releases and this organisation, applies continuity
  -- narrowing, never assigns a role, and asserts the permanent-steward
  -- invariant before it returns.
  select result.* into strict changed
  from vortex_access.coordinate_application_access_change(
    coordinated_operation,
    expected_revision,
    p_prepared_templates,
    authority.organization_id,
    p_application_root_id,
    authority.organization_account_id,
    authority.correlation_id
  ) as result;

  if changed.organization_id <> authority.organization_id
    or changed.application_root_id <> p_application_root_id
    or changed.correlation_id <> authority.correlation_id then
    raise exception using errcode = '55000',
      message = 'Application installation access result is inconsistent';
  end if;

  if changed.outcome = 'changed' then
    if p_change = 'withdraw' then
      -- Withdrawal ends every assignment of this application's roles. Keeping a
      -- live assignment would restore its access when a reinstall accepts the
      -- role again. Use the one assignment writer, retaining its revision and
      -- revocation history inside this same installation transaction.
      for assignment_to_revoke in
        select assignment.role_assignment_id, assignment.revision
        from vortex_access.organization_role_assignments as assignment
        join vortex_access.organization_roles as role
          on role.organization_id = assignment.organization_id
          and role.role_id = assignment.role_id
        where assignment.organization_id = authority.organization_id
          and role.application_root_id = p_application_root_id
          and role.role_kind = 'application'
          and assignment.state = 'live'
        order by assignment.role_assignment_id
        for update of assignment
      loop
        perform vortex_access.coordinate_organization_role_assignment_change(
          'revoke', authority.organization_id,
          assignment_to_revoke.role_assignment_id, assignment_to_revoke.revision,
          null, null, null, null, null, null, null,
          authority.organization_account_id, authority.correlation_id
        );
      end loop;
    end if;

    append_result := vortex_record.append_organization_activity_entry(
      authority.organization_id,
      p_activity_id,
      pg_catalog.statement_timestamp(),
      'organization_account',
      authority.organization_account_id,
      coordinated_operation || '_application_access',
      array[p_application_root_id]::uuid[],
      array[]::uuid[],
      vortex_platform.channel(),
      authority.correlation_id,
      'completed'
    );
    if append_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Application installation access Activity is stale';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', changed.outcome,
    'operation', changed.operation,
    'organizationId', changed.organization_id,
    'applicationRootId', changed.application_root_id,
    'registrationState', changed.registration_state,
    'registrationRevision', changed.registration_revision,
    'accessVersion', changed.access_version
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation access evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation access evidence is ambiguous';
end
$function$;

revoke all on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) to vortex_request;

comment on function vortex_access.change_application_installation_access(
  uuid, uuid, text, jsonb
) is
  'Authority-checked Application permission registration change for installation; derives actor and correlation from validated human context and grants no access.';

alter function vortex_access.change_application_installation_access(p_activity_id uuid, p_application_root_id uuid, p_change text, p_prepared_templates jsonb) owner to vortex_owner;

grant execute on function vortex_access.change_application_installation_access(p_activity_id uuid, p_application_root_id uuid, p_change text, p_prepared_templates jsonb) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  current_registration vortex_access.permission_registrations%rowtype;
  raw_result record;
  first_observation boolean := false;
  permission_candidate jsonb;
  template_value jsonb;
  template_role_id uuid;
  role_record record;
  target_template jsonb;
  current_permission_count bigint;
  retained_permission_count bigint;
  unchanged_permission_count bigint;
  target_permission_count bigint;
  target_lifecycle text;
  next_role_revision bigint;
  next_authority_continuity_revision bigint;
  target_template_continuity_revision bigint;
begin
  if p_operation is null
    or p_operation not in ('register', 'update', 'reactivate', 'withdraw')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'register' and p_expected_revision is not null)
    or (
      p_operation <> 'register'
      and (
        p_expected_revision is null
        or p_expected_revision not between 1 and 9007199254740991
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
  end if;

  if p_operation = 'withdraw' then
    if p_prepared_templates is not null then
      raise exception using errcode = '22023',
        message = 'Coordinated application access input is invalid';
    end if;
  else
    if p_prepared_templates is null
      or pg_catalog.jsonb_typeof(p_prepared_templates) is distinct from 'object'
      or p_prepared_templates - array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ]::text[] <> '{}'::jsonb
      or not (p_prepared_templates ?& array[
        'contractVersion', 'preparationBasis', 'permissionRegistration',
        'templates'
      ])
      or p_prepared_templates ->> 'contractVersion' is distinct from '1.0.0'
      or p_prepared_templates -> 'preparationBasis' is distinct from
        '{"kind":"registration_candidate"}'::jsonb
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'permissionRegistration')
        is distinct from 'object'
      or p_prepared_templates #>> '{permissionRegistration,contractVersion}'
        is distinct from '1.0.0'
      or pg_catalog.jsonb_typeof(p_prepared_templates -> 'templates')
        is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_prepared_templates -> 'templates') = 0
      or (p_prepared_templates #>> '{permissionRegistration,organizationId}')::uuid
        is distinct from
        p_organization_id
      or (p_prepared_templates #>> '{permissionRegistration,applicationRootId}')::uuid
        is distinct from
        p_application_root_id then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;

    permission_candidate := p_prepared_templates -> 'permissionRegistration';
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or item.value - array['template', 'sourcePermissions', 'livePermissions']::text[]
          <> '{}'::jsonb
        or not (item.value ?& array['template', 'sourcePermissions', 'livePermissions'])
        or pg_catalog.jsonb_typeof(item.value -> 'template') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'sourcePermissions') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'livePermissions') is distinct from 'array'
        or item.value #>> '{template,roleId}' is null
        or (item.value #>> '{template,roleId}')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      group by item.value #>> '{template,roleId}'
      having pg_catalog.count(*) <> 1
    ) or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        item.value -> 'livePermissions'
      ) as live(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(permission_candidate -> 'entries') as entry(value)
        where entry.value = live.value
      )
    ) then
      raise exception using errcode = '22023',
        message = 'Coordinated application access preparation is invalid';
    end if;
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
      message = 'Coordinated application access scope is unavailable';
  end if;

  select registration.* into current_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
  for update;

  if p_operation = 'register' then
    if found then
      raise exception using errcode = '40001',
        message = 'Application permission registration already exists';
    end if;
  elsif not found
    or current_registration.revision <> p_expected_revision
    or (p_operation in ('update', 'withdraw') and current_registration.state <> 'active')
    or (p_operation = 'reactivate' and current_registration.state <> 'withdrawn') then
    raise exception using errcode = '40001',
      message = 'Application permission registration revision is stale or unavailable';
  end if;

  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.application_scope_id, continuity.owner_kind collate "C",
    continuity.owner_id, continuity.permission_id
  for update;

  perform 1
  from vortex_access.application_role_template_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.application_root_id = p_application_root_id
  order by continuity.source_role_id
  for update;

  perform 1
  from vortex_access.organization_roles as role
  where role.organization_id = p_organization_id
    and role.role_kind = 'application'
    and role.application_root_id = p_application_root_id
  order by role.role_id
  for update;

  if p_operation <> 'register' then
    first_observation :=
      not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.application_role_template_continuities as continuity
        where continuity.organization_id = p_organization_id
          and continuity.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_roles as role
        where role.organization_id = p_organization_id
          and role.role_kind = 'application'
          and role.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_revisions as revision
        where revision.organization_id = p_organization_id
          and revision.role_kind = 'application'
          and revision.application_root_id = p_application_root_id
      )
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = p_organization_id
          and permission.application_root_id = p_application_root_id
      );

    if p_operation = 'update'
      and vortex_access.application_permission_registration_matches_candidate(
        p_organization_id, p_application_root_id, current_registration.revision,
        permission_candidate
      )
      and not first_observation then
      if not vortex_access.application_access_current_state_matches_candidate(
          p_organization_id, p_application_root_id, current_registration.revision,
          p_prepared_templates
      ) then
        raise exception using errcode = '55000',
          message = 'Coordinated application access state is incomplete';
      end if;

      return query
      select 'unchanged'::text, p_operation, p_organization_id, p_application_root_id,
        current_registration.state, current_registration.revision,
        version.current_version, p_correlation_id
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id;
      return;
    end if;

    if current_registration.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Application permission registration revision is exhausted';
    end if;
  end if;

  -- The organization version row is already locked. Check before invoking the
  -- registration helper, whose input-error handler also catches numeric overflow.
  -- A complete exact no-op returned above does not need a new Access version.
  if exists (
    select 1 from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id
      and version.current_version >= 9007199254740991
  ) then
    raise exception using errcode = '22003',
      message = 'Organization Access version is exhausted';
  end if;

  if first_observation then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      case when current_registration.state = 'active' then 'available' else 'unavailable' end,
      1, current_registration.revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = current_registration.revision;
  end if;

  if not first_observation
    and current_registration.state = 'active'
    and not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
    ) then
    raise exception using errcode = '55000',
      message = 'Coordinated application access state is incomplete';
  end if;

  if p_operation = 'withdraw' then
    select changed.* into strict raw_result
    from vortex_access.withdraw_application_permission_registration_internal(
      p_organization_id, p_application_root_id, p_expected_revision,
      p_changed_by, p_correlation_id
    ) as changed;
  else
    select changed.* into strict raw_result
    from vortex_access.apply_application_permission_registration_internal(
      p_operation, p_expected_revision, permission_candidate,
      p_changed_by, p_correlation_id
    ) as changed;
  end if;

  -- A still-available permission retains continuity only while its protected
  -- authority-bearing fields match the previous registration exactly.
  if exists (
    select 1 from vortex_access.permission_continuities as continuity
    join vortex_access.permission_catalogue_entries as target
      on target.organization_id = continuity.organization_id
      and target.registration_kind = continuity.registration_kind
      and target.registration_owner_id = continuity.registration_owner_id
      and target.registration_revision = raw_result.registration_revision
      and target.application_root_id is not distinct from continuity.application_root_id
      and target.owner_kind = continuity.owner_kind
      and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    left join vortex_access.permission_catalogue_entries as previous
      on previous.organization_id = continuity.organization_id
      and previous.registration_kind = continuity.registration_kind
      and previous.registration_owner_id = continuity.registration_owner_id
      and previous.registration_revision = continuity.last_processed_registration_revision
      and previous.application_root_id is not distinct from continuity.application_root_id
      and previous.owner_kind = continuity.owner_kind
      and previous.owner_id = continuity.owner_id
      and previous.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.state = 'available'
      and raw_result.registration_state = 'active'
      and previous.permission_id is null
  ) then
    raise exception using errcode = '55000',
      message = 'Previous permission meaning is unavailable';
  end if;

  if exists (
    with target as (
      select entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry as target_entry
      from vortex_access.permission_catalogue_entries as entry
      where raw_result.registration_state = 'active'
        and entry.organization_id = p_organization_id
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = p_application_root_id
        and entry.registration_revision = raw_result.registration_revision
    )
    select 1 from vortex_access.permission_continuities as continuity
    left join target on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    left join vortex_access.permission_catalogue_entries as previous
      on previous.organization_id = continuity.organization_id
      and previous.registration_kind = continuity.registration_kind
      and previous.registration_owner_id = continuity.registration_owner_id
      and previous.registration_revision = continuity.last_processed_registration_revision
      and previous.application_root_id is not distinct from continuity.application_root_id
      and previous.owner_kind = continuity.owner_kind and previous.owner_id = continuity.owner_id
      and previous.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.permission_id is null and continuity.state <> 'unavailable')
        or (target.permission_id is not null and continuity.state <> 'available')
        or (target.permission_id is not null and continuity.state = 'available'
          and not vortex_access.permission_meaning_is_same_internal(previous, target.target_entry))
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application permission continuity revision is exhausted';
  end if;

  with target as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry as target_entry
    from vortex_access.permission_catalogue_entries as entry
    where raw_result.registration_state = 'active'
      and entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
  ), transition as (
    select continuity.ctid as continuity_row, target.permission_id as target_permission_id,
      vortex_access.permission_meaning_is_same_internal(previous, target.target_entry) as same_meaning
    from vortex_access.permission_continuities as continuity
    left join target on target.application_root_id = continuity.application_root_id
      and target.owner_kind = continuity.owner_kind and target.owner_id = continuity.owner_id
      and target.permission_id = continuity.permission_id
    left join vortex_access.permission_catalogue_entries as previous
      on previous.organization_id = continuity.organization_id
      and previous.registration_kind = continuity.registration_kind
      and previous.registration_owner_id = continuity.registration_owner_id
      and previous.registration_revision = continuity.last_processed_registration_revision
      and previous.application_root_id is not distinct from continuity.application_root_id
      and previous.owner_kind = continuity.owner_kind and previous.owner_id = continuity.owner_id
      and previous.permission_id = continuity.permission_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.permission_continuities as continuity
  set state = case when transition.target_permission_id is null then 'unavailable'
        else 'available' end,
      continuity_revision = case
        when transition.target_permission_id is not null and continuity.state = 'available'
          and transition.same_meaning then continuity.continuity_revision
        when transition.target_permission_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, entry.application_root_id, entry.owner_kind,
      entry.owner_id, entry.permission_id, 'application', p_application_root_id,
      'available', 1, raw_result.registration_revision,
      pg_catalog.statement_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = p_application_root_id
      and entry.registration_revision = raw_result.registration_revision
      and not exists (
        select 1
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id = entry.organization_id
          and continuity.application_root_id = entry.application_root_id
          and continuity.owner_kind = entry.owner_kind
          and continuity.owner_id = entry.owner_id
          and continuity.permission_id = entry.permission_id
      );
  end if;

  if exists (
    with target as (
      select (item.value #>> '{template,roleId}')::uuid as source_role_id
      from pg_catalog.jsonb_array_elements(
        case when raw_result.registration_state = 'active'
          then p_prepared_templates -> 'templates'
          else '[]'::jsonb
        end
      ) as item(value)
    )
    select 1
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.continuity_revision = 9007199254740991
      and (
        (target.source_role_id is null and continuity.state <> 'unavailable')
        or (
          target.source_role_id is not null
          and continuity.state <> 'available'
        )
      )
  ) then
    raise exception using errcode = '22003',
      message = 'Application role template continuity revision is exhausted';
  end if;

  with target as (
    select (item.value #>> '{template,roleId}')::uuid as source_role_id,
      item.value #>> '{template,key}' as role_key,
      item.value #>> '{template,name}' as role_label
    from pg_catalog.jsonb_array_elements(
      case when raw_result.registration_state = 'active'
        then p_prepared_templates -> 'templates'
        else '[]'::jsonb
      end
    ) as item(value)
  ), transition as (
    select continuity.ctid as continuity_row, target.source_role_id as target_role_id,
      target.role_key, target.role_label
    from vortex_access.application_role_template_continuities as continuity
    left join target on target.source_role_id = continuity.source_role_id
    where continuity.organization_id = p_organization_id
      and continuity.application_root_id = p_application_root_id
  )
  update vortex_access.application_role_template_continuities as continuity
  set state = case when transition.target_role_id is null
        then 'unavailable' else 'available' end,
      key = coalesce(transition.role_key, continuity.key),
      label = coalesce(transition.role_label, continuity.label),
      continuity_revision = case
        when transition.target_role_id is not null and continuity.state = 'available'
          then continuity.continuity_revision
        when transition.target_role_id is null and continuity.state = 'unavailable'
          then continuity.continuity_revision
        else continuity.continuity_revision + 1
      end,
      last_processed_registration_revision = raw_result.registration_revision,
      changed_at = pg_catalog.statement_timestamp()
  from transition
  where continuity.ctid = transition.continuity_row;

  if raw_result.registration_state = 'active' then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, last_processed_registration_revision, changed_at,
      key, label
    )
    select p_organization_id, p_application_root_id,
      (item.value #>> '{template,roleId}')::uuid, 'available', 1,
      raw_result.registration_revision, pg_catalog.statement_timestamp(),
      item.value #>> '{template,key}', item.value #>> '{template,name}'
    from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates') as item(value)
    where not exists (
      select 1
      from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id = (item.value #>> '{template,roleId}')::uuid
    );
  end if;

  for role_record in
    select role.role_id, role.source_role_id, role.live_revision,
      revision.lifecycle, revision.privilege_classification,
      revision.policy_continuity_revision,
      revision.authority_continuity_revision,
      revision.role_key,
      revision.label, revision.description, revision.source_definition_key,
      revision.source_release_revision, revision.source_release_version,
      revision.source_validation_contract_version,
      revision.accepted_registration_revision,
      revision.template_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.role_id
  loop
    if role_record.lifecycle = 'retired' then
      continue;
    end if;

    target_template := null;
    target_template_continuity_revision := null;
    if raw_result.registration_state = 'active' then
      select item.value, continuity.continuity_revision
      into target_template, target_template_continuity_revision
      from pg_catalog.jsonb_array_elements(p_prepared_templates -> 'templates')
        as item(value)
      join vortex_access.application_role_template_continuities as continuity
        on continuity.organization_id = p_organization_id
        and continuity.application_root_id = p_application_root_id
        and continuity.source_role_id =
          (item.value #>> '{template,roleId}')::uuid
        and continuity.state = 'available'
      where (item.value #>> '{template,roleId}')::uuid = role_record.source_role_id;
    end if;

    select pg_catalog.count(*) into current_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = p_organization_id
      and permission.role_id = role_record.role_id
      and permission.role_revision = role_record.live_revision;

    if target_template is null then
      retained_permission_count := 0;
      target_permission_count := 0;
      target_lifecycle := 'unavailable';
    else
      -- A role keeps every permission the template still grants, with the
      -- meaning it was accepted under: a changed meaning is neither applied
      -- nor dropped until the role revision is accepted. A permission the
      -- template no longer grants, or that is no longer registered, leaves.
      select pg_catalog.count(*) into retained_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      select pg_catalog.count(*) into unchanged_permission_count
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
      target_permission_count := pg_catalog.jsonb_array_length(
        target_template -> 'livePermissions'
      );
      -- ACCEPTANCE INVARIANT: a role stays active only when it holds every
      -- permission of the template with exactly its registered meaning. Any
      -- meaning change, added or removed permission requires acceptance. The
      -- release version class (patch, minor or major) is never consulted.
      if role_record.lifecycle = 'active'
        and unchanged_permission_count > 0
        and unchanged_permission_count = target_permission_count
        and retained_permission_count = target_permission_count
        and role_record.template_continuity_revision =
          target_template_continuity_revision then
        target_lifecycle := 'active';
      else
        target_lifecycle := 'acceptance_required';
      end if;
    end if;

    if role_record.lifecycle = target_lifecycle
      and current_permission_count = retained_permission_count then
      continue;
    end if;

    if role_record.live_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role revision is exhausted';
    end if;
    next_role_revision := role_record.live_revision + 1;
    next_authority_continuity_revision :=
      role_record.authority_continuity_revision;
    if role_record.lifecycle in ('unavailable', 'retired')
      and target_lifecycle in ('active', 'acceptance_required') then
      if role_record.authority_continuity_revision = 9007199254740991 then
        raise exception using errcode = '22003',
          message = 'Organization role authority continuity is exhausted';
      end if;
      next_authority_continuity_revision :=
        role_record.authority_continuity_revision + 1;
    end if;

    if target_template is not null then
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        role_application_root_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id,
        accepted_registration_revision, catalogue_fingerprint,
        continuity_revision
      )
      select permission.organization_id, permission.role_id, next_role_revision,
        pg_catalog.row_number() over (
          order by permission.application_root_id, permission.owner_kind collate "C",
            permission.owner_id, permission.permission_id
        ), permission.role_kind, permission.role_application_root_id,
        permission.application_root_id, permission.owner_kind,
        permission.owner_id, permission.permission_id,
        permission.registration_kind, permission.registration_owner_id,
        permission.accepted_registration_revision,
        permission.catalogue_fingerprint, permission.continuity_revision
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_continuities as continuity
        on continuity.organization_id = permission.organization_id
        and continuity.application_root_id = permission.application_root_id
        and continuity.owner_kind = permission.owner_kind
        and continuity.owner_id = permission.owner_id
        and continuity.permission_id = permission.permission_id
        and continuity.state = 'available'
        and continuity.continuity_revision = permission.continuity_revision
      where permission.organization_id = p_organization_id
        and permission.role_id = role_record.role_id
        and permission.role_revision = role_record.live_revision
        and exists (
          select 1
          from pg_catalog.jsonb_array_elements(
            target_template -> 'livePermissions'
          ) as candidate(value)
          where (candidate.value ->> 'applicationRootId')::uuid =
              permission.application_root_id
            and candidate.value ->> 'ownerKind' = permission.owner_kind
            and (candidate.value ->> 'ownerId')::uuid = permission.owner_id
            and (candidate.value #>> '{permission,permissionId}')::uuid =
              permission.permission_id
        );
    end if;

    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification,
      policy_continuity_revision, authority_continuity_revision,
      role_key,
      label, description, source_definition_key, source_release_revision,
      source_release_version, source_validation_contract_version, accepted_registration_revision,
      template_continuity_revision,
      changed_by, changed_at, change_correlation_id
    ) values (
      p_organization_id, role_record.role_id, next_role_revision, 'application',
      p_application_root_id, target_lifecycle,
      role_record.privilege_classification,
      role_record.policy_continuity_revision,
      next_authority_continuity_revision,
      role_record.role_key,
      role_record.label, role_record.description,
      role_record.source_definition_key, role_record.source_release_revision,
      role_record.source_release_version,
      role_record.source_validation_contract_version,
      role_record.accepted_registration_revision,
      role_record.template_continuity_revision,
      p_changed_by,
      pg_catalog.statement_timestamp(), p_correlation_id
    );

    update vortex_access.organization_roles as role
    set live_revision = next_role_revision
    where role.organization_id = p_organization_id
      and role.role_id = role_record.role_id
      and role.live_revision = role_record.live_revision;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role revision is stale';
    end if;
  end loop;

  return query select 'changed'::text, raw_result.operation,
    raw_result.organization_id, raw_result.application_root_id,
    raw_result.registration_state, raw_result.registration_revision,
    raw_result.access_version, raw_result.correlation_id;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023',
      message = 'Coordinated application access input is invalid';
end
$_$;

COMMENT ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Internal application-access implementation retained only behind the stewardship safeguard.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

alter function vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

grant execute on function vortex_access.coordinate_application_access_without_stewardship_internal(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, role_assignment_id uuid, role_id uuid, assignee_kind text, organization_account_id uuid, group_id uuid, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  next_access_version bigint;
  operation_at timestamptz;
  role_fact record;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
begin
  if p_operation is null
    or p_operation not in ('grant', 'revoke')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment change input is invalid';
  end if;

  if p_operation = 'grant' then
    if p_expected_assignment_revision is not null
      or p_role_id is null
      or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_role_revision is null
      or p_expected_role_revision not between 1 and 9007199254740991
      or p_assignee_kind is null
      or p_assignee_kind not in ('organization_account', 'group')
      or p_starts_at is null
      or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (p_expires_at is not null and p_expires_at <= p_starts_at)
      or (
        p_assignee_kind = 'organization_account'
        and (
          p_organization_account_id is null
          or p_organization_account_id =
            '00000000-0000-0000-0000-000000000000'::uuid
          or p_group_id is not null
        )
      )
      or (
        p_assignee_kind = 'group'
        and (
          p_group_id is null
          or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_organization_account_id is not null
        )
      ) then
      raise exception using errcode = '22023',
        message = 'Organization role-assignment grant input is invalid';
    end if;
  elsif p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_role_id is not null
    or p_expected_role_revision is not null
    or p_assignee_kind is not null
    or p_organization_account_id is not null
    or p_group_id is not null
    or p_starts_at is not null
    or p_expires_at is not null then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
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
      message = 'Organization role-assignment change scope is unavailable';
  end if;

  if p_operation = 'grant' then
    select role.live_revision, role_revision.lifecycle
    into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_id = p_role_id
    for update of role;

    if not found
      or role_fact.live_revision <> p_expected_role_revision
      or role_fact.lifecycle <> 'active' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant evidence is stale or unavailable';
    end if;

    if p_assignee_kind = 'organization_account' then
      perform 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = p_organization_account_id
        and account.state = 'active'
      for update;
    else
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
        and organization_group.state = 'active'
      for update;
    end if;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant evidence is stale or unavailable';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    if p_expires_at is not null and p_expires_at <= operation_at then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment grant window is no longer current';
    end if;

    insert into vortex_access.organization_role_assignments (
      organization_id, role_assignment_id, role_id, assignee_kind,
      organization_account_id, group_id, revision, starts_at,
      expires_at, state, granted_by, granted_at, grant_correlation_id,
      changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_role_assignment_id, p_role_id, p_assignee_kind,
      p_organization_account_id, p_group_id, 1, p_starts_at,
      p_expires_at, 'live', p_changed_by, operation_at, p_correlation_id,
      p_changed_by, operation_at, p_correlation_id, null, null, null
    );
  else
    select assignment.* into assignment_fact
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
    for update;

    if not found
      or assignment_fact.revision <> p_expected_assignment_revision
      or assignment_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation is stale or unavailable';
    end if;
    if assignment_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization role-assignment revision is exhausted';
    end if;

    operation_at := greatest(
      assignment_fact.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_role_assignments as assignment
    set revision = assignment_fact.revision + 1,
      state = 'revoked',
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = p_changed_by,
      revoked_at = operation_at,
      revocation_correlation_id = p_correlation_id
    where assignment.organization_id = p_organization_id
      and assignment.role_assignment_id = p_role_assignment_id
      and assignment.revision = p_expected_assignment_revision
      and assignment.state = 'live';
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation is stale or unavailable';
    end if;
  end if;

  select version.current_version into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'role_assignment_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation, assignment.organization_id,
    assignment.role_assignment_id, assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state, assignment.granted_by,
    assignment.granted_at, assignment.grant_correlation_id,
    assignment.changed_by, assignment.changed_at,
    assignment.change_correlation_id, assignment.revoked_by,
    assignment.revoked_at, assignment.revocation_correlation_id,
    next_access_version, p_correlation_id
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;
end
$$;

alter function vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) IS 'Private atomic role-assignment fact and Access change used by the stewardship-preserving public composition.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_assignment_change_without_stewardship_internal(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, role_assignment_id uuid, role_id uuid, assignee_kind text, organization_account_id uuid, group_id uuid, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_assignment_change_without_stewardship_internal(
      p_operation, p_organization_id, p_role_assignment_id,
      p_expected_assignment_revision, p_role_id, p_expected_role_revision,
      p_assignee_kind, p_organization_account_id, p_group_id,
      p_starts_at, p_expires_at, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.role_assignment_id, changed.role_id,
    changed.assignee_kind, changed.organization_account_id, changed.group_id,
    changed.revision, changed.starts_at,
    changed.expires_at, changed.state, changed.granted_by_actor_id,
    changed.granted_at, changed.grant_correlation_id,
    changed.changed_by_actor_id, changed.changed_at,
    changed.change_correlation_id, changed.revoked_by_actor_id,
    changed.revoked_at, changed.revocation_correlation_id,
    changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, role jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_role_change_without_stewardship_internal(
      p_evidence, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.role ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation, changed.role,
    changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) to postgres;

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
    continuity_revision
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
    continuity.continuity_revision
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
    lifecycle, privilege_classification,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', null, 'active', 'privileged',
    1, 1, p_role_key, p_role_label,
    p_role_description, null, null, null, null, null, null,
    p_changed_by, checked_at, p_correlation_id
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_role_assignment_id, p_role_id,
    'organization_account', p_organization_account_id, null, 1,
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

alter function vortex_access.coordinate_organization_stewardship_adoption(uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid) owner to vortex_owner;

create or replace function vortex_access.coordinate_private_organization_role_authority_change(
  p_prepared_evidence jsonb,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  role jsonb,
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
    'accept_new_application_role', 'revise_custom_permissions',
    'accept_application_role_revision'
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
  -- role settings. Compare them under the same Access lock as the write. Changing settings uses
  -- role management.
  if operation_name = 'accept_application_role_revision' and (
    candidate -> 'key' is distinct from pg_catalog.to_jsonb(current_revision.role_key)
    or candidate -> 'label' is distinct from pg_catalog.to_jsonb(current_revision.label)
    or candidate -> 'description' is distinct from pg_catalog.to_jsonb(current_revision.description)
    or candidate -> 'privilegeClassification' is distinct from
      pg_catalog.to_jsonb(current_revision.privilege_classification)
  ) then
    raise exception using errcode = 'V3151',
      message = 'Accepting application role changes must keep the role settings. Use Manage roles to change its name, description or classification.';
  end if;

  authority_after := vortex_access.private_management_scope_from_permission(
    candidate -> 'permissions'
  );

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
      'recentAuthentication', pg_catalog.jsonb_build_object(
        'kind', 'multi_factor', 'maximumAgeSeconds', 3600
      ),
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

  if decision.outcome = 'refused' and decision.reason_code = 'multi_factor_unsatisfied' then
    raise exception using errcode = 'V3152',
      message = 'Organization role-authority change requires multi-factor authentication';
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
    changed.access_version, changed.correlation_id;
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
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
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
  manifest jsonb;
  canonical_assignments jsonb;
  manifest_required boolean := false;
  authority_broadened boolean := false;
  permissions_changed boolean := false;
  configured_state_changed boolean := false;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  operation_at timestamptz;
  next_access_version bigint;
  role_result jsonb;
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
      'privilegeClassification'
    ])
      or pg_catalog.jsonb_typeof(candidate -> 'key') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'label') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'description') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate -> 'privilegeClassification')
        is distinct from 'string'
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
      'privilegeClassification', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom role shape is invalid';
    end if;
  elsif operation_name in ('create_custom_from_template', 'accept_new_application_role') then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'key', 'label', 'description',
      'privilegeClassification', 'templateSource',
      'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'New template role shape is invalid';
    end if;
  elsif operation_name = 'revise_metadata_policy' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Role metadata shape is invalid';
    end if;
  elsif operation_name = 'revise_custom_permissions' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification',
      'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Custom permission shape is invalid';
    end if;
  elsif operation_name = 'accept_application_role_revision' then
    if candidate - array[
      'operation', 'organizationId', 'roleId', 'expectedRoleRevision', 'key',
      'label', 'description', 'privilegeClassification',
      'templateSource', 'sourceRoleId', 'templateContinuityRevision', 'permissions'
    ]::text[] <> '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Application acceptance shape is invalid';
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
          'continuityRevision'
        ]::text[] <> '{}'::jsonb
        or not (item.value ?& array[
          'kind', 'ownerKind', 'ownerId', 'permissionId',
          'acceptedRegistrationRevision', 'catalogueFingerprint',
          'continuityRevision'
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
        or item.value ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
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
          (item.value ->> 'continuityRevision')::numeric::bigint
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
      'applicationRootId', 'registrationRevision', 'releaseRevision', 'catalogueFingerprint'
    ]::text[] <> '{}'::jsonb
      or not (template_source ?& array[
        'applicationRootId', 'registrationRevision', 'releaseRevision', 'catalogueFingerprint'
      ])
      or pg_catalog.jsonb_typeof(template_source -> 'applicationRootId') <> 'string'
      or vortex_platform.is_non_nil_uuid(template_source ->> 'applicationRootId') is not true
      or pg_catalog.jsonb_typeof(template_source -> 'registrationRevision') <> 'number'
      or (template_source ->> 'registrationRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'registrationRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'registrationRevision')::numeric)
      or pg_catalog.jsonb_typeof(template_source -> 'releaseRevision') <> 'number'
      or (template_source ->> 'releaseRevision')::numeric not between 1 and 9007199254740991
      or (template_source ->> 'releaseRevision')::numeric <>
        pg_catalog.trunc((template_source ->> 'releaseRevision')::numeric)
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
      and registration.source_revision = (template_source ->> 'releaseRevision')::bigint
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
      and continuity.last_processed_registration_revision = registration.revision;
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
    if operation_name = 'retire_role' then
      target_role_key := current_revision.role_key;
      target_label := current_revision.label;
      target_description := current_revision.description;
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

  -- A role's policy continuity is fixed: no role setting advances it.
  if current_revision.organization_id is not null then
    target_policy_continuity_revision := current_revision.policy_continuity_revision;
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
          'continuityRevision', permission.continuity_revision
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
      )
    ) into authority_broadened;

    manifest_required :=
      (
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
      continuity_revision
    )
    select permission.organization_id, permission.role_id, target_role_revision,
      permission.entry_ordinal, permission.role_kind,
      permission.role_application_root_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.registration_kind, permission.registration_owner_id,
      permission.accepted_registration_revision, permission.catalogue_fingerprint,
      permission.continuity_revision
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
      continuity_revision
    )
    select target_organization_id, target_role_id, target_role_revision,
      item.ordinality, target_role_kind,
      case when target_role_kind = 'application' then target_application_root_id else null end,
      continuity.application_root_id, continuity.owner_kind,
      continuity.owner_id, continuity.permission_id,
      continuity.registration_kind, continuity.registration_owner_id,
      (item.value ->> 'acceptedRegistrationRevision')::numeric::bigint,
      item.value ->> 'catalogueFingerprint',
      (item.value ->> 'continuityRevision')::numeric::bigint
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

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    target_organization_id, target_role_id, target_role_revision,
    target_role_kind, target_application_root_id, target_lifecycle,
    target_privilege_classification,
    target_policy_continuity_revision, target_authority_continuity_revision,
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
          'continuityRevision', permission.continuity_revision
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

  return query select 'changed'::text, operation_name, role_result,
    next_access_version, p_correlation_id;
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

CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
  role_item record; role_intents jsonb := '[]'::jsonb;
  locked_version bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_role_ids is null or pg_catalog.cardinality(p_role_ids) = 0
    or exists (select 1 from pg_catalog.unnest(p_role_ids) as id where id is null or not vortex_platform.is_non_nil_uuid(id::text))
    or pg_catalog.cardinality(p_role_ids) <> (select pg_catalog.count(distinct id) from pg_catalog.unnest(p_role_ids) as id) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[]);
    if pg_catalog.cardinality(stored."subjectIds") is distinct from 2
      or pg_catalog.cardinality(stored."subjectRevisions") is distinct from 2
      or pg_catalog.array_position(stored."subjectIds", null) is not null
      or stored."subjectIds"[1] = stored."subjectIds"[2]
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select version.current_version into locked_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id for update;
  if locked_version is distinct from scope.access_version then
    raise exception using errcode = '40001', message = 'Invitation authority is stale';
  end if;
  for role_item in
    select role.role_id, role.live_revision, revision.lifecycle
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = scope.organization_id and role.role_id = any(p_role_ids)
    order by role.role_id for update of role
  loop
    if role_item.lifecycle <> 'active'
      or not vortex_access.check_organization_invitation_role_authority_internal(
        scope.organization_id, scope.organization_account_id, role_item.role_id, operation_at
      ) then
      raise exception using errcode = 'V3145', message = 'You cannot give this role';
    end if;
    role_intents := role_intents || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'roleId', role_item.role_id, 'roleRevision', role_item.live_revision
    ));
  end loop;
  if pg_catalog.jsonb_array_length(role_intents) <> pg_catalog.cardinality(p_role_ids) then
    raise exception using errcode = 'V3145', message = 'You cannot give this role';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_expires_at, role_intents
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions)));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) IS 'Protected role-intent invitation creation; replay returns receipt evidence. The invited person accepts it after signing in with that verified email.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) TO vortex_request;

grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone, p_role_ids uuid[]) to postgres;

create or replace function vortex_access.delegable_invitation_role_ids(p_role_ids uuid[])
returns uuid[]
language plpgsql stable security definer set search_path = ''
as $function$
declare
  scope record;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_role_ids is null or pg_catalog.cardinality(p_role_ids) > 200 then
    raise exception using errcode = '22023', message = 'Delegable role request is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  return coalesce((
    select pg_catalog.array_agg(role.role_id order by role.role_id)
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = scope.organization_id and role.role_id = any(p_role_ids)
      and revision.lifecycle = 'active'
      and vortex_access.check_organization_invitation_role_authority_internal(
        scope.organization_id, scope.organization_account_id, role.role_id, checked_at)
  ), '{}'::uuid[]);
end
$function$;

alter function vortex_access.delegable_invitation_role_ids(uuid[]) owner to vortex_owner;
revoke all on function vortex_access.delegable_invitation_role_ids(uuid[]) from public, anon, authenticated, service_role;
grant execute on function vortex_access.delegable_invitation_role_ids(uuid[]) to vortex_request, postgres;

create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
  preview_registration record;
  preview_projection boolean := false;
  projection_live_registration boolean := false;
begin
  -- A preview request decides the permissions of the previewed Application and its own Modules
  -- from the preview's registration alone: the builder who opened the preview holds the draft's
  -- roles there. Every other permission, a used Module's included, and every permission on a
  -- system projection, the platform's live read model, is decided by the builder's own live
  -- access below; the preview's roles never apply to it.
  if permission_owner_kind_value in ('application', 'module')
    and nullif(
      pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
    ) is not null then
    select registration.* into preview_registration
    from vortex_access.request_application_registration_internal(
      context_organization_value,
      (p_context ->> 'applicationRootId')::uuid,
      context_account_value
    ) as registration;
    if preview_registration.registration_kind is distinct from 'preview' then
      return;
    end if;
    preview_projection := coalesce(
      p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
    );
    if permission_owner_value = any(preview_registration.owned_owner_ids)
      and not coalesce(
        p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
      ) then
      return query
      select preview_entry.entry,
        case when preview_entry.held
          then least(context_expires_value, preview_registration.valid_until)
        end
      from vortex_access.preview_permission_entries as preview_entry
      where preview_entry.preview_installation_id = preview_registration.preview_installation_id
        and (preview_entry.entry).application_root_id is not distinct from
          permission_application_value
        and (preview_entry.entry).owner_kind = permission_owner_kind_value
        and (preview_entry.entry).owner_id = permission_owner_value
        and (preview_entry.entry).permission_id = permission_value
        and (preview_entry.entry).record_type_id is not distinct from p_record_type_id
        and (preview_entry.entry).action_kind = action_kind_value
        and (preview_entry.entry).named_action is not distinct from named_action_value;
      return;
    end if;
  end if;

  -- A projection has no preview copy or draft grant. A Module's permission is registered by every
  -- installed Application that links that Module, each under its own Application root, and none of
  -- those is the address of the previewed Application: a projection of a used Module selects its
  -- permission from the caller's live registrations rather than from the address it was asked
  -- about. The common live role-path decision below still proves a current grant, and ordinary
  -- borrowed record types keep their existing refusal.
  if preview_projection and permission_owner_kind_value = 'module' then
    projection_live_registration := true;
  end if;

  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.registration_kind, catalogue.registration_owner_id,
      catalogue.registration_revision, continuity.continuity_revision,
      catalogue as permission_entry,
      catalogue.record_type_id is not distinct from p_record_type_id
        and catalogue.action_kind = action_kind_value
        and catalogue.named_action is not distinct from named_action_value
        as matches_request
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_scope_id = coalesce(catalogue.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and (
        projection_live_registration
        or catalogue.application_root_id is not distinct from
          permission_application_value
      )
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
  ), current_role_permission as materialized (
    -- The accepted registration remains historical evidence. A changed meaning
    -- advances continuity, so a role cannot retain it without fresh acceptance.
    select role.role_id, role.live_revision,
      accepted as accepted_entry,
      accepted.registration_revision as accepted_registration_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.registration_kind = permission.registration_kind
      and available.registration_owner_id is not distinct from
        permission.registration_owner_id
    cross join lateral vortex_access.accepted_permission_meaning_internal(
      permission.organization_id, permission.application_root_id,
      permission.owner_kind, permission.owner_id, permission.permission_id,
      permission.continuity_revision, permission.accepted_registration_revision
    ) as accepted
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
      and accepted.registration_kind = permission.registration_kind
      and accepted.registration_owner_id is not distinct from permission.registration_owner_id
      and accepted.record_type_id is not distinct from p_record_type_id
      and accepted.action_kind = action_kind_value
      and accepted.named_action is not distinct from named_action_value
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id,
      permission.accepted_entry, permission.accepted_registration_revision,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
  ), granted as materialized (
    -- Every accepted meaning the caller holds through a live path is granted: a caller holding
    -- two roles with different accepted meanings of the permission has both, each with the
    -- earliest deadline of the paths that carry it. Registration revisions are local to each
    -- registration, so equal revisions under different Application addresses remain distinct.
    select distinct on (
      (route.accepted_entry).organization_id,
      (route.accepted_entry).application_root_id,
      (route.accepted_entry).owner_kind,
      (route.accepted_entry).owner_id,
      (route.accepted_entry).permission_id,
      (route.accepted_entry).registration_kind,
      (route.accepted_entry).registration_owner_id,
      route.accepted_registration_revision
    )
      route.accepted_entry as permission_entry, route.path_valid_until
    from route_candidates as route
    order by (route.accepted_entry).organization_id,
      (route.accepted_entry).application_root_id,
      (route.accepted_entry).owner_kind,
      (route.accepted_entry).owner_id,
      (route.accepted_entry).permission_id,
      (route.accepted_entry).registration_kind,
      (route.accepted_entry).registration_owner_id,
      route.accepted_registration_revision, route.path_valid_until
  ), administered as materialized (
    -- A super administrator is evaluated with the registered meaning.
    select available.permission_entry, context_expires_value as path_valid_until
    from current_permission as available
    where available.matches_request
      and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        (p_context ->> 'identityId')::uuid, decision_checked_at
      ) is not null
  )
  select granted.permission_entry, granted.path_valid_until from granted
  union all
  select administered.permission_entry, administered.path_valid_until from administered
  union all
  -- Without a live path the registered permission is returned with no deadline, so callers
  -- can tell an unavailable permission from one that is not effective.
  select available.permission_entry, null::timestamptz
  from current_permission as available
  where available.matches_request
    and not exists (select 1 from granted)
    and not exists (select 1 from administered);
end
$function$;

revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) to vortex_owner;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. It returns one row per accepted meaning the caller holds through a live role path (never a later registered meaning), the registered meaning for a super administrator, or the registered permission without a deadline when no path is live. A preview request decides the previewed Application''s own permissions from its preview registration, and a permission on a system projection of a used Module from the caller''s live registrations, under whichever Application links that Module. No row authority.';

alter function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) owner to vortex_owner;

grant execute on function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) RETURNS TABLE(organization_id uuid, current_version bigint, changed_at timestamp with time zone, changed_by uuid, change_correlation_id uuid, change_reason text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change_reason not in (
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  -- This marker detects a wrong request runner before UPDATE attempts a lock upgrade.
  -- It is not authority: callers still validate the current context and permission.
  if pg_catalog.current_setting('vortex_access.exclusive_organization_id', true)
    is distinct from p_organization_id::text then
    raise exception using errcode = '55000',
      message = 'Access-version increment requires an exclusive access-change scope';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = greatest(version.changed_at, pg_catalog.clock_timestamp()),
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id,
      change_reason = p_change_reason
  where version.organization_id = p_organization_id
    and version.current_version < 9007199254740991
  returning version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason;

  if not found then
    if exists (
      select 1 from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
        and version.current_version = 9007199254740991
    ) then
      raise exception using errcode = '22003', message = 'Access version is exhausted';
    end if;
    raise exception using errcode = '40001', message = 'Access version is unavailable';
  end if;

  -- The request that made this change continues at the version it produced, so its later
  -- statements (Activity, flow effects, receipts) validate against current access. Only this
  -- transaction's own context for this organisation moves, one step from the version it was
  -- admitted at, while the exclusive version lock is held until commit; identity, session,
  -- authentication, correlation and scope stay pinned, and rollback restores the context too.
  update vortex_platform.request_contexts as established
  set context = pg_catalog.jsonb_set(
    established.context, '{accessVersion}', pg_catalog.to_jsonb(version.current_version)
  )
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
    and established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = pg_catalog.pg_current_xact_id()
    and established.context ->> 'organizationId' = p_organization_id::text
    and established.context ->> 'accessVersion' = (version.current_version - 1)::text;

  -- A preview's copied live rows and fields were admitted under the previous access.
  -- Invalidate every builder's snapshot atomically with the version advance, while the
  -- access-change scope excludes preview requests. The next open seeds a new preview
  -- using current live access; retired physical storage is dropped in the background.
  perform vortex_access.invalidate_preview_installations_internal(p_organization_id);
end
$$;

alter function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) FROM PUBLIC;

grant execute on function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) to postgres;

create or replace function vortex_access.list_organization_role_assignments_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text,
  p_after jsonb, p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
  sort_column text;
  sort_kind text;
  sort_expression text;
  sort_null_expression text := 'false';
  candidate_joins text := '';
  direction_sql text;
  keyset_sql text := '';
  order_sql text;
  outer_order_sql text;
  after_text text;
  after_time timestamptz;
  after_record_id uuid;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'starts_at', 'expires_at', 'state')
    or p_sort_key is null or p_direction not in ('ascending', 'descending')
    or p_direction is null or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Assignment projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'starts_at' then 'assignment.starts_at'
    when 'expires_at' then 'assignment.expires_at'
    when 'state' then 'assignment.state'
    else 'assignment.role_assignment_id' end;
  sort_kind := case p_sort_key
    when 'starts_at' then 'time'
    when 'expires_at' then 'nullable_time'
    when 'state' then 'text'
    else 'id' end;
  direction_sql := case when p_direction = 'ascending' then 'asc' else 'desc' end;
  if sort_kind = 'nullable_time' then
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s nulls %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql,
      case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s nulls %s, candidate.record_id %s',
      direction_sql, case when p_direction = 'ascending' then 'first' else 'last' end, direction_sql);
  elsif sort_kind = 'text' then
    sort_expression := sort_column || ' collate "C"';
    order_sql := pg_catalog.format('%s %s, assignment.role_assignment_id %s', sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value collate "C" %s, candidate.record_id %s',
      direction_sql, direction_sql);
  else
    sort_expression := sort_column;
    order_sql := pg_catalog.format('%s %s, assignment.role_assignment_id %s',
      sort_expression, direction_sql, direction_sql);
    outer_order_sql := pg_catalog.format('candidate.sort_value %s, candidate.record_id %s',
      direction_sql, direction_sql);
  end if;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (sort_kind <> 'id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or (pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
          and (sort_kind <> 'nullable_time'
            or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'null'))
      )) then
      raise exception using errcode = '22023', message = 'Assignment projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
      after_text := p_after -> 'sortKey' ->> 0;
      if sort_kind in ('time', 'nullable_time') then
        after_time := after_text::timestamptz;
      end if;
    exception when invalid_text_representation or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Assignment projection cursor is invalid';
    end;
    if sort_kind = 'id' then
      keyset_sql := pg_catalog.format(' and assignment.role_assignment_id %s $4',
        case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'text' then
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($3 collate "C", $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    elsif sort_kind = 'nullable_time' then
      keyset_sql := pg_catalog.format(case when p_direction = 'ascending' then
        ' and (($5 is null and (assignment.expires_at is not null or (assignment.expires_at is null and assignment.role_assignment_id > $4)))'
          || ' or ($5 is not null and (assignment.expires_at, assignment.role_assignment_id) > ($5, $4)))'
        else
        ' and (($5 is null and assignment.expires_at is null and assignment.role_assignment_id < $4)'
          || ' or ($5 is not null and (assignment.expires_at is null or (assignment.expires_at, assignment.role_assignment_id) < ($5, $4))))'
        end);
    else
      keyset_sql := pg_catalog.format(' and (%s, assignment.role_assignment_id) %s ($5, $4)',
        sort_expression, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "role_id": {"sql": "assignment.role_id::text", "database": "text", "filter": true},
      "assignee_kind": {"sql": "assignment.assignee_kind::text", "database": "text", "filter": true},
      "organization_account_id": {"sql": "assignment.organization_account_id::text", "database": "text", "filter": true},
      "group_id": {"sql": "assignment.group_id::text", "database": "text", "filter": true},
      "state": {"sql": "assignment.state::text", "database": "text", "filter": true},
      "temporal_state": {"sql": "(case when assignment.state = 'revoked' then 'revoked' when assignment.starts_at > $7 then 'scheduled' when assignment.expires_at is not null and assignment.expires_at <= $7 then 'expired' else 'active' end)", "database": "text", "filter": true},
      "role_key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "role_label": {"sql": "role_revision.label", "database": "text", "filter": true, "search": true}
    }$declared$::jsonb,
    8
  );
  if predicate_plan ->> 'predicate' is not null then
    -- The predicate may read the role of an assignment; the final select
    -- joins it the same way, so the candidate scan sees the same rows.
    candidate_joins := $joins$join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision$joins$;
    keyset_sql := ' and ' || (predicate_plan ->> 'predicate') || keyset_sql;
  end if;
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_administration_read_scope(
      'platform.organization.assignments.read', 'Organization assignment ledger is unavailable'
    ) as authorized;
  exception when insufficient_privilege then
    return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  scan_sql := pg_catalog.format($scan$
    with candidate as materialized (
      select assignment.role_assignment_id as record_id,
        %s as sort_value, %s as sort_null
      from vortex_access.organization_role_assignments as assignment
      %s
      where assignment.organization_id = $1
        and ($2 is null or assignment.role_assignment_id = any($2))
      %s
      order by %s limit $6
    )
    select assignment.organization_id, assignment.role_assignment_id, assignment.revision,
      pg_catalog.jsonb_build_object(
      'role_id', assignment.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'assignee_kind', assignment.assignee_kind,
      'organization_account_id', assignment.organization_account_id,
      'group_id', assignment.group_id,
      'assignee_display_name', coalesce(assignee_account.display_name, assignee_group.label),
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', assignment.state,
      'temporal_state', case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > $7 then 'scheduled'
        when assignment.expires_at is not null and assignment.expires_at <= $7 then 'expired'
        else 'active' end
      )
    from candidate
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = $1 and assignment.role_assignment_id = candidate.record_id
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id and role_revision.revision = role.live_revision
    left join vortex_identity.organization_accounts as assignee_account
      on assignment.assignee_kind = 'organization_account'
      and assignee_account.organization_id = assignment.organization_id
      and assignee_account.organization_account_id = assignment.organization_account_id
    left join vortex_access.organization_groups as assignee_group
      on assignment.assignee_kind = 'group'
      and assignee_group.organization_id = assignment.organization_id
      and assignee_group.group_id = assignment.group_id
    order by %s
  $scan$, sort_expression, sort_null_expression, candidate_joins, keyset_sql,
    order_sql, outer_order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_text, after_record_id, after_time, p_limit, checked_at, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, vortex_request, postgres;
alter function vortex_access.list_organization_role_assignments_projection(uuid[], text, text, jsonb, integer, jsonb) owner to vortex_owner;

create or replace function vortex_access.list_organization_roles_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer, p_predicate jsonb
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  sort_column text;
  keyset_sql text := '';
  order_sql text;
  after_value text;
  after_record_id uuid;
  join_sql text;
  scan_sql text;
  predicate_plan jsonb;
begin
  if p_sort_key not in ('record_id', 'key', 'label', 'lifecycle')
    or p_direction not in ('ascending', 'descending')
    or p_sort_key is null or p_direction is null
    or (p_limit is not null and p_limit < 1)
    or (p_sort_key <> 'record_id' and p_limit is null) then
    raise exception using errcode = '22023', message = 'Role projection bounds are invalid';
  end if;
  sort_column := case p_sort_key
    when 'key' then 'role.role_key'
    when 'label' then 'role_revision.label'
    when 'lifecycle' then 'role_revision.lifecycle'
    else 'role.role_id' end;
  if p_after is not null then
    if pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or (p_sort_key <> 'record_id' and (
        pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_after -> 'sortKey') is distinct from 1
        or pg_catalog.jsonb_typeof(p_after -> 'sortKey' -> 0) is distinct from 'string'
      )) then
      raise exception using errcode = '22023', message = 'Role projection cursor is invalid';
    end if;
    begin
      after_record_id := (p_after ->> 'recordId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Role projection cursor is invalid';
    end;
    after_value := p_after -> 'sortKey' ->> 0;
    if p_sort_key = 'record_id' then
      keyset_sql := case when p_direction = 'ascending'
        then ' and role.role_id > $4' else ' and role.role_id < $4' end;
    else
      keyset_sql := pg_catalog.format(
        ' and (%s collate "C", role.role_id) %s ($3 collate "C", $4)',
        sort_column, case when p_direction = 'ascending' then '>' else '<' end);
    end if;
  end if;
  order_sql := case when p_sort_key = 'record_id'
    then pg_catalog.format('role.role_id %s',
      case when p_direction = 'ascending' then 'asc' else 'desc' end)
    else pg_catalog.format('%s collate "C" %s, role.role_id %s',
      sort_column, case when p_direction = 'ascending' then 'asc' else 'desc' end,
      case when p_direction = 'ascending' then 'asc' else 'desc' end) end;
  join_sql := case when p_sort_key in ('record_id', 'key') then $join$
    join lateral (
      select role_revision.*
      from vortex_access.organization_role_revisions as role_revision
      where role_revision.organization_id = role.organization_id
        and role_revision.role_id = role.role_id
        and role_revision.revision = role.live_revision
      limit 1
    ) as role_revision on true
  $join$ else $join$
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
  $join$ end;
  predicate_plan := vortex_record.compile_projection_predicate_internal(
    p_predicate,
    $declared${
      "key": {"sql": "role_revision.role_key", "database": "text", "search": true},
      "label": {"sql": "role_revision.label", "database": "text", "filter": true, "search": true},
      "lifecycle": {"sql": "role_revision.lifecycle::text", "database": "text", "filter": true},
      "role_kind": {"sql": "role.role_kind::text", "database": "text", "filter": true},
      "privilege_classification": {"sql": "role_revision.privilege_classification::text", "database": "text", "filter": true}
    }$declared$::jsonb,
    6
  );
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_administration_read_scope(
      'platform.organization.roles.read', 'Organization role catalogue is unavailable'
    ) as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  scan_sql := $scan$
  select role.organization_id,
    role.role_id,
    role.live_revision,
    pg_catalog.jsonb_build_object(
      'key', role_revision.role_key,
      'label', role_revision.label,
      'application_name', (
        select release.application_address ->> 'name'
        from vortex_definition.releases as release
        where release.root_id = role.application_root_id
        order by release.release_revision desc
        limit 1
      ),
      'lifecycle', role_revision.lifecycle,
      'role_kind', role.role_kind,
      'privilege_classification', role_revision.privilege_classification,
      'accepted_permission_count', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role_revision.organization_id
          and permission.role_id = role_revision.role_id
          and permission.role_revision = role_revision.revision
      )
    )
  from vortex_access.organization_roles as role
  $scan$ || join_sql || $scan$
  where role.organization_id = $1
    and ($2 is null or role.role_id = any($2))
  $scan$ || coalesce(' and ' || (predicate_plan ->> 'predicate'), '') || keyset_sql || pg_catalog.format(' order by %s limit $5', order_sql);
  return query execute scan_sql using scope_row.organization_id, p_record_ids,
    after_value, after_record_id, p_limit, predicate_plan -> 'parameters';
end
$function$;

revoke all on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  to vortex_owner, vortex_record_adapter, vortex_request, postgres;
alter function vortex_access.list_organization_roles_projection(uuid[], text, text, jsonb, integer, jsonb)
  owner to vortex_owner;

-- Private Access-owner routine; Record callers first lock the active linked account.
create or replace function vortex_access.organization_account_has_current_application_access_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    return false;
  end if;

  -- In a preview the builder who opened it holds every role of the previewed draft; anyone else
  -- has the access their live roles give them.
  if exists (
    select 1
    from vortex_access.request_application_registration_internal(
      p_organization_id, p_application_root_id, p_organization_account_id
    ) as registration
    where registration.registration_kind = 'preview'
      and registration.valid_until > checked_at
      and pg_catalog.cardinality(registration.role_ids) > 0
  ) then
    return true;
  end if;

  -- The Record writer invokes this helper only after locking the exact active
  -- organisation-account projection and its active identity in this organisation.
  return exists (
    with current_roles as (
      select role.role_id, role.source_role_id
      from vortex_access.organization_roles as role
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      where role.organization_id = p_organization_id
        and role.application_root_id = p_application_root_id
        and role.role_kind = 'application'
        and revision.lifecycle in ('active', 'acceptance_required')
    ), active_roles as (
      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'group'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_groups as organization_group
        on organization_group.organization_id = assignment.organization_id
        and organization_group.group_id = assignment.group_id
        and organization_group.state = 'active'
      join vortex_access.organization_group_memberships as membership
        on membership.organization_id = assignment.organization_id
        and membership.group_id = assignment.group_id
        and membership.organization_account_id = p_organization_account_id
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
    )
    select 1 from active_roles
  );
end
$function$;

revoke all on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid) is
  'Private Record-link authorization for a previously locked active organisation account: returns only whether that linked account has a current direct or Group application role under the validated human application context, including current assignment and membership, or is the builder of the preview the context runs, who holds its draft''s roles.';

alter function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  owner to vortex_owner;

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
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ), current_platform_registration as (
    select registration.revision, registration.registration_owner_id
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), required_declaration as materialized (
    select declaration.permission_id
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_platform_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id,
      registration.revision as registration_revision
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
    where entry.application_root_id is null
      and entry.owner_kind = 'platform'
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
            and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.last_processed_registration_revision =
              required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
        )
      )
  )
  select (select pg_catalog.count(*) from required_declaration) > 0
    and (
      select pg_catalog.count(*)
      from (
        select distinct declaration.permission_id
        from required_declaration as declaration
      ) as distinct_declaration
    ) = (select pg_catalog.count(*) from required_declaration)
    and (
      select pg_catalog.count(*)
      from (
        select distinct required.permission_id
        from required_platform_permission as required
      ) as matched_declaration
    ) = (select pg_catalog.count(*) from required_declaration)
    and (select pg_catalog.count(*) from required_platform_permission)
      = (select pg_catalog.count(*) from required_declaration)
    and exists (
      select 1
      from candidate_steward as steward
      cross join stewardship_requirement as requirement
    )
$function$;

revoke execute on function vortex_access.organization_has_permanent_steward(uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.organization_has_permanent_steward(uuid, timestamptz) is
  'Checks the direct permanent steward and original platform-permission invariant for an adopted organisation.';
alter function vortex_access.organization_has_permanent_steward(p_organization_id uuid, p_checked_at timestamp with time zone) owner to vortex_owner;

create or replace function vortex_access.project_organization_role_change_summary(
  p_organization_id uuid,
  p_role_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = p_organization_id
    and role.role_id = p_role_id
$function$;

revoke execute on function
  vortex_access.project_organization_role_change_summary(uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.project_organization_role_change_summary(uuid, uuid) is
  'Private safe current role projection for protected structural changes.';

alter function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.project_organization_role_change_summary(p_organization_id uuid, p_role_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.protect_organization_role_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization role assignments cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role assignment revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.state <> 'revoked'
    or new.revoked_at is null
    or new.revoked_at < old.changed_at
    or new.organization_id is distinct from old.organization_id
    or new.role_assignment_id is distinct from old.role_assignment_id
    or new.role_id is distinct from old.role_id
    or new.assignee_kind is distinct from old.assignee_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization role assignment transition is invalid';
  end if;

  return new;
end
$$;

alter function vortex_access.protect_organization_role_assignment() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_role_assignment() FROM PUBLIC;

grant execute on function vortex_access.protect_organization_role_assignment() to postgres;

create or replace function vortex_access.read_application_roles_for_installation(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installer record;
  roles_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Installation role read input is invalid',
      detail = 'vortex_access.read_application_roles_for_installation';
  end if;

  -- The installation authority (applications.manage plus delegated management over the whole
  -- organisation catalogue) is what entitles this read; it needs no separate roles.read grant.
  select locked.* into strict installer
  from vortex_access.lock_application_installation_authority() as locked;

  -- One organisation role per role template of this application: a live one before a retired
  -- one, so a retired role is reported instead of being accepted a second time. Each carries the
  -- permissions it accepted (with the meaning it accepted), how many live assignments hold it,
  -- and the installer's own live standing assignment of it.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'roleId', selected.role_id,
      'sourceRoleId', selected.source_role_id,
      'label', selected.label,
      'liveRevision', selected.live_revision,
      'lifecycle', selected.lifecycle,
      'liveAssignmentCount', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = installer.organization_id
          and assignment.role_id = selected.role_id
          and assignment.state = 'live'
      ),
      'installerAssignment', (
        select pg_catalog.jsonb_build_object(
          'roleAssignmentId', assignment.role_assignment_id,
          'revision', assignment.revision,
          'selfGranted', assignment.granted_by = installer.organization_account_id
        )
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = installer.organization_id
          and assignment.role_id = selected.role_id
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = installer.organization_account_id
          and assignment.state = 'live'
          and assignment.starts_at <= pg_catalog.clock_timestamp()
          and (assignment.expires_at is null
            or assignment.expires_at > pg_catalog.clock_timestamp())
        order by assignment.granted_at, assignment.role_assignment_id
        limit 1
      ),
      'acceptedPermissions', (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'reference', pg_catalog.jsonb_strip_nulls(
                  pg_catalog.jsonb_build_object(
                    'applicationRootId', permission.application_root_id,
                    'ownerKind', permission.owner_kind,
                    'ownerId', permission.owner_id,
                    'permissionId', permission.permission_id
                  )
                ),
                'key', catalogue.permission_key,
                'label', catalogue.label,
                'description', catalogue.description,
                'recordTypeId', catalogue.record_type_id,
                'action', pg_catalog.jsonb_strip_nulls(
                  pg_catalog.jsonb_build_object(
                    'actionKind', catalogue.action_kind,
                    'namedAction', catalogue.named_action
                  )
                ),
                'administrative', catalogue.administrative,
                -- The meaning the role accepted, which may be older than the registered one.
                'recordScope', catalogue.record_scope,
                'fieldPolicy', catalogue.field_policy
              )
            ) order by permission.entry_ordinal
          ),
          '[]'::jsonb
        )
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_catalogue_entries as catalogue
          on catalogue.organization_id = permission.organization_id
          and catalogue.registration_kind = permission.registration_kind
          and catalogue.registration_owner_id = permission.registration_owner_id
          and catalogue.registration_revision = permission.accepted_registration_revision
          and catalogue.owner_kind = permission.owner_kind
          and catalogue.owner_id = permission.owner_id
          and catalogue.permission_id = permission.permission_id
        where permission.organization_id = installer.organization_id
          and permission.role_id = selected.role_id
          and permission.role_revision = selected.live_revision
      )
    ) order by selected.source_role_id), '[]'::jsonb)
  into roles_value
  from (
    select distinct on (role.source_role_id)
      role.role_id, role.source_role_id, role.live_revision, revision.label,
      revision.lifecycle
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = installer.organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.source_role_id, (revision.lifecycle = 'retired'), role.created_at desc,
      role.role_id
  ) as selected;

  return pg_catalog.jsonb_build_object(
    'organizationId', installer.organization_id,
    'organizationAccountId', installer.organization_account_id,
    'roles', roles_value
  );
end
$function$;

alter function vortex_access.read_application_roles_for_installation(uuid) owner to vortex_owner;

revoke all on function vortex_access.read_application_roles_for_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.read_application_roles_for_installation(uuid)
  to vortex_request;

comment on function vortex_access.read_application_roles_for_installation(uuid) is
  'Installation role read under the installation authority: for each role template of one application, the organisation role accepted from it (a live one before a retired one) with its accepted permissions and their accepted meaning, its live assignment count and the installer''s own live standing assignment. Reads only that application''s roles; needs no roles.read grant.';

create or replace function vortex_access.read_current_application_role_ids_for_launcher()
returns table (source_role_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at then
    return;
  end if;

  -- In a preview the builder who opened it holds every role of the previewed draft.
  if nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  ) is not null then
    return query
    select distinct role_id.value
    from vortex_access.request_application_registration_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid
    ) as registration
    cross join lateral pg_catalog.unnest(registration.role_ids) as role_id(value)
    where registration.registration_kind = 'preview'
      and registration.valid_until > checked_at
    order by role_id.value;
    return;
  end if;

  return query
  with current_roles as (
    select role.role_id, role.source_role_id
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = (context_value ->> 'organizationId')::uuid
      and role.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and role.role_kind = 'application'
      and revision.lifecycle in ('active', 'acceptance_required')
  ), active_roles as (
    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
  )
  select active.source_role_id from active_roles as active
  order by active.source_role_id;
end
$function$;

revoke execute on function vortex_access.read_current_application_role_ids_for_launcher()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_current_application_role_ids_for_launcher()
  to vortex_request;

comment on function vortex_access.read_current_application_role_ids_for_launcher() is
  'Returns only current direct or group application-role source identities for the validated human application context, or every role of the previewed draft for the builder of a preview; page authority is checked separately.';

alter function vortex_access.read_current_application_role_ids_for_launcher() owner to vortex_owner;

create or replace function vortex_access.read_organization_role_change_for_administration(
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  context_organization_id uuid;
  operation_name text;
  accepted_truth text;
  requested jsonb;
  refs jsonb;
  permissions_value jsonb;
  has_administrative_permissions boolean;
  target_application_root_id uuid;
  target_source_role_id uuid;
  application_registration vortex_access.permission_registrations%rowtype;
  selected_continuity vortex_access.application_role_template_continuities%rowtype;
  live_permissions jsonb;
  template_source jsonb;
  role_identity vortex_access.organization_roles%rowtype;
  current_revision vortex_access.organization_role_revisions%rowtype;
  role_configuration jsonb;
  target_role_id uuid;
  expected_role_revision bigint;
  target_lifecycle text := 'active';
  authority_broadened boolean := false;
  manifest_required boolean := false;
  affected_assignments jsonb;
begin
  -- New-role callers supply bounded configuration only. Existing-Application-revision callers
  -- supply only the selected role identity and expected revision; this function derives that
  -- role's configuration and application source from the verified organisation's stored rows.
  -- Neither path accepts a fingerprint or organisation from its caller.
  if p_preparation is null
    or pg_catalog.jsonb_typeof(p_preparation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_preparation -> 'operation') is distinct from 'string'
    or p_preparation ->> 'operation' not in (
      'create_custom', 'accept_new_application_role', 'accept_application_role_revision'
    ) then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  operation_name := p_preparation ->> 'operation';

  if operation_name = 'accept_application_role_revision' then
    if p_preparation - array[
      'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
    ]::text[] <> '{}'::jsonb
      or not (p_preparation ?& array[
        'operation', 'roleId', 'expectedRoleRevision', 'acceptBroadenedAuthority'
      ])
      or pg_catalog.jsonb_typeof(p_preparation -> 'roleId') is distinct from 'string'
      or vortex_platform.is_non_nil_uuid(p_preparation ->> 'roleId') is not true
      or (p_preparation ->> 'roleId') <> (p_preparation ->> 'roleId')::uuid::text
      or pg_catalog.jsonb_typeof(p_preparation -> 'expectedRoleRevision')
        is distinct from 'number'
      or (p_preparation ->> 'expectedRoleRevision')::numeric not between
        1 and 9007199254740991
      or (p_preparation ->> 'expectedRoleRevision')::numeric <>
        pg_catalog.trunc((p_preparation ->> 'expectedRoleRevision')::numeric)
      or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority')
        is distinct from 'string'
      or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  elsif pg_catalog.jsonb_typeof(p_preparation -> 'roleKey') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'label') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'description') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_preparation -> 'privilegeClassification') is distinct from 'string'
    or p_preparation ->> 'privilegeClassification' not in ('standard', 'privileged')
    or pg_catalog.jsonb_typeof(p_preparation -> 'acceptBroadenedAuthority') is distinct from 'string'
    or p_preparation ->> 'acceptBroadenedAuthority' not in ('accept', 'decline') then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
  end if;
  accepted_truth := p_preparation ->> 'acceptBroadenedAuthority';

  -- Explicit acceptance of broadened authority is a visible choice, never inferred from a
  -- submitted form. Declining is an ordinary unavailability, not an error.
  if accepted_truth is distinct from 'accept' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;

  -- The verified request context and the caller's own current authority decide the organisation;
  -- the caller never names it. A custom role needs role management. Accepting an application's
  -- role template or role revision is part of installing or upgrading that application, so it
  -- needs the installation permission instead; the writer keeps the delegated-scope and recent
  -- sign-in checks for both.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', case when operation_name = 'create_custom'
        then 'platform.organization.roles.manage'
        else 'platform.organization.applications.manage' end,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        case when operation_name = 'create_custom'
          then 'platform.organization.roles.manage'
          else 'platform.organization.applications.manage' end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization role-change preparation is unavailable';
  end if;
  context_organization_id := decision.organization_id;

  if operation_name = 'accept_application_role_revision' then
    target_role_id := (p_preparation ->> 'roleId')::uuid;
    expected_role_revision :=
      (p_preparation ->> 'expectedRoleRevision')::numeric::bigint;
    select stored.* into role_identity
    from vortex_access.organization_roles as stored
    where stored.organization_id = context_organization_id
      and stored.role_id = target_role_id;
    if not found
      or role_identity.role_kind <> 'application'
      or role_identity.application_root_id is null
      or role_identity.application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.source_role_id is null
      or role_identity.source_role_id = '00000000-0000-0000-0000-000000000000'::uuid
      or role_identity.live_revision <> expected_role_revision then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    if role_identity.live_revision = 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select revision.* into current_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = context_organization_id
      and revision.role_id = target_role_id
      and revision.revision = expected_role_revision;
    if not found
      or current_revision.lifecycle is null
      or current_revision.lifecycle not in ('active', 'acceptance_required') then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    target_application_root_id := role_identity.application_root_id;
    target_source_role_id := role_identity.source_role_id;
    role_configuration := pg_catalog.jsonb_build_object(
      'roleId', role_identity.role_id,
      'expectedRoleRevision', current_revision.revision,
      'key', current_revision.role_key,
      'label', current_revision.label,
      'description', current_revision.description,
      'privilegeClassification', current_revision.privilege_classification,
      'sourceRoleId', role_identity.source_role_id
    );
  end if;

  if operation_name = 'create_custom' then
    requested := p_preparation -> 'permissions';
    if pg_catalog.jsonb_typeof(requested) is distinct from 'array'
      or pg_catalog.jsonb_array_length(requested) = 0 then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(requested) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['ownerKind', 'ownerId', 'permissionId'])
        or pg_catalog.jsonb_typeof(item.value -> 'ownerKind') is distinct from 'string'
        or item.value ->> 'ownerKind' not in ('platform', 'application', 'module')
        or pg_catalog.jsonb_typeof(item.value -> 'ownerId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'ownerId') is not true
        or pg_catalog.jsonb_typeof(item.value -> 'permissionId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(item.value ->> 'permissionId') is not true
        or ((item.value ->> 'ownerKind' = 'platform') = (item.value ? 'applicationRootId'))
        or (
          item.value ->> 'ownerKind' <> 'platform'
          and (
            pg_catalog.jsonb_typeof(item.value -> 'applicationRootId') is distinct from 'string'
            or vortex_platform.is_non_nil_uuid(item.value ->> 'applicationRootId') is not true
            or (item.value ->> 'ownerKind' = 'application'
              and (item.value ->> 'ownerId')::uuid
                <> (item.value ->> 'applicationRootId')::uuid)
          )
        )
    ) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
    select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'applicationRootId', case when item.value ->> 'ownerKind' = 'platform'
          then null else (item.value ->> 'applicationRootId')::uuid end,
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', (item.value ->> 'ownerId')::uuid,
        'permissionId', (item.value ->> 'permissionId')::uuid
      )
    ))
    into refs
    from pg_catalog.jsonb_array_elements(requested) as item(value);
    if refs is null
      or pg_catalog.jsonb_array_length(refs) <> pg_catalog.jsonb_array_length(requested) then
      raise exception using errcode = '22023',
        message = 'Organization role-change preparation input is invalid';
    end if;
  else
    if operation_name <> 'accept_application_role_revision' then
      if pg_catalog.jsonb_typeof(p_preparation -> 'applicationRootId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'applicationRootId') is not true
        or pg_catalog.jsonb_typeof(p_preparation -> 'sourceRoleId') is distinct from 'string'
        or vortex_platform.is_non_nil_uuid(p_preparation ->> 'sourceRoleId') is not true then
        raise exception using errcode = '22023',
          message = 'Organization role-change preparation input is invalid';
      end if;
      target_application_root_id := (p_preparation ->> 'applicationRootId')::uuid;
      target_source_role_id := (p_preparation ->> 'sourceRoleId')::uuid;
    end if;

    select registration.* into application_registration
    from vortex_access.permission_registrations as registration
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = target_application_root_id
      and registration.state = 'active';
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    select continuity.* into selected_continuity
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = context_organization_id
      and continuity.application_root_id = target_application_root_id
      and continuity.source_role_id = target_source_role_id
      and continuity.state = 'available'
      and continuity.last_processed_registration_revision = application_registration.revision;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;

    -- The writer reads the same projection, so the evidence names the registration revision and
    -- its catalogue fingerprint instead of carrying the registered entries.
    live_permissions := vortex_access.application_role_template_live_permissions_internal(
      context_organization_id, target_application_root_id, application_registration.revision,
      target_source_role_id
    );
    if live_permissions is null then
      return pg_catalog.jsonb_build_object('outcome', 'unavailable');
    end if;
    template_source := pg_catalog.jsonb_build_object(
      'applicationRootId', target_application_root_id,
      'registrationRevision', application_registration.revision,
      'releaseRevision', application_registration.source_revision,
      'catalogueFingerprint', application_registration.permission_catalogue_fingerprint
    );

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', item.value -> 'applicationRootId',
        'ownerKind', item.value ->> 'ownerKind',
        'ownerId', item.value ->> 'ownerId',
        'permissionId', item.value ->> 'permissionId'
      )))
    into refs
    from pg_catalog.jsonb_array_elements(live_permissions) as item(value);
  end if;

  -- Every requested identity must still resolve to exactly one current, available accepted
  -- permission. The returned scope is exactly the references the role entry names, never wider.
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', continuity.application_root_id,
      'ownerKind', continuity.owner_kind,
      'ownerId', continuity.owner_id,
      'permissionId', continuity.permission_id,
      'acceptedRegistrationRevision', registration.revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision
    )) order by continuity.application_root_id nulls last,
      continuity.owner_kind collate "C", continuity.owner_id, continuity.permission_id),
    pg_catalog.bool_or(catalogue.administrative)
  into permissions_value, has_administrative_permissions
  from pg_catalog.jsonb_array_elements(refs) as requested_permission(value)
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = context_organization_id
    and continuity.state = 'available'
    and continuity.application_scope_id = coalesce(case when requested_permission.value ? 'applicationRootId'
        then (requested_permission.value ->> 'applicationRootId')::uuid else null end, '00000000-0000-0000-0000-000000000000'::uuid)
      and (requested_permission.value ->> 'applicationRootId') is distinct from '00000000-0000-0000-0000-000000000000'
    and continuity.owner_kind = requested_permission.value ->> 'ownerKind'
    and continuity.owner_id = (requested_permission.value ->> 'ownerId')::uuid
    and continuity.permission_id = (requested_permission.value ->> 'permissionId')::uuid
  join vortex_access.permission_registrations as registration
    on registration.organization_id = continuity.organization_id
    and registration.registration_kind = continuity.registration_kind
    and registration.registration_owner_id = continuity.registration_owner_id
    and registration.state = 'active'
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = continuity.organization_id
    and catalogue.registration_kind = continuity.registration_kind
    and catalogue.registration_owner_id = continuity.registration_owner_id
    and catalogue.registration_revision = registration.revision
    and catalogue.owner_kind = continuity.owner_kind
    and catalogue.owner_id = continuity.owner_id
    and catalogue.permission_id = continuity.permission_id
    and catalogue.application_root_id is not distinct from continuity.application_root_id;
  if permissions_value is null
    or pg_catalog.jsonb_array_length(permissions_value)
      <> pg_catalog.jsonb_array_length(refs) then
    raise exception using errcode = '40001',
      message = 'Organization role permission evidence is stale or unavailable';
  end if;

  -- Reject the submitted classification before sealing evidence for a write whose deferred
  -- revision constraint would reject the same administrative permissions at commit.
  if operation_name <> 'accept_application_role_revision'
    and p_preparation ->> 'privilegeClassification' = 'standard'
    and has_administrative_permissions then
    return pg_catalog.jsonb_build_object(
      'outcome', 'invalid_privilege_classification',
      'organizationId', context_organization_id
    );
  end if;

  if operation_name = 'accept_application_role_revision' then
    select exists (
      select 1
      from pg_catalog.jsonb_array_elements(permissions_value) as proposed(value)
      where not exists (
        select 1
        from vortex_access.organization_role_permission_entries as existing
        where existing.organization_id = context_organization_id
          and existing.role_id = target_role_id
          and existing.role_revision = current_revision.revision
          and existing.application_root_id is not distinct from
            case when proposed.value ? 'applicationRootId'
              then (proposed.value ->> 'applicationRootId')::uuid else null end
          and existing.owner_kind = proposed.value ->> 'ownerKind'
          and existing.owner_id = (proposed.value ->> 'ownerId')::uuid
          and existing.permission_id = (proposed.value ->> 'permissionId')::uuid
          and existing.continuity_revision =
            (proposed.value ->> 'continuityRevision')::numeric::bigint
      )
    ) into authority_broadened;

    -- The candidate either moves from acceptance_required to active or keeps an active revision
    -- active. This is the writer's manifest predicate, so the only additional true term for this
    -- operation is a broadened permission projection.
    manifest_required :=
      (
        current_revision.lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      )
      or authority_broadened;

    if manifest_required then
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
                'kind', 'group',
                'groupId', assignment.group_id
              )
            end
          ) order by assignment.role_assignment_id
        ),
        '[]'::jsonb
      ) into affected_assignments
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = target_role_id
        and assignment.state = 'live';
    end if;

    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'roleConfiguration', role_configuration,
      'permissions', permissions_value,
      'templateContinuityRevision', selected_continuity.continuity_revision,
      'templateSource', template_source,
      'manifestRequired', manifest_required,
      'affectedAssignments', affected_assignments
    );
  end if;

  if operation_name = 'create_custom' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'available',
      'organizationId', context_organization_id,
      'permissions', permissions_value,
      'templateContinuityRevision', null,
      'templateSource', null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'available',
    'organizationId', context_organization_id,
    'permissions', permissions_value,
    'templateContinuityRevision', selected_continuity.continuity_revision,
    'templateSource', template_source
  );
exception
  when invalid_text_representation or invalid_parameter_value
      or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Organization role-change preparation input is invalid';
end
$function$;

revoke execute on function vortex_access.read_organization_role_change_for_administration(jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.read_organization_role_change_for_administration(jsonb)
to vortex_request;

comment on function vortex_access.read_organization_role_change_for_administration(jsonb) is
  'Server-side preparation read: given bounded role configuration or an existing Application role identity and expected revision, it returns complete, fingerprinted permission and template evidence for the verified caller organisation only, deriving stored role configuration, actor and organisation from protected context and including an exact live-assignment snapshot only when the writer requires it.';

alter function vortex_access.read_organization_role_change_for_administration(p_preparation jsonb) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_change_for_administration(p_preparation jsonb) to postgres;

create or replace function vortex_access.read_organization_role_for_administration(
  p_role_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  role_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  role_value jsonb;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_administration_read_scope(
      'platform.organization.roles.read', 'Organization role catalogue is unavailable'
    ) as authorized;

  select pg_catalog.jsonb_build_object(
    'roleId', role.role_id,
    'key', revision.role_key,
    'label', revision.label,
    'description', revision.description,
    'roleKind', role.role_kind,
    'lifecycle', revision.lifecycle,
    'liveRevision', revision.revision,
    'privilegeClassification', revision.privilege_classification,
    'source', case role.role_kind
      when 'custom' then pg_catalog.jsonb_build_object('kind', 'custom')
      else pg_catalog.jsonb_build_object(
        'kind', 'application',
        'applicationRootId', role.application_root_id,
        'sourceRoleId', role.source_role_id
      )
    end,
    'acceptedPermissionCount', (
      select pg_catalog.count(*)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    ),
    'acceptedPermissions', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_strip_nulls(
            pg_catalog.jsonb_build_object(
              'reference', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'applicationRootId', permission.application_root_id,
                  'ownerKind', permission.owner_kind,
                  'ownerId', permission.owner_id,
                  'permissionId', permission.permission_id
                )
              ),
              'key', catalogue.permission_key,
              'label', catalogue.label,
              'description', catalogue.description,
              'recordTypeId', catalogue.record_type_id,
              'action', pg_catalog.jsonb_strip_nulls(
                pg_catalog.jsonb_build_object(
                  'actionKind', catalogue.action_kind,
                  'namedAction', catalogue.named_action
                )
              ),
              'administrative', catalogue.administrative,
              -- The meaning the role accepted, which may be older than the registered one.
              'recordScope', catalogue.record_scope,
              'fieldPolicy', catalogue.field_policy
            )
          ) order by permission.entry_ordinal
        ),
        '[]'::jsonb
      )
      from vortex_access.organization_role_permission_entries as permission
      join vortex_access.permission_catalogue_entries as catalogue
        on catalogue.organization_id = permission.organization_id
        and catalogue.registration_kind = permission.registration_kind
        and catalogue.registration_owner_id = permission.registration_owner_id
        and catalogue.registration_revision = permission.accepted_registration_revision
        and catalogue.owner_kind = permission.owner_kind
        and catalogue.owner_id = permission.owner_id
        and catalogue.permission_id = permission.permission_id
      where permission.organization_id = revision.organization_id
        and permission.role_id = revision.role_id
        and permission.role_revision = revision.revision
    )
  )
  into role_value
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = scope.organization_id
    and role.role_id = p_role_id;

  return query select scope.organization_id,
    case when role_value is null then 'unavailable' else 'available' end,
    role_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_role_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_role_for_administration(uuid)
to vortex_request;

comment on function vortex_access.read_organization_role_for_administration(uuid) is
  'Returns one current local role and its accepted configuration without assignment evidence.';

alter function vortex_access.read_organization_role_for_administration(p_role_id uuid) owner to vortex_owner;

grant execute on function vortex_access.read_organization_role_for_administration(p_role_id uuid) to postgres;

create or replace function vortex_access.revise_organization_role_metadata_for_administration(
  p_role_id uuid,
  p_expected_role_revision bigint,
  p_label text,
  p_description text,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  role_summary jsonb,
  access_version bigint, refusal_reason text
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
  role_fact vortex_access.organization_roles%rowtype;
  revision_fact vortex_access.organization_role_revisions%rowtype;
  affected_permissions jsonb;
  authority_requirement jsonb;
  decision record;
  changed_summary jsonb;
  operation_at timestamptz;
  activity_result text;
begin
  if p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_role_revision is null
    or p_expected_role_revision not between 1 and 9007199254740991
    or p_label is null or p_label <> pg_catalog.btrim(p_label)
    or pg_catalog.char_length(p_label) not between 1 and 60
    or p_description is null or p_description <> pg_catalog.btrim(p_description)
    or pg_catalog.char_length(p_description) not between 1 and 1000
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role metadata revision input is invalid';
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
      message = 'Organization role metadata revision is unavailable';
  end if;

  select role.* into role_fact
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = p_role_id
  for update;
  if not found or role_fact.live_revision <> p_expected_role_revision then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;
  select revision.* into strict revision_fact
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = p_role_id
    and revision.revision = role_fact.live_revision;
  if revision_fact.lifecycle = 'retired' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata revision is stale or unavailable';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id,
      'acceptedRegistrationRevision', permission.accepted_registration_revision
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ) into affected_permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision;

  if affected_permissions is null and exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = context_organization_id
      and assignment.role_id = p_role_id
      and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case when affected_permissions is null
    then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      ),
      'after', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      )
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.roles.revise_metadata',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.roles.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.roles.revise_metadata'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revise_role_metadata',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role metadata revision refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.roles.revise_metadata'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role metadata revision is unavailable';
  end if;

  if role_fact.live_revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization role revision is exhausted';
  end if;
  if revision_fact.label is not distinct from p_label
    and revision_fact.description is not distinct from p_description then
    raise exception using errcode = '40001',
      message = 'Organization role label and description are unchanged';
  end if;

  -- A label or description edit changes no permission, assignment policy,
  -- lifecycle or source fact, so it appends one revision that carries every
  -- other fact forward and leaves the Access version untouched.
  operation_at := greatest(
    revision_fact.changed_at, pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision
  )
  select permission.organization_id, permission.role_id,
    role_fact.live_revision + 1, permission.entry_ordinal, permission.role_kind,
    permission.role_application_root_id, permission.application_root_id,
    permission.owner_kind, permission.owner_id, permission.permission_id,
    permission.registration_kind, permission.registration_owner_id,
    permission.accepted_registration_revision, permission.catalogue_fingerprint,
    permission.continuity_revision
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = context_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = role_fact.live_revision
  order by permission.entry_ordinal;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, accepted_registration_revision,
    template_continuity_revision,
    changed_by, changed_at, change_correlation_id
  ) values (
    context_organization_id, p_role_id, role_fact.live_revision + 1,
    revision_fact.role_kind, revision_fact.application_root_id,
    revision_fact.lifecycle, revision_fact.privilege_classification,
    revision_fact.policy_continuity_revision,
    revision_fact.authority_continuity_revision,
    revision_fact.role_key,
    p_label, p_description, revision_fact.source_definition_key,
    revision_fact.source_release_revision, revision_fact.source_release_version,
    revision_fact.source_validation_contract_version,
    revision_fact.accepted_registration_revision,
    revision_fact.template_continuity_revision,
    context_account_id, operation_at, context_correlation_id
  );

  update vortex_access.organization_roles as stored
  set live_revision = role_fact.live_revision + 1
  where stored.organization_id = context_organization_id
    and stored.role_id = p_role_id
    and stored.live_revision = p_expected_role_revision;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization role revision changed concurrently';
  end if;

  changed_summary := vortex_access.project_organization_role_change_summary(
    context_organization_id, p_role_id
  );
  if changed_summary is null then
    raise exception using errcode = '40001',
      message = 'Changed organization role projection is unavailable';
  end if;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    operation_at,
    'organization_account', context_account_id, 'revise_role_metadata',
    array[p_role_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role metadata Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    context_access_version, null::text;
end
$function$;

revoke execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid)
to vortex_request;

comment on function vortex_access.revise_organization_role_metadata_for_administration(uuid, bigint, text, text, uuid) is
  'Standalone request entry: performs a display-only role label and description revision after fixed protected checks without advancing the Access version, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revise_organization_role_metadata_for_administration(p_role_id uuid, p_expected_role_revision bigint, p_label text, p_description text, p_activity_id uuid) to postgres;

create or replace function vortex_access.revoke_organization_role_assignment_for_administration(
  p_role_assignment_id uuid,
  p_expected_assignment_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  assignment_summary jsonb,
  access_version bigint, refusal_reason text
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
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  current_role_revision bigint;
  current_role_lifecycle text;
  affected_permissions jsonb;
  affected_authority jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  activity_result text;
begin
  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_assignment_revision is null
    or p_expected_assignment_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role-assignment revocation input is invalid';
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
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment.* into assignment_fact
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
  for update;
  if not found
    or assignment_fact.revision <> p_expected_assignment_revision
    or assignment_fact.state <> 'live' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation is stale or unavailable';
  end if;

  select role.live_revision, revision.lifecycle
    into strict current_role_revision, current_role_lifecycle
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = context_organization_id
    and role.role_id = assignment_fact.role_id;

  select pg_catalog.jsonb_agg(reference.permission order by
      reference.application_root_id nulls first, reference.owner_kind,
      reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id,
        'permissionId', permission.permission_id,
        'acceptedRegistrationRevision', permission.accepted_registration_revision
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = assignment_fact.role_id
      and permission.role_revision = current_role_revision
  ) as reference;
  if affected_permissions is not null then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'bounded', 'permissions', affected_permissions
    );
  elsif current_role_lifecycle in ('unavailable', 'acceptance_required', 'retired') then
    affected_authority := pg_catalog.jsonb_build_object(
      'kind', 'organization_catalogue'
    );
  else
    raise exception using errcode = '40001',
      message = 'Organization role-assignment authority is stale or unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', affected_authority,
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_assignments.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'multi_factor_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization role-assignment revocation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version, case decision.reason_code when 'authentication_unsatisfied' then 'recent_authentication_required' when 'multi_factor_unsatisfied' then 'multi_factor_required' else null end;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_assignments.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization role-assignment revocation is unavailable';
  end if;

  select assignment_change.* into strict changed
  from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', context_organization_id, p_role_assignment_id,
    p_expected_assignment_revision, null, null, null, null, null, null,
    null, context_account_id, context_correlation_id
  ) as assignment_change;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id, 'key', revision.role_key,
      'label', revision.label, 'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      ) else pg_catalog.jsonb_build_object(
        'kind', 'group', 'groupId', assignment.group_id,
        'key', organization_group.group_key, 'label', organization_group.label,
        'state', organization_group.state
      ) end,
    'revision', assignment.revision, 'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at, 'state', assignment.state,
    'temporalState', 'revoked'
  )) into strict changed_summary
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = context_organization_id
    and assignment.role_assignment_id = p_role_assignment_id;

  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, p_activity_id, changed.changed_at,
    'organization_account', context_account_id, 'revoke_role_assignment',
    array[p_role_assignment_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization role-assignment revocation Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version, null::text;
end
$function$;

revoke execute on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_assignment after fixed protected checks; a current zero-entry unavailable, acceptance_required or retired role uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';

alter function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) owner to vortex_owner;

grant execute on function vortex_access.revoke_organization_role_assignment_for_administration(p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_activity_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.validate_organization_role_assignment_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.revision <> 1
    or new.state <> 'live'
    or (new.expires_at is not null
      and new.expires_at <= pg_catalog.statement_timestamp()) then
    raise exception using errcode = '23514',
      message = 'A new role assignment requires a current live revision-one window';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = new.organization_id
      and role.role_id = new.role_id
      and revision.lifecycle = 'active'
  ) then
    raise exception using errcode = '23514',
      message = 'A new role assignment requires a compatible active role';
  end if;

  if new.assignee_kind = 'organization_account' then
    if not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = new.organization_id
        and account.organization_account_id = new.organization_account_id
        and account.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A new role assignment requires an active same-organization account';
    end if;
  elsif new.assignee_kind = 'group' then
    if not exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = new.organization_id
        and organization_group.group_id = new.group_id
        and organization_group.state = 'active'
    ) then
      raise exception using errcode = '23514',
        message = 'A new role assignment requires an active same-organization Group';
    end if;
  end if;

  return new;
end
$$;

alter function vortex_access.validate_organization_role_assignment_insert() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.validate_organization_role_assignment_insert() FROM PUBLIC;

grant execute on function vortex_access.validate_organization_role_assignment_insert() to postgres;

create or replace function vortex_access.validate_organization_role_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target_organization_id uuid;
  target_role_id uuid;
  target_role_revision bigint;
  target_role_kind text;
  target_lifecycle text;
  target_privilege_classification text;
  target_policy_continuity_revision bigint;
  target_authority_continuity_revision bigint;
  target_application_root_id uuid;
  target_registration_revision bigint;
  previous_lifecycle text;
  previous_policy_continuity_revision bigint;
  previous_authority_continuity_revision bigint;
  authority_broadened boolean;
  permission_count bigint;
  administrative_permission_count bigint;
  inconsistent_permission_count bigint;
  inconsistent_source_count bigint;
begin
  target_organization_id := new.organization_id;
  target_role_id := new.role_id;
  target_role_revision := new.revision;

  select revision.role_kind, revision.lifecycle, revision.privilege_classification,
    revision.policy_continuity_revision,
    revision.authority_continuity_revision,
    revision.application_root_id,
    revision.accepted_registration_revision
  into target_role_kind, target_lifecycle, target_privilege_classification,
    target_policy_continuity_revision,
    target_authority_continuity_revision,
    target_application_root_id,
    target_registration_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = target_organization_id
    and revision.role_id = target_role_id
    and revision.revision = target_role_revision;

  if not found then
    return null;
  end if;

  if target_role_revision = 1 then
    if target_policy_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role policy continuity revision must be one';
    end if;
    if target_authority_continuity_revision <> 1 then
      raise exception using errcode = '23514',
        message = 'An initial organization role authority continuity revision must be one';
    end if;
  else
    select revision.lifecycle,
      revision.policy_continuity_revision,
      revision.authority_continuity_revision
    into previous_lifecycle,
      previous_policy_continuity_revision,
      previous_authority_continuity_revision
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision - 1;

    if not found then
      raise exception using errcode = '23514',
        message = 'An organization role revision requires its immediate predecessor';
    end if;

    -- No role setting changes a role's policy, so every revision keeps its policy continuity.
    if target_policy_continuity_revision <> previous_policy_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Unchanged role policy must preserve policy continuity';
    end if;

    select exists (
      select 1
      from vortex_access.organization_role_permission_entries as current_permission
      where current_permission.organization_id = target_organization_id
        and current_permission.role_id = target_role_id
        and current_permission.role_revision = target_role_revision
        and not exists (
          select 1
          from vortex_access.organization_role_permission_entries as previous_permission
          where previous_permission.organization_id = current_permission.organization_id
            and previous_permission.role_id = current_permission.role_id
            and previous_permission.role_revision = target_role_revision - 1
            and previous_permission.application_root_id is not distinct
              from current_permission.application_root_id
            and previous_permission.owner_kind = current_permission.owner_kind
            and previous_permission.owner_id = current_permission.owner_id
            and previous_permission.permission_id = current_permission.permission_id
            and previous_permission.continuity_revision =
              current_permission.continuity_revision
        )
    ) into authority_broadened;

    if authority_broadened
      or (
        previous_lifecycle in ('unavailable', 'retired')
        and target_lifecycle in ('active', 'acceptance_required')
      ) then
      if previous_authority_continuity_revision = 9007199254740991
        or target_authority_continuity_revision <>
          previous_authority_continuity_revision + 1 then
        raise exception using errcode = '23514',
          message = 'Broadened or restored role authority must advance continuity exactly once';
      end if;
    elsif target_authority_continuity_revision <>
      previous_authority_continuity_revision then
      raise exception using errcode = '23514',
        message = 'Preserved or narrowed role authority must preserve continuity';
    end if;
  end if;

  select pg_catalog.count(*) into permission_count
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision;

  if (target_role_kind = 'custom' or target_lifecycle = 'active')
    and permission_count = 0 then
    raise exception using errcode = '23514',
      message = 'This organization role lifecycle requires accepted permissions';
  end if;

  select pg_catalog.count(*) into inconsistent_source_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = permission.organization_id
    and registration.registration_kind = permission.registration_kind
    and registration.registration_owner_id = permission.registration_owner_id
    and registration.revision = permission.accepted_registration_revision
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and (
      permission.catalogue_fingerprint <> registration.permission_catalogue_fingerprint
    );

  if inconsistent_source_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Role permissions must retain exact catalogue evidence';
  end if;

  select pg_catalog.count(*) into administrative_permission_count
  from vortex_access.organization_role_permission_entries as permission
  join vortex_access.permission_catalogue_entries as catalogue
    on catalogue.organization_id = permission.organization_id
    and catalogue.registration_kind = permission.registration_kind
    and catalogue.registration_owner_id = permission.registration_owner_id
    and catalogue.registration_revision = permission.accepted_registration_revision
    and catalogue.owner_kind = permission.owner_kind
    and catalogue.owner_id = permission.owner_id
    and catalogue.permission_id = permission.permission_id
  where permission.organization_id = target_organization_id
    and permission.role_id = target_role_id
    and permission.role_revision = target_role_revision
    and catalogue.administrative;

  if target_privilege_classification = 'standard'
    and administrative_permission_count <> 0 then
    raise exception using errcode = '23514',
      message = 'Administrative permissions require privileged role classification';
  end if;

  if target_role_kind = 'application' then
    select pg_catalog.count(*) into inconsistent_source_count
    from vortex_access.organization_role_revisions as revision
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = revision.organization_id
      and registration.registration_kind = revision.source_registration_kind
      and registration.registration_owner_id = revision.application_root_id
      and registration.revision = revision.accepted_registration_revision
    where revision.organization_id = target_organization_id
      and revision.role_id = target_role_id
      and revision.revision = target_role_revision
      and (
        revision.source_definition_key <> registration.source_definition_key
        or revision.source_release_revision <> registration.source_revision
        or revision.source_release_version <> registration.source_version
        or revision.source_validation_contract_version <>
          registration.validation_contract_version
      );

    if inconsistent_source_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role source must match exact registration evidence';
    end if;

    select pg_catalog.count(*) into inconsistent_permission_count
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = target_organization_id
      and permission.role_id = target_role_id
      and permission.role_revision = target_role_revision
      and (
        permission.application_root_id is distinct from target_application_root_id
        or permission.accepted_registration_revision <> target_registration_revision
      );

    if inconsistent_permission_count <> 0 then
      raise exception using errcode = '23514',
        message = 'Application role permissions must match accepted registration evidence';
    end if;
  end if;

  return null;
end
$function$;

revoke execute on function vortex_access.validate_organization_role_revision()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.validate_organization_role_revision() is
  'Deferred evidence check of one organisation role revision and its accepted permission entries. Definer, because it fires at commit under the request role, which has no table access.';

alter function vortex_access.validate_organization_role_revision()
  owner to vortex_owner;

create or replace function vortex_platform.grid_view_viewer_targets_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns table (role_ids uuid[], group_ids uuid[])
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return query
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
      coalesce((select pg_catalog.array_agg(member.group_id) from groups as member), '{}'::uuid[]);
end
$function$;

revoke all on function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid) is
  'The roles of the application and the groups the account holds now, which decide the shared grid views it sees; owner-only.';

alter function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid)
  owner to vortex_owner;


-- IAM access requests of the removed kinds role_activation and role_deactivation can never be acted
-- on once role activations are gone. They go in every installation, with the request items linked
-- to them, the relationship edges that touch either and their search documents; activity history
-- stays.
do $$
declare
  request_store record;
  item_store record;
  removed_requests uuid[];
  removed_items uuid[];
  removed_records uuid[];
begin
  for request_store in
    select catalogue.storage_contract_id, catalogue.physical_table_token,
      mapping.physical_column_token
    from vortex_record.storage_catalogue as catalogue
    join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = catalogue.storage_contract_id
    where catalogue.physical_schema_token = 'record_data'
      and catalogue.record_type_definition ->> 'key' = 'access_request'
      and mapping.field_definition ->> 'key' = 'request_type'
      and pg_catalog.to_regclass(
        pg_catalog.format('record_data.%I', catalogue.physical_table_token)
      ) is not null
  loop
    execute pg_catalog.format(
      'with removed as (delete from record_data.%I where %I in (''role_activation'', ''role_deactivation'') returning record_id) '
        || 'select coalesce(pg_catalog.array_agg(record_id), array[]::uuid[]) from removed',
      request_store.physical_table_token, request_store.physical_column_token
    ) into removed_requests;
    raise notice 'IAM access requests of removed kinds deleted from %: %',
      request_store.physical_table_token, pg_catalog.cardinality(removed_requests);
    if pg_catalog.cardinality(removed_requests) = 0 then
      continue;
    end if;
    removed_records := removed_requests;
    for item_store in
      select distinct catalogue.storage_contract_id, catalogue.physical_table_token
      from vortex_record.relationship_edges as edge
      join vortex_record.storage_catalogue as catalogue
        on catalogue.storage_contract_id = edge.from_storage_contract_id
      where edge.to_storage_contract_id = request_store.storage_contract_id
        and edge.to_record_id = any (removed_requests)
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.record_type_definition ->> 'key' = 'access_request_item'
    loop
      execute pg_catalog.format(
        'with removed as (delete from record_data.%I as item where item.record_id in ('
          || 'select edge.from_record_id from vortex_record.relationship_edges as edge '
          || 'where edge.from_storage_contract_id = $1 and edge.to_storage_contract_id = $2 '
          || 'and edge.to_record_id = any ($3)) returning item.record_id) '
          || 'select coalesce(pg_catalog.array_agg(record_id), array[]::uuid[]) from removed',
        item_store.physical_table_token
      ) into removed_items
        using item_store.storage_contract_id, request_store.storage_contract_id, removed_requests;
      raise notice 'IAM request items of those requests deleted from %: %',
        item_store.physical_table_token, pg_catalog.cardinality(removed_items);
      removed_records := removed_records || removed_items;
    end loop;
    delete from vortex_record.relationship_edges as edge
    where edge.from_record_id = any (removed_records) or edge.to_record_id = any (removed_records);
    delete from vortex_record.documents as document
    where document.record_id = any (removed_records);
  end loop;
end
$$;

-- The IAM system projection of role activations: its storage contract and registry row.
delete from vortex_record.field_storage_mappings
where storage_contract_id in (
  select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
  where catalogue.protected_read_model_key = 'role_activations'
);
delete from vortex_record.record_type_lifecycle_policies
where storage_contract_id in (
  select catalogue.storage_contract_id from vortex_record.storage_catalogue as catalogue
  where catalogue.protected_read_model_key = 'role_activations'
);
delete from vortex_record.storage_catalogue where protected_read_model_key = 'role_activations';
delete from vortex_record.protected_read_model_views where protected_read_model_key = 'role_activations';

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check,
  add constraint protected_read_model_views_protected_read_model_key_check check (protected_read_model_key = any (array[
    'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
    'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
    'permissions', 'delegations', 'tenants', 'tenant_administrators', 'installed_applications',
    'application_role_templates', 'activity_entry', 'application_store_entries',
    'connection_instances'
  ]::text[]));
alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check,
  add constraint storage_catalogue_protected_read_model_key_check check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (protected_read_model_key is null or protected_read_model_key = any (array[
      'people', 'organization_accounts', 'roles', 'groups', 'effective_assignments',
      'tenant_structure', 'organization_invitations', 'organization_runtime_settings',
      'permissions', 'delegations', 'tenants', 'tenant_administrators', 'installed_applications',
      'application_role_templates', 'activity_entry', 'application_store_entries',
      'connection_instances'
    ]::text[]))
  );

-- Activations, their writers, readers and triggers.
drop table vortex_access.organization_role_activations;
drop function vortex_access.coordinate_organization_role_activation_change(p_operation text, p_organization_id uuid, p_role_activation_id uuid, p_expected_activation_revision bigint, p_organization_account_id uuid, p_role_id uuid, p_expected_role_revision bigint, p_requested_duration_seconds bigint, p_eligibility_source_kind text, p_role_assignment_id uuid, p_expected_role_assignment_revision bigint, p_membership_id uuid, p_expected_membership_revision bigint, p_changed_by uuid, p_correlation_id uuid);
drop function vortex_access.deactivate_organization_role_activation_for_administration(p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid);
drop function vortex_access.list_organization_role_activations_projection(p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb, p_limit integer, p_predicate jsonb);
drop function vortex_access.project_organization_role_activation_summary(p_organization_id uuid, p_role_activation_id uuid);
drop function vortex_access.protect_organization_role_activation();
drop function vortex_access.validate_organization_role_activation_insert();

-- Role revisions keep no assignment or activation policy. Dropping a column would silently drop
-- every multi-column CHECK that names it, so those are replaced explicitly.
alter table vortex_access.organization_role_revisions
  drop constraint organization_role_revisions_activation_policy_fk,
  drop constraint organization_role_revisions_assignment_policy_shape,
  drop constraint organization_role_revisions_assignment_policy_valid,
  drop constraint organization_role_revisions_ids_non_nil,
  drop constraint organization_role_revisions_revision_range;
drop index vortex_access.organization_role_revisions_activation_policy_idx;
alter table vortex_access.organization_role_revisions
  drop column assignment_policy,
  drop column activation_policy_id,
  drop column activation_policy_revision,
  add constraint organization_role_revisions_ids_non_nil check (
    role_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (application_root_id is null or application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    and changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
    and change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  add constraint organization_role_revisions_revision_range check (
    revision between 1 and 9007199254740991
    and policy_continuity_revision between 1 and 9007199254740991
    and (source_release_revision is null or source_release_revision between 1 and 9007199254740991)
    and (accepted_registration_revision is null
      or accepted_registration_revision between 1 and 9007199254740991)
    and (template_continuity_revision is null
      or template_continuity_revision between 1 and 9007199254740991)
  );
drop table vortex_access.organization_role_activation_policy_revisions;

-- Every role assignment is standing.
alter table vortex_access.organization_role_assignments
  drop constraint organization_role_assignments_kind_valid;
alter table vortex_access.organization_role_assignments
  drop column assignment_kind,
  add constraint organization_role_assignments_kind_valid check (
    assignee_kind = any (array['organization_account', 'group']::text[])
  );

-- No writer records a role activation change.
alter table vortex_access.organization_access_versions
  drop constraint organization_access_versions_reason_valid,
  add constraint organization_access_versions_reason_valid check (change_reason = any (array[
    'organization_initialized', 'organization_account_activated',
    'organization_account_reactivated', 'organization_account_suspended',
    'organization_account_closed', 'role_assignment_changed',
    'delegation_changed', 'stewardship_changed', 'invitation_access_accepted',
    'role_catalogue_changed', 'group_membership_changed', 'application_access_changed',
    'record_ownership_changed', 'access_grant_changed', 'public_policy_changed',
    'federation_mirror_changed', 'mcp_authorization_changed'
  ]::text[]));

reset role;
