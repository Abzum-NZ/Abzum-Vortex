create or replace function vortex_access.begin_protected_node_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
  p_task_path text,
  p_iteration text,
  p_operation_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  retained record;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'human'
    or checked ->> 'channel' is distinct from 'durable_workflow'
    or pg_catalog.lower(checked ->> 'organizationId') is distinct from p_organization_id::text
    or pg_catalog.lower(checked ->> 'identityId') is distinct from p_identity_id::text
    or p_operation_key is null
    or pg_catalog.length(p_operation_key) not between 1 and 128 then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select stored.identity_id, stored.run_record into retained
  from vortex_workflow.protected_workflow_runs as stored
  where stored.run_id = p_run_id
    and stored.organization_id = p_organization_id
  for update;
  if not found
    or retained.identity_id is distinct from p_identity_id
    or retained.run_record #>> '{authority,state}' is distinct from 'running'
    or pg_catalog.lower(retained.run_record #>> '{authority,applicationRootId}')
      is distinct from pg_catalog.lower(checked ->> 'applicationRootId')
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(retained.run_record -> 'nodes') as node(value)
      where pg_catalog.lower(node.value ->> 'nodeId') = pg_catalog.lower(p_task_path)
        and node.value ->> 'operationKey' = p_operation_key
    ) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  return vortex_workflow.begin_flow_effect(
    p_run_id, p_organization_id, p_identity_id, p_task_path, p_iteration
  );
end
$function$;

revoke all on function vortex_access.begin_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.begin_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) to vortex_request;
comment on function vortex_access.begin_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) is
  'Claims a protected node effect only for the exact retained run, node and durable human request context, locking the run until the callback transaction finishes.';
