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
