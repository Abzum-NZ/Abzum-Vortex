create or replace function vortex_access.add_organization_group_membership_for_administration(
  p_membership_id uuid,
  p_group_id uuid,
  p_organization_account_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  membership_summary jsonb,
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
  group_fact vortex_access.organization_groups%rowtype;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  checked_at timestamptz;
  activity_result text;
begin
  if p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership addition input is invalid';
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
      message = 'Organization Group membership addition is unavailable';
  end if;

  select organization_group.* into group_fact
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = p_group_id
  for update;
  if not found or group_fact.state <> 'active' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership addition is stale or unavailable';
  end if;

  authority_after := vortex_access.organization_group_reduction_authority(
    context_organization_id, p_group_id
  );
  authority_requirement := case authority_after ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object('kind', 'none'),
      'after', authority_after
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.group_memberships.add',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', authority_requirement
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.group_memberships.add'
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
    activity_result := vortex_activity.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'add_group_membership',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_context.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group membership addition refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.group_memberships.add'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group membership addition is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', context_organization_id, p_membership_id,
    null, p_group_id, p_organization_account_id, p_starts_at, p_expires_at,
    null, context_account_id, context_correlation_id
  ) as result;

  checked_at := pg_catalog.clock_timestamp();
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'membershipId', membership.membership_id,
    'groupId', membership.group_id,
    'organizationAccountId', membership.organization_account_id,
    'accountDisplayName', account.display_name,
    'revision', membership.revision,
    'startsAt', membership.starts_at,
    'expiresAt', membership.expires_at,
    'state', membership.state,
    'temporalState', case
      when membership.state = 'revoked' then 'revoked'
      when membership.starts_at > checked_at then 'scheduled'
      when membership.expires_at is not null
        and membership.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )) into strict changed_summary
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'add_group_membership',
    array[p_membership_id]::uuid[], array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership addition Activity is stale';
  end if;

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version;
end
$function$;

revoke execute on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid)
to vortex_request;

comment on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid) is
  'Standalone request entry: performs add_membership after fixed protected checks of the caller current authority, the delegation subset and the target organisation account, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';
