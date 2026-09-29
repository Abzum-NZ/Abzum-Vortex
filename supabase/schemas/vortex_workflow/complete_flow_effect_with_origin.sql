create or replace function vortex_workflow.complete_flow_effect_with_origin(
  p_run_id uuid,
  p_organization_id uuid,
  p_principal_kind text,
  p_principal_id uuid,
  p_origin_kind text,
  p_origin_id uuid,
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
  if p_run_id is null or not vortex_context.is_non_nil_uuid(p_run_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_principal_kind is null
    or p_principal_kind not in ('person', 'specified_account', 'system')
    or p_principal_id is null
    or not vortex_context.is_non_nil_uuid(p_principal_id::text)
    or p_origin_kind is null
    or p_origin_kind not in ('person', 'event', 'schedule')
    or p_origin_id is null
    or not vortex_context.is_non_nil_uuid(p_origin_id::text)
    or (p_origin_kind = 'person' and (
      p_principal_kind <> 'person' or p_origin_id <> p_principal_id
    ))
    or (p_origin_kind in ('event', 'schedule') and p_principal_kind = 'person')
    or p_task_path is null
    or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null
    or pg_catalog.length(p_iteration) not between 1 and 200
    or p_outcome is null
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
    and ledger.principal_kind = p_principal_kind
    and ledger.principal_id = p_principal_id
    and ledger.origin_kind = p_origin_kind
    and ledger.origin_id = p_origin_id
    and ledger.identity_id is not distinct from
      case when p_principal_kind = 'person' then p_principal_id else null end
    and ledger.state = 'started';

  return found;
end
$function$;

alter function vortex_workflow.complete_flow_effect_with_origin(
  uuid,uuid,text,uuid,text,uuid,text,text,text,jsonb
) owner to vortex_workflow_owner;

revoke all on function vortex_workflow.complete_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.complete_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) to vortex_runtime;

comment on function vortex_workflow.complete_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) is
  'Private effect completion for the exact run, principal, trigger origin, task path and iteration claim.';
