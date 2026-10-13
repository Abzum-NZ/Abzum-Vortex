CREATE FUNCTION vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) RETURNS TABLE(organization_id uuid, group_id uuid, group_key text, label text, state text, revision bigint, created_by_actor_id uuid, created_at timestamp with time zone, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select organization_group.organization_id, organization_group.group_id,
    organization_group.group_key, organization_group.label,
    organization_group.state, organization_group.revision,
    organization_group.created_by, organization_group.created_at,
    organization_group.changed_by, organization_group.changed_at,
    organization_group.change_correlation_id
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = p_organization_id
    and organization_group.group_id = p_group_id
$$;

alter function vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) IS 'Owner-only exact Group fact read; foreign and unknown identities both return no row.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) FROM PUBLIC;

grant execute on function vortex_access.read_organization_group(p_organization_id uuid, p_group_id uuid) to postgres;
