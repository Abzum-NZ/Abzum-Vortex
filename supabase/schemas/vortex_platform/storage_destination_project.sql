create or replace function vortex_platform.storage_destination_project()
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select destination.project_ref
  from vortex_platform.storage_destination as destination
  where destination.singleton;
$function$;

alter function vortex_platform.storage_destination_project() owner to vortex_owner;
revoke all on function vortex_platform.storage_destination_project()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.storage_destination_project() to authenticated, postgres;
comment on function vortex_platform.storage_destination_project() is
  'Storage policy destination from operations-owned configuration, never caller-writable session settings.';
