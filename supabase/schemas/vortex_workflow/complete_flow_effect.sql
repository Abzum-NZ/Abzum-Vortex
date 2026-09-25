create or replace function vortex_workflow.complete_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
  p_task_path text,
  p_iteration text,
  p_outcome text,
  p_outputs jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_outcome is null
    or p_outcome not in (
      'completed', 'committed', 'background_pending', 'refused', 'conflict', 'validation',
      'uncertain', 'failed'
    )
    or p_outputs is null
    or pg_catalog.jsonb_typeof(p_outputs) <> 'object'
    or pg_catalog.pg_column_size(p_outputs) > 65536 then
    return false;
  end if;

  update vortex_workflow.flow_effect_ledger as ledger
  set state = 'completed',
      outcome = p_outcome,
      outputs = p_outputs,
      completed_at = pg_catalog.statement_timestamp()
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration
    and ledger.organization_id = p_organization_id
    and ledger.identity_id = p_identity_id
    and ledger.state = 'started';

  return found;
end
$function$;

revoke all on function vortex_workflow.complete_flow_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.complete_flow_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) to vortex_runtime;

comment on function vortex_workflow.complete_flow_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) is
  'Private flow-effect completion: records the safe outcome of the one claimed protected effect of a run, task path and iteration so a repeat replays it.';
