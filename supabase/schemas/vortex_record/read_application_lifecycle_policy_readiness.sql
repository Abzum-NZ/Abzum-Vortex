CREATE OR REPLACE FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  from vortex_definition.read_lifecycle_activation_targets_internal(
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

      if not vortex_definition.record_lifecycle_workflow_is_installed_internal(
        p_organization_id,
        p_application_root_id,
        target.storage_contract_id,
        (policy_row.policy_body ->> 'archiveWorkflowId')::uuid,
        (policy_row.policy_body #>> '{expectedWorkflowRevision}')::bigint
      ) then
        raise exception using errcode = '23514',
          message = 'Record-type lifecycle archive workflow is unavailable';
      end if;

      connection_readiness := vortex_platform.resolve_connection_instance_readiness(
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
$$;
alter function vortex_record.read_application_lifecycle_policy_readiness(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Complete executable-policy snapshot for one activating Application installation: every owned record type''s current policy, the organisation ceilings and the live archive readiness those policies name.';

REVOKE ALL ON FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;
