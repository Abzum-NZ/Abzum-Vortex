-- Activation and recovery policy integration (#567).
--
-- Two additions, both narrow and both built on top of #566 rather than
-- replacing any part of it:
--
-- 1. `vortex_record.read_application_lifecycle_policy_readiness` projects the
--    exact stored lifecycle policy of every record type an Application
--    installation owns, together with the organisation's current ceilings and
--    the live archive readiness facts those policies name. Module calls it
--    inside the activation transaction, immediately after
--    `vortex_module.activate_application_installation` has taken its own
--    exclusive binding locks and validated the human authority, and refuses
--    the activation when any policy is missing, out of scope or not
--    executable. Taking the snapshot after that write means this read never
--    upgrades a shared lock to an exclusive one and therefore adds no new
--    lock-order or deadlock edge, and the bindings it reads are already
--    'active'.
--
-- 2. `vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup`
--    closes the first-activation deadlock that (1) would otherwise create: the
--    #566 administration save requires an already-active installation, but an
--    installation can no longer become active without a stored policy. This
--    narrow primitive saves revision 1 only -- never an update -- for one
--    exact organisation, storage contract and application scope, under one
--    exact provisioned Module binding revision, the organisation's exact
--    current limits revision, and the same current
--    `platform.organization.applications.manage` human authority that #566
--    requires. It deliberately does not touch
--    `vortex_record.save_record_type_lifecycle_policy_for_administration`,
--    `vortex_module.record_lifecycle_target_is_installed_internal` or
--    `vortex_module.record_lifecycle_workflow_is_installed_internal`, so the
--    general policy-save authority stays exactly as #566 defined it: an
--    active installation.

begin;

set local role vortex_module_owner;

-- The exact storage contracts one activating Application installation owns.
-- The organisation is never taken from the caller: it is re-derived from the
-- validated human request context and the supplied value must match it, so a
-- request role cannot project another organisation's installation targets.
create function vortex_module.read_lifecycle_activation_targets_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns table (storage_contract_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
    ) then
    raise exception using errcode = '22023',
      message = 'Lifecycle activation target command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Lifecycle activation targets are unavailable';
  end if;

  return query
  select storage_id.value
  from vortex_module.installation_bindings as binding
  join pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    on expected.value ->> 'moduleRootId' = binding.module_root_id::text
    and expected.value ->> 'bindingRevision' = binding.binding_revision::text
  join pg_catalog.unnest(binding.storage_contract_ids) as storage_id(value) on true
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.application_release_revision = p_application_release_revision
    -- Activation has already flipped this exact binding set to 'active' under
    -- its own advisory and row locks earlier in this transaction.
    and binding.state = 'active'
  for share of binding;
end
$function$;

revoke all on function vortex_module.read_lifecycle_activation_targets_internal(
  uuid, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.read_lifecycle_activation_targets_internal(
  uuid, uuid, bigint, jsonb
) to vortex_record_owner;
comment on function vortex_module.read_lifecycle_activation_targets_internal(
  uuid, uuid, bigint, jsonb
) is 'Private activation-time installation fact: the exact storage contracts of one already-activated Application binding set, shared for the transaction.';

-- The one provisioned-setup installation fact, used only by the initial
-- policy save below. It is deliberately a separate function from
-- `record_lifecycle_target_is_installed_internal`: that one still answers
-- only for an active installation and still gates every #566 administration
-- save, and this one answers only for one exact provisioned binding revision
-- of one exact Application. When a workflow is supplied it also proves the
-- workflow belongs to that exact immutable Application release, exactly as
-- #566 does for an active installation.
create function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_expected_binding_revision bigint,
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
  provisioned_release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_binding_revision is null
    or p_expected_binding_revision not between 1 and 9007199254740991
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    -- A workflow reference is either completely absent or completely present.
    or (p_workflow_id is null) <> (p_expected_workflow_revision is null)
    or (p_workflow_id is not null
      and p_workflow_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_expected_workflow_revision is not null
      and p_expected_workflow_revision not between 1 and 9007199254740991) then
    return false;
  end if;

  select binding.application_release_revision into provisioned_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned'
    and binding.binding_revision = p_expected_binding_revision
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found then
    return false;
  end if;

  if p_workflow_id is null then
    return true;
  end if;

  -- There is no free-standing workflow revision in a compiled definition: the
  -- Application release revision is the workflow revision runtime pins.
  if provisioned_release_revision <> p_expected_workflow_revision then
    return false;
  end if;

  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = provisioned_release_revision
    and application_root.organization_id = p_organization_id
    and application_root.kind = 'application'
    and application_release.compilation_output #>> '{kind}' = 'application'
    and application_release.compilation_output #>> '{canonical,envelope,rootId}'
      = p_application_root_id::text
    and application_release.compilation_output #>> '{validationContractVersion}'
      = application_release.validation_contract_version
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
        and workflow.value ->> 'workflowId' = p_workflow_id::text
    )
  for share of application_release, application_root;

  return pg_catalog.coalesce(matched, false);
end
$function$;

revoke all on function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  uuid, uuid, bigint, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  uuid, uuid, bigint, uuid, uuid, bigint
) to vortex_record_owner;
comment on function vortex_module.record_lifecycle_provisioned_setup_target_internal(
  uuid, uuid, bigint, uuid, uuid, bigint
) is 'Private provisioned-setup installation fact for one exact Application binding revision and, optionally, one workflow of that exact immutable release; never used by the #566 administration save.';

