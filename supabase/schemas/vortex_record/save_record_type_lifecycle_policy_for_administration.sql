CREATE OR REPLACE FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  authority record;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  existing vortex_record.record_type_lifecycle_policies%rowtype;
  has_existing boolean;
  next_revision bigint;
  next_policy_id uuid;
  full_policy jsonb;
  connection_readiness jsonb;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_expected_settings_revision is null
    or p_expected_settings_revision not between 1 and 9007199254740991
    or (p_expected_policy_revision is not null
      and p_expected_policy_revision not between 1 and 9007199254740991)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_policy is null
    or pg_catalog.jsonb_typeof(p_policy) <> 'object'
    -- Identity, scope and revision are assigned by this operation. A caller
    -- that supplies any of them is refused rather than silently overridden.
    or p_policy ?| array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision'
    ] then
    raise exception using errcode = '22023',
      message = 'Record-type lifecycle policy command is invalid';
  end if;

  select locked.* into strict authority
  from vortex_access.lock_record_lifecycle_policy_authority() as locked;

  -- The resolved request scope must be application-bound exactly when the
  -- target is application-contained, and bound to the exact same application.
  if (p_application_root_id is null) <> (authority.application_root_id is null)
    or (p_application_root_id is not null
      and authority.application_root_id <> p_application_root_id) then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy administration is unavailable';
  end if;

  -- Exact target existence and application-contained/organisation-shared
  -- scope shape: the storage contract must be an active record-type target
  -- whose declared scope matches the supplied application root ID (null only
  -- for organisation-shared record types).
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

  -- A platform storage contract is not a target for every organisation: the
  -- record type must belong to a currently active installation here.
  if not vortex_definition.record_lifecycle_target_is_installed_internal(
    authority.organization_id, p_application_root_id, p_storage_contract_id
  ) then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy target is unavailable';
  end if;

  -- A policy can only be bound to the exact, current organisation limits
  -- revision the caller reviewed; a concurrently changed ceiling is a stale
  -- refusal, never a silent reinterpretation under the new limits.
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

  select stored.* into existing
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = authority.organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for update;
  -- `found` is reset by every later query, so the create/update decision is
  -- kept in its own variable.
  has_existing := found;

  if has_existing then
    if p_expected_policy_revision is null
      or existing.policy_revision <> p_expected_policy_revision then
      raise exception using errcode = '40001',
        message = 'Record-type lifecycle policy is stale';
    end if;
    if existing.policy_revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Record-type lifecycle policy revision is exhausted';
    end if;
    next_revision := existing.policy_revision + 1;
    next_policy_id := existing.policy_id;
  else
    if p_expected_policy_revision is not null then
      raise exception using errcode = '40001',
        message = 'Record-type lifecycle policy is stale';
    end if;
    next_revision := 1;
    next_policy_id := pg_catalog.gen_random_uuid();
  end if;

  -- The envelope (identity, scope and revision) is assigned here, never
  -- accepted from the caller; this is what keeps `policyId` immutable.
  full_policy := p_policy || pg_catalog.jsonb_build_object(
    'policyId', next_policy_id,
    'organizationId', authority.organization_id,
    'storageContractId', p_storage_contract_id,
    'applicationRootId', p_application_root_id,
    'policyRevision', next_revision
  );

  if not vortex_record.is_record_type_lifecycle_policy(full_policy) then
    raise exception using errcode = '22023',
      message = 'Record-type lifecycle policy command is invalid';
  end if;

  -- Enforce organisation limits: allowed action, age/count ceilings and
  -- unlimited permissions, and (for archive_workflow) an allowed
  -- destination. This is re-checked here, under the limits row's lock,
  -- rather than trusted from an earlier, possibly stale, client read.
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

  if full_policy ->> 'action' = 'archive_workflow' then
    -- Runtime workflows and Connection grants require one permanent
    -- Application scope. An organisation-shared policy cannot invent one.
    if p_application_root_id is null
      or not vortex_definition.record_lifecycle_workflow_is_installed_internal(
        authority.organization_id,
        p_application_root_id,
        p_storage_contract_id,
        (full_policy ->> 'archiveWorkflowId')::uuid,
        (full_policy #>> '{expectedWorkflowRevision}')::bigint
      ) then
      raise exception using errcode = '42501',
        message = 'Record-type lifecycle policy archive workflow is unavailable';
    end if;

    connection_readiness := vortex_platform.resolve_connection_instance_readiness(
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

  if has_existing then
    update vortex_record.record_type_lifecycle_policies as stored set
      policy_revision = next_revision,
      action = full_policy ->> 'action',
      policy_body = full_policy,
      changed_at = pg_catalog.statement_timestamp()
    where stored.policy_id = next_policy_id;
  else
    begin
      insert into vortex_record.record_type_lifecycle_policies (
        policy_id, organization_id, storage_contract_id, application_root_id,
        policy_revision, action, policy_body
      ) values (
        next_policy_id, authority.organization_id, p_storage_contract_id,
        p_application_root_id, next_revision, full_policy ->> 'action', full_policy
      );
    exception when unique_violation then
      raise exception using errcode = '40001',
        message = 'Record-type lifecycle policy is stale';
    end;
  end if;

  perform vortex_record.append_lifecycle_policy_activity_internal(
    p_activity_id, next_policy_id
  );

  return full_policy;
end
$$;
alter function vortex_record.save_record_type_lifecycle_policy_for_administration(uuid,uuid,bigint,bigint,uuid,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) IS 'Protected administrator save (create or update) of one record type''s current lifecycle policy within current organisation limits; stale organisation-limits/policy revisions, uninstalled or unknown targets, unready archive bindings and disallowed actions/destinations are refused. policyId is server-assigned and immutable; successful Activity commits atomically.';

REVOKE ALL ON FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) TO vortex_runtime;
