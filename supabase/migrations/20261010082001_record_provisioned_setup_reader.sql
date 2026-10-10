begin;

set local role vortex_record_owner;

create or replace function vortex_record.read_provisioned_lifecycle_policy_setup(
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
  expected_item jsonb;
  expected_root uuid;
  expected_revision bigint;
  previous_expected_root text;
  projection jsonb;
  projection_item jsonb;
  projection_storage_item jsonb;
  previous_projection_root text;
  previous_projection_storage text;
  previous_union_storage text;
  storage_ids uuid[] := array[]::uuid[];
  storage_id uuid;
  authority record;
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  context_after_lock jsonb;
  context_at_completion jsonb;
  final_decision record;
  completed_at timestamptz;
  expected_binding_count integer := 0;
  target_ordinal integer := 0;
  source_bindings jsonb;
  target_application_root_id uuid;
  target_policy jsonb;
  limits_value jsonb;
  targets_value jsonb := '[]'::jsonb;
  target_value jsonb;
  policy_found boolean;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_expected_module_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Provisioned lifecycle setup request is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_expected_module_bindings) not between 1 and 10000 then
    raise exception using errcode = '22023',
      message = 'Provisioned lifecycle setup request is invalid';
  end if;

  for expected_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings)
      with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    expected_binding_count := expected_binding_count + 1;
    if pg_catalog.jsonb_typeof(expected_item) <> 'object'
      or not expected_item ?& array['moduleRootId', 'bindingRevision']
      or expected_item - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(expected_item -> 'moduleRootId') <> 'string'
      or not vortex_record.is_lifecycle_uuid_text(expected_item ->> 'moduleRootId')
      or (expected_item ->> 'moduleRootId') <> pg_catalog.lower(expected_item ->> 'moduleRootId')
      or not vortex_record.is_lifecycle_revision_value(expected_item -> 'bindingRevision') then
      raise exception using errcode = '22023',
        message = 'Provisioned lifecycle setup request is invalid';
    end if;
    if previous_expected_root is not null
      and previous_expected_root collate "C"
        >= (expected_item ->> 'moduleRootId') collate "C" then
      raise exception using errcode = '22023',
        message = 'Provisioned lifecycle setup request is not canonical';
    end if;
    previous_expected_root := expected_item ->> 'moduleRootId';
  end loop;

  select locked.* into strict authority
  from vortex_access.lock_record_lifecycle_policy_authority() as locked;
  if authority.application_root_id is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Provisioned lifecycle setup authority is unavailable';
  end if;
  context_after_lock := vortex_access.validated_human_request_context();
  if context_after_lock is null
    or pg_catalog.jsonb_typeof(context_after_lock) <> 'object'
    or not context_after_lock ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'identityId', 'sessionId', 'authenticationStrength',
      'issuedAt', 'expiresAt', 'accessVersion', 'correlationId'
    ]
    or context_after_lock ->> 'callerKind' is distinct from 'human'
    or context_after_lock ->> 'applicationRootId' is distinct from p_application_root_id::text
    or context_after_lock ->> 'organizationId' is distinct from authority.organization_id::text
    or context_after_lock ->> 'organizationAccountId' is distinct from
      authority.organization_account_id::text
    or context_after_lock ->> 'accessVersion' is distinct from authority.access_version::text
    or context_after_lock ->> 'correlationId' is distinct from authority.correlation_id::text then
    raise exception using errcode = '42501',
      message = 'Provisioned lifecycle setup authority is unavailable';
  end if;

  projection := vortex_module.read_provisioned_lifecycle_setup_targets_internal(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  if projection is null
    or pg_catalog.jsonb_typeof(projection) <> 'object'
    or not projection ?& array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'registrationRevision', 'moduleBindings', 'storageContractIds'
    ]
    or projection - array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'registrationRevision', 'moduleBindings', 'storageContractIds'
    ] <> '{}'::jsonb
    or not vortex_record.is_lifecycle_uuid_text(projection ->> 'organizationId')
    or not vortex_record.is_lifecycle_uuid_text(projection ->> 'applicationRootId')
    or pg_catalog.lower(projection ->> 'organizationId') <> authority.organization_id::text
    or pg_catalog.lower(projection ->> 'applicationRootId') <> p_application_root_id::text
    or not vortex_record.is_lifecycle_revision_value(projection -> 'applicationReleaseRevision')
    or (projection ->> 'applicationReleaseRevision')::bigint <> p_application_release_revision
    or not vortex_record.is_lifecycle_revision_value(projection -> 'registrationRevision')
    or pg_catalog.jsonb_typeof(projection -> 'moduleBindings') <> 'array'
    or pg_catalog.jsonb_typeof(projection -> 'storageContractIds') <> 'array' then
    raise exception using errcode = '40001',
      message = 'Provisioned lifecycle setup source changed';
  end if;
  if pg_catalog.jsonb_array_length(projection -> 'moduleBindings') <> expected_binding_count then
    raise exception using errcode = '40001',
      message = 'Provisioned lifecycle setup source changed';
  end if;

  for projection_item in
    select item.value
    from pg_catalog.jsonb_array_elements(projection -> 'moduleBindings')
      with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    if pg_catalog.jsonb_typeof(projection_item) <> 'object'
      or not projection_item ?& array[
        'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state', 'storageContractIds'
      ]
      or projection_item - array[
        'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state', 'storageContractIds'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(projection_item -> 'moduleRootId') <> 'string'
      or not vortex_record.is_lifecycle_uuid_text(projection_item ->> 'moduleRootId')
      or (projection_item ->> 'moduleRootId') <> pg_catalog.lower(projection_item ->> 'moduleRootId')
      or not vortex_record.is_lifecycle_revision_value(projection_item -> 'moduleReleaseRevision')
      or not vortex_record.is_lifecycle_revision_value(projection_item -> 'bindingRevision')
      or projection_item ->> 'state' is distinct from 'provisioned'
      or pg_catalog.jsonb_typeof(projection_item -> 'storageContractIds') <> 'array' then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source is incomplete';
    end if;
    if previous_projection_root is not null
      and previous_projection_root collate "C"
        >= (projection_item ->> 'moduleRootId') collate "C" then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source is not canonical';
    end if;
    previous_projection_root := projection_item ->> 'moduleRootId';
    expected_root := (projection_item ->> 'moduleRootId')::uuid;
    expected_revision := (projection_item ->> 'bindingRevision')::bigint;
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
      where (expected.value ->> 'moduleRootId')::uuid = expected_root
        and (expected.value ->> 'bindingRevision')::bigint = expected_revision
    ) then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source changed';
    end if;

    previous_projection_storage := null;
    for projection_storage_item in
      select storage_item.value
      from pg_catalog.jsonb_array_elements(projection_item -> 'storageContractIds')
        with ordinality as storage_item(value, ordinal)
      order by storage_item.ordinal
    loop
      if pg_catalog.jsonb_typeof(projection_storage_item) <> 'string'
        or not vortex_record.is_lifecycle_uuid_text(projection_storage_item #>> '{}')
        or (projection_storage_item #>> '{}') <> pg_catalog.lower(projection_storage_item #>> '{}') then
        raise exception using errcode = '40001',
          message = 'Provisioned lifecycle setup source is incomplete';
      end if;
      if previous_projection_storage is not null
        and previous_projection_storage collate "C"
          >= (projection_storage_item #>> '{}') collate "C" then
        raise exception using errcode = '40001',
          message = 'Provisioned lifecycle setup source is not canonical';
      end if;
      previous_projection_storage := projection_storage_item #>> '{}';
      storage_id := (projection_storage_item #>> '{}')::uuid;
      if not storage_id = any (storage_ids) then
        storage_ids := pg_catalog.array_append(storage_ids, storage_id);
      end if;
    end loop;
  end loop;

  if pg_catalog.cardinality(storage_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Provisioned lifecycle setup has no policy targets';
  end if;
  storage_ids := array(select distinct item.value from pg_catalog.unnest(storage_ids) item(value)
    order by item.value);
  if pg_catalog.jsonb_array_length(projection -> 'storageContractIds') <>
    pg_catalog.cardinality(storage_ids) then
    raise exception using errcode = '40001',
      message = 'Provisioned lifecycle setup source is incomplete';
  end if;
  target_ordinal := 0;
  for projection_storage_item in
    select item.value
    from pg_catalog.jsonb_array_elements(projection -> 'storageContractIds')
      with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    target_ordinal := target_ordinal + 1;
    if pg_catalog.jsonb_typeof(projection_storage_item) <> 'string'
      or not vortex_record.is_lifecycle_uuid_text(projection_storage_item #>> '{}')
      or (projection_storage_item #>> '{}') <> pg_catalog.lower(projection_storage_item #>> '{}')
      or (projection_storage_item #>> '{}') <> storage_ids[target_ordinal]::text
      or (previous_union_storage is not null
        and previous_union_storage collate "C"
          >= (projection_storage_item #>> '{}') collate "C") then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle setup source is not canonical';
    end if;
    previous_union_storage := projection_storage_item #>> '{}';
  end loop;

  select stored.* into limits_row
  from vortex_record.organization_lifecycle_limits as stored
  where stored.organization_id = authority.organization_id
  for share;
  if not found
    or limits_row.settings_revision not between 1 and 9007199254740991
    or not vortex_record.is_lifecycle_action_list(limits_row.allowed_actions)
    or not vortex_record.is_lifecycle_destination_list(limits_row.allowed_archive_destinations)
    or limits_row.allow_unlimited_retention_days is distinct from
      (limits_row.max_retention_days is null)
    or limits_row.allow_unlimited_record_count is distinct from
      (limits_row.max_record_count is null) then
    raise exception using errcode = '23514',
      message = 'Provisioned lifecycle settings are incomplete';
  end if;
  limits_value := pg_catalog.jsonb_build_object(
    'organizationId', limits_row.organization_id,
    'settingsRevision', limits_row.settings_revision,
    'maxRetentionDays', limits_row.max_retention_days,
    'maxRecordCount', limits_row.max_record_count,
    'allowUnlimitedRetentionDays', limits_row.allow_unlimited_retention_days,
    'allowUnlimitedRecordCount', limits_row.allow_unlimited_record_count,
    'allowedActions', pg_catalog.to_jsonb(limits_row.allowed_actions),
    'allowedArchiveDestinations', pg_catalog.to_jsonb(limits_row.allowed_archive_destinations)
  );

  for storage_id in select item.value from pg_catalog.unnest(storage_ids) item(value)
    order by item.value
  loop
    select stored.* into catalogue_row
    from vortex_record.storage_catalogue as stored
    where stored.storage_contract_id = storage_id
      and stored.state = 'active'
    for share;
    if not found then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle target is incomplete';
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', binding.value ->> 'moduleRootId',
        'moduleReleaseRevision', (binding.value ->> 'moduleReleaseRevision')::bigint,
        'bindingRevision', (binding.value ->> 'bindingRevision')::bigint
      ) order by (binding.value ->> 'moduleRootId') collate "C"
    ) into source_bindings
    from pg_catalog.jsonb_array_elements(projection -> 'moduleBindings') as binding(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements(binding.value -> 'storageContractIds') as source(value)
      where (source.value #>> '{}')::uuid = storage_id
    );
    if source_bindings is null or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(source_bindings) as source(value)
      where (source.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id
    ) then
      raise exception using errcode = '40001',
        message = 'Provisioned lifecycle target source is incomplete';
    end if;

    target_application_root_id := case
      when catalogue_row.storage_scope = 'organization_shared' then null
      when catalogue_row.storage_scope = 'application_contained' then p_application_root_id
      else null
    end;
    if catalogue_row.storage_scope not in ('organization_shared', 'application_contained') then
      raise exception using errcode = '23514',
        message = 'Provisioned lifecycle target scope is invalid';
    end if;

    select stored.* into policy_row
    from vortex_record.record_type_lifecycle_policies as stored
    where stored.organization_id = authority.organization_id
      and stored.storage_contract_id = storage_id
      and stored.application_root_id is not distinct from target_application_root_id
    for share;
    policy_found := found;
    if not policy_found then
      target_policy := pg_catalog.jsonb_build_object('state', 'absent');
    else
      if not vortex_record.is_record_type_lifecycle_policy(policy_row.policy_body)
        or pg_catalog.lower(policy_row.policy_body ->> 'policyId') is distinct from
          policy_row.policy_id::text
        or pg_catalog.lower(policy_row.policy_body ->> 'organizationId') is distinct from
          authority.organization_id::text
        or pg_catalog.lower(policy_row.policy_body ->> 'storageContractId') is distinct from
          storage_id::text
        or pg_catalog.lower(policy_row.policy_body ->> 'applicationRootId') is distinct from
          target_application_root_id::text
        or policy_row.policy_body ->> 'policyRevision' is distinct from
          policy_row.policy_revision::text
        or policy_row.policy_body ->> 'action' is distinct from policy_row.action then
        raise exception using errcode = '23514',
          message = 'Provisioned lifecycle policy is inconsistent';
      end if;
      target_policy := pg_catalog.jsonb_build_object(
        'state', 'configured',
        'policyId', policy_row.policy_id,
        'policyRevision', policy_row.policy_revision,
        'policyBody', policy_row.policy_body
      );
    end if;

    target_value := pg_catalog.jsonb_build_object(
      'storageContractId', storage_id,
      'storageScope', catalogue_row.storage_scope,
      'applicationRootId', target_application_root_id,
      'sourceBindings', source_bindings,
      'policy', target_policy
    );
    targets_value := targets_value || pg_catalog.jsonb_build_array(target_value);
  end loop;

  -- Re-evaluate after every Module and Record lock wait. The request-role
  -- caller also repeats this check at completion, after validating the DTO.
  select evaluated.* into strict final_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  context_at_completion := vortex_access.validated_human_request_context();
  completed_at := pg_catalog.clock_timestamp();
  if context_at_completion is null
    or pg_catalog.jsonb_typeof(context_at_completion) <> 'object'
    or not context_at_completion ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'identityId', 'sessionId', 'authenticationStrength',
      'issuedAt', 'expiresAt', 'accessVersion', 'correlationId'
    ]
    or final_decision.outcome is distinct from 'eligible'
    or final_decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or final_decision.organization_id is distinct from authority.organization_id
    or final_decision.organization_account_id is distinct from authority.organization_account_id
    or final_decision.access_version is distinct from authority.access_version
    or final_decision.correlation_id is distinct from authority.correlation_id
    or final_decision.target_kind is distinct from 'organization'
    or final_decision.target_application_root_id is not null
    or final_decision.reason_code is not null
    or final_decision.valid_until is null
    or final_decision.checked_at is null
    or final_decision.checked_at > completed_at
    or final_decision.valid_until <= completed_at
    or context_at_completion ->> 'callerKind' is distinct from 'human'
    or context_at_completion ->> 'tenantId' is distinct from context_after_lock ->> 'tenantId'
    or context_at_completion ->> 'organizationId' is distinct from authority.organization_id::text
    or context_at_completion ->> 'organizationAccountId' is distinct from
      authority.organization_account_id::text
    or context_at_completion ->> 'applicationRootId' is distinct from p_application_root_id::text
    or context_at_completion ->> 'accessVersion' is distinct from authority.access_version::text
    or context_at_completion ->> 'correlationId' is distinct from authority.correlation_id::text
    or context_at_completion ->> 'identityId' is distinct from context_after_lock ->> 'identityId'
    or context_at_completion ->> 'sessionId' is distinct from context_after_lock ->> 'sessionId'
    or context_at_completion ->> 'authenticationStrength' is distinct from
      context_after_lock ->> 'authenticationStrength'
    or context_at_completion ->> 'accessTokenIssuedAt' is distinct from
      context_after_lock ->> 'accessTokenIssuedAt'
    or context_at_completion ->> 'primaryAuthenticatedAt' is distinct from
      context_after_lock ->> 'primaryAuthenticatedAt'
    or context_at_completion ->> 'multiFactorAuthenticatedAt' is distinct from
      context_after_lock ->> 'multiFactorAuthenticatedAt'
    or context_at_completion ->> 'issuedAt' is distinct from context_after_lock ->> 'issuedAt'
    or context_at_completion ->> 'expiresAt' is distinct from context_after_lock ->> 'expiresAt'
    or (context_at_completion ->> 'issuedAt')::timestamptz > completed_at
    or (context_at_completion ->> 'expiresAt')::timestamptz <= completed_at then
    raise exception using errcode = '42501',
      message = 'Provisioned lifecycle setup authority expired';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'registrationRevision', (projection ->> 'registrationRevision')::bigint,
    'organizationLimits', limits_value,
    'targets', targets_value
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Provisioned lifecycle setup evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Provisioned lifecycle setup evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Provisioned lifecycle setup request is invalid';
end
$function$;

alter function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb)
  owner to vortex_record_owner;

revoke all on function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter,
    vortex_module_owner;
grant execute on function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb)
  to vortex_request;

comment on function vortex_record.read_provisioned_lifecycle_policy_setup(uuid, bigint, jsonb) is
  'Read-only first-install projection of lifecycle limits and exact provisioned storage policies; binds a complete Module projection to current HUMAN policy-management authority.';


reset role;

commit;
