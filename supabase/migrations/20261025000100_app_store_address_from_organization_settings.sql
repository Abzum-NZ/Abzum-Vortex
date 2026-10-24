-- #2900: keep the App Store route in the organisation settings record and read it in the current organisation context.

set local role vortex_owner;

create or replace function vortex_access.read_current_organization_app_store_address_for_application()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  address_value text;
begin
  context_value := vortex_access.validated_human_request_context();
  select settings.extension_values ->> 'app_store_address'
  into address_value
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = (context_value ->> 'organizationId')::uuid;
  return address_value;
end
$function$;

revoke all on function vortex_access.read_current_organization_app_store_address_for_application()
  from public, anon, authenticated, service_role;
grant execute on function vortex_access.read_current_organization_app_store_address_for_application()
  to vortex_request;
alter function vortex_access.read_current_organization_app_store_address_for_application()
  owner to vortex_owner;
grant execute on function vortex_access.read_current_organization_app_store_address_for_application()
  to postgres;

reset role;
