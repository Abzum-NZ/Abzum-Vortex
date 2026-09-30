-- #729: immutable same-cluster source and recipient consent decisions.
--
-- Each decision is bound to one protected human organisation context, the
-- locked proposal revision and fingerprint, a current named role path and
-- genuine recent MFA evidence. The table has no client access. Recording both
-- decisions does not activate or publish a grant.

begin;

create table vortex_access.record_share_grant_consent_decisions (
  decision_id uuid primary key,
  request_id uuid not null
    references vortex_access.record_share_grant_consent_requests (request_id),
  grant_id uuid not null
    references vortex_access.record_share_grants (grant_id),
  tenant_id uuid not null
    references vortex_identity.tenants (tenant_id),
  source_organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  recipient_organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  side text not null,
  approver_organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  approver_organization_account_id uuid not null
    references vortex_identity.organization_accounts (organization_account_id),
  approver_application_root_id uuid not null,
  proposal_revision bigint not null,
  proposed_grant_fingerprint text not null,
  proposal_expires_at timestamptz not null,
  access_version bigint not null,
  decision text not null,
  note text,
  authorization_path jsonb not null,
  multi_factor_authenticated_at timestamptz not null,
  multi_factor_authentication_expires_at timestamptz not null,
  decided_at timestamptz not null,
  expires_at timestamptz not null,
  correlation_id uuid not null,
  constraint record_share_grant_consent_decisions_ids_non_nil check (
    decision_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and approver_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint record_share_grant_consent_decisions_proposal_valid check (
    source_organization_id <> recipient_organization_id
    and proposal_revision between 1 and 9007199254740991
    and proposed_grant_fingerprint ~ '^sha256:[a-f0-9]{64}$'
    and access_version between 1 and 9007199254740991
  ),
  constraint record_share_grant_consent_decisions_side_valid check (
    side in ('source_authorization', 'recipient_acceptance')
    and ((side = 'source_authorization'
        and approver_organization_id = source_organization_id)
      or (side = 'recipient_acceptance'
        and approver_organization_id = recipient_organization_id))
  ),
  constraint record_share_grant_consent_decisions_decision_valid check (
    decision in ('consented', 'refused')
    and (note is null or pg_catalog.char_length(note) <= 500)
  ),
  constraint record_share_grant_consent_decisions_path_valid check (
    pg_catalog.jsonb_typeof(authorization_path) = 'object'
    and authorization_path ->> 'kind' in (
      'direct', 'group', 'activated_pim_direct', 'activated_pim_group'
    )
    and authorization_path ->> 'roleId' is not null
    and authorization_path ->> 'roleId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and authorization_path ->> 'roleAssignmentId' is not null
    and authorization_path ->> 'roleAssignmentId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and authorization_path ->> 'validUntil' is not null
    and ((authorization_path ->> 'kind' = 'direct'
        and not (authorization_path ? 'membershipId')
        and not (authorization_path ? 'roleActivationId'))
      or (authorization_path ->> 'kind' = 'group'
        and authorization_path ->> 'membershipId' is not null
        and not (authorization_path ? 'roleActivationId'))
      or (authorization_path ->> 'kind' = 'activated_pim_direct'
        and not (authorization_path ? 'membershipId')
        and authorization_path ->> 'roleActivationId' is not null)
      or (authorization_path ->> 'kind' = 'activated_pim_group'
        and authorization_path ->> 'membershipId' is not null
        and authorization_path ->> 'roleActivationId' is not null))
  ),
  constraint record_share_grant_consent_decisions_mfa_valid check (
    multi_factor_authenticated_at <= decided_at
    and multi_factor_authenticated_at >= decided_at - interval '300 seconds'
    and multi_factor_authentication_expires_at >= decided_at
    and multi_factor_authentication_expires_at <=
      multi_factor_authenticated_at + interval '300 seconds'
    and expires_at between decided_at and multi_factor_authentication_expires_at
    and expires_at <= proposal_expires_at
    and proposal_expires_at > decided_at
  ),
  constraint record_share_grant_consent_decisions_finite_time check (
    multi_factor_authenticated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and multi_factor_authentication_expires_at not in (
      '-infinity'::timestamptz, 'infinity'::timestamptz
    )
    and proposal_expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and decided_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  constraint record_share_grant_consent_decisions_request_revision_side_unique unique (
    request_id, proposal_revision, side
  )
);

create index record_share_grant_consent_decisions_grant_idx
  on vortex_access.record_share_grant_consent_decisions (grant_id, side);

alter table vortex_access.record_share_grant_consent_decisions enable row level security;
alter table vortex_access.record_share_grant_consent_decisions force row level security;

revoke all on table vortex_access.record_share_grant_consent_decisions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter, vortex_access_owner;

comment on table vortex_access.record_share_grant_consent_decisions is
  'Private immutable one-per-side decisions bound to one same-cluster record-share proposal revision, named role path and recent MFA evidence; no row or grant is activated here.';

create or replace function vortex_access.record_share_grant_consent_role_path_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid,
  p_authorized_role_ids uuid[],
  p_checked_at timestamptz,
  p_context_expires_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  evidence jsonb;
begin
  if p_organization_id is null
    or p_organization_account_id is null
    or p_application_root_id is null
    or p_authorized_role_ids is null
    or pg_catalog.cardinality(p_authorized_role_ids) not between 1 and 100
    or p_checked_at is null
    or p_context_expires_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_context_expires_at <= p_checked_at
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_authorized_role_ids)
    or (select pg_catalog.count(distinct supplied.role_id)
        from pg_catalog.unnest(p_authorized_role_ids) as supplied(role_id))
      <> pg_catalog.cardinality(p_authorized_role_ids) then
    return null;
  end if;

  with current_roles as materialized (
    select role.role_id, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision,
      revision.activation_policy_id,
      revision.activation_policy_revision,
      revision.activation_policy_fingerprint
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = p_organization_id
      and role.role_id = any (p_authorized_role_ids)
      and (role.application_root_id is null
        or role.application_root_id = p_application_root_id)
      and (role.derived_application_root_id is null
        or role.derived_application_root_id = p_application_root_id)
      and revision.application_root_id is not distinct from role.application_root_id
      and revision.lifecycle in ('active', 'acceptance_required')
  ), route_candidates as (
    select
      1 as route_rank,
      'direct'::text as path_kind,
      role.role_id,
      assignment.role_assignment_id,
      null::uuid as membership_id,
      null::uuid as role_activation_id,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at)
      ) as path_valid_until
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    where role.assignment_policy = 'standing'

    union all

    select
      2,
      'group',
      role.role_id,
      assignment.role_assignment_id,
      membership.membership_id,
      null::uuid,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at),
        coalesce(membership.expires_at, p_context_expires_at)
      )
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = p_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at)
    where role.assignment_policy = 'standing'

    union all

    select
      3,
      'activated_pim_direct',
      role.role_id,
      assignment.role_assignment_id,
      null::uuid,
      activation.role_activation_id,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at),
        activation.expires_at
      )
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = p_organization_account_id
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= p_checked_at
      and activation.expires_at > p_checked_at
      and activation.authority_continuity_revision =
        role.authority_continuity_revision
      and activation.policy_continuity_revision =
        role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision =
        role.activation_policy_revision
      and activation.activation_policy_fingerprint =
        role.activation_policy_fingerprint
    where role.assignment_policy = 'activation_required'

    union all

    select
      4,
      'activated_pim_group',
      role.role_id,
      assignment.role_assignment_id,
      membership.membership_id,
      activation.role_activation_id,
      least(
        p_context_expires_at,
        coalesce(assignment.expires_at, p_context_expires_at),
        coalesce(membership.expires_at, p_context_expires_at),
        activation.expires_at
      )
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = p_organization_id
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and (assignment.expires_at is null or assignment.expires_at > p_checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = p_organization_account_id
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= p_checked_at
      and activation.expires_at > p_checked_at
      and activation.authority_continuity_revision =
        role.authority_continuity_revision
      and activation.policy_continuity_revision =
        role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision =
        role.activation_policy_revision
      and activation.activation_policy_fingerprint =
        role.activation_policy_fingerprint
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = p_organization_account_id
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at)
    where role.assignment_policy = 'activation_required'
  )
  select pg_catalog.jsonb_build_object(
    'kind', route.path_kind,
    'roleId', route.role_id,
    'roleAssignmentId', route.role_assignment_id,
    'validUntil', pg_catalog.to_char(
      route.path_valid_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
    || case when route.membership_id is null then '{}'::jsonb else
      pg_catalog.jsonb_build_object('membershipId', route.membership_id) end
    || case when route.role_activation_id is null then '{}'::jsonb else
      pg_catalog.jsonb_build_object('roleActivationId', route.role_activation_id) end
  into evidence
  from route_candidates as route
  where route.path_valid_until > p_checked_at
  order by route.route_rank, route.role_id, route.role_assignment_id,
    route.membership_id nulls first, route.role_activation_id nulls first
  limit 1;

  return evidence;
end
$function$;

revoke all on function vortex_access.record_share_grant_consent_role_path_internal(
  uuid, uuid, uuid, uuid[], timestamptz, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.record_share_grant_consent_role_path_internal(
  uuid, uuid, uuid, uuid[], timestamptz, timestamptz
) to postgres;

comment on function vortex_access.record_share_grant_consent_role_path_internal(
  uuid, uuid, uuid, uuid[], timestamptz, timestamptz
) is
  'Private current direct, Group or activated-PIM path for one of the proposal''s exact consent roles; returns bounded path evidence or null.';
create or replace function vortex_access.record_share_grant_consent_decision_for_administration(
  p_decision_id uuid,
  p_request_id uuid,
  p_expected_revision bigint,
  p_expected_proposal_fingerprint text,
  p_decision text,
  p_note text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_tenant_id uuid;
  context_organization_id uuid;
  context_account_id uuid;
  context_application_root_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_expires_at timestamptz;
  context_multi_factor_at timestamptz;
  authentication_expires_at timestamptz;
  locked_access_version bigint;
  current_access_version bigint;
  lock_organization_id uuid;
  pre_source_organization_id uuid;
  pre_source_application_root_id uuid;
  pre_recipient_organization_id uuid;
  pre_recipient_application_root_id uuid;
  registration_target record;
  stored_grant vortex_access.record_share_grants%rowtype;
  stored_request vortex_access.record_share_grant_consent_requests%rowtype;
  source_tenant_id uuid;
  recipient_tenant_id uuid;
  side_value text;
  role_ids uuid[];
  checked_at timestamptz;
  path_checked_at timestamptz;
  authorization_path jsonb;
  path_valid_until timestamptz;
  source_authority jsonb;
  readable_ceiling uuid[];
  changeable_ceiling uuid[];
  decision_expires_at timestamptz;
  inserted_decision_id uuid;
  activity_result text;
begin
  if p_decision_id is null
    or p_decision_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_request_id is null
    or p_request_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_expected_proposal_fingerprint is null
    or p_expected_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_decision is null
    or p_decision not in ('consented', 'refused')
    or (p_note is not null and pg_catalog.char_length(p_note) > 500)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share consent decision is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_tenant_id := (context_value ->> 'tenantId')::uuid;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_expires_at := (context_value ->> 'expiresAt')::timestamptz;
  context_multi_factor_at :=
    (context_value ->> 'multiFactorAuthenticatedAt')::timestamptz;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_value ->> 'authenticationStrength' is distinct from 'multi_factor'
    or context_multi_factor_at is null
    or context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is unavailable';
  end if;

  select grants.source_organization_id, grants.source_application_root_id,
    grants.recipient_organization_id, grants.recipient_application_root_id
  into pre_source_organization_id, pre_source_application_root_id,
    pre_recipient_organization_id, pre_recipient_application_root_id
  from vortex_access.record_share_grants as grants
  join vortex_access.record_share_grant_consent_requests as requests
    on requests.request_id = grants.consent_request_id
    and requests.grant_id = grants.grant_id
  where requests.request_id = p_request_id;
  if not found
    or pre_source_organization_id is null
    or pre_source_application_root_id is null
    or pre_recipient_organization_id is null
    or pre_recipient_application_root_id is null
    or pre_source_organization_id = pre_recipient_organization_id
    or context_organization_id not in (
      pre_source_organization_id, pre_recipient_organization_id
    ) then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  -- The human change-scope resolver already holds the caller's Access-version
  -- row FOR UPDATE. Lock both participant versions by organisation ID, then
  -- exact application registrations by (organisation ID, application root ID).
  -- FOR SHARE is the weakest lock that blocks non-key updates. NOWAIT avoids a
  -- cross-side deadlock when the preheld caller row reverses UUID order; SQLSTATE
  -- 55P03 becomes a retryable unavailable result at the service boundary.
  for lock_organization_id in
    select participant.organization_id
    from (values
      (pre_source_organization_id),
      (pre_recipient_organization_id)
    ) as participant(organization_id)
    order by participant.organization_id
  loop
    select version.current_version into current_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = lock_organization_id
    for share nowait;
    if not found then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
    if lock_organization_id = context_organization_id then
      locked_access_version := current_access_version;
    end if;
  end loop;
  if locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  for registration_target in
    select participant.organization_id, participant.application_root_id
    from (values
      (pre_source_organization_id, pre_source_application_root_id),
      (pre_recipient_organization_id, pre_recipient_application_root_id)
    ) as participant(organization_id, application_root_id)
    order by participant.organization_id, participant.application_root_id
  loop
    perform 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = registration_target.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = registration_target.application_root_id
      and registration.state = 'active'
    for share nowait;
    if not found then
      raise exception using errcode = '42501',
        message = 'Record-share consent application is unavailable';
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id in (
      pre_source_organization_id, pre_recipient_organization_id
    )
      and organization.state = 'active'
      and tenant.state = 'active'
  ) <> 2 then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select grants.* into stored_grant
  from vortex_access.record_share_grants as grants
  where grants.consent_request_id = p_request_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select requests.* into stored_request
  from vortex_access.record_share_grant_consent_requests as requests
  where requests.request_id = p_request_id
    and requests.grant_id = stored_grant.grant_id
  for update;
  if not found
    or stored_grant.revision <> p_expected_revision
    or stored_request.revision <> p_expected_revision
    or stored_grant.status <> 'pending_consent'
    or stored_request.status <> 'pending'
    or stored_grant.consent_request_id is distinct from stored_request.request_id
    or stored_grant.proposal_fingerprint is distinct from
      stored_request.proposed_grant_fingerprint
    or stored_grant.proposal_fingerprint is distinct from
      p_expected_proposal_fingerprint
    or stored_grant.source_organization_id is distinct from
      stored_request.source_organization_id
    or stored_grant.source_organization_id is distinct from
      pre_source_organization_id
    or stored_grant.source_cluster_id is distinct from
      stored_request.source_cluster_id
    or stored_grant.source_application_root_id is distinct from
      pre_source_application_root_id
    or stored_grant.recipient_organization_id is distinct from
      stored_request.recipient_organization_id
    or stored_grant.recipient_organization_id is distinct from
      pre_recipient_organization_id
    or stored_grant.recipient_cluster_id is distinct from
      stored_request.recipient_cluster_id
    or stored_grant.recipient_application_root_id is distinct from
      pre_recipient_application_root_id
    or stored_grant.expires_at is distinct from stored_request.expires_at
    or stored_grant.source_organization_id = stored_grant.recipient_organization_id
    or stored_grant.source_cluster_id is distinct from stored_grant.recipient_cluster_id then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is stale or unavailable';
  end if;

  if context_organization_id = stored_grant.source_organization_id then
    side_value := 'source_authorization';
    role_ids := stored_request.source_authorizing_role_ids;
    if context_application_root_id is distinct from
      stored_grant.source_application_root_id then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
  elsif context_organization_id = stored_grant.recipient_organization_id then
    side_value := 'recipient_acceptance';
    role_ids := stored_request.recipient_accepting_role_ids;
    if context_application_root_id is distinct from
      stored_grant.recipient_application_root_id then
      raise exception using errcode = '42501',
        message = 'Record-share consent decision is unavailable';
    end if;
  else
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  select source.tenant_id, recipient.tenant_id
  into source_tenant_id, recipient_tenant_id
  from vortex_identity.organizations as source
  join vortex_identity.tenants as source_tenant
    on source_tenant.tenant_id = source.tenant_id
    and source_tenant.state = 'active'
  join vortex_identity.organizations as recipient
    on recipient.organization_id = stored_grant.recipient_organization_id
    and recipient.state = 'active'
  join vortex_identity.tenants as recipient_tenant
    on recipient_tenant.tenant_id = recipient.tenant_id
    and recipient_tenant.state = 'active'
  where source.organization_id = stored_grant.source_organization_id
    and source.state = 'active';
  if not found
    or (side_value = 'source_authorization'
      and source_tenant_id is distinct from context_tenant_id)
    or (side_value = 'recipient_acceptance'
      and recipient_tenant_id is distinct from context_tenant_id) then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is unavailable';
  end if;

  path_checked_at := pg_catalog.clock_timestamp();
  if context_expires_at is null
    or context_expires_at <= path_checked_at
    or context_multi_factor_at > path_checked_at
    or context_multi_factor_at < path_checked_at - interval '300 seconds'
    or stored_grant.expires_at is null
    or stored_grant.expires_at <= path_checked_at
    or stored_request.expires_at <= path_checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  authorization_path :=
    vortex_access.record_share_grant_consent_role_path_internal(
      context_organization_id,
      context_account_id,
      context_application_root_id,
      role_ids,
      path_checked_at,
      context_expires_at
    );
  if authorization_path is null then
    raise exception using errcode = '42501',
      message = 'Record-share consent role path is unavailable';
  end if;
  path_valid_until := (authorization_path ->> 'validUntil')::timestamptz;

  if side_value = 'source_authorization' then
    source_authority :=
      vortex_access.record_share_grant_source_authority_internal(
        context_value, stored_grant.module_root_id, stored_grant.record_type_id
      );
    if source_authority is null
      or pg_catalog.jsonb_typeof(source_authority -> 'recordTypeIds') is distinct from 'array'
      or pg_catalog.jsonb_array_length(source_authority -> 'recordTypeIds') = 0
      or pg_catalog.jsonb_typeof(source_authority -> 'readableFieldIds') is distinct from 'array'
      or pg_catalog.jsonb_typeof(source_authority -> 'changeableFieldIds') is distinct from 'array' then
      raise exception using errcode = '42501',
        message = 'Record-share consent requires current source share permission';
    end if;
    select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
    into readable_ceiling
    from pg_catalog.jsonb_array_elements_text(
      source_authority -> 'readableFieldIds'
    ) as field(value);
    select coalesce(pg_catalog.array_agg(field.value::uuid), array[]::uuid[])
    into changeable_ceiling
    from pg_catalog.jsonb_array_elements_text(
      source_authority -> 'changeableFieldIds'
    ) as field(value);
    if not (stored_grant.readable_field_ids <@ readable_ceiling)
      or not (stored_grant.changeable_field_ids <@ changeable_ceiling) then
      raise exception using errcode = '42501',
        message = 'Record-share consent exceeds current source field authority';
    end if;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  if context_expires_at <= checked_at
    or context_multi_factor_at > checked_at
    or context_multi_factor_at < checked_at - interval '300 seconds'
    or stored_grant.expires_at <= checked_at
    or stored_request.expires_at <= checked_at
    or path_valid_until <= checked_at then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision evidence is stale or unavailable';
  end if;

  authentication_expires_at := least(
    context_expires_at,
    context_multi_factor_at + interval '300 seconds'
  );
  decision_expires_at := least(
    authentication_expires_at,
    path_valid_until,
    stored_grant.expires_at,
    stored_request.expires_at
  );

  insert into vortex_access.record_share_grant_consent_decisions (
    decision_id,
    request_id,
    grant_id,
    tenant_id,
    source_organization_id,
    recipient_organization_id,
    side,
    approver_organization_id,
    approver_organization_account_id,
    approver_application_root_id,
    proposal_revision,
    proposed_grant_fingerprint,
    proposal_expires_at,
    access_version,
    decision,
    note,
    authorization_path,
    multi_factor_authenticated_at,
    multi_factor_authentication_expires_at,
    decided_at,
    expires_at,
    correlation_id
  ) values (
    p_decision_id,
    stored_request.request_id,
    stored_grant.grant_id,
    context_tenant_id,
    stored_grant.source_organization_id,
    stored_grant.recipient_organization_id,
    side_value,
    context_organization_id,
    context_account_id,
    context_application_root_id,
    stored_grant.revision,
    stored_grant.proposal_fingerprint,
    stored_grant.expires_at,
    locked_access_version,
    p_decision,
    p_note,
    authorization_path,
    context_multi_factor_at,
    authentication_expires_at,
    checked_at,
    decision_expires_at,
    context_correlation_id
  )
  on conflict (request_id, proposal_revision, side) do nothing
  returning decision_id into inserted_decision_id;
  if not found or inserted_decision_id is distinct from p_decision_id then
    raise exception using errcode = '42501',
      message = 'Record-share consent decision is already recorded or unavailable';
  end if;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id,
    p_activity_id,
    checked_at,
    'organization_account',
    context_account_id,
    'record_share_consent_decision',
    array[stored_grant.grant_id, stored_request.request_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    context_correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share consent decision Activity is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'decisionId', p_decision_id,
    'requestId', stored_request.request_id,
    'side', side_value,
    'proposedGrantFingerprint', stored_grant.proposal_fingerprint,
    'proposalRevision', stored_grant.revision,
    'approverOrganizationId', context_organization_id,
    'approverOrganizationAccountId', context_account_id,
    'approverApplicationRootId', context_application_root_id,
    'accessVersion', locked_access_version,
    'proposalExpiresAt', pg_catalog.to_char(
      stored_grant.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'decision', p_decision,
    'decidedAt', pg_catalog.to_char(
      checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'authorizationPath', authorization_path,
    'authenticationStrength', 'recent_multi_factor',
    'multiFactorAuthenticatedAt', pg_catalog.to_char(
      context_multi_factor_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'multiFactorAuthenticationExpiresAt', pg_catalog.to_char(
      authentication_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'expiresAt', pg_catalog.to_char(
      decision_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'correlationId', context_correlation_id
  ) || case when p_note is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('note', p_note) end;
end
$function$;

revoke all on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, text, uuid
) to vortex_request;

comment on function vortex_access.record_share_grant_consent_decision_for_administration(
  uuid, uuid, bigint, text, text, text, uuid
) is
  'Fixed protected same-cluster consent writer: records one immutable side decision for the locked current proposal, requiring current named role-path evidence, source share and field authority where applicable and MFA no older than 300 seconds; it never activates a grant.';
commit;
