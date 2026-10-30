create or replace function vortex_platform.claim_backend_run(p_backend_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claimed record;
begin
  if p_backend_run_id is null or not vortex_platform.is_non_nil_uuid(p_backend_run_id::text) then
    return null;
  end if;
  update vortex_platform.backend_runs as run
  set state = 'running',
    claimed_until = pg_catalog.statement_timestamp() + interval '2 minutes'
  where run.backend_run_id = p_backend_run_id
    and (
      run.state = 'pending'
      or (run.state = 'running' and run.claimed_until < pg_catalog.statement_timestamp())
    )
  returning run.backend_run_id, run.organization_id, run.application_root_id, run.flow_id,
    run.actor_id, run.origin_kind, run.source_key, run.inputs
  into claimed;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'backendRunId', claimed.backend_run_id,
    'organizationId', claimed.organization_id,
    'applicationRootId', claimed.application_root_id,
    'flowId', claimed.flow_id,
    'actorId', claimed.actor_id,
    'originKind', claimed.origin_kind,
    'sourceKey', claimed.source_key,
    'inputs', claimed.inputs
  );
end
$function$;
alter function vortex_platform.claim_backend_run(uuid) owner to vortex_owner;

revoke all on function vortex_platform.claim_backend_run(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.claim_backend_run(uuid) to vortex_runtime;

comment on function vortex_platform.claim_backend_run(uuid) is
  'Claims one pending (or abandoned) back-end run for two minutes so exactly one executor runs it; null when it is not claimable.';
