CREATE FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) RETURNS TABLE(organization_id uuid, outcome text, group_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  group_value jsonb;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_groups_administration_scope() as authorized;

  select pg_catalog.jsonb_build_object(
    'groupId', organization_group.group_id,
    'key', organization_group.group_key,
    'label', organization_group.label,
    'state', organization_group.state,
    'revision', organization_group.revision
  )
  into group_value
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = scope.organization_id
    and organization_group.group_id = p_group_id;

  return query select scope.organization_id,
    case when group_value is null then 'unavailable' else 'available' end,
    group_value, scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) IS 'Returns one safe Group administration detail without exposing current-fact audit evidence.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_group_for_administration(p_group_id uuid) TO vortex_request;
