create or replace function vortex_workflow.read_protected_node_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
  p_task_path text,
  p_iteration text,
  p_operation_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  existing record;
begin
  if not exists (
    select 1
    from vortex_workflow.protected_workflow_runs as stored
    where stored.run_id = p_run_id
      and stored.organization_id = p_organization_id
      and stored.identity_id = p_identity_id
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(stored.run_record -> 'nodes') as node(value)
        where pg_catalog.lower(node.value ->> 'nodeId') = pg_catalog.lower(p_task_path)
          and node.value ->> 'operationKey' = p_operation_key
      )
  ) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select ledger.state, ledger.outcome, ledger.outputs into existing
  from vortex_workflow.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id
    and ledger.organization_id = p_organization_id
    and ledger.identity_id = p_identity_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration;
  if not found then
    return pg_catalog.jsonb_build_object('kind', 'missing');
  end if;
  if existing.state = 'completed' then
    return pg_catalog.jsonb_build_object(
      'kind', 'completed',
      'outcome', existing.outcome,
      'outputs', coalesce(existing.outputs, '{}'::jsonb)
    );
  end if;
  return pg_catalog.jsonb_build_object('kind', 'in_progress');
end
$function$;

revoke all on function vortex_workflow.read_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.read_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) to vortex_runtime;
comment on function vortex_workflow.read_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) is
  'Reads a prior protected node response only for the exact retained run and node binding; it never claims or changes an effect.';
