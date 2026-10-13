CREATE FUNCTION vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) RETURNS TABLE(tenant_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  decision record;
  operation_value text;
  organization_tenant_id uuid;
begin
  if p_mode is null or p_mode not in ('grant', 'revoke', 'read') then
    raise exception using errcode = '22023', message = 'Flow execution binding authority mode is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (context_value ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  operation_value := case p_mode
    when 'grant' then 'platform.organization.execution_bindings.grant'
    when 'revoke' then 'platform.organization.execution_bindings.revoke'
    else 'platform.organization.execution_bindings.read'
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object(
        'actionKind', case when p_mode = 'read' then 'read' else 'manage' end),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', case when p_mode = 'read'
          then '9901c0dc-8bac-45c7-be0b-3642cb839bb1'
          else '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
        end
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', case p_mode
        when 'grant' then pg_catalog.jsonb_build_object(
          'kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'none'),
          'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'))
        when 'revoke' then pg_catalog.jsonb_build_object(
          'kind', 'delegated_management',
          'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
          'after', pg_catalog.jsonb_build_object('kind', 'none'))
        else pg_catalog.jsonb_build_object('kind', 'permission')
      end
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from p_organization_id
    or decision.organization_account_id is distinct from p_actor_organization_account_id
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  select organization.tenant_id into organization_tenant_id
  from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
    and organization.state = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Flow execution binding administration is unavailable';
  end if;

  return query select organization_tenant_id,
    decision.access_version,
    decision.correlation_id;
end
$$;

alter function vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) FROM PUBLIC;

grant execute on function vortex_access.flow_execution_binding_authority_internal(p_actor_identity_id uuid, p_actor_organization_account_id uuid, p_organization_id uuid, p_mode text) to postgres;
