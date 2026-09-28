create or replace function vortex_module.read_application_installation_bindings(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  binding_evidence jsonb;
  staged_binding_evidence jsonb;
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
  from vortex_module.installation_bindings as binding
  where binding.organization_id = authority.organization_id
    and binding.application_root_id = p_application_root_id;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', staged.organization_id,
      'applicationRootId', staged.application_root_id,
      'moduleRootId', staged.module_root_id,
      'bindingRevision', staged.binding_revision,
      'applicationReleaseRevision', staged.application_release_revision,
      'moduleReleaseRevision', staged.module_release_revision,
      'state', 'provisioned'
    ) order by staged.application_release_revision, staged.module_root_id), '[]'::jsonb)
  into staged_binding_evidence
  from vortex_module.staged_installation_bindings as staged
  where staged.organization_id = authority.organization_id
    and staged.application_root_id = p_application_root_id;

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
    'moduleBindings', binding_evidence,
    'stagedModuleBindings', staged_binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
end
$function$;

alter function vortex_module.read_application_installation_bindings(uuid) owner to vortex_module_owner;

revoke all on function vortex_module.read_application_installation_bindings(uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.read_application_installation_bindings(uuid)
  to vortex_request;
comment on function vortex_module.read_application_installation_bindings(uuid) is
  'Installer-only read of current and staged Module bindings plus the registered release under application-management authority.';
