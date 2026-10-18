CREATE OR REPLACE FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  -- The registration the request runs under: the installed one, or the preview's own.
  if not exists (
    select 1
    from vortex_access.request_application_registration_internal(
      resolved_organization_id, p_application_root_id, resolved_organization_account_id
    )
  ) then
    raise exception using errcode = '42501',
      message = 'Application selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$$;

alter function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) IS 'Resolves one exact active human organisation scope and active application registration under the organisation''s shared Access lock, for reads and ordinary changes alike.';

REVOKE ALL ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) TO vortex_runtime;

grant execute on function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;
