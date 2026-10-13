create or replace function vortex_platform.assert_human_administration_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(vortex_platform.current_context() ->> 'callerKind', '') <> 'human' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration requires a human request context';
  end if;
end
$function$;

revoke all on function vortex_platform.assert_human_administration_request()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.assert_human_administration_request()
  to postgres;

comment on function vortex_platform.assert_human_administration_request() is
  'Refuses any caller whose request context is not a human request; used by the connection administration entry points.';
alter function vortex_platform.assert_human_administration_request() owner to vortex_owner;
