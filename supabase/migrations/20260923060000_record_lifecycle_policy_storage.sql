-- Protected current record lifecycle policy storage (#566).
--
-- Stores the organisation's retention/archive ceilings and each installed
-- record type's current lifecycle policy (recoverable delete or durable
-- archive-then-delete), scoped by storage contract and, for
-- application-contained record types, by permanent application root ID.
-- Organisation-shared record types share one organisation-owned policy.
--
-- This migration only stores an authorised administrator's current protected
-- policy and returns it with its current revision (contracts/src/record-
-- lifecycle-policy.ts). Live activation/recovery integration (#567) and
-- bounded preview/removal handoff (#568) are separate and are not built here.

set local role vortex_record_owner;

create table vortex_record.organization_lifecycle_limits (
  organization_id uuid primary key
    references vortex_identity.organizations (organization_id),
  settings_revision bigint not null check (
    settings_revision between 1 and 9007199254740991
  ),
  max_retention_days integer check (max_retention_days > 0),
  max_record_count integer check (max_record_count > 0),
  allow_unlimited_retention_days boolean not null,
  allow_unlimited_record_count boolean not null,
  allowed_actions text[] not null,
  allowed_archive_destinations text[] not null default '{}'::text[],
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint organization_lifecycle_limits_retention_closed check (
    (allow_unlimited_retention_days and max_retention_days is null)
    or (not allow_unlimited_retention_days and max_retention_days is not null)
  ),
  constraint organization_lifecycle_limits_count_closed check (
    (allow_unlimited_record_count and max_record_count is null)
    or (not allow_unlimited_record_count and max_record_count is not null)
  ),
  constraint organization_lifecycle_limits_actions_shape check (
    cardinality(allowed_actions) > 0
    and allowed_actions <@ array['delete', 'archive_workflow']::text[]
    and cardinality(allowed_actions) = (
      select pg_catalog.count(distinct item.value)
      from pg_catalog.unnest(allowed_actions) as item(value)
    )
  ),
  constraint organization_lifecycle_limits_archive_requires_destination check (
    not ('archive_workflow' = any (allowed_actions))
    or cardinality(allowed_archive_destinations) > 0
  ),
  constraint organization_lifecycle_limits_destinations_shape check (
    not exists (
      select 1 from pg_catalog.unnest(allowed_archive_destinations) as item(value)
      where pg_catalog.char_length(item.value) not between 1 and 80
        or item.value !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
        or item.value ~* '^https?://|postgres://|select |insert '
    )
  )
);

-- One current policy per organisation + storage contract + (for
-- application-contained record types) permanent application root ID.
-- `policy_id` is immutable across revisions: it is assigned once, on the
-- first save for that exact target, and never changes afterwards.
create table vortex_record.record_type_lifecycle_policies (
  policy_id uuid primary key,
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  storage_contract_id uuid not null
    references vortex_record.storage_catalogue (storage_contract_id),
  application_root_id uuid,
  policy_revision bigint not null check (
    policy_revision between 1 and 9007199254740991
  ),
  action text not null check (action in ('delete', 'archive_workflow')),
  policy_body jsonb not null check (pg_catalog.jsonb_typeof(policy_body) = 'object'),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique nulls not distinct (organization_id, storage_contract_id, application_root_id)
);

alter table vortex_record.organization_lifecycle_limits enable row level security;
alter table vortex_record.organization_lifecycle_limits force row level security;
alter table vortex_record.record_type_lifecycle_policies enable row level security;
alter table vortex_record.record_type_lifecycle_policies force row level security;

create policy organization_lifecycle_limits_owner
  on vortex_record.organization_lifecycle_limits
  to vortex_record_owner using (true) with check (true);
create policy record_type_lifecycle_policies_owner
  on vortex_record.record_type_lifecycle_policies
  to vortex_record_owner using (true) with check (true);

-- Trusted storage for organisation lifecycle ceilings. This is not a human-
-- request administration operation: it is called only by trusted runtime
-- code (server-only, no request-role/RLS-scoped caller), the same way
-- Identity's `initialize_organization_runtime_settings` is trusted setup
-- rather than a permission-checked change. An authorised administrator's
-- protected save of a per-record-type policy below is the human-facing,
-- permission-checked operation this issue's acceptance criteria covers.
create function vortex_record.set_organization_lifecycle_limits(
  p_organization_id uuid,
  p_expected_settings_revision bigint,
  p_limits jsonb
)
returns table (organization_id uuid, limits jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_record.organization_lifecycle_limits%rowtype;
  next_revision bigint;
  max_retention_value integer;
  max_count_value integer;
  allow_unlimited_retention_value boolean;
  allow_unlimited_count_value boolean;
  allowed_actions_value text[];
  allowed_destinations_value text[];
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_expected_settings_revision is not null
      and p_expected_settings_revision not between 1 and 9007199254740991)
    or p_limits is null or pg_catalog.jsonb_typeof(p_limits) <> 'object'
    or not p_limits ?& array[
      'organizationId', 'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount',
      'allowedActions', 'allowedArchiveDestinations'
    ]
    or p_limits - array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ] <> '{}'::jsonb
    or (p_limits ->> 'organizationId')::uuid is distinct from p_organization_id
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRetentionDays') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowUnlimitedRecordCount') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') <> 'array'
    or pg_catalog.jsonb_typeof(p_limits -> 'allowedArchiveDestinations') <> 'array' then
    raise exception using errcode = '22023',
      message = 'Organization lifecycle limits command is invalid';
  end if;

  select existing_row.* into existing
  from vortex_record.organization_lifecycle_limits as existing_row
  where existing_row.organization_id = p_organization_id
  for update;

  if found then
    if p_expected_settings_revision is null
      or existing.settings_revision <> p_expected_settings_revision then
      raise exception using errcode = '40001',
        message = 'Organization lifecycle limits are stale or unavailable';
    end if;
    next_revision := existing.settings_revision + 1;
  else
    if p_expected_settings_revision is not null then
      raise exception using errcode = '40001',
        message = 'Organization lifecycle limits are stale or unavailable';
    end if;
    next_revision := 1;
  end if;

  if (p_limits ->> 'settingsRevision')::bigint is distinct from next_revision then
    raise exception using errcode = '22023',
      message = 'Organization lifecycle limits command is invalid';
  end if;

  max_retention_value := (p_limits ->> 'maxRetentionDays')::integer;
  max_count_value := (p_limits ->> 'maxRecordCount')::integer;
  allow_unlimited_retention_value := (p_limits ->> 'allowUnlimitedRetentionDays')::boolean;
  allow_unlimited_count_value := (p_limits ->> 'allowUnlimitedRecordCount')::boolean;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into allowed_actions_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedActions') as item(value);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into allowed_destinations_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedArchiveDestinations') as item(value);

  if found then
    update vortex_record.organization_lifecycle_limits set
      settings_revision = next_revision,
      max_retention_days = max_retention_value,
      max_record_count = max_count_value,
      allow_unlimited_retention_days = allow_unlimited_retention_value,
      allow_unlimited_record_count = allow_unlimited_count_value,
      allowed_actions = allowed_actions_value,
      allowed_archive_destinations = allowed_destinations_value,
      changed_at = pg_catalog.statement_timestamp()
    where organization_id = p_organization_id;
  else
    begin
      insert into vortex_record.organization_lifecycle_limits (
        organization_id, settings_revision, max_retention_days, max_record_count,
        allow_unlimited_retention_days, allow_unlimited_record_count,
        allowed_actions, allowed_archive_destinations
      ) values (
        p_organization_id, next_revision, max_retention_value, max_count_value,
        allow_unlimited_retention_value, allow_unlimited_count_value,
        allowed_actions_value, allowed_destinations_value
      );
    exception when unique_violation then
      raise exception using errcode = '40001',
        message = 'Organization lifecycle limits are stale or unavailable';
    end;
  end if;

  return query select p_organization_id, pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'settingsRevision', next_revision,
    'maxRetentionDays', max_retention_value,
    'maxRecordCount', max_count_value,
    'allowUnlimitedRetentionDays', allow_unlimited_retention_value,
    'allowUnlimitedRecordCount', allow_unlimited_count_value,
    'allowedActions', pg_catalog.to_jsonb(allowed_actions_value),
    'allowedArchiveDestinations', pg_catalog.to_jsonb(allowed_destinations_value)
  );
