CREATE OR REPLACE FUNCTION vortex_record.authorize_storage_conversion_internal(p_storage_contract_id uuid, p_installed_release_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  permission_decision record;
  checked_context jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  scope_application_root_id uuid;
  owns_module boolean;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      p_installed_release_revision is not null
      and p_installed_release_revision not between 1 and 9007199254740991
    ) then
    raise exception using errcode = '22023',
      message = 'Storage conversion command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.storage_conversion',
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
      message = 'Storage conversion authority is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Storage conversion context changed';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  if catalogue_row.storage_scope = 'application_contained' then
    if not coalesce(
      vortex_platform.is_non_nil_uuid(checked_context ->> 'applicationRootId'), false
    ) then
      raise exception using errcode = '42501',
        message = 'Storage conversion requires an application context';
    end if;
    scope_application_root_id := (checked_context ->> 'applicationRootId')::uuid;
  else
    scope_application_root_id := null;
  end if;

  owns_module := exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = catalogue_row.module_root_id
      and root.kind = 'module'
      and root.organization_id = permission_decision.organization_id
  );

  if p_installed_release_revision is not null
    and not vortex_definition.storage_conversion_is_installed_internal(
      permission_decision.organization_id, scope_application_root_id,
      p_storage_contract_id, catalogue_row.module_root_id, p_installed_release_revision
    ) then
    raise exception using errcode = '42501',
      message = 'Storage conversion installation is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', permission_decision.organization_id,
    'organizationAccountId', permission_decision.organization_account_id,
    'accessVersion', permission_decision.access_version,
    'correlationId', permission_decision.correlation_id,
    'applicationRootId', scope_application_root_id,
    'ownsModule', owns_module
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '42501',
      message = 'Storage conversion authority is unavailable';
end
$$;
alter function vortex_record.authorize_storage_conversion_internal(uuid,bigint) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.authorize_storage_conversion_internal(p_storage_contract_id uuid, p_installed_release_revision bigint) IS 'Private authority for storage conversion: Application-management permission, validated tenant scope, Module ownership and, when named, an active installation of the exact source release.';

REVOKE ALL ON FUNCTION vortex_record.authorize_storage_conversion_internal(p_storage_contract_id uuid, p_installed_release_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.authorize_storage_conversion_internal(p_storage_contract_id uuid, p_installed_release_revision bigint) TO vortex_record_adapter;
