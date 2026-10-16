create or replace function vortex_platform.begin_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_principal_kind text,
  p_principal_id uuid,
  p_origin_kind text,
  p_origin_id uuid,
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
  if p_run_id is null or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_principal_kind is null
    or p_principal_kind not in ('person', 'specified_account', 'system')
    or p_principal_id is null
    or not vortex_platform.is_non_nil_uuid(p_principal_id::text)
    or p_origin_kind is null
    or p_origin_kind not in ('person', 'event', 'schedule')
    or p_origin_id is null
    or not vortex_platform.is_non_nil_uuid(p_origin_id::text)
    or (p_origin_kind = 'person' and (
      p_principal_kind <> 'person' or p_origin_id <> p_principal_id
    ))
    or (p_origin_kind in ('event', 'schedule') and p_principal_kind = 'person')
    or p_task_path is null
    or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null
    or pg_catalog.length(p_iteration) not between 1 and 200 then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  insert into vortex_platform.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id,
    principal_kind, principal_id, origin_kind, origin_id, state, started_at
  ) values (
    p_run_id, p_task_path, p_iteration, p_organization_id,
    case when p_principal_kind = 'person' then p_principal_id else null end,
    p_principal_kind, p_principal_id, p_origin_kind, p_origin_id, 'started',
    pg_catalog.statement_timestamp()
  )
  on conflict (run_id, task_path, iteration) do nothing
  returning run_id into inserted_run_id;

  if inserted_run_id is not null then
    return pg_catalog.jsonb_build_object('kind', 'claimed');
  end if;

  select ledger.organization_id, ledger.identity_id, ledger.principal_kind,
    ledger.principal_id, ledger.origin_kind, ledger.origin_id,
    ledger.state, ledger.outcome, ledger.outputs
  into existing
  from vortex_platform.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration;

  if not found
    or existing.organization_id is distinct from p_organization_id
    or existing.principal_kind is distinct from p_principal_kind
    or existing.principal_id is distinct from p_principal_id
    or existing.origin_kind is distinct from p_origin_kind
    or existing.origin_id is distinct from p_origin_id then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
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
alter function vortex_platform.begin_flow_effect(uuid,uuid,text,uuid,text,uuid,text,text)
  owner to vortex_owner;

revoke all on function vortex_platform.begin_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.begin_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text
) to vortex_runtime;

comment on function vortex_platform.begin_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text
) is
  'Private effect claim bound to a verified person or execution principal and trigger origin; the run, task path and iteration remain duplicate-safe.';
