create or replace function vortex_workflow.complete_protected_node_effect(
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
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'human'
    or checked ->> 'channel' is distinct from 'durable_workflow'
    or pg_catalog.lower(checked ->> 'organizationId') is distinct from p_organization_id::text
    or pg_catalog.lower(checked ->> 'identityId') is distinct from p_identity_id::text
    or not exists (
      select 1
      from vortex_workflow.protected_workflow_runs as stored
      where stored.run_id = p_run_id
        and stored.organization_id = p_organization_id
        and stored.identity_id = p_identity_id
        and stored.run_record #>> '{authority,state}' = 'running'
        and pg_catalog.lower(stored.run_record #>> '{authority,applicationRootId}')
          = pg_catalog.lower(checked ->> 'applicationRootId')
    ) then
    return false;
  end if;

  return vortex_workflow.complete_flow_effect(
    p_run_id, p_organization_id, p_identity_id, p_task_path, p_iteration,
    p_outcome, p_outputs
  );
end
$function$;

revoke all on function vortex_workflow.complete_protected_node_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.complete_protected_node_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) to vortex_request;
comment on function vortex_workflow.complete_protected_node_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) is
  'Records the safe response of a claimed protected node effect in the same durable actor transaction as its operation.';
