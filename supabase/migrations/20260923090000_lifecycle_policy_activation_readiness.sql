-- #567: policy setup is deliberately permitted while bindings are provisioned;
-- first activation then reads and locks those exact policies before changing
-- any binding state.  Requiring active bindings here made the first activation
-- impossible without a policy bypass.
set local role vortex_module_owner;

create or replace function vortex_module.record_lifecycle_target_is_installed_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_contract_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    return false;
  end if;
  select true into matched
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.state in ('provisioned', 'active')
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and (p_application_root_id is null or binding.application_root_id = p_application_root_id)
  limit 1
  for share;
  return pg_catalog.coalesce(matched, false);
end
$function$;

create or replace function vortex_module.record_lifecycle_workflow_is_installed_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_contract_id uuid,
  p_workflow_id uuid,
  p_expected_workflow_revision bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_application_root_id is null
    or p_storage_contract_id is null
    or p_workflow_id is null
    or p_expected_workflow_revision not between 1 and 9007199254740991 then
    return false;
  end if;
  select binding.application_release_revision into release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state in ('provisioned', 'active')
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found or release_revision <> p_expected_workflow_revision then return false; end if;
  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = release_revision
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
    and application_release.compilation_output #>> '{kind}' = 'application'
    and application_release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
    and application_release.compilation_output #>> '{validationContractVersion}' = application_release.validation_contract_version
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(application_release.compilation_output #> '{canonical,content,workflows}') = 'array'
          then application_release.compilation_output #> '{canonical,content,workflows}'
          else '[]'::jsonb end
      ) as workflow(value)
      where pg_catalog.jsonb_typeof(workflow.value) = 'object'
        and workflow.value ->> 'workflowId' = p_workflow_id::text
    )
  for share of application_release, application_root;
  return pg_catalog.coalesce(matched, false);
end
$function$;

