create or replace function vortex_definition.has_active_application_release_binding_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.application_root_id = p_application_root_id
      and binding.application_release_revision = p_application_release_revision
      and binding.state = 'active'
  );
$function$;
alter function vortex_definition.has_active_application_release_binding_internal(uuid,uuid,bigint) owner to vortex_owner;


revoke all on function vortex_definition.has_active_application_release_binding_internal(
  uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.has_active_application_release_binding_internal(
  uuid, uuid, bigint
) to vortex_owner;
alter function vortex_definition.has_active_application_release_binding_internal(
  uuid, uuid, bigint
) owner to vortex_owner;
comment on function vortex_definition.has_active_application_release_binding_internal(
  uuid, uuid, bigint
) is
  'Private exact active Application release binding existence predicate for owner-controlled installation decisions; returns no binding rows or authority.';
