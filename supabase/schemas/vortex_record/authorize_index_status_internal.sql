CREATE FUNCTION vortex_record.authorize_index_status_internal(p_organization_id uuid, p_application_root_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  permission_decision record;
  checked_context jsonb;
begin
  if p_organization_id is null
    or p_organization_id = nil_uuid
    or p_application_root_id is null
    or p_application_root_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Index status command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.index_status',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Index status authority is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Index status context changed';
  end if;

  -- The organisation and the Application are both the validated request
  -- context's own. The conflict search runs behind the `record_data` policies
  -- of that context, so a status for any other Application would resolve
  -- conflicts against the wrong rows.
  if permission_decision.organization_id is distinct from p_organization_id
    or (checked_context ->> 'applicationRootId') is null
    or (checked_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Index status scope is unavailable';
  end if;

  -- The named Application must be a real Application of exactly this
  -- organisation; a foreign or non-Application root is one refusal.
  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.kind = 'application'
      and root.organization_id = permission_decision.organization_id
  ) then
    raise exception using errcode = '42501',
      message = 'Index status Application is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', permission_decision.organization_id,
    'accessVersion', permission_decision.access_version
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '42501',
      message = 'Index status authority is unavailable';
end
$$;

COMMENT ON FUNCTION vortex_record.authorize_index_status_internal(p_organization_id uuid, p_application_root_id uuid) IS 'Private authority for the index-status read: Application-management permission, validated organisation context and the exact owned Application.';

REVOKE ALL ON FUNCTION vortex_record.authorize_index_status_internal(p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
