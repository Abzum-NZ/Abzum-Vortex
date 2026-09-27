-- Issue #664: retain the exact authority and private Kestra mapping for one durable run.
-- The runtime reaches this storage only through the private functions below.
create table vortex_workflow.protected_workflow_runs (
  run_id uuid not null check (vortex_context.is_non_nil_uuid(run_id::text)),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id)
    check (vortex_context.is_non_nil_uuid(organization_id::text)),
  identity_id uuid check (identity_id is null or vortex_context.is_non_nil_uuid(identity_id::text)),
  run_record jsonb not null check (
    pg_catalog.jsonb_typeof(run_record) = 'object'
    and pg_catalog.pg_column_size(run_record) <= 262144
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint protected_workflow_runs_pk primary key (run_id),
  constraint protected_workflow_runs_authority_binding check (
    run_record #>> '{authority,runId}' is not null
    and pg_catalog.lower(run_record #>> '{authority,runId}') = run_id::text
    and pg_catalog.lower(run_record #>> '{authority,organizationId}') = organization_id::text
    and pg_catalog.lower(run_record #>> '{executionReference,runId}') = run_id::text
    and pg_catalog.lower(run_record #>> '{executionReference,organizationId}') = organization_id::text
    and run_record #>> '{authority,applicationRootId}' is not null
    and pg_catalog.lower(run_record #>> '{authority,applicationRootId}') = pg_catalog.lower(run_record #>> '{executionReference,applicationRootId}')
    and run_record #>> '{authority,workflowId}' is not null
    and pg_catalog.lower(run_record #>> '{authority,workflowId}') = pg_catalog.lower(run_record #>> '{executionReference,workflowId}')
    and run_record #>> '{authority,workflowRevision}' is not null
    and run_record #>> '{authority,workflowRevision}' = run_record #>> '{executionReference,workflowRevision}'
    and pg_catalog.jsonb_typeof(run_record -> 'nodes') is not distinct from 'array'
    and pg_catalog.jsonb_typeof(run_record -> 'kestra') is not distinct from 'object'
  ),
  constraint protected_workflow_runs_initiator_binding check (
    (run_record #>> '{authority,runAs}' = 'initiating_person'
      and identity_id is not null
    and pg_catalog.lower(run_record #>> '{authority,initiator,identityId}') = identity_id::text)
    or (run_record #>> '{authority,runAs}' = 'system_with_source_authority'
      and identity_id is null)
  )
);

alter table vortex_workflow.protected_workflow_runs enable row level security;
revoke all on table vortex_workflow.protected_workflow_runs
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create or replace function vortex_workflow.write_protected_workflow_run(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
  p_run_record jsonb
)
returns boolean
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
    or (p_identity_id is not null and not vortex_context.is_non_nil_uuid(p_identity_id::text))
    or p_run_record is null
    or pg_catalog.jsonb_typeof(p_run_record) <> 'object'
    or pg_catalog.pg_column_size(p_run_record) > 262144
    or pg_catalog.lower(p_run_record #>> '{authority,runId}') is distinct from p_run_id::text
    or pg_catalog.lower(p_run_record #>> '{authority,organizationId}') is distinct from p_organization_id::text
    or pg_catalog.lower(p_run_record #>> '{executionReference,runId}') is distinct from p_run_id::text
    or pg_catalog.lower(p_run_record #>> '{executionReference,organizationId}') is distinct from p_organization_id::text
    or pg_catalog.lower(p_run_record #>> '{authority,applicationRootId}') is distinct from pg_catalog.lower(p_run_record #>> '{executionReference,applicationRootId}')
    or pg_catalog.lower(p_run_record #>> '{authority,workflowId}') is distinct from pg_catalog.lower(p_run_record #>> '{executionReference,workflowId}')
    or p_run_record #>> '{authority,workflowRevision}' is distinct from p_run_record #>> '{executionReference,workflowRevision}'
    or p_run_record #>> '{authority,applicationRootId}' is null
    or p_run_record #>> '{authority,workflowId}' is null
    or p_run_record #>> '{authority,workflowRevision}' is null
    or p_run_record #>> '{authority,state}' is distinct from 'running'
    or pg_catalog.jsonb_typeof(p_run_record -> 'nodes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_run_record -> 'kestra') is distinct from 'object'
    or not (
      (p_run_record #>> '{authority,runAs}' = 'initiating_person'
        and p_identity_id is not null
        and pg_catalog.lower(p_run_record #>> '{authority,initiator,identityId}') = p_identity_id::text)
      or (p_run_record #>> '{authority,runAs}' = 'system_with_source_authority'
        and p_identity_id is null)
    ) then
    return false;
  end if;

  insert into vortex_workflow.protected_workflow_runs (
    run_id, organization_id, identity_id, run_record, created_at, updated_at
  ) values (
    p_run_id, p_organization_id, p_identity_id, p_run_record,
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
  )
  on conflict (run_id) do nothing
  returning run_id into inserted_run_id;

  if inserted_run_id is not null then
    return true;
  end if;

  select stored.organization_id, stored.identity_id, stored.run_record
  into existing
  from vortex_workflow.protected_workflow_runs as stored
  where stored.run_id = p_run_id;

  if not found then
    return false;
  end if;

  return existing.organization_id = p_organization_id
    and existing.identity_id is not distinct from p_identity_id
    and (existing.run_record #- '{executionReference,lastKnownState}' #- '{executionReference,lastRefreshedAt}' #- '{authority,state}')
      = (p_run_record #- '{executionReference,lastKnownState}' #- '{executionReference,lastRefreshedAt}' #- '{authority,state}');
end
$function$;

revoke all on function vortex_workflow.write_protected_workflow_run(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.write_protected_workflow_run(uuid, uuid, uuid, jsonb)
  to vortex_runtime;
comment on function vortex_workflow.write_protected_workflow_run(uuid, uuid, uuid, jsonb) is
  'Private protected workflow run writer: stores one exact retained run authority and private Kestra mapping, allowing only an identical duplicate write.';

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

create or replace function vortex_workflow.refresh_protected_workflow_run_state(
  p_run_id uuid,
  p_state text,
  p_refreshed_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not vortex_context.is_non_nil_uuid(p_run_id::text)
    or p_state is null
    or p_state not in ('queued', 'running', 'waiting', 'completed', 'cancelled', 'failed')
    or p_refreshed_at is null then
    return false;
  end if;

  update vortex_workflow.protected_workflow_runs as stored
  set run_record = pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          stored.run_record,
          '{executionReference,lastKnownState}',
          pg_catalog.to_jsonb(p_state),
          false
        ),
        '{executionReference,lastRefreshedAt}',
        pg_catalog.to_jsonb(
          pg_catalog.to_char(
            p_refreshed_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        ),
        false
      ),
      '{authority,state}',
      pg_catalog.to_jsonb(case p_state
        when 'completed' then 'completed'
        when 'cancelled' then 'cancelled'
        when 'failed' then 'refused'
        else stored.run_record #>> '{authority,state}'
      end),
      false
    ),
    updated_at = pg_catalog.statement_timestamp()
  where stored.run_id = p_run_id
    and (stored.run_record #>> '{executionReference,lastRefreshedAt}')::timestamptz <= p_refreshed_at;

  return found;
end
$function$;

revoke all on function vortex_workflow.refresh_protected_workflow_run_state(uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.refresh_protected_workflow_run_state(uuid, text, timestamptz)
  to vortex_runtime;
comment on function vortex_workflow.refresh_protected_workflow_run_state(uuid, text, timestamptz) is
  'Private protected workflow run refresh: caches a safe Kestra state and closes callback authority after a terminal state.';


-- Only the two context-bound callback functions are exposed to request-role transactions.
grant usage on schema vortex_workflow to vortex_request;

create or replace function vortex_workflow.begin_protected_node_effect(
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

revoke all on function vortex_workflow.begin_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.begin_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) to vortex_request;
comment on function vortex_workflow.begin_protected_node_effect(
  uuid, uuid, uuid, text, text, text
) is
  'Claims a protected node effect only for the exact retained run, node and durable human request context, locking the run until the callback transaction finishes.';

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
