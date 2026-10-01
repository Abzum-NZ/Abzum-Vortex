create or replace function vortex_definition.application_root_exists_for_organization_internal(
  p_organization_id uuid,
  p_application_root_id uuid
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
    where root.organization_id = p_organization_id
      and root.root_id = p_application_root_id
      and root.kind = 'application'
  )
$function$;

revoke all on function vortex_definition.application_root_exists_for_organization_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_definition.application_root_exists_for_organization_internal(uuid, uuid)
  to vortex_invalidation_owner;
comment on function vortex_definition.application_root_exists_for_organization_internal(uuid, uuid) is
  'Private exact organisation-owned Application root existence predicate for owner-controlled installation decisions; returns no root rows or authority.';
alter function vortex_definition.application_root_exists_for_organization_internal(uuid, uuid)
  owner to vortex_definition_owner;
