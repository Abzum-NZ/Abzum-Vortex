create or replace function vortex_access.appoint_organization_steward_for_administration(
  p_organization_account_id uuid,
  p_expected_account_revision bigint
)
returns table (
  outcome text,
  organization_id uuid,
  appointment_summary jsonb,
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
  stewardship_requirement vortex_access.organization_stewardship_requirements%rowtype;
  target_account vortex_identity.organization_accounts%rowtype;
  steward_role vortex_access.organization_roles%rowtype;
  steward_role_revision vortex_access.organization_role_revisions%rowtype;
  decision record;
  role_grant record;
  delegation_grant record;
  existing_role_assignment_id uuid;
  existing_delegation_authority_id uuid;
  generated_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  generated_delegation_authority_id uuid := pg_catalog.gen_random_uuid();
  activity_id uuid;
  activity_result text;
  appointment_starts_at timestamptz;
  result_summary jsonb;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_account_revision is null
    or p_expected_account_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization steward appointment input is invalid';
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

  select role.* into steward_role
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = stewardship_requirement.original_role_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select revision.* into steward_role_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = steward_role.role_id
    and revision.revision = steward_role.live_revision;
  if not found
    or steward_role_revision.lifecycle is distinct from 'active'
    or steward_role_revision.assignment_policy is distinct from 'standing' then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
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
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_activity.append_organization_activity_entry(
      context_organization_id, activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      vortex_context.channel(), context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
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
  for update of account;
  if not found or p_organization_account_id = context_account_id then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_activity.append_organization_activity_entry(
      context_organization_id, activity_id, appointment_starts_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      vortex_context.channel(), context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;
  if target_account.revision is distinct from p_expected_account_revision then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment is stale or unavailable';
  end if;

  select assignment.role_assignment_id,
    delegation.delegation_authority_id
  into existing_role_assignment_id, existing_delegation_authority_id
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
    and delegation.holder_kind = 'organization_account'
    and delegation.organization_account_id = p_organization_account_id
    and delegation.group_id is null
    and delegation.scope_kind = 'organization_catalogue'
    and delegation.state = 'live'
    and delegation.starts_at <= appointment_starts_at
    and delegation.expires_at is null
  where assignment.organization_id = context_organization_id
    and assignment.role_id = stewardship_requirement.original_role_id
    and assignment.assignee_kind = 'organization_account'
    and assignment.organization_account_id = p_organization_account_id
    and assignment.group_id is null
    and assignment.assignment_kind = 'standing'
    and assignment.state = 'live'
    and assignment.starts_at <= appointment_starts_at
    and assignment.expires_at is null
    and revision.lifecycle = 'active'
    and revision.assignment_policy = 'standing'
  order by assignment.role_assignment_id, delegation.delegation_authority_id
  limit 1;
  if found then
    perform vortex_access.assert_organization_has_permanent_steward(
      context_organization_id
    );
    result_summary := pg_catalog.jsonb_build_object(
      'organizationAccountId', p_organization_account_id,
      'roleAssignmentId', existing_role_assignment_id,
      'delegationAuthorityId', existing_delegation_authority_id
    );
    return query select 'unchanged'::text, context_organization_id,
      result_summary, context_access_version;
    return;
  end if;

  activity_id := pg_catalog.gen_random_uuid();
  select changed.* into strict role_grant
  from vortex_access.coordinate_private_organization_role_assignment_grant(
    generated_role_assignment_id, steward_role.role_id, steward_role.live_revision,
    'organization_account', p_organization_account_id, null, 'standing',
    appointment_starts_at, null, activity_id
  ) as changed;
  if role_grant.outcome is distinct from 'changed'
    or role_grant.organization_id is distinct from context_organization_id
    or role_grant.role_assignment_id is distinct from generated_role_assignment_id
    or role_grant.role_id is distinct from steward_role.role_id
    or role_grant.assignee_kind is distinct from 'organization_account'
    or role_grant.organization_account_id is distinct from p_organization_account_id
    or role_grant.group_id is not null
    or role_grant.assignment_kind is distinct from 'standing'
    or role_grant.revision is distinct from 1
    or role_grant.expires_at is not null
    or role_grant.state is distinct from 'live'
    or role_grant.access_version is distinct from context_access_version + 1 then
    raise exception using errcode = '40001',
      message = 'Organization steward role grant is stale or unavailable';
  end if;

  -- The first coordinator returned this version under the held Access lock. Keep the
  -- verified actor and request evidence, advancing only this transaction-local context.
  context_value := vortex_context.validated(
    pg_catalog.jsonb_set(
      context_value, '{accessVersion}',
      pg_catalog.to_jsonb(role_grant.access_version), true
    )
  );
  perform pg_catalog.set_config('vortex.request_context', context_value::text, true);
  context_value := vortex_access.validated_human_request_context();

  activity_id := pg_catalog.gen_random_uuid();
  select changed.* into strict delegation_grant
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'grant_delegation', generated_delegation_authority_id, null,
    'organization_account', p_organization_account_id, null,
    pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
    appointment_starts_at, null, activity_id
  ) as changed;
  if delegation_grant.outcome is distinct from 'changed'
    or delegation_grant.access_version is distinct from context_access_version + 2 then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation grant is stale or unavailable';
  end if;

  context_value := vortex_context.validated(
    pg_catalog.jsonb_set(
      context_value, '{accessVersion}',
      pg_catalog.to_jsonb(delegation_grant.access_version), true
    )
  );
  perform pg_catalog.set_config('vortex.request_context', context_value::text, true);
  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'accessVersion')::bigint
      is distinct from delegation_grant.access_version
    or not exists (
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
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= appointment_starts_at
        and assignment.expires_at is null
        and role.live_revision = steward_role.live_revision
        and revision.lifecycle = 'active'
        and revision.assignment_policy = 'standing'
        and delegation.delegation_authority_id = generated_delegation_authority_id
        and delegation.holder_kind = 'organization_account'
        and delegation.organization_account_id = p_organization_account_id
        and delegation.group_id is null
        and delegation.scope_kind = 'organization_catalogue'
        and delegation.state = 'live'
        and delegation.starts_at <= appointment_starts_at
        and delegation.expires_at is null
        and account.state = 'active'
        and identity.state = 'active'
    ) then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment result is stale or unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(
    context_organization_id
  );
  result_summary := pg_catalog.jsonb_build_object(
    'organizationAccountId', p_organization_account_id,
    'roleAssignmentId', generated_role_assignment_id,
    'delegationAuthorityId', generated_delegation_authority_id
  );
  return query select 'changed'::text, context_organization_id,
    result_summary, delegation_grant.access_version;
end
$function$;

revoke execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
to vortex_request;

comment on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint) is
  'Verified human request entry: atomically appoints another active same-organisation account to the current steward role and organisation-catalogue delegation through the private coordinators, with safe refusal evidence and no public operation binding.';
