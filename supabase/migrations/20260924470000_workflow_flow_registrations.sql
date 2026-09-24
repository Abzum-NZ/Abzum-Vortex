-- #947 (part B of #661): idempotent registration of inactive workflow flow
-- candidates.
--
-- #661 part A compiles one exact published WorkflowDefinition plus installation
-- and release identity into a deterministic inactive Kestra flow candidate
-- (`runtime/workflow/src/kestra-compiler.ts`). Publishing is inert: the compiler
-- registers nothing and enables nothing. This migration adds the database half
-- of preparation, additive only:
--
-- 1. `vortex_workflow.flow_registrations` maps one exact installation and
--    release identity (environment, organisation, Application root, published
--    Application version, installation revision and workflow revision) plus the
--    generated workflow flow id to the generated namespace and a fingerprint of
--    the whole candidate. The part A identity carries no separate workflow id,
--    so the deterministic generated flow id (which already names the permanent
--    workflow) is part of the mapping's unique key: two workflows of one
--    installation never collide, and an exact retry still converges. Every row
--    is `inactive`; activation is a separate, later operation, so this table can
--    never hold an active flow.
-- 2. `vortex_workflow.register_workflow_flow_candidate` validates one candidate
--    against its identity and the stored release evidence (the organisation's
--    own Application root, the exact published release and version, and the
--    workflow published in it) and is duplicate-safe: repeating one exact
--    identity and candidate converges on the stored row, while a different
--    candidate for the same identity is refused, never overwritten.
--
-- The fingerprint is computed here from the validated candidate, and the stored
-- namespace and flow id must equal the ones derived from the permanent
-- identity. Identity is never recovered from diagnostic labels. The
-- table is revoked from every role and reached only through the function, which
-- is granted to the private runtime that prepares flows. No flow is called, run
-- or deployed and nothing here enables anything.

begin;

create schema if not exists vortex_workflow authorization postgres;

revoke all on schema vortex_workflow from public, anon, authenticated, service_role;
grant usage on schema vortex_workflow to vortex_runtime;

alter default privileges for role postgres in schema vortex_workflow
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_workflow
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema vortex_workflow
  revoke execute on functions from public, anon, authenticated, service_role;

create table vortex_workflow.flow_registrations (
  environment text not null,
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid not null,
  application_version text not null,
  installation_revision bigint not null,
  workflow_revision bigint not null,
  namespace text not null,
  flow_id text not null,
  candidate_fingerprint text not null,
  status text not null default 'inactive',
  registered_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint flow_registrations_pk primary key (
    environment,
    organization_id,
    application_root_id,
    application_version,
    installation_revision,
    workflow_revision,
    flow_id
  ),
  constraint flow_registrations_environment_valid check (
    environment in ('local', 'testing', 'production')
  ),
  constraint flow_registrations_ids_non_nil check (
    vortex_context.is_non_nil_uuid(organization_id::text)
    and vortex_context.is_non_nil_uuid(application_root_id::text)
  ),
  constraint flow_registrations_application_version_valid check (
    application_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  constraint flow_registrations_revisions_valid check (
    installation_revision between 1 and 9007199254740991
    and workflow_revision between 1 and 9007199254740991
  ),
  constraint flow_registrations_namespace_valid check (
    pg_catalog.char_length(namespace) between 1 and 150
  ),
  constraint flow_registrations_flow_id_valid check (
    pg_catalog.char_length(flow_id) between 1 and 100
  ),
  constraint flow_registrations_fingerprint_valid check (
    candidate_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint flow_registrations_status_inactive check (status = 'inactive'),
  constraint flow_registrations_registered_at_valid check (
    registered_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

comment on table vortex_workflow.flow_registrations is
  'Protected mapping from one exact installation and release identity to the generated inactive Kestra flow candidate: namespace, flow id and candidate fingerprint. Rows are inactive and are written only by the protected register function.';

alter table vortex_workflow.flow_registrations enable row level security;
alter table vortex_workflow.flow_registrations force row level security;

revoke all on table vortex_workflow.flow_registrations
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- The canonical registration projection: permanent identity, generated provider
-- identity and the candidate fingerprint, never the candidate's task bodies.
create function vortex_workflow.flow_registration_to_json_internal(
  r vortex_workflow.flow_registrations
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'environment', r.environment,
    'organizationId', r.organization_id,
    'applicationRootId', r.application_root_id,
    'applicationVersion', r.application_version,
    'installationRevision', r.installation_revision,
    'workflowRevision', r.workflow_revision,
    'namespace', r.namespace,
    'flowId', r.flow_id,
    'candidateFingerprint', r.candidate_fingerprint,
    'status', r.status,
    'registeredAt', pg_catalog.to_char(r.registered_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
$function$;

-- Registers one part A candidate under its exact installation and release
-- identity, or reports one already exists. A repeated exact candidate converges
-- on the stored row; a different candidate for the same identity is refused
-- without touching it. The candidate is validated against the identity and is
-- never active, so registration can never enable a flow.
create function vortex_workflow.register_workflow_flow_candidate(
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
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            application_release.compilation_output #> '{canonical,content,workflows}'
          ) = 'array'
            then application_release.compilation_output #> '{canonical,content,workflows}'
          else '[]'::jsonb
        end
      ) as workflow(value)
      where pg_catalog.jsonb_typeof(workflow.value) = 'object'
        and pg_catalog.lower(workflow.value ->> 'workflowId') = workflow_id_value
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

-- The candidate projection stays private; the register function is reached only
-- through the private flow-preparation runtime.
revoke all on function vortex_workflow.flow_registration_to_json_internal(
  vortex_workflow.flow_registrations
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) to vortex_runtime;

comment on function vortex_workflow.flow_registration_to_json_internal(
  vortex_workflow.flow_registrations
) is
  'Canonical private projection of one inactive flow registration; never granted above the owning runtime.';
comment on function vortex_workflow.register_workflow_flow_candidate(
  text, uuid, uuid, text, bigint, bigint, jsonb
) is
  'Idempotently registers one inactive workflow flow candidate under its exact installation and release identity, refusing a changed candidate for an existing identity.';

commit;
