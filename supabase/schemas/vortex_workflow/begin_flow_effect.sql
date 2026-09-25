create or replace function vortex_workflow.begin_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
  p_task_path text,
  p_iteration text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  inserted_run_id uuid;
  existing record;
begin
  if not vortex_context.is_non_nil_uuid(p_run_id::text)
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_task_path is null
    or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null
    or pg_catalog.length(p_iteration) not between 1 and 200 then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  insert into vortex_workflow.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id, state, started_at
  ) values (
    p_run_id, p_task_path, p_iteration, p_organization_id, p_identity_id, 'started',
    pg_catalog.statement_timestamp()
  )
  on conflict (run_id, task_path, iteration) do nothing
  returning run_id into inserted_run_id;

  if inserted_run_id is not null then
    return pg_catalog.jsonb_build_object('kind', 'claimed');
  end if;

  select ledger.organization_id, ledger.identity_id, ledger.state, ledger.outcome, ledger.outputs
  into existing
  from vortex_workflow.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration;

  if not found
    or existing.organization_id is distinct from p_organization_id
    or existing.identity_id is distinct from p_identity_id then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  -- A repeat never runs the effect again: a finished one replays its recorded safe outcome, and one
  -- that started but never recorded an outcome is uncertain and is reported as such.
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

revoke all on function vortex_workflow.begin_flow_effect(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.begin_flow_effect(
  uuid, uuid, uuid, text, text
) to vortex_runtime;

comment on function vortex_workflow.begin_flow_effect(
  uuid, uuid, uuid, text, text
) is
  'Private flow-effect claim: the first call for one run, task path and iteration claims the protected effect; every repeat replays the recorded safe outcome or reports it in progress, so a replayed flow can never repeat an effect.';
