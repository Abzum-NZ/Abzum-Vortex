-- #2114: exact published durable Flow registration and private registered-run reads.
-- Retains original candidate digests; does not enable flows or grant viewer authority.

begin;

set local role postgres;

create or replace function vortex_workflow.register_workflow_flow_candidate(
  p_environment text,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_version text,
  p_installation_revision bigint,
  p_workflow_revision bigint,
  p_candidate jsonb
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_namespace text;
  flow_id_value text;
  workflow_id_value text;
  expected_id_suffix text;
  candidate_fingerprint text;
  stored vortex_workflow.flow_registrations%rowtype;
begin
  if p_environment is null
    or p_environment not in ('local', 'testing', 'production')
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_application_version is null
    or p_application_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_installation_revision is null
    or p_installation_revision not between 1 and 9007199254740991
    or p_workflow_revision is null
    or p_workflow_revision not between 1 and 9007199254740991
    or p_candidate is null
    or pg_catalog.jsonb_typeof(p_candidate) <> 'object' then
    raise exception using errcode = '22023',
      message = 'Workflow flow registration command is invalid';
  end if;

  -- A candidate is prepared inactive: registration must never hold a runnable
  -- flow. The typed fields are checked before any value is read out of them.
  if p_candidate -> 'active' is distinct from 'false'::jsonb
    or p_candidate #> '{trigger,disabled}' is distinct from 'true'::jsonb
    or coalesce(pg_catalog.jsonb_typeof(p_candidate -> 'id'), 'missing') <> 'string'
    or coalesce(pg_catalog.jsonb_typeof(p_candidate -> 'namespace'), 'missing') <> 'string'
    or coalesce(pg_catalog.jsonb_typeof(p_candidate -> 'workflowRevision'), 'missing')
      <> 'number' then
    raise exception using errcode = '22023',
      message = 'Workflow flow candidate is invalid or active';
  end if;

  if (p_candidate ->> 'workflowRevision') !~ '^[1-9][0-9]{0,15}$' then
    raise exception using errcode = '22023',
      message = 'Workflow flow candidate revision is invalid';
  end if;
  if (p_candidate ->> 'workflowRevision')::bigint <> p_workflow_revision then
    raise exception using errcode = '22023',
      message = 'Workflow flow candidate revision does not match its identity';
  end if;

  -- The namespace and flow id are derived only from permanent identity, exactly
  -- as the part A compiler derives them: `w_<workflow id>_<version>_r<revision>`
  -- with the lower-case workflow UUID, so the flow names one exact workflow of
  -- this exact release.
  expected_namespace := pg_catalog.concat_ws(
    '.',
    'vortex',
    'application',
    p_environment,
    p_organization_id::text,
    p_application_root_id::text,
    'i' || p_installation_revision::text
  );
  flow_id_value := p_candidate ->> 'id';
  expected_id_suffix := '_' || pg_catalog.replace(p_application_version, '.', '-')
    || '_r' || p_workflow_revision::text;
  workflow_id_value := pg_catalog.substr(flow_id_value, 3, 36);
  if (p_candidate ->> 'namespace') <> expected_namespace
    or pg_catalog.char_length(flow_id_value) > 100
    or flow_id_value <> 'w_' || workflow_id_value || expected_id_suffix
    or workflow_id_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or not vortex_context.is_non_nil_uuid(workflow_id_value) then
    raise exception using errcode = '22023',
      message = 'Workflow flow candidate identity does not match its installation';
  end if;

  -- The identity must name a real published release of an Application the
  -- organisation owns, and the flow's workflow must be published in exactly that
  -- release. A caller can never register a mapping for another organisation's
  -- Application, an unpublished revision or a workflow the release lacks. The
  -- key-share locks keep that release evidence in place for this transaction.
  perform 1
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = p_installation_revision
    and application_release.release_version = p_application_version
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
    and application_release.compilation_output #>> '{kind}' = 'application'
    and application_release.compilation_output #>> '{canonical,envelope,rootId}'
      = p_application_root_id::text
    and 1 = (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            application_release.compilation_output #> '{canonical,content,flows}'
          ) = 'array'
            then application_release.compilation_output #> '{canonical,content,flows}'
          else '[]'::jsonb
        end
      ) as published_flow(value)
      where pg_catalog.jsonb_typeof(published_flow.value) = 'object'
        and pg_catalog.jsonb_typeof(published_flow.value -> 'id') = 'string'
        and pg_catalog.lower(published_flow.value ->> 'id') = workflow_id_value
    )
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(
          application_release.compilation_output #> '{canonical,content,flows}'
        ) = 'array' then application_release.compilation_output #> '{canonical,content,flows}'
        else '[]'::jsonb end
      ) as published_flow(value)
      where pg_catalog.lower(published_flow.value ->> 'id') = workflow_id_value
        and published_flow.value -> 'execution' = '"durable"'::jsonb
    )
  for key share of application_release, application_root;
  if not found then
    raise exception using errcode = '22023',
      message = 'Workflow flow candidate does not belong to a published release';
  end if;

  candidate_fingerprint := 'sha256:' || pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_candidate::text, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into vortex_workflow.flow_registrations as registration (
    environment, organization_id, application_root_id, application_version,
    installation_revision, workflow_revision, namespace, flow_id,
    candidate_fingerprint, status, registered_at
  ) values (
    p_environment, p_organization_id, p_application_root_id, p_application_version,
    p_installation_revision, p_workflow_revision,
    p_candidate ->> 'namespace', flow_id_value,
    candidate_fingerprint, 'inactive', pg_catalog.statement_timestamp()
  )
  on conflict (
    environment, organization_id, application_root_id, application_version,
    installation_revision, workflow_revision, flow_id
  ) do nothing
  returning registration.* into stored;

  if stored.environment is not null then
    return query select 'registered'::text,
      vortex_workflow.flow_registration_to_json_internal(stored);
    return;
  end if;

  -- The row existed already (or a concurrent transaction committed it first).
  -- The fingerprint decides: an exact retry converges, changed content is
  -- refused and left untouched.
  select registration.* into stored
  from vortex_workflow.flow_registrations as registration
  where registration.environment = p_environment
    and registration.organization_id = p_organization_id
    and registration.application_root_id = p_application_root_id
    and registration.application_version = p_application_version
    and registration.installation_revision = p_installation_revision
    and registration.workflow_revision = p_workflow_revision
    and registration.flow_id = flow_id_value;
  -- Rows are never deleted, so a conflict always leaves one row to compare.
  if not found then
    raise exception using errcode = '55000',
      message = 'Workflow flow registration is unavailable';
  end if;

  if stored.candidate_fingerprint <> candidate_fingerprint then
    return query select 'refused'::text,
      pg_catalog.jsonb_build_object('reasonCode', 'candidate_changed');
    return;
  end if;

  return query select 'existing'::text,
    vortex_workflow.flow_registration_to_json_internal(stored);
end
$function$;

alter function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) owner to postgres;

revoke all on function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) to vortex_runtime;
comment on function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) is
  'Idempotently registers one inactive durable Flow candidate under its exact published Application release identity, refusing a changed candidate for an existing identity.';

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

reset role;

commit;