reset role;

set local role vortex_record_owner;

-- The complete executable-policy snapshot for one activating Application.
-- Every record type the installation owns must have a current stored policy
-- in this organisation and scope; a missing, out-of-scope or unexecutable
-- policy raises, and Module turns that into a refused activation.
create function vortex_record.read_application_lifecycle_policy_readiness(
  p_organization_id uuid,
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
  target_storage_contract_ids uuid[];
  target_count integer := 0;
  policies jsonb := '[]'::jsonb;
  workflows jsonb := '[]'::jsonb;
  connections jsonb := '[]'::jsonb;
  connection_readiness jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Lifecycle activation readiness command is invalid';
  end if;

  -- One read of the installation targets, de-duplicated once, so the
  -- completeness check below cannot disagree with the policies collected.
  select pg_catalog.array_agg(distinct targets.storage_contract_id)
    into target_storage_contract_ids
  from vortex_module.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  if target_storage_contract_ids is null
    or pg_catalog.cardinality(target_storage_contract_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Lifecycle activation targets are incomplete';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    select stored.* into policy_row
    from vortex_record.record_type_lifecycle_policies as stored
    where stored.organization_id = p_organization_id
      and stored.storage_contract_id = target.storage_contract_id
      and stored.application_root_id is not distinct from case
        when target.storage_scope = 'application_contained' then p_application_root_id
        else null
      end
    for share;
    if not found then
      raise exception using errcode = '23514',
        message = 'Record-type lifecycle policy is unavailable';
    end if;
    policies := policies || pg_catalog.jsonb_build_array(policy_row.policy_body);

    if policy_row.action = 'archive_workflow' then
      -- An archive policy always carries a permanent Application scope; #566
      -- refuses to store an organisation-shared one.
      if policy_row.application_root_id is distinct from p_application_root_id then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive policy scope is unavailable';
      end if;

      if not vortex_module.record_lifecycle_workflow_is_installed_internal(
        p_organization_id,
        p_application_root_id,
        target.storage_contract_id,
        (policy_row.policy_body ->> 'archiveWorkflowId')::uuid,
        (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint
      ) then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive workflow is unavailable';
      end if;

      connection_readiness := vortex_connection.resolve_connection_instance_readiness(
        p_organization_id,
        p_application_root_id,
        (policy_row.policy_body ->> 'archiveConnectionInstanceId')::uuid,
        policy_row.policy_body ->> 'archiveDestination',
        (policy_row.policy_body #>> '{expectedConnectionRevision}')::bigint,
        policy_row.policy_body ->> 'expectedDestinationFingerprint'
      );
      -- Every returned fact is checked against the stored policy, exactly as
      -- the #566 save does: a 'ready' outcome alone is not evidence that the
      -- readiness answers the policy this activation is gating on.
      if connection_readiness ->> 'outcome' is distinct from 'ready'
        or pg_catalog.lower(connection_readiness ->> 'connectionInstanceId')
          is distinct from pg_catalog.lower(
            policy_row.policy_body ->> 'archiveConnectionInstanceId')
        or connection_readiness ->> 'organizationId' is distinct from p_organization_id::text
        or connection_readiness ->> 'applicationRootId'
          is distinct from p_application_root_id::text
        or connection_readiness ->> 'destinationKey'
          is distinct from policy_row.policy_body ->> 'archiveDestination'
        or connection_readiness ->> 'destinationFingerprint'
          is distinct from policy_row.policy_body ->> 'expectedDestinationFingerprint'
        or connection_readiness ->> 'revision'
          is distinct from policy_row.policy_body #>> '{expectedConnectionRevision}'
        or connection_readiness ->> 'healthOutcome' is distinct from 'healthy'
        or connection_readiness ->> 'state' is distinct from 'active' then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive connection is unavailable';
      end if;

      workflows := workflows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'workflowId', policy_row.policy_body ->> 'archiveWorkflowId',
        'workflowRevision',
          (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint,
        'organizationId', p_organization_id,
        'authorizedApplicationIds', pg_catalog.jsonb_build_array(p_application_root_id),
        'state', 'active'
      ));
      connections := connections || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'connectionInstanceId', connection_readiness ->> 'connectionInstanceId',
        'destinationKey', connection_readiness ->> 'destinationKey',
        'destinationFingerprint', connection_readiness ->> 'destinationFingerprint',
        'organizationId', p_organization_id,
        'authorizedApplicationIds', pg_catalog.jsonb_build_array(p_application_root_id),
        'state', connection_readiness ->> 'state',
        'revision', (connection_readiness ->> 'revision')::bigint,
        'lastHealthOutcome', connection_readiness ->> 'healthOutcome',
        'verifiedAt', connection_readiness -> 'verifiedAt'
      ));
    end if;
  end loop;

  -- Every installed storage contract must be an active catalogue entry with a
  -- policy. A target this read cannot account for is an incomplete
  -- installation, never an implicitly unmanaged record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Lifecycle activation targets are incomplete';
  end if;

  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = p_organization_id
  for share;
  if not found then
    raise exception using errcode = '23514',
      message = 'Organisation lifecycle limits are unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
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
      'organizationId', p_organization_id,
      'registeredWorkflows', workflows,
      'activeConnections', connections
    )
  );
