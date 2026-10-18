set local role vortex_owner;

create or replace function vortex_access.grant_organization_delegation_authority_for_administration(
  p_delegation_authority_id uuid, p_holder_kind text, p_holder_id uuid,
  p_expected_holder_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, delegation_summary jsonb, access_version bigint)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid; locked_access_version bigint;
  holder_revision bigint; decision record; changed record; summary jsonb; activity_result text;
begin
  if p_delegation_authority_id is null or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_holder_kind is null or p_holder_kind not in ('organization_account', 'group')
    or p_holder_id is null or p_holder_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_holder_revision is null or p_expected_holder_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Delegation grant input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id and organization.state = 'active'
    and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Delegation grant is unavailable'; end if;

  select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object('operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.assignments.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')))) as evaluated;
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
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001', message = 'Delegation grant refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id, null::jsonb, context_access_version;
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
    raise exception using errcode = '42501', message = 'Delegation grant is unavailable';
  end if;

  if p_holder_kind = 'organization_account' and p_holder_id = context_account_id then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, pg_catalog.clock_timestamp(),
      'organization_account', context_account_id, 'grant_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001', message = 'Delegation grant refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id, null::jsonb, context_access_version;
    return;
  end if;
  if p_holder_kind = 'organization_account' then
    select account.revision into holder_revision from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity on identity.identity_id = account.identity_id
    where account.organization_id = context_organization_id
      and account.organization_account_id = p_holder_id and account.state = 'active'
      and identity.state = 'active' for update of account, identity;
  else
    select organization_group.revision into holder_revision from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = context_organization_id
      and organization_group.group_id = p_holder_id and organization_group.state = 'active' for update;
  end if;
  if holder_revision is distinct from p_expected_holder_revision or exists (
    select 1 from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = context_organization_id and delegation.holder_kind = p_holder_kind
      and (delegation.organization_account_id = p_holder_id or delegation.group_id = p_holder_id)
      and delegation.scope_kind = 'organization_catalogue' and delegation.state = 'live'
      and (delegation.expires_at is null or delegation.expires_at > pg_catalog.clock_timestamp())
  ) then
    raise exception using errcode = '40001', message = 'Delegation holder is stale or already has catalogue authority';
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_delegation_authority_change(
    'grant_delegation', context_organization_id, p_delegation_authority_id, null, p_holder_kind,
    case when p_holder_kind = 'organization_account' then p_holder_id else null end,
    case when p_holder_kind = 'group' then p_holder_id else null end,
    'organization_catalogue', null, pg_catalog.clock_timestamp(), null,
    context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_delegation_summary(context_organization_id, p_delegation_authority_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed delegation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.delegation ->> 'changedAt')::timestamptz, 'organization_account', context_account_id,
    'grant_delegation', array[p_delegation_authority_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Delegation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version;
end $function$;

alter function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid) owner to vortex_owner;
revoke execute on function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid)
to vortex_request, postgres;
comment on function vortex_access.grant_organization_delegation_authority_for_administration(uuid, text, uuid, bigint, uuid) is
  'Grants catalogue delegation to an active person or Group through delegated management; grants no role or Studio permission. Existing delegation revocation removes the authority.';

reset role;
