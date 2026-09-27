create or replace function vortex_workflow.read_protected_workflow_run(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select stored.run_record
  from vortex_workflow.protected_workflow_runs as stored
  where vortex_context.is_non_nil_uuid(p_run_id::text)
    and stored.run_id = p_run_id
$function$;

revoke all on function vortex_workflow.read_protected_workflow_run(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.read_protected_workflow_run(uuid) to vortex_runtime;
comment on function vortex_workflow.read_protected_workflow_run(uuid) is
  'Private protected workflow run reader: returns the retained Vortex authority and private Kestra mapping for one run id to the trusted runtime only.';
