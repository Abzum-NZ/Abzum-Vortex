create or replace function vortex_platform.finish_backend_run(
  p_backend_run_id uuid,
  p_state text,
  p_outputs jsonb,
  p_failure_code text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_backend_run_id is null or not vortex_platform.is_non_nil_uuid(p_backend_run_id::text)
    or p_state is null or p_state not in ('succeeded', 'refused', 'failed')
    or (p_outputs is not null and (
      pg_catalog.jsonb_typeof(p_outputs) <> 'object' or pg_catalog.pg_column_size(p_outputs) > 16384
    ))
    or (p_failure_code is not null and pg_catalog.length(p_failure_code) > 100) then
    raise exception using errcode = '22023', message = 'Back-end run result is invalid';
  end if;
  update vortex_platform.backend_runs as run
  set state = p_state,
    outputs = p_outputs,
    failure_code = p_failure_code,
    claimed_until = null,
    finished_at = pg_catalog.statement_timestamp()
  where run.backend_run_id = p_backend_run_id
    and run.state = 'running';
  return found;
end
$function$;
alter function vortex_platform.finish_backend_run(uuid, text, jsonb, text) owner to vortex_owner;

revoke all on function vortex_platform.finish_backend_run(uuid, text, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.finish_backend_run(uuid, text, jsonb, text)
  to vortex_runtime;

comment on function vortex_platform.finish_backend_run(uuid, text, jsonb, text) is
  'Records the final state, outputs and stable failure code of a running back-end run, once.';
