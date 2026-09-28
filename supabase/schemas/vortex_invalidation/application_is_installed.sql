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
      from vortex_access.permission_registrations as registration
      join vortex_definition.roots as root
        on root.root_id = registration.registration_owner_id
        and root.organization_id = registration.organization_id
        and root.kind = 'application'
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
        and exists (
          select 1
          from vortex_module.installation_bindings as binding
          where binding.organization_id = p_organization_id
            and binding.application_root_id = p_application_root_id
            and binding.application_release_revision = registration.source_revision
            and binding.state = 'active'
        )
    )
$function$;

revoke all on function vortex_invalidation.application_is_installed(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_invalidation.application_is_installed(uuid, uuid) is
  'Private check that an application has an active registration and an active installation binding for its registered release in one organisation.';

alter function vortex_invalidation.application_is_installed(uuid, uuid)
  owner to postgres;
