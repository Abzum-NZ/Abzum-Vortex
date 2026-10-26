CREATE OR REPLACE FUNCTION vortex_access.lock_record_lifecycle_policy_authority() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint, correlation_id uuid, application_root_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy authority changed';
  end if;

  context_value := vortex_access.validated_human_request_context();

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (context_value ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;

  return query select decision.organization_id, decision.organization_account_id,
    decision.access_version, decision.correlation_id,
    case
      when context_value ? 'applicationRootId'
        then (context_value ->> 'applicationRootId')::uuid
      else null
    end;
end
$$;

alter function vortex_access.lock_record_lifecycle_policy_authority() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() IS 'Access-owned lock and current authority decision for one protected record-type lifecycle policy transaction.';

REVOKE ALL ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.lock_record_lifecycle_policy_authority() TO vortex_owner;

grant execute on function vortex_access.lock_record_lifecycle_policy_authority() to postgres;
