create or replace function vortex_platform.storage_destination_project()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  project text;
begin
  select destination.project_ref into project
  from vortex_platform.storage_destination as destination
  where destination.singleton;
  if project is null then
    raise exception using errcode = '55000',
      message = 'Storage destination has not been provisioned';
  end if;
  return project;
end
$function$;

alter function vortex_platform.storage_destination_project() owner to vortex_owner;
revoke all on function vortex_platform.storage_destination_project()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.storage_destination_project() to authenticated, postgres;
comment on function vortex_platform.storage_destination_project() is
  'Storage policy destination from operations-owned configuration, never caller-writable session settings.';
