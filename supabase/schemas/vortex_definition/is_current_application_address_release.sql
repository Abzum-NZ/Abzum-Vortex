create or replace function vortex_definition.is_current_application_address_release(
  p_release_revision bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  installation_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or p_release_revision not between 1 and 9007199254740991 then
    return false;
  end if;
  installation_value := vortex_definition.read_current_active_installation();
  return (installation_value ->> 'applicationReleaseRevision')::bigint = p_release_revision
    and exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = (context_value ->> 'organizationId')::uuid
      and registration.registration_kind = 'application'
      and registration.registration_owner_id =
        (context_value ->> 'applicationRootId')::uuid
      and registration.state = 'active'
      -- A preview runs the draft under the permissions the installed release registered.
      and (installation_value ? 'previewInstallationId'
        or registration.source_revision = p_release_revision)
  );
exception
  when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
    return false;
end
$function$;

revoke execute on function vortex_definition.is_current_application_address_release(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.is_current_application_address_release(bigint)
  to vortex_request;

comment on function vortex_definition.is_current_application_address_release(bigint) is
  'Checks an internal candidate release against the exact active registration and binding in the validated human application context, or against the pins of the preview installation the context runs.';

alter function vortex_definition.is_current_application_address_release(p_release_revision bigint) owner to vortex_owner;
