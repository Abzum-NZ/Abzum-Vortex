create or replace function vortex_invalidation.application_is_installed(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null
    and p_application_root_id is not null
    and exists (
      select 1
      from vortex_access.read_application_permission_snapshot(
        p_organization_id, p_application_root_id
      ) as registration
      where vortex_definition.application_root_exists_for_organization_internal(
          p_organization_id, p_application_root_id
        )
        and vortex_module.has_active_application_release_binding_internal(
          p_organization_id, p_application_root_id, registration.release_revision
        )
    )
$function$;

revoke all on function vortex_invalidation.application_is_installed(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.application_is_installed(uuid, uuid)
  to postgres;

comment on function vortex_invalidation.application_is_installed(uuid, uuid) is
  'Private check that an application has an active registration and an active installation binding for its registered release in one organisation.';

alter function vortex_invalidation.application_is_installed(uuid, uuid)
  owner to vortex_invalidation_owner;
