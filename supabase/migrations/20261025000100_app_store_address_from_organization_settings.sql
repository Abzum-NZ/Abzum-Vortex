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
  -- A cleared address is stored as an empty value; it is as absent as one never set.
  select nullif(pg_catalog.btrim(settings.extension_values ->> 'app_store_address'), '')
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

-- Existing organisations keep the App Store they use today: name it in every settings record that
-- does not name one yet. A configured address is preserved.
update vortex_identity.organization_runtime_settings as settings
set extension_values = settings.extension_values
      || pg_catalog.jsonb_build_object('app_store_address', 'vortex.app.app_store'),
    changed_at = greatest(pg_catalog.statement_timestamp(), settings.changed_at),
    revision = settings.revision + 1
where not settings.extension_values ? 'app_store_address';

reset role;
