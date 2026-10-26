create or replace function vortex_definition.is_platform_system_module_internal(
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
    join vortex_definition.roots as owner_root
      on owner_root.root_id = root.owner_application_root_id
      and owner_root.organization_id = root.organization_id
      and owner_root.kind = 'application'
      and owner_root.application_origin_kind = 'platform_system_application'
    where root.root_id = p_module_root_id
      and root.organization_id = p_organization_id
      and root.kind = 'module'
      and root.system_projection
  );
$function$;

alter function vortex_definition.is_platform_system_module_internal(uuid, uuid)
  owner to vortex_owner;

revoke all on function vortex_definition.is_platform_system_module_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.is_platform_system_module_internal(uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_definition.is_platform_system_module_internal(uuid, uuid) is
  'Private organisation-scoped check that a system-projection Module belongs to a platform system Application, for the Record adapter.';
