create or replace function vortex_workflow.read_protected_workflow_run_registration(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored vortex_workflow.protected_workflow_runs%rowtype;
  run_value jsonb;
  field_path text[];
  application_id uuid;
  permanent_flow_id uuid;
  compiler_revision bigint;
  version_value text;
  matched record;
  matched_count integer := 0;
  declarations jsonb;
  release_value jsonb;
begin
  if p_run_id is null or not vortex_context.is_non_nil_uuid(p_run_id::text) then
    return null;
  end if;

  select run.* into stored
  from vortex_workflow.protected_workflow_runs as run
  where run.run_id = p_run_id;
  if not found then
    return null;
  end if;
  run_value := stored.run_record;
  if pg_catalog.jsonb_typeof(run_value) is distinct from 'object'
    or pg_catalog.jsonb_typeof(run_value -> 'authority') is distinct from 'object'
    or pg_catalog.jsonb_typeof(run_value -> 'executionReference') is distinct from 'object'
    or pg_catalog.jsonb_typeof(run_value -> 'kestra') is distinct from 'object' then
    return null;
  end if;

  -- Check JSON types and RFC UUIDs before casts. NULL comparisons always refuse.
  for field_path in select path from (values
    (array['authority', 'runId']),
    (array['authority', 'organizationId']),
    (array['authority', 'applicationRootId']),
    (array['authority', 'workflowId']),
    (array['executionReference', 'runId']),
    (array['executionReference', 'tenantId']),
    (array['executionReference', 'organizationId']),
    (array['executionReference', 'applicationRootId']),
    (array['executionReference', 'workflowId'])
  ) as required(path) loop
    if pg_catalog.jsonb_typeof(run_value #> field_path) is distinct from 'string'
      or not vortex_context.is_non_nil_uuid(run_value #>> field_path) then
      return null;
    end if;
  end loop;
  if pg_catalog.lower(run_value #>> '{authority,runId}') is distinct from p_run_id::text
    or pg_catalog.lower(run_value #>> '{executionReference,runId}') is distinct from p_run_id::text
    or pg_catalog.lower(run_value #>> '{authority,organizationId}') is distinct from stored.organization_id::text
    or pg_catalog.lower(run_value #>> '{executionReference,organizationId}') is distinct from stored.organization_id::text
    or pg_catalog.lower(run_value #>> '{authority,applicationRootId}') is distinct from pg_catalog.lower(run_value #>> '{executionReference,applicationRootId}')
    or pg_catalog.lower(run_value #>> '{authority,workflowId}') is distinct from pg_catalog.lower(run_value #>> '{executionReference,workflowId}') then
    return null;
  end if;

  for field_path in select path from (values
    (array['authority', 'workflowRevision']),
    (array['executionReference', 'workflowRevision'])
  ) as required(path) loop
    if pg_catalog.jsonb_typeof(run_value #> field_path) is distinct from 'number'
      or (run_value #>> field_path) !~ '^[1-9][0-9]{0,15}$' then
      return null;
    end if;
    if (run_value #>> field_path)::bigint not between 1 and 9007199254740991 then
      return null;
    end if;
  end loop;
  compiler_revision := (run_value #>> '{authority,workflowRevision}')::bigint;
  if compiler_revision <> (run_value #>> '{executionReference,workflowRevision}')::bigint
    or pg_catalog.jsonb_typeof(run_value #> '{authority,applicationReleaseVersion}') is distinct from 'string'
    or pg_catalog.jsonb_typeof(run_value #> '{executionReference,applicationVersion}') is distinct from 'string'
    or (run_value #>> '{authority,applicationReleaseVersion}') !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or run_value #>> '{authority,applicationReleaseVersion}' is distinct from run_value #>> '{executionReference,applicationVersion}'
    or pg_catalog.jsonb_typeof(run_value #> '{kestra,namespace}') is distinct from 'string'
    or pg_catalog.jsonb_typeof(run_value #> '{kestra,flowId}') is distinct from 'string' then
    return null;
  end if;
  application_id := (run_value #>> '{authority,applicationRootId}')::uuid;
  permanent_flow_id := (run_value #>> '{authority,workflowId}')::uuid;
  version_value := run_value #>> '{authority,applicationReleaseVersion}';

  -- Only the stored organization can supply the Vortex tenant. Provider tenant
  -- labels remain private mapping metadata and confer no Vortex authority.
  perform 1 from vortex_identity.organizations as organization
  where organization.organization_id = stored.organization_id
    and organization.tenant_id = (run_value #>> '{executionReference,tenantId}')::uuid;
  if not found then
    return null;
  end if;

  -- Do not consult current_release_revision or reinterpret inactive preparation
  -- status as current installation activation or provider execution state.
  for matched in
    select registration.*, published.compilation_output,
      published.content_fingerprint, published.resolution_fingerprint
    from vortex_workflow.flow_registrations as registration
    join vortex_definition.releases as published
      on published.root_id = registration.application_root_id
      and published.release_revision = registration.installation_revision
      and published.release_version = registration.application_version
    join vortex_definition.roots as root
      on root.root_id = published.root_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
    where registration.organization_id = stored.organization_id
      and registration.application_root_id = application_id
      and registration.application_version = version_value
      and registration.workflow_revision = compiler_revision
      and registration.namespace = run_value #>> '{kestra,namespace}'
      and registration.flow_id = run_value #>> '{kestra,flowId}'
      and registration.namespace = pg_catalog.concat_ws('.', 'vortex', 'application',
        registration.environment, stored.organization_id::text,
        application_id::text, 'i' || registration.installation_revision::text)
      and registration.flow_id = 'w_' || permanent_flow_id::text || '_'
        || pg_catalog.replace(version_value, '.', '-') || '_r' || compiler_revision::text
      and published.compilation_output ->> 'kind' = 'application'
      and published.compilation_output #>> '{canonical,envelope,kind}' = 'application'
      and published.compilation_output #>> '{canonical,envelope,key}' = root.key
      and published.compilation_output #>> '{canonical,envelope,rootId}' = application_id::text
      and published.compilation_output #>> '{canonical,envelope,organizationId}' = stored.organization_id::text
      and published.compilation_output #>> '{artifact,kind}' = 'application'
      and published.compilation_output #>> '{artifact,rootId}' = application_id::text
      and published.compilation_output #>> '{artifact,definitionKey}' = root.key
      and published.compilation_output #>> '{artifact,exactVersion}' = version_value
      and published.compilation_output #>> '{artifact,contentFingerprint}' = published.content_fingerprint
      and published.compilation_output #>> '{artifact,resolutionFingerprint}' = published.resolution_fingerprint
      and published.compilation_output ->> 'resolutionFingerprint' = published.resolution_fingerprint
  loop
    matched_count := matched_count + 1;
    if matched_count <> 1 then
      return null;
    end if;
    if pg_catalog.jsonb_typeof(matched.compilation_output #> '{canonical,content,flows}') is distinct from 'array' then
      return null;
    end if;
    select pg_catalog.jsonb_agg(flow.value) into declarations
    from pg_catalog.jsonb_array_elements(matched.compilation_output #> '{canonical,content,flows}') as flow(value)
    where pg_catalog.jsonb_typeof(flow.value) = 'object'
      and pg_catalog.jsonb_typeof(flow.value -> 'id') = 'string'
      and pg_catalog.lower(flow.value ->> 'id') = permanent_flow_id::text;
    if declarations is null or pg_catalog.jsonb_array_length(declarations) <> 1 then
      return null;
    end if;
    if declarations #> '{0,execution}' is distinct from '"durable"'::jsonb then
      return null;
    end if;
    release_value := pg_catalog.jsonb_build_object(
      'environment', matched.environment,
      'organizationId', matched.organization_id,
      'applicationRootId', matched.application_root_id,
      'applicationVersion', matched.application_version,
      'installationRevision', matched.installation_revision,
      'compilerWorkflowRevision', matched.workflow_revision,
      'namespace', matched.namespace,
      'providerFlowId', matched.flow_id,
      'candidateFingerprint', matched.candidate_fingerprint,
      'permanentFlowId', permanent_flow_id,
      'contentFingerprint', matched.content_fingerprint,
      'resolutionFingerprint', matched.resolution_fingerprint,
      'definition', declarations -> 0
    );
  end loop;
  if matched_count <> 1 then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('runRecord', run_value, 'registeredRelease', release_value);
end
$function$;

alter function vortex_workflow.read_protected_workflow_run_registration(uuid) owner to postgres;
revoke all on function vortex_workflow.read_protected_workflow_run_registration(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_workflow.read_protected_workflow_run_registration(uuid) to vortex_runtime;
comment on function vortex_workflow.read_protected_workflow_run_registration(uuid) is
  'Private registered-run metadata reader: validates the retained run against its exact stored candidate identity and immutable published durable Flow; no provider, viewer or candidate-body authority.';
