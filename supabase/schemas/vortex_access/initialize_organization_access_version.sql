CREATE FUNCTION vortex_access.initialize_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(organization_id uuid, current_version bigint, changed_at timestamp with time zone, changed_by uuid, change_correlation_id uuid, change_reason text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Access-version initialization input is invalid';
  end if;

  insert into vortex_access.organization_access_versions as version (
    organization_id, current_version, changed_at, changed_by,
    change_correlation_id, change_reason
  ) values (
    p_organization_id, 1, operation_at, p_changed_by,
    p_correlation_id, 'organization_initialized'
  ) on conflict on constraint organization_access_versions_pk do nothing;

  return query
  select version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;
end
$$;

ALTER FUNCTION vortex_access.initialize_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.initialize_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;