end
$function$;

-- Initial policy setup for one record type of an Application that is still
-- being provisioned. This is the only way a revision-1 policy can be stored
-- before first activation, and it can do nothing else: an existing policy is
-- refused rather than updated, so it can never become a second, weaker route
-- to change a policy that #566 already governs.
create function vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
  p_binding_application_root_id uuid,
  p_expected_binding_revision bigint,
  p_storage_contract_id uuid,
  p_application_root_id uuid,
  p_expected_settings_revision bigint,
  p_activity_id uuid,
  p_policy jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  existing vortex_record.record_type_lifecycle_policies%rowtype;
  next_policy_id uuid;
  full_policy jsonb;
  connection_readiness jsonb;
begin
  if p_binding_application_root_id is null
    or p_binding_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_binding_revision is null
    or p_expected_binding_revision not between 1 and 9007199254740991
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    -- The policy scope is either this exact Application or, for an
    -- organisation-shared record type, no Application at all.
    or (p_application_root_id is not null
      and p_application_root_id is distinct from p_binding_application_root_id)
    or p_expected_settings_revision is null
    or p_expected_settings_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_policy is null
    or pg_catalog.jsonb_typeof(p_policy) <> 'object'
    -- Identity, scope and revision are assigned here, never accepted.
    or p_policy ?| array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision'
    ] then
    raise exception using errcode = '22023',
      message = 'Record-type lifecycle policy provisioned setup command is invalid';
  end if;

  -- The same registered `platform.organization.applications.manage` authority
  -- #566 requires, taken under the same organisation Access-version lock.
  select locked.* into strict authority
  from vortex_access.lock_record_lifecycle_policy_authority() as locked;

  -- Provisioned setup is always an Application-scoped request, and it must be
  -- scoped to exactly the Application whose binding authorises it.
  if authority.application_root_id is distinct from p_binding_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
  for share;
  if not found
    or catalogue_row.state <> 'active'
    or (catalogue_row.storage_scope = 'organization_shared')
      <> (p_application_root_id is null) then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy target is unavailable';
  end if;

  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = authority.organization_id
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organisation lifecycle limits are unavailable';
  end if;
  if limits_row.settings_revision <> p_expected_settings_revision then
    raise exception using errcode = '40001',
      message = 'Organisation lifecycle limits are stale';
  end if;

  -- Initial setup only. An existing policy belongs to the #566 administration
  -- save, which requires an active installation.
  select stored.* into existing
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = authority.organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for update;
  if found then
    raise exception using errcode = '40001',
      message = 'Record-type lifecycle policy is stale';
  end if;

  next_policy_id := pg_catalog.gen_random_uuid();
  full_policy := p_policy || pg_catalog.jsonb_build_object(
    'policyId', next_policy_id,
    'organizationId', authority.organization_id,
    'storageContractId', p_storage_contract_id,
    'applicationRootId', p_application_root_id,
    'policyRevision', 1
  );

  if not vortex_record.is_record_type_lifecycle_policy(full_policy) then
    raise exception using errcode = '22023',
      message = 'Record-type lifecycle policy provisioned setup command is invalid';
  end if;

  if full_policy ->> 'action' <> all (limits_row.allowed_actions) then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy action is not permitted by organisation limits';
  end if;

  if pg_catalog.jsonb_typeof(full_policy -> 'maxAgeDays') = 'number' then
    if limits_row.max_retention_days is not null
      and (full_policy #>> '{maxAgeDays}')::numeric > limits_row.max_retention_days then
      raise exception using errcode = '42501',
        message = 'Record-type lifecycle policy maxAgeDays exceeds organisation limit';
    end if;
  elsif not limits_row.allow_unlimited_retention_days then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy unlimited age retention is not permitted';
  end if;

  if pg_catalog.jsonb_typeof(full_policy -> 'maxCount') = 'number' then
    if limits_row.max_record_count is not null
      and (full_policy #>> '{maxCount}')::numeric > limits_row.max_record_count then
      raise exception using errcode = '42501',
        message = 'Record-type lifecycle policy maxCount exceeds organisation limit';
    end if;
  elsif not limits_row.allow_unlimited_record_count then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy unlimited record count is not permitted';
  end if;

  if full_policy ->> 'action' = 'archive_workflow'
    and (full_policy ->> 'archiveDestination')
      <> all (limits_row.allowed_archive_destinations) then
    raise exception using errcode = '42501',
      message =
        'Record-type lifecycle policy archive destination is not permitted by organisation limits';
  end if;

  -- The exact provisioned binding revision, and (for an archive policy) the
  -- workflow of that exact immutable Application release.
  if not vortex_module.record_lifecycle_provisioned_setup_target_internal(
    authority.organization_id,
    p_binding_application_root_id,
    p_expected_binding_revision,
    p_storage_contract_id,
    case when full_policy ->> 'action' = 'archive_workflow'
      then (full_policy ->> 'archiveWorkflowId')::uuid end,
    case when full_policy ->> 'action' = 'archive_workflow'
      then (full_policy #>> '{expectedWorkflowRevision}')::bigint end
  ) then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy target is unavailable';
  end if;

  if full_policy ->> 'action' = 'archive_workflow' then
    -- Runtime workflows and Connection grants require one permanent
    -- Application scope. An organisation-shared policy cannot invent one.
    if p_application_root_id is null then
      raise exception using errcode = '42501',
        message = 'Record-type lifecycle policy archive workflow is unavailable';
    end if;

    connection_readiness := vortex_connection.resolve_connection_instance_readiness(
      authority.organization_id,
      p_application_root_id,
      (full_policy ->> 'archiveConnectionInstanceId')::uuid,
      full_policy ->> 'archiveDestination',
      (full_policy #>> '{expectedConnectionRevision}')::bigint,
      full_policy ->> 'expectedDestinationFingerprint'
    );
    if connection_readiness ->> 'outcome' is distinct from 'ready'
      or pg_catalog.lower(connection_readiness ->> 'connectionInstanceId')
        is distinct from pg_catalog.lower(full_policy ->> 'archiveConnectionInstanceId')
      or connection_readiness ->> 'organizationId'
        is distinct from authority.organization_id::text
      or connection_readiness ->> 'applicationRootId'
        is distinct from p_application_root_id::text
      or connection_readiness ->> 'destinationKey'
        is distinct from full_policy ->> 'archiveDestination'
      or connection_readiness ->> 'destinationFingerprint'
        is distinct from full_policy ->> 'expectedDestinationFingerprint'
      or connection_readiness ->> 'revision'
        is distinct from full_policy #>> '{expectedConnectionRevision}'
      or connection_readiness ->> 'healthOutcome' is distinct from 'healthy'
      or connection_readiness ->> 'state' is distinct from 'active' then
      raise exception using errcode = '42501',
        message = 'Record-type lifecycle policy archive connection is unavailable';
    end if;
  end if;

  begin
    insert into vortex_record.record_type_lifecycle_policies (
      policy_id, organization_id, storage_contract_id, application_root_id,
      policy_revision, action, policy_body
    ) values (
      next_policy_id, authority.organization_id, p_storage_contract_id,
      p_application_root_id, 1, full_policy ->> 'action', full_policy
    );
  exception when unique_violation then
    raise exception using errcode = '40001',
      message = 'Record-type lifecycle policy is stale';
  end;

  perform vortex_record.append_lifecycle_policy_activity_internal(
    p_activity_id, next_policy_id
  );

  return full_policy;
end
$function$;

revoke all on function vortex_record.read_application_lifecycle_policy_readiness(
  uuid, uuid, bigint, jsonb
), vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
  uuid, bigint, uuid, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

-- Module reads the readiness snapshot from the request-role activation
-- transaction, the same role that calls
-- `vortex_module.activate_application_installation`.
grant execute on function vortex_record.read_application_lifecycle_policy_readiness(
  uuid, uuid, bigint, jsonb
) to vortex_request;

-- The initial policy save is a write primitive and follows the #566 rule that
-- every vortex_record write is callable only as vortex_runtime; the
-- request-role transaction re-elevates immediately before the call.
grant execute on function
  vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
    uuid, bigint, uuid, uuid, bigint, uuid, jsonb
  ) to vortex_runtime;

comment on function vortex_record.read_application_lifecycle_policy_readiness(
  uuid, uuid, bigint, jsonb
) is 'Complete executable-policy snapshot for one activating Application installation: every owned record type''s current policy, the organisation ceilings and the live archive readiness those policies name.';
comment on function
  vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(
    uuid, bigint, uuid, uuid, bigint, uuid, jsonb
  ) is 'Narrow provisioned-setup save of one record type''s first lifecycle policy at revision 1, under one exact provisioned binding revision, exact organisation limits revision and the current applications.manage human authority; an existing policy is refused, never updated.';

reset role;

commit;
