create or replace function vortex_definition.is_system_projection_module_internal(
  p_module_root_id uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_definition.roots as root
    where root.root_id = p_module_root_id
      and root.organization_id = p_organization_id
      and root.kind = 'module'
      and root.system_projection
  );
$function$;

alter function vortex_definition.is_system_projection_module_internal(uuid, uuid)
  owner to vortex_owner;

revoke all on function vortex_definition.is_system_projection_module_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.is_system_projection_module_internal(uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_definition.is_system_projection_module_internal(uuid, uuid) is
  'Private organisation-scoped check of the root-row system-projection flag for the Record adapter.';
