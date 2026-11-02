-- Step 3 of removing an application, run as vortex_owner: the roots themselves, modules first.
create or replace function vortex_definition.purge_application_roots_internal(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  delete from vortex_definition.roots as module
  where module.organization_id = p_organization_id
    and module.owner_application_root_id = p_application_root_id;
  delete from vortex_definition.roots as root
  where root.organization_id = p_organization_id and root.root_id = p_application_root_id;
end
$function$;

revoke all on function vortex_definition.purge_application_roots_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.purge_application_roots_internal(uuid, uuid)
  to vortex_owner;
alter function vortex_definition.purge_application_roots_internal(uuid, uuid) owner to vortex_owner;
