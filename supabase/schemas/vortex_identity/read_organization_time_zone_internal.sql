create or replace function vortex_identity.read_organization_time_zone_internal(
  p_organization_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  zone_value text;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization time zone read is invalid';
  end if;
  select settings.time_zone
  into zone_value
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id;
  return zone_value;
end
$function$;

revoke all on function vortex_identity.read_organization_time_zone_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_identity.read_organization_time_zone_internal(uuid)
  to vortex_record_adapter;

comment on function vortex_identity.read_organization_time_zone_internal(uuid) is
  'Private reader of one organisation''s configured time zone, or null when its runtime settings are not set up; callable only by the record adapter with the organisation of its own validated request context.';
