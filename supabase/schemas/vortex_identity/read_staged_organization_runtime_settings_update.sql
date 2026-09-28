create or replace function vortex_identity.read_staged_organization_runtime_settings_update()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  staged jsonb;
begin
  select row_value.settings into staged
  from vortex_identity.organization_runtime_settings_update_staging as row_value
  where row_value.backend_pid = pg_catalog.pg_backend_pid()
    and row_value.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  if staged is null then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;
  return staged;
end
$function$;

revoke all on function vortex_identity.read_staged_organization_runtime_settings_update() from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_staged_organization_runtime_settings_update() is null;

alter function vortex_identity.read_staged_organization_runtime_settings_update() owner to vortex_identity_owner;
