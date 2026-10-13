CREATE FUNCTION vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  permissions jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.application_root_id,
      'ownerKind', permission.owner_kind,
      'ownerId', permission.owner_id,
      'permissionId', permission.permission_id
    )) order by permission.application_root_id nulls first,
      permission.owner_kind collate "C", permission.owner_id,
      permission.permission_id
  ), '[]'::jsonb)
  into permissions
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id = p_organization_id
    and permission.role_id = p_role_id
    and permission.role_revision = p_role_revision;

  if pg_catalog.jsonb_array_length(permissions) = 0 then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', permissions
  );
end
$$;

alter function vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) FROM PUBLIC;

grant execute on function vortex_access.private_current_role_management_scope(p_organization_id uuid, p_role_id uuid, p_role_revision bigint) to postgres;