end
$function$;

-- Protected human administration operation: save (create or update) the
-- current lifecycle policy for one exact storage contract and application
-- scope. Enforces organisation limits (allowed action, allowed archive
-- destination, age/count ceilings and unlimited permissions), exact target
-- existence and application-contained/organisation-shared scope shape,
-- stale organisation-limits and policy revision refusal, and immutable
-- policy identity (the caller never supplies or changes `policyId`).
create function vortex_record.save_record_type_lifecycle_policy_for_administration(
  p_storage_contract_id uuid,
  p_application_root_id uuid,
  p_expected_settings_revision bigint,
  p_expected_policy_revision bigint,
  p_policy jsonb
)
returns table (policy_id uuid, policy jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  decision record;
  limits_row vortex_record.organization_lifecycle_limits%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  existing vortex_record.record_type_lifecycle_policies%rowtype;
  next_revision bigint;
  next_policy_id uuid;
  full_policy jsonb;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_application_root_id is not null
      and p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or p_expected_settings_revision is null
    or p_expected_settings_revision not between 1 and 9007199254740991
    or (p_expected_policy_revision is not null
      and p_expected_policy_revision not between 1 and 9007199254740991)
    or p_policy is null or pg_catalog.jsonb_typeof(p_policy) <> 'object'
    or not p_policy ?& array[
      'action', 'maxAgeDays', 'maxCount', 'allowUnlimitedAge', 'allowUnlimitedCount'
    ]
    or p_policy ->> 'action' not in ('delete', 'archive_workflow')
    or pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedAge') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedCount') <> 'boolean'
    or (p_policy ->> 'action' = 'archive_workflow'
      and not p_policy ?& array[
        'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
        'archiveDestination', 'expectedConnectionRevision', 'expectedDestinationFingerprint',
        'expectedConnectionHealthOutcome'
      ]) then
    raise exception using errcode = '22023',
      message = 'Record-type lifecycle policy command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  -- The resolved request scope must be application-bound exactly when the
  -- target is application-contained, and bound to the exact same application.
  if (p_application_root_id is null) = (context_value ? 'applicationRootId')
    or (p_application_root_id is not null
      and (context_value ->> 'applicationRootId')::uuid <> p_application_root_id) then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy command is invalid';
  end if;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.record_lifecycle.manage_policy',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Record-type lifecycle policy update is unavailable';
  end if;

  -- Exact target existence and application-contained/organisation-shared
  -- scope shape: the storage contract must be an active, currently installed
  -- record-type target whose declared scope matches the supplied application
  -- root ID (null only for organisation-shared record types).
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
  for share;
  if not found or catalogue_row.state <> 'active'
    or (catalogue_row.storage_scope = 'organization_shared') <> (p_application_root_id is null) then
    raise exception using errcode = '55000',
      message = 'Record-type lifecycle policy target is unavailable';
  end if;

  -- A policy can only be bound to the exact, current organisation limits
  -- revision the caller reviewed; a concurrently changed ceiling is a stale
  -- refusal, never a silent reinterpretation under the new limits.
  select limits.* into limits_row
  from vortex_record.organization_lifecycle_limits as limits
  where limits.organization_id = context_organization_id
  for share;
  if not found or limits_row.settings_revision <> p_expected_settings_revision then
    raise exception using errcode = '40001',
      message = 'Organisation lifecycle limits are stale or unavailable';
  end if;

  select policy.* into existing
  from vortex_record.record_type_lifecycle_policies as policy
  where policy.organization_id = context_organization_id
    and policy.storage_contract_id = p_storage_contract_id
    and policy.application_root_id is not distinct from p_application_root_id
  for update;

  if found then
    if p_expected_policy_revision is null
      or existing.policy_revision <> p_expected_policy_revision then
      raise exception using errcode = '40001',
        message = 'Record-type lifecycle policy is stale or unavailable';
    end if;
    next_revision := existing.policy_revision + 1;
    next_policy_id := existing.policy_id;
  else
    if p_expected_policy_revision is not null then
      raise exception using errcode = '40001',
        message = 'Record-type lifecycle policy is stale or unavailable';
    end if;
    next_revision := 1;
    next_policy_id := pg_catalog.gen_random_uuid();
  end if;

  -- The envelope (identity, scope and revision) is assigned here, never
  -- accepted from the caller; this is what keeps `policyId` immutable.
  full_policy := p_policy || pg_catalog.jsonb_build_object(
    'policyId', next_policy_id,
    'organizationId', context_organization_id,
    'storageContractId', p_storage_contract_id,
    'applicationRootId', p_application_root_id,
    'policyRevision', next_revision
  );

  -- Enforce organisation limits: allowed action, age/count ceilings and
  -- unlimited permissions, and (for archive_workflow) an allowed
  -- destination. This is re-checked here, under the limits row's lock,
  -- rather than trusted from an earlier, possibly stale, client read.
  if not (full_policy ->> 'action' = any (limits_row.allowed_actions)) then
    raise exception using errcode = '23514',
      message = 'Record-type lifecycle policy action is not permitted by organisation limits';
  end if;

  if pg_catalog.jsonb_typeof(full_policy -> 'maxAgeDays') = 'number' then
    if limits_row.max_retention_days is not null
      and (full_policy ->> 'maxAgeDays')::integer > limits_row.max_retention_days then
      raise exception using errcode = '23514',
        message = 'Record-type lifecycle policy maxAgeDays exceeds organisation limit';
    end if;
  elsif (full_policy ->> 'allowUnlimitedAge')::boolean
    and not limits_row.allow_unlimited_retention_days then
    raise exception using errcode = '23514',
      message = 'Record-type lifecycle policy unlimited age retention is not permitted';
  end if;

  if pg_catalog.jsonb_typeof(full_policy -> 'maxCount') = 'number' then
    if limits_row.max_record_count is not null
      and (full_policy ->> 'maxCount')::integer > limits_row.max_record_count then
      raise exception using errcode = '23514',
        message = 'Record-type lifecycle policy maxCount exceeds organisation limit';
    end if;
  elsif (full_policy ->> 'allowUnlimitedCount')::boolean
    and not limits_row.allow_unlimited_record_count then
    raise exception using errcode = '23514',
      message = 'Record-type lifecycle policy unlimited record count is not permitted';
  end if;

  if full_policy ->> 'action' = 'archive_workflow'
    and not (full_policy ->> 'archiveDestination' = any (limits_row.allowed_archive_destinations)) then
    raise exception using errcode = '23514',
      message = 'Record-type lifecycle policy archive destination is not permitted by organisation limits';
  end if;

  if found then
    update vortex_record.record_type_lifecycle_policies set
      policy_revision = next_revision,
      action = full_policy ->> 'action',
      policy_body = full_policy,
      changed_at = pg_catalog.statement_timestamp()
    where organization_id = context_organization_id
      and storage_contract_id = p_storage_contract_id
      and application_root_id is not distinct from p_application_root_id;
  else
    begin
      insert into vortex_record.record_type_lifecycle_policies (
        policy_id, organization_id, storage_contract_id, application_root_id,
        policy_revision, action, policy_body
      ) values (
        next_policy_id, context_organization_id, p_storage_contract_id, p_application_root_id,
        next_revision, full_policy ->> 'action', full_policy
      );
    exception when unique_violation then
      raise exception using errcode = '40001',
        message = 'Record-type lifecycle policy is stale or unavailable';
    end;
  end if;

  return query select next_policy_id, full_policy;
