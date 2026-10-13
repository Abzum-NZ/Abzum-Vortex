create or replace function vortex_platform.current_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored jsonb;
begin
  select established.context into stored
  from vortex_platform.request_contexts as established
  where established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();

  if stored is null then
    raise exception using errcode = '55000', message = 'Vortex request context is not established';
  end if;

  return vortex_platform.validated(stored);
end
$function$;
revoke execute on function vortex_platform.current_context()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_platform.current_context()
  to vortex_request, vortex_record_adapter, vortex_owner, vortex_record_inventory;

comment on function vortex_platform.current_context() is
  'Returns the validated request context established in this transaction or fails closed when it is absent, expired or stale.';

alter function vortex_platform.current_context() owner to postgres;
