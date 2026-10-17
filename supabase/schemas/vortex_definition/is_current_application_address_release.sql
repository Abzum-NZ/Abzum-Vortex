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
    from vortex_access.request_application_registration_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid
    ) as registration
    where registration.source_revision = p_release_revision
      and (registration.registration_kind = 'preview')
        = (installation_value ? 'previewInstallationId')
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
  'Checks an internal candidate release against the registration the validated human application context runs under and its binding: the installed registration, or the preview''s own registration and pins.';

alter function vortex_definition.is_current_application_address_release(p_release_revision bigint) owner to vortex_owner;
