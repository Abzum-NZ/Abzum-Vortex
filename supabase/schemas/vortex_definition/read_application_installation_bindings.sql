CREATE OR REPLACE FUNCTION vortex_definition.read_application_installation_bindings(p_application_root_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  authority record;
  binding_evidence jsonb;
  registered_release_revision bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application installation read command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_application_root_id
      and root.organization_id = authority.organization_id
      and root.kind = 'application'
  ) then
    raise exception using errcode = 'P0002',
      message = 'Application installation is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', binding.organization_id,
      'applicationRootId', binding.application_root_id,
      'moduleRootId', binding.module_root_id,
      'bindingRevision', binding.binding_revision,
      'applicationReleaseRevision', binding.application_release_revision,
      'moduleReleaseRevision', binding.module_release_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into binding_evidence
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id;

  -- The exact release the active permission registration was prepared from,
  -- or null when it is absent or withdrawn. The fixed activation requires it
  -- to name the release being activated.
  select snapshot.release_revision into registered_release_revision
  from vortex_access.read_application_permission_snapshot(
    authority.organization_id, p_application_root_id
  ) as snapshot;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority.organization_id,
    'applicationRootId', p_application_root_id,
    'registeredReleaseRevision', registered_release_revision,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
end
$$;
alter function vortex_definition.read_application_installation_bindings(uuid) owner to vortex_owner;


COMMENT ON FUNCTION vortex_definition.read_application_installation_bindings(p_application_root_id uuid) IS 'Installer-only read of one Application''s current Module binding revisions and registered release under application-management authority.';

REVOKE ALL ON FUNCTION vortex_definition.read_application_installation_bindings(p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_definition.read_application_installation_bindings(p_application_root_id uuid) TO vortex_request;
