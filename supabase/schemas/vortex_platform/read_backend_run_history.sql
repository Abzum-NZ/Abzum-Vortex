create or replace function vortex_platform.read_backend_run_history(
  p_application_root_id uuid,
  p_limit integer
)
returns table (
  backend_run_id uuid,
  flow_id uuid,
  origin_kind text,
  source_key text,
  state text,
  failure_code text,
  created_at timestamptz,
  finished_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  -- The caller must be a human whose organisation grants definition-draft management, the
  -- authority Studio uses to open an application; the organisation comes from that context.
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Back-end run history request is invalid';
  end if;
  -- Outputs can hold record values, so the history never returns them.
  return query
  select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
    run.failure_code, run.created_at, run.finished_at
  from vortex_platform.backend_runs as run
  where run.organization_id = (checked_context ->> 'organizationId')::uuid
    and run.application_root_id = p_application_root_id
  order by run.created_at desc
  limit p_limit;
end
$function$;
alter function vortex_platform.read_backend_run_history(uuid, integer) owner to vortex_owner;

revoke all on function vortex_platform.read_backend_run_history(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_backend_run_history(uuid, integer)
  to vortex_request;

comment on function vortex_platform.read_backend_run_history(uuid, integer) is
  'Lists the newest back-end runs of one application (flow, origin, source, state, failure code, times) without their outputs; it requires definition-draft management in the own request context of the caller.';
