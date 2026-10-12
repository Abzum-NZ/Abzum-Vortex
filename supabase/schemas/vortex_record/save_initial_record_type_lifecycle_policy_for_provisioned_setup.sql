CREATE FUNCTION vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(p_binding_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_activity_id uuid, p_policy jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;

COMMENT ON FUNCTION vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(p_binding_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_activity_id uuid, p_policy jsonb) IS 'Narrow provisioned-setup save of one record type''s first lifecycle policy at revision 1, under one exact provisioned binding revision, exact organisation limits revision and the current applications.manage human authority; an existing policy is refused, never updated.';

REVOKE ALL ON FUNCTION vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(p_binding_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_activity_id uuid, p_policy jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(p_binding_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_activity_id uuid, p_policy jsonb) TO vortex_runtime;
