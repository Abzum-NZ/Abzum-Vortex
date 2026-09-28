create or replace function vortex_identity.read_current_organization_runtime_settings_internal(
  p_organization_id uuid
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings read is invalid';
  end if;
  return query
  select settings.organization_id, settings.language, settings.time_zone,
    settings.currency, settings.date_format, settings.number_format,
    settings.revision
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id;
end
$function$;

revoke all on function vortex_identity.read_current_organization_runtime_settings_internal(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_current_organization_runtime_settings_internal(uuid) is null;

alter function vortex_identity.read_current_organization_runtime_settings_internal(uuid) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.read_current_organization_runtime_settings_internal(uuid) to postgres;
reset role;
