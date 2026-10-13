CREATE FUNCTION vortex_access.organization_accounts_administration_change_scope() RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare decision record; resolved_tenant_id uuid;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.accounts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '630a980c-0ff5-40b1-a329-7326a2122395'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.accounts.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization account administration change is unavailable';
  end if;
  select organization.tenant_id into strict resolved_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = decision.organization_id;
  return query select resolved_tenant_id, decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$$;

ALTER FUNCTION vortex_access.organization_accounts_administration_change_scope() OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.organization_accounts_administration_change_scope() IS 'Private fixed accounts.manage decision for organisation-local account lifecycle.';

REVOKE ALL ON FUNCTION vortex_access.organization_accounts_administration_change_scope() FROM PUBLIC;
