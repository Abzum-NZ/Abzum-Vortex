create or replace function vortex_platform.list_pending_backend_runs(p_limit integer)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Back-end run limit is invalid';
  end if;
  return query
  select run.backend_run_id
  from vortex_platform.backend_runs as run
  where run.state = 'pending'
    or (run.state = 'running' and run.claimed_until < pg_catalog.statement_timestamp())
  order by run.created_at
  limit p_limit;
end
$function$;
alter function vortex_platform.list_pending_backend_runs(integer) owner to vortex_owner;

revoke all on function vortex_platform.list_pending_backend_runs(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.list_pending_backend_runs(integer) to vortex_runtime;

comment on function vortex_platform.list_pending_backend_runs(integer) is
  'Lists the oldest pending or abandoned back-end runs for the recovery tick.';
