create or replace function vortex_access.organization_runtime_settings_administration_read_scope() RETURNS TABLE(organization_id uuid, organization_account_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.runtime_settings.read'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.runtime_settings.read'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings administration read is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$$;

alter function vortex_access.organization_runtime_settings_administration_read_scope() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.organization_runtime_settings_administration_read_scope() FROM PUBLIC;

grant execute on function vortex_access.organization_runtime_settings_administration_read_scope() to postgres;
