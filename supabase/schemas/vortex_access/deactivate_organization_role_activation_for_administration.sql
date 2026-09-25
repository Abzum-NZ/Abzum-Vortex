create or replace function vortex_access.deactivate_organization_role_activation_for_administration(
  p_role_activation_id uuid, p_expected_activation_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, activation_summary jsonb, access_version bigint)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid;
  locked_access_version bigint; activation_fact vortex_access.organization_role_activations%rowtype;
  affected_permissions jsonb; decision record; changed record; summary jsonb;
  activity_result text;
begin
  if p_role_activation_id is null or p_role_activation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_activation_revision is null or p_expected_activation_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Role activation deactivation input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Role activation deactivation is unavailable';
  end if;
  select activation.* into activation_fact
  from vortex_access.organization_role_activations as activation
  where activation.organization_id = context_organization_id
    and activation.role_activation_id = p_role_activation_id for update;
  if not found or activation_fact.revision <> p_expected_activation_revision
    or activation_fact.state <> 'live' then
    raise exception using errcode = '40001', message = 'Role activation deactivation is stale or unavailable';
  end if;
  if activation_fact.organization_account_id <> context_account_id then
    select pg_catalog.jsonb_agg(reference.permission order by reference.application_root_id nulls first,
      reference.owner_kind, reference.owner_id, reference.permission_id) into affected_permissions
    from (select permission.application_root_id, permission.owner_kind, permission.owner_id,
      permission.permission_id, pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id, 'ownerKind', permission.owner_kind,
        'ownerId', permission.owner_id, 'permissionId', permission.permission_id)) as permission
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = context_organization_id
        and permission.role_id = activation_fact.role_id
        and permission.role_revision = activation_fact.historical_role_revision) as reference;
    if affected_permissions is null then
      raise exception using errcode = '40001', message = 'Role activation historical scope is unavailable';
    end if;
    select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object('operationKey', 'platform.organization.role_activations.revoke',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object('ownerKind', 'platform',
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions', affected_permissions),
          'after', pg_catalog.jsonb_build_object('kind', 'none')))) as evaluated;
    if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.role_activations.revoke'
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
      'organization_account', context_account_id, 'revoke_role_activation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_context.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Role activation deactivation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.role_activations.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Role activation deactivation is unavailable';
  end if;
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_role_activation_change(
    'revoke_role_activation', context_organization_id, p_role_activation_id,
    p_expected_activation_revision, null, null, null, null, null, null, null,
    null, null, context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_role_activation_summary(context_organization_id, p_role_activation_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed activation projection is unavailable'; end if;
  activity_result := vortex_activity.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.activation ->> 'changedAt')::timestamptz, 'organization_account',
    context_account_id, 'revoke_role_activation', array[p_role_activation_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Role activation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version;
end $function$;

revoke execute on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.deactivate_organization_role_activation_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_activation after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';
