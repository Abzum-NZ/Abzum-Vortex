-- Preserve the previous setup choice explicitly for existing organisations.
-- Future setup supplies the policy; the column has no database default.
set local role vortex_owner;

alter table vortex_record.organization_lifecycle_limits add column initial_policy jsonb;
update vortex_record.organization_lifecycle_limits
set initial_policy = '{"action":"delete","maxAgeDays":null,"maxCount":null,"allowUnlimitedAge":true,"allowUnlimitedCount":true,"recoveryWindowDays":30}'::jsonb;
alter table vortex_record.organization_lifecycle_limits alter column initial_policy set not null;

create or replace function vortex_record.initialize_organization_lifecycle_limits(
  p_organization_id uuid,
  p_limits jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_record.organization_lifecycle_limits%rowtype;
  max_retention_value bigint;
  max_count_value bigint;
  allow_unlimited_retention_value boolean;
  allow_unlimited_count_value boolean;
  allowed_actions_value text[];
  allowed_destinations_value text[];
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_limits is null
    or pg_catalog.jsonb_typeof(p_limits) <> 'object'
    or not p_limits ?& array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations', 'initialPolicy'
    ]
    or p_limits - array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations', 'initialPolicy'
    ] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_limits ->> 'organizationId')
    or pg_catalog.lower(p_limits ->> 'organizationId')
      <> pg_catalog.lower(p_organization_id::text)
    or (p_limits -> 'settingsRevision') <> pg_catalog.to_jsonb(1)
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRetentionDays') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRecordCount') <> 'boolean'
    or not vortex_record.is_lifecycle_limit_value(p_limits -> 'maxRetentionDays')
    or not vortex_record.is_lifecycle_limit_value(p_limits -> 'maxRecordCount')
    or (p_limits -> 'allowUnlimitedRetentionDays' = 'true'::jsonb)
      <> (pg_catalog.jsonb_typeof(p_limits -> 'maxRetentionDays') = 'null')
    or (p_limits -> 'allowUnlimitedRecordCount' = 'true'::jsonb)
      <> (pg_catalog.jsonb_typeof(p_limits -> 'maxRecordCount') = 'null')
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') <> 'array'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') <> 'array'
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') = 'array'
          then p_limits -> 'allowedActions' else '[]'::jsonb end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') = 'array'
            then p_limits -> 'allowedArchiveDestinations'
          else '[]'::jsonb
        end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    ) then
    raise exception using errcode = '22023',
      message = 'Organisation lifecycle limits setup is invalid';
  end if;

  max_retention_value := case
    when pg_catalog.jsonb_typeof(p_limits -> 'maxRetentionDays') = 'null' then null
    else (p_limits #>> '{maxRetentionDays}')::bigint
  end;
  max_count_value := case
    when pg_catalog.jsonb_typeof(p_limits -> 'maxRecordCount') = 'null' then null
    else (p_limits #>> '{maxRecordCount}')::bigint
  end;
  allow_unlimited_retention_value := (p_limits -> 'allowUnlimitedRetentionDays') = 'true'::jsonb;
  allow_unlimited_count_value := (p_limits -> 'allowUnlimitedRecordCount') = 'true'::jsonb;
  select coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_actions_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedActions')
    with ordinality as item(value, ordinal);
  select coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_destinations_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedArchiveDestinations')
    with ordinality as item(value, ordinal);

  if not vortex_record.is_lifecycle_action_list(allowed_actions_value)
    or not vortex_record.is_lifecycle_destination_list(allowed_destinations_value)
    or (
      'archive_workflow' = any (allowed_actions_value)
      and pg_catalog.cardinality(allowed_destinations_value) = 0
    ) then
    raise exception using errcode = '22023',
      message = 'Organisation lifecycle limits setup is invalid';
  end if;

  -- Identity fields are supplied by installation, never by the setup template.
  if pg_catalog.jsonb_typeof(p_limits -> 'initialPolicy') is distinct from 'object'
    or (p_limits -> 'initialPolicy') ?| array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId', 'policyRevision'
    ]
    or (p_limits #>> '{initialPolicy,action}') is distinct from 'delete'
    or not (p_limits -> 'initialPolicy') ? 'recoveryWindowDays'
    or not vortex_record.is_record_type_lifecycle_policy(
      (p_limits -> 'initialPolicy') || pg_catalog.jsonb_build_object(
        'policyId', p_organization_id, 'organizationId', p_organization_id,
        'storageContractId', p_organization_id, 'applicationRootId', null, 'policyRevision', 1
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Initial record lifecycle policy setup is invalid';
  end if;

  if (p_limits #>> '{initialPolicy,action}') <> all (allowed_actions_value)
    or ((p_limits #> '{initialPolicy,allowUnlimitedAge}') = 'true'::jsonb
      and not allow_unlimited_retention_value)
    or ((p_limits #> '{initialPolicy,allowUnlimitedCount}') = 'true'::jsonb
      and not allow_unlimited_count_value)
    or (max_retention_value is not null
      and (p_limits #>> '{initialPolicy,maxAgeDays}')::numeric > max_retention_value)
    or (max_count_value is not null
      and (p_limits #>> '{initialPolicy,maxCount}')::numeric > max_count_value) then
    raise exception using errcode = '23514',
      message = 'Initial record lifecycle policy exceeds organisation limits';
  end if;

  -- Serialize the absent-row case as well as retries against an existing row.
  -- Locking only the settings row cannot coordinate two concurrent first calls.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_record.lifecycle_limits:' || p_organization_id::text,
      0
    )
  );

  -- The existing row is the setup decision for this organisation. Locking it
  -- makes two simultaneous identical calls behave as retries.
  select stored.* into existing
  from vortex_record.organization_lifecycle_limits as stored
  where stored.organization_id = p_organization_id
  for update;

  if found then
    if existing.initial_policy is distinct from p_limits -> 'initialPolicy'
      or existing.settings_revision <> 1
      or existing.max_retention_days is distinct from max_retention_value
      or existing.max_record_count is distinct from max_count_value
      or existing.allow_unlimited_retention_days is distinct from allow_unlimited_retention_value
      or existing.allow_unlimited_record_count is distinct from allow_unlimited_count_value
      or existing.allowed_actions is distinct from allowed_actions_value
      or existing.allowed_archive_destinations is distinct from allowed_destinations_value then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end if;
  else
    begin
      insert into vortex_record.organization_lifecycle_limits (
        organization_id, settings_revision, max_retention_days, max_record_count,
        allow_unlimited_retention_days, allow_unlimited_record_count,
        allowed_actions, allowed_archive_destinations, initial_policy
      ) values (
        p_organization_id, 1, max_retention_value, max_count_value,
        allow_unlimited_retention_value, allow_unlimited_count_value,
        allowed_actions_value, allowed_destinations_value, p_limits -> 'initialPolicy'
      ) returning * into existing;
    exception when unique_violation then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', existing.organization_id,
    'settingsRevision', existing.settings_revision,
    'maxRetentionDays', existing.max_retention_days,
    'maxRecordCount', existing.max_record_count,
    'allowUnlimitedRetentionDays', existing.allow_unlimited_retention_days,
    'allowUnlimitedRecordCount', existing.allow_unlimited_record_count,
    'allowedActions', pg_catalog.to_jsonb(existing.allowed_actions),
    'allowedArchiveDestinations', pg_catalog.to_jsonb(existing.allowed_archive_destinations)
  );
end
$function$;

alter function vortex_record.initialize_organization_lifecycle_limits(uuid,jsonb) owner to vortex_owner;

revoke all on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb)
  to vortex_owner;
grant execute on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) to vortex_runtime;

comment on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) is
  'Trusted explicit setup of one organisation lifecycle ceiling row at revision 1; identical retries return the existing row and conflicting retries refuse.';

create or replace function vortex_record.ensure_application_lifecycle_policies(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  target record;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  target_storage_contract_ids uuid[];
  policy_scope uuid;
  next_policy_id uuid;
  full_policy jsonb;
  inserted_count integer;
  stored_count integer := 0;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Lifecycle policy installation command is invalid';
  end if;

  -- The installer authority that provisioned this release's storage in the same transaction.
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission',
        vortex_access.required_platform_permission('platform.organization.applications.manage'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible'
    or permission_decision.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Lifecycle policy installation authority is unavailable';
  end if;

  -- The storage contracts of the binding set the activation just switched on, read once.
  -- Modules that hold no record types yet have no targets: zero record types, zero policies.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = p_organization_id
  for share;
  if not found then
    raise exception using errcode = '23514',
      message = 'Organisation lifecycle limits are unavailable';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    policy_scope := case
      when target.storage_scope = 'application_contained' then p_application_root_id
      else null
    end;
    -- A stored policy is the organisation's current choice and is never replaced here.
    continue when exists (
      select 1
      from vortex_record.record_type_lifecycle_policies as stored
      where stored.organization_id = p_organization_id
        and stored.storage_contract_id = target.storage_contract_id
        and stored.application_root_id is not distinct from policy_scope
    );

    next_policy_id := pg_catalog.gen_random_uuid();
    full_policy := limits_row.initial_policy || pg_catalog.jsonb_build_object(
      'policyId', next_policy_id,
      'organizationId', p_organization_id,
      'storageContractId', target.storage_contract_id,
      'applicationRootId', policy_scope,
      'policyRevision', 1
    );
    if not vortex_record.is_record_type_lifecycle_policy(full_policy) then
      raise exception using errcode = '22023',
        message = 'Configured initial record lifecycle policy is invalid',
        detail = 'storage contract ' || target.storage_contract_id::text;
    end if;

    -- A concurrent installation sharing this organisation-shared record type may store it first.
    insert into vortex_record.record_type_lifecycle_policies (
      policy_id, organization_id, storage_contract_id, application_root_id,
      policy_revision, action, policy_body
    ) values (
      next_policy_id, p_organization_id, target.storage_contract_id,
      policy_scope, 1, full_policy ->> 'action', full_policy
    )
    on conflict on constraint record_type_lifecycle_policies_scope_unique do nothing;
    get diagnostics inserted_count = row_count;
    if inserted_count = 1 then
      perform vortex_record.append_lifecycle_policy_activity_internal(
        pg_catalog.gen_random_uuid(), next_policy_id
      );
      stored_count := stored_count + 1;
    end if;
  end loop;

  return stored_count;
end
$function$;

alter function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb)
  to vortex_request;

comment on function vortex_record.ensure_application_lifecycle_policies(uuid, uuid, bigint, jsonb) is
  'The one installation step that gives every record type of an activating Application release its lifecycle policy: a record type without one gets the explicit organisation setup policy at revision 1, within the organisation limits. A stored policy is never changed. Returns the number stored.';

reset role;