create function vortex_module.read_lifecycle_activation_targets_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns table (organization_id uuid, storage_contract_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_organization_id uuid;
begin
  if p_application_root_id is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Lifecycle activation target command is invalid';
  end if;
  context_organization_id := vortex_context.organization_id();
  return query
  select binding.organization_id, storage_id.value
  from vortex_module.installation_bindings as binding
  join lateral pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    on expected.value ->> 'moduleRootId' = binding.module_root_id::text
    and expected.value ->> 'bindingRevision' = binding.binding_revision::text
  join lateral pg_catalog.unnest(binding.storage_contract_ids) as storage_id(value) on true
  where binding.organization_id = context_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.application_release_revision = p_application_release_revision
    and binding.state in ('provisioned', 'active')
  for share of binding;
end
$function$;

grant execute on function vortex_module.read_lifecycle_activation_targets_internal(uuid, bigint, jsonb)
  to vortex_record_owner;
grant usage on schema vortex_module to vortex_record_owner;
reset role;

grant usage on schema vortex_context to vortex_module_owner;
grant execute on function vortex_context.organization_id() to vortex_module_owner;

set local role vortex_record_owner;

create function vortex_record.read_application_lifecycle_policy_readiness(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target record;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  target_count integer := 0;
  expected_target_count integer := 0;
  selected_organization_id uuid;
  policies jsonb := '[]'::jsonb;
  workflows jsonb := '[]'::jsonb;
  connections jsonb := '[]'::jsonb;
  connection_readiness jsonb;
begin
  select pg_catalog.count(distinct targets.storage_contract_id)::integer into expected_target_count
  from vortex_module.read_lifecycle_activation_targets_internal(
    p_application_root_id, p_application_release_revision, p_expected_module_bindings
  ) as targets;
  for target in
    select distinct targets.organization_id, targets.storage_contract_id, catalogue.storage_scope
    from vortex_module.read_lifecycle_activation_targets_internal(
      p_application_root_id, p_application_release_revision, p_expected_module_bindings
    ) as targets
    join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = targets.storage_contract_id
    where catalogue.state = 'active'
    order by targets.storage_contract_id
  loop
    target_count := target_count + 1;
    if selected_organization_id is null then
      selected_organization_id := target.organization_id;
    elsif selected_organization_id <> target.organization_id then
      raise exception using errcode = '23514', message = 'Lifecycle activation targets are not organisation-local';
    end if;
    select stored.* into policy_row
    from vortex_record.record_type_lifecycle_policies as stored
    where stored.organization_id = target.organization_id
      and stored.storage_contract_id = target.storage_contract_id
      and stored.application_root_id is not distinct from case
        when target.storage_scope = 'application_contained' then p_application_root_id else null end
    for share;
    if not found then
      raise exception using errcode = '23514', message = 'Record-type lifecycle policy is unavailable';
    end if;
    policies := policies || pg_catalog.jsonb_build_array(policy_row.policy_body);
    if policy_row.action = 'archive_workflow' then
      if not vortex_module.record_lifecycle_workflow_is_installed_internal(
        target.organization_id, p_application_root_id, target.storage_contract_id,
        (policy_row.policy_body ->> 'archiveWorkflowId')::uuid,
        (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint
      ) then
        raise exception using errcode = '23514', message = 'Record-type lifecycle archive workflow is unavailable';
      end if;
      connection_readiness := vortex_connection.resolve_connection_instance_readiness(
        target.organization_id, p_application_root_id,
        (policy_row.policy_body ->> 'archiveConnectionInstanceId')::uuid,
        policy_row.policy_body ->> 'archiveDestination',
        (policy_row.policy_body #>> '{expectedConnectionRevision}')::bigint,
        policy_row.policy_body ->> 'expectedDestinationFingerprint'
      );
      if connection_readiness ->> 'outcome' is distinct from 'ready' then
        raise exception using errcode = '23514', message = 'Record-type lifecycle archive connection is unavailable';
      end if;
      workflows := workflows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'workflowId', policy_row.policy_body ->> 'archiveWorkflowId',
        'workflowRevision', (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint,
        'organizationId', target.organization_id,
        'authorizedApplicationIds', pg_catalog.jsonb_build_array(p_application_root_id),
        'state', 'active'
      ));
      connections := connections || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'connectionInstanceId', connection_readiness ->> 'connectionInstanceId',
        'destinationKey', connection_readiness ->> 'destinationKey',
        'destinationFingerprint', connection_readiness ->> 'destinationFingerprint',
        'organizationId', target.organization_id,
        'authorizedApplicationIds', pg_catalog.jsonb_build_array(p_application_root_id),
        'state', connection_readiness ->> 'state',
        'revision', (connection_readiness ->> 'revision')::bigint,
        'lastHealthOutcome', connection_readiness ->> 'healthOutcome',
        'verifiedAt', connection_readiness -> 'verifiedAt'
      ));
    end if;
  end loop;
  if target_count = 0 or target_count <> expected_target_count then
    raise exception using errcode = '23514', message = 'Lifecycle activation targets are incomplete';
  end if;
  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = selected_organization_id
  for share;
  if not found then
    raise exception using errcode = '23514', message = 'Organisation lifecycle limits are unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'applicationRootId', p_application_root_id,
    'policies', policies,
    'organizationLimits', pg_catalog.jsonb_build_object(
      'organizationId', limits_row.organization_id,
      'settingsRevision', limits_row.settings_revision,
      'maxRetentionDays', limits_row.max_retention_days,
      'maxRecordCount', limits_row.max_record_count,
      'allowUnlimitedRetentionDays', limits_row.allow_unlimited_retention_days,
      'allowUnlimitedRecordCount', limits_row.allow_unlimited_record_count,
      'allowedActions', pg_catalog.to_jsonb(limits_row.allowed_actions),
      'allowedArchiveDestinations', pg_catalog.to_jsonb(limits_row.allowed_archive_destinations)
    ),
    'readinessEvidence', pg_catalog.jsonb_build_object(
      'organizationId', selected_organization_id,
      'registeredWorkflows', workflows,
      'activeConnections', connections
    )
  );
end
$function$;

grant usage on schema vortex_record to vortex_request;
grant usage on schema vortex_connection to vortex_record_owner;
grant execute on function vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text)
  to vortex_record_owner;
grant execute on function vortex_record.read_application_lifecycle_policy_readiness(uuid, bigint, jsonb)
  to vortex_request;
revoke all on function vortex_record.read_application_lifecycle_policy_readiness(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
reset role;
