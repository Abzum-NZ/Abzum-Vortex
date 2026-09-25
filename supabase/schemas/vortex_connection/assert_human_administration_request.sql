create or replace function vortex_connection.assert_human_administration_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.coalesce(vortex_context.current_context() ->> 'callerKind', '') <> 'human' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration requires a human request context';
  end if;
end
$function$;

revoke all on function vortex_connection.assert_human_administration_request()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_connection.assert_human_administration_request() is
  'Refuses any caller whose request context is not a human request; used by the connection administration entry points.';
