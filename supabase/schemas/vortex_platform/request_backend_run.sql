create or replace function vortex_platform.request_backend_run(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_flow_id uuid,
  p_actor_id uuid,
  p_origin_kind text,
  p_source_key text,
  p_mode text,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  requested record;
begin
  if p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_flow_id is null or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or p_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_id::text)
    or p_origin_kind is null or p_origin_kind not in ('backend_run', 'event')
    or p_source_key is null or pg_catalog.length(p_source_key) not between 1 and 200
    or p_mode is null or p_mode not in ('await', 'start')
    or p_inputs is null or pg_catalog.jsonb_typeof(p_inputs) <> 'object'
    or pg_catalog.pg_column_size(p_inputs) > 16384 then
    raise exception using errcode = '22023', message = 'Back-end run request is invalid';
  end if;

  insert into vortex_platform.backend_runs (
    organization_id, application_root_id, flow_id, actor_id, origin_kind, source_key, mode,
    inputs, state
  ) values (
    p_organization_id, p_application_root_id, p_flow_id, p_actor_id, p_origin_kind, p_source_key,
    p_mode, p_inputs, 'pending'
  )
  on conflict (organization_id, origin_kind, source_key, flow_id) do nothing;

  select run.backend_run_id, run.state, run.outputs, run.failure_code, run.actor_id,
    run.application_root_id
  into requested
  from vortex_platform.backend_runs as run
  where run.organization_id = p_organization_id
    and run.origin_kind = p_origin_kind
    and run.source_key = p_source_key
    and run.flow_id = p_flow_id;

  -- A repeated key must repeat the same request, never silently reuse another run.
  if requested.actor_id is distinct from p_actor_id
    or requested.application_root_id is distinct from p_application_root_id then
    raise exception using errcode = '22023', message = 'Back-end run key is already used';
  end if;
  return pg_catalog.jsonb_build_object(
    'backendRunId', requested.backend_run_id,
    'state', requested.state,
    'outputs', requested.outputs,
    'failureCode', requested.failure_code
  );
end
$function$;
alter function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb) owner to vortex_owner;

revoke all on function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb)
  to vortex_runtime;

comment on function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb) is
  'Records one pending back-end run once per origin, source key and flow; a repeat returns the same run and its state.';