end
$function$;

revoke all on function vortex_record.set_organization_lifecycle_limits(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter,
    vortex_module_owner;
revoke all on function vortex_record.save_record_type_lifecycle_policy_for_administration(
  uuid, uuid, bigint, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter,
  vortex_module_owner;

-- Both functions are callable only as `vortex_runtime`, the same as every
-- other vortex_record write primitive (transfer_record_ownership, save-record
-- and named-action storage): the request-role transaction explicitly
-- re-elevates to vortex_runtime immediately before calling in, matching that
-- exact existing convention rather than granting vortex_request a new direct
-- execute path into this schema.
grant execute on function vortex_record.set_organization_lifecycle_limits(uuid, bigint, jsonb)
  to vortex_runtime;
grant execute on function vortex_record.save_record_type_lifecycle_policy_for_administration(
  uuid, uuid, bigint, bigint, jsonb
) to vortex_runtime;

comment on table vortex_record.organization_lifecycle_limits is
  'One trusted-runtime-owned revisioned retention/archive ceiling row per organisation; not directly administrator-editable by this migration.';
comment on table vortex_record.record_type_lifecycle_policies is
  'One current revisioned lifecycle policy per organisation + storage contract + application scope; policy_id is immutable across revisions.';
comment on function vortex_record.set_organization_lifecycle_limits(uuid, bigint, jsonb) is
  'Trusted (non-human-request) storage for organisation lifecycle ceilings; not a permission-checked administration operation.';
comment on function vortex_record.save_record_type_lifecycle_policy_for_administration(
  uuid, uuid, bigint, bigint, jsonb
) is 'Protected administrator save (create or update) of one record type''s current lifecycle policy within current organisation limits; stale organisation-limits/policy revisions, unknown targets and disallowed actions/destinations are refused. policyId is server-assigned and immutable.';

reset role;

-- The protected policy save needs the same current human organisation
-- administration context and permission-eligibility evaluation every other
-- administration operation uses; these are already granted to the Record
-- adapter and Module owner (20260908122641, 20260912011556) and are extended
-- here to the Record owner, which is this new function's owner.
grant execute on function vortex_access.validated_human_request_context()
  to vortex_record_owner;
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_record_owner;
