create or replace function vortex_platform.set_instance_profile_internal(p_kind text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_kind is null or p_kind not in ('development', 'production') then
    raise exception using errcode = '22023', message = 'Instance profile kind is invalid';
  end if;
  update vortex_platform.instance_profile as profile
  set kind = p_kind
  where profile.singleton;
  if not found then
    raise exception using errcode = '55000', message = 'Instance profile is unavailable';
  end if;
end
$function$;

comment on function vortex_platform.set_instance_profile_internal(text) is
  'Marks this database as a development or production instance. Only local development setup and demo setup call it, as the owner; no request role can execute it.';

revoke all on function vortex_platform.set_instance_profile_internal(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

alter function vortex_platform.set_instance_profile_internal(p_kind text) owner to vortex_owner;

grant execute on function vortex_platform.set_instance_profile_internal(p_kind text) to postgres;
