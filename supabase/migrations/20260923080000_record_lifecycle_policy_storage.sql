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
--
-- Organisation ceilings are trusted explicit setup, not an administration
-- operation: the specification requires an impact preview and the normal
-- authorised confirmation before a ceiling changes, and no registered platform
-- permission carries that organisation retention-governance authority. This
-- migration therefore installs initialisation only, exactly like Identity's
-- `initialize_organization_runtime_settings`, so no ungated path can raise or
-- lower an existing organisation's ceilings. The authorised ceiling change
-- belongs with the preview work that the specification pairs it with.

begin;

-- The migration role holds this foreign-key privilege only while the policy
-- table is created; it is revoked again before the transaction completes.
grant references on vortex_definition.roots to vortex_record_owner;

set local role vortex_record_owner;

-- One closed age/count ceiling value: an explicit finite JSON-safe positive
-- integer or an explicit JSON null. A missing limit is never an unlimited
-- fallback, so the absent key is rejected by the shape checks that use this.
create function vortex_record.is_lifecycle_limit_value(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_value is null then false
    when pg_catalog.jsonb_typeof(p_value) = 'null' then true
    when pg_catalog.jsonb_typeof(p_value) <> 'number' then false
    else (p_value #>> '{}')::numeric = pg_catalog.trunc((p_value #>> '{}')::numeric)
      and (p_value #>> '{}')::numeric between 1 and 9007199254740991
  end;
$function$;

-- A non-nil UUID carried as JSON text. Policies transport identifiers as text
-- rather than casting unchecked caller input to `uuid`, so a malformed value
-- is a refusal instead of a cast failure.
create function vortex_record.is_lifecycle_uuid_text(p_value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.coalesce(
    p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and pg_catalog.lower(p_value) <> '00000000-0000-0000-0000-000000000000',
    false
  );
$function$;

-- A JSON-safe positive integer revision carried as a JSON number.
create function vortex_record.is_lifecycle_revision_value(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'number' then false
    else (p_value #>> '{}')::numeric = pg_catalog.trunc((p_value #>> '{}')::numeric)
      and (p_value #>> '{}')::numeric between 1 and 9007199254740991
  end;
$function$;

-- A closed archive destination reference: a lowercase alphanumeric identifier
-- with hyphen or underscore delimiters. URLs, connection strings, credentials
-- and SQL escape hatches are excluded, matching the contract exactly.
create function vortex_record.is_lifecycle_destination(p_value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.coalesce(
    pg_catalog.char_length(p_value) between 1 and 80
    and p_value ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    and p_value !~* '^https?://|postgres://|select |insert ',
    false
  );
$function$;

create function vortex_record.is_lifecycle_action_list(p_values text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.coalesce(
    p_values is not null
    and pg_catalog.array_ndims(p_values) = 1
    and pg_catalog.cardinality(p_values) > 0
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or item.value <> all (array['delete', 'archive_workflow']::text[])
    )
    and pg_catalog.cardinality(p_values) = (
      select pg_catalog.count(distinct item.value)
      from pg_catalog.unnest(p_values) as item(value)
    ),
    false
  );
$function$;

create function vortex_record.is_lifecycle_destination_list(p_values text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.coalesce(
    p_values is not null
    and (
      pg_catalog.cardinality(p_values) = 0
      or pg_catalog.array_ndims(p_values) = 1
    )
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or not vortex_record.is_lifecycle_destination(item.value)
    ),
    false
  );
$function$;

-- The complete stored record-type lifecycle policy shape, closed key by key
-- against `recordTypeLifecyclePolicySchema`. The save operation validates the
-- envelope it assembles with this same function that guards the stored row,
-- so a policy body can never be written in a shape the contract rejects.
create function vortex_record.is_record_type_lifecycle_policy(p_policy jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.coalesce(
    p_policy is not null
    and pg_catalog.jsonb_typeof(p_policy) = 'object'
    and p_policy ?& array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision', 'action', 'maxAgeDays', 'maxCount',
      'allowUnlimitedAge', 'allowUnlimitedCount'
    ]
    and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'policyId')
    and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'organizationId')
    and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'storageContractId')
    and (
      pg_catalog.jsonb_typeof(p_policy -> 'applicationRootId') = 'null'
      or vortex_record.is_lifecycle_uuid_text(p_policy ->> 'applicationRootId')
    )
    and vortex_record.is_lifecycle_revision_value(p_policy -> 'policyRevision')
    and p_policy ->> 'action' in ('delete', 'archive_workflow')
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedAge') = 'boolean'
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedCount') = 'boolean'
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxAgeDays')
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxCount')
    -- Closed representation: an explicit ceiling or an explicit unlimited
    -- permission, never both and never a silent missing-limit fallback.
    and (p_policy -> 'allowUnlimitedAge' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxAgeDays') = 'null')
    and (p_policy -> 'allowUnlimitedCount' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxCount') = 'null')
    and case
      when p_policy ->> 'action' = 'delete' then
        p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount'
        ] = '{}'::jsonb
      else
        p_policy ?& array[
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ]
        and p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount',
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ] = '{}'::jsonb
        and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'archiveWorkflowId')
        and vortex_record.is_lifecycle_uuid_text(p_policy ->> 'archiveConnectionInstanceId')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedWorkflowRevision')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedConnectionRevision')
        and pg_catalog.jsonb_typeof(p_policy -> 'archiveDestination') = 'string'
        and vortex_record.is_lifecycle_destination(p_policy ->> 'archiveDestination')
        and pg_catalog.jsonb_typeof(p_policy -> 'expectedDestinationFingerprint') = 'string'
        and (p_policy ->> 'expectedDestinationFingerprint') ~ '^[a-f0-9]{64}$'
        and p_policy ->> 'expectedConnectionHealthOutcome' = 'healthy'
    end,
    false
  );
$function$;

create table vortex_record.organization_lifecycle_limits (
  organization_id uuid primary key
    constraint organization_lifecycle_limits_organization_fk
      references vortex_identity.organizations (organization_id)
    constraint organization_lifecycle_limits_organization_non_nil check (
      organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  settings_revision bigint not null
    constraint organization_lifecycle_limits_revision_range check (
      settings_revision between 1 and 9007199254740991
    ),
  max_retention_days bigint
    constraint organization_lifecycle_limits_retention_range check (
      max_retention_days between 1 and 9007199254740991
    ),
  max_record_count bigint
    constraint organization_lifecycle_limits_count_range check (
      max_record_count between 1 and 9007199254740991
    ),
  allow_unlimited_retention_days boolean not null,
  allow_unlimited_record_count boolean not null,
  allowed_actions text[] not null
    constraint organization_lifecycle_limits_actions_shape check (
      vortex_record.is_lifecycle_action_list(allowed_actions)
    ),
  allowed_archive_destinations text[] not null default '{}'::text[]
    constraint organization_lifecycle_limits_destinations_shape check (
      vortex_record.is_lifecycle_destination_list(allowed_archive_destinations)
    ),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint organization_lifecycle_limits_retention_closed check (
    allow_unlimited_retention_days = (max_retention_days is null)
  ),
  constraint organization_lifecycle_limits_count_closed check (
    allow_unlimited_record_count = (max_record_count is null)
  ),
  constraint organization_lifecycle_limits_archive_requires_destination check (
    not ('archive_workflow' = any (allowed_actions))
    or pg_catalog.cardinality(allowed_archive_destinations) > 0
  )
);

-- One current policy per organisation + storage contract + (for
-- application-contained record types) permanent application root ID.
-- `policy_id` is immutable across revisions: it is assigned once, on the
-- first save for that exact target, and never changes afterwards.
create table vortex_record.record_type_lifecycle_policies (
  policy_id uuid primary key
    constraint record_type_lifecycle_policies_policy_non_nil check (
      policy_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  organization_id uuid not null
    constraint record_type_lifecycle_policies_organization_fk
      references vortex_identity.organizations (organization_id)
    constraint record_type_lifecycle_policies_organization_non_nil check (
      organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  storage_contract_id uuid not null
    constraint record_type_lifecycle_policies_storage_fk
      references vortex_record.storage_catalogue (storage_contract_id)
    constraint record_type_lifecycle_policies_storage_non_nil check (
      storage_contract_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  application_root_id uuid
    constraint record_type_lifecycle_policies_application_fk
      references vortex_definition.roots (root_id)
    constraint record_type_lifecycle_policies_application_non_nil check (
      application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
    ),
  policy_revision bigint not null
    constraint record_type_lifecycle_policies_revision_range check (
      policy_revision between 1 and 9007199254740991
    ),
  action text not null
    constraint record_type_lifecycle_policies_action_valid check (
      action in ('delete', 'archive_workflow')
    ),
  policy_body jsonb not null
    constraint record_type_lifecycle_policies_body_shape check (
      vortex_record.is_record_type_lifecycle_policy(policy_body)
    ),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint record_type_lifecycle_policies_scope_unique
    unique nulls not distinct (organization_id, storage_contract_id, application_root_id),
  -- The stored body always carries the row's own identity, scope, revision and
  -- action; they cannot drift apart through any later writer.
  constraint record_type_lifecycle_policies_body_envelope check (
    pg_catalog.lower(policy_body ->> 'policyId') = pg_catalog.lower(policy_id::text)
    and pg_catalog.lower(policy_body ->> 'organizationId')
      = pg_catalog.lower(organization_id::text)
    and pg_catalog.lower(policy_body ->> 'storageContractId')
      = pg_catalog.lower(storage_contract_id::text)
    and pg_catalog.lower(policy_body ->> 'applicationRootId')
      is not distinct from pg_catalog.lower(application_root_id::text)
    and (policy_body ->> 'policyRevision') = policy_revision::text
    and (policy_body ->> 'action') = action
  )
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

alter table vortex_record.organization_lifecycle_limits owner to vortex_record_owner;
alter table vortex_record.record_type_lifecycle_policies owner to vortex_record_owner;
revoke all on table vortex_record.organization_lifecycle_limits,
  vortex_record.record_type_lifecycle_policies
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

-- Trusted explicit setup of one organisation's lifecycle ceilings. Identical
-- retries return the existing row and a conflicting retry refuses, the same as
-- Identity's organisation runtime-settings setup. There is deliberately no
-- ungated update path: changing a ceiling needs the impact preview and
-- authorised confirmation the specification requires.
create function vortex_record.initialize_organization_lifecycle_limits(
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
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_limits is null
    or pg_catalog.jsonb_typeof(p_limits) <> 'object'
    or not p_limits ?& array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ]
    or p_limits - array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'allowedArchiveDestinations'
    ] <> '{}'::jsonb
    or not vortex_record.is_lifecycle_uuid_text(p_limits ->> 'organizationId')
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
  select pg_catalog.coalesce(
    pg_catalog.array_agg(item.value #>> '{}' order by item.ordinal),
    array[]::text[]
  )
    into allowed_actions_value
  from pg_catalog.jsonb_array_elements(p_limits -> 'allowedActions')
    with ordinality as item(value, ordinal);
  select pg_catalog.coalesce(
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
    if existing.settings_revision <> 1
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
        allowed_actions, allowed_archive_destinations
      ) values (
        p_organization_id, 1, max_retention_value, max_count_value,
        allow_unlimited_retention_value, allow_unlimited_count_value,
        allowed_actions_value, allowed_destinations_value
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

reset role;

-- Access owns the authority decision for this protected administration
-- operation, exactly as it does for Application installation. It takes the
-- organisation Access-version lock first, revalidates the request context
-- while that lock is held so a revocation that committed while this operation
-- waited cannot reach the permission evaluation, and returns the current
-- decision facts the Record storage operation then binds its write to.
--
-- Selecting a record type's end-of-life policy is part of installing and
-- configuring an Application in the organisation, so it requires the
-- registered `platform.organization.applications.manage` permission. No new
-- permission is registered here.
create function vortex_access.lock_record_lifecycle_policy_authority()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint,
  correlation_id uuid,
  application_root_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
  current_version bigint;
begin
  context_value := vortex_access.validated_human_request_context();

  select version.current_version into current_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (context_value ->> 'organizationId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;
  if current_version <> (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy authority changed';
  end if;

  context_value := vortex_access.validated_human_request_context();

  select evaluated.* into strict decision
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
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.record_lifecycle.manage_policy'
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (context_value ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Record lifecycle policy administration is unavailable';
  end if;

  return query select decision.organization_id, decision.organization_account_id,
    decision.access_version, decision.correlation_id,
    case
      when context_value ? 'applicationRootId'
        then (context_value ->> 'applicationRootId')::uuid
      else null
    end;
end
$function$;

revoke all on function vortex_access.lock_record_lifecycle_policy_authority()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.lock_record_lifecycle_policy_authority()
  to vortex_record_owner;
comment on function vortex_access.lock_record_lifecycle_policy_authority() is
  'Access-owned lock and current authority decision for one protected record-type lifecycle policy transaction.';

-- The Record owner calls only narrow owner-projected Access, Module,
-- Connection and Activity functions. Schema usage alone exposes nothing:
-- their tables keep forced row level security with no policy for this role.
grant usage on schema vortex_access to vortex_record_owner;

-- Module owns installation facts. This narrow check answers one question --
-- is this exact storage contract part of a currently active installation in
-- this organisation (and, for application-contained record types, of that
-- exact Application) -- and shares the installation rows for the transaction
-- so a concurrent detach cannot slip under the policy write.
set local role vortex_module_owner;

create function vortex_module.record_lifecycle_target_is_installed_internal(
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
    and binding.state = 'active'
    and p_storage_contract_id = any (binding.storage_contract_ids)
    and (
      p_application_root_id is null
      or binding.application_root_id = p_application_root_id
    )
  limit 1
  for share;
  return pg_catalog.coalesce(matched, false);
end
$function$;

revoke all on function vortex_module.record_lifecycle_target_is_installed_internal(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant usage on schema vortex_module to vortex_record_owner;
grant execute on function vortex_module.record_lifecycle_target_is_installed_internal(
  uuid, uuid, uuid
) to vortex_record_owner;
comment on function vortex_module.record_lifecycle_target_is_installed_internal(
  uuid, uuid, uuid
) is 'Private installation fact for record lifecycle policy administration; shares the matching active installation binding for the transaction.';

-- A lifecycle archive policy names a workflow from the exact active
-- Application release that also installed the target storage contract. There
-- is no free-standing workflow revision in the compiled definition: the
-- Application release revision is the workflow revision pinned by runtime.
create function vortex_module.record_lifecycle_workflow_is_installed_internal(
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
  active_release_revision bigint;
  matched boolean;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_workflow_id is null
    or p_workflow_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_workflow_revision is null
    or p_expected_workflow_revision not between 1 and 9007199254740991 then
    return false;
  end if;

  select binding.application_release_revision into active_release_revision
  from vortex_module.installation_bindings as binding
  where binding.organization_id = p_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'active'
    and p_storage_contract_id = any (binding.storage_contract_ids)
  order by binding.module_root_id
  limit 1
  for share;
  if not found or active_release_revision <> p_expected_workflow_revision then
    return false;
  end if;

  select true into matched
  from vortex_definition.releases as application_release
  join vortex_definition.roots as application_root
    on application_root.root_id = application_release.root_id
  where application_release.root_id = p_application_root_id
    and application_release.release_revision = active_release_revision
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

revoke all on function vortex_module.record_lifecycle_workflow_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_module.record_lifecycle_workflow_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) to vortex_record_owner;
comment on function vortex_module.record_lifecycle_workflow_is_installed_internal(
  uuid, uuid, uuid, uuid, bigint
) is 'Private exact-active-Application workflow fact for record lifecycle policy administration; locks the matching installation and immutable Application release.';

reset role;

-- The successful policy mutation and its content-free Activity are one
-- transaction. This closed composer derives actor, organisation, correlation
-- and time from the validated human context and exposes no generic append
-- capability to the Record owner.
create function vortex_record.append_lifecycle_policy_activity_internal(
  p_activity_id uuid,
  p_policy_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_policy_id is null
    or p_policy_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record lifecycle policy Activity input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id,
    pg_catalog.statement_timestamp(),
    'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'manage_record_lifecycle_policy',
    array[p_policy_id]::uuid[],
    array[]::uuid[],
    'web',
    (context_value ->> 'correlationId')::uuid,
    'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record lifecycle policy Activity is stale';
  end if;
end
$function$;

revoke all on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid)
  to vortex_record_owner;

-- Connection owns the current state, health, exact destination fingerprint
-- and permanent-Application grant. Record receives only this narrow protected
-- readiness decision, never Connection tables or credentials.
grant usage on schema vortex_connection to vortex_record_owner;
grant execute on function vortex_connection.resolve_connection_instance_readiness(
  uuid, uuid, uuid, text, bigint, text
) to vortex_record_owner;

set local role vortex_record_owner;

-- Protected human administration operation: save (create or update) the
-- current lifecycle policy for one exact storage contract and application
-- scope. Enforces organisation limits (allowed action, allowed archive
-- destination, age/count ceilings and unlimited permissions), exact target
-- existence, current installation binding and application-contained/
-- organisation-shared scope shape, stale organisation-limits and policy
-- revision refusal, exact archive workflow/Connection readiness, immutable
-- policy identity (the caller never supplies or changes `policyId`), and
-- atomic content-free Activity for every successful mutation.
create function vortex_record.save_record_type_lifecycle_policy_for_administration(
  p_storage_contract_id uuid,
  p_application_root_id uuid,
  p_expected_settings_revision bigint,
  p_expected_policy_revision bigint,
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
  if not vortex_module.record_lifecycle_target_is_installed_internal(
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
      or not vortex_module.record_lifecycle_workflow_is_installed_internal(
        authority.organization_id,
        p_application_root_id,
        p_storage_contract_id,
        (full_policy ->> 'archiveWorkflowId')::uuid,
        (full_policy #>> '{expectedWorkflowRevision}')::bigint
      ) then
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
$function$;

revoke all on function vortex_record.is_lifecycle_limit_value(jsonb),
  vortex_record.is_lifecycle_uuid_text(text),
  vortex_record.is_lifecycle_revision_value(jsonb),
  vortex_record.is_lifecycle_destination(text),
  vortex_record.is_lifecycle_action_list(text[]),
  vortex_record.is_lifecycle_destination_list(text[]),
  vortex_record.is_record_type_lifecycle_policy(jsonb),
  vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb),
  vortex_record.append_lifecycle_policy_activity_internal(uuid, uuid),
  vortex_record.save_record_type_lifecycle_policy_for_administration(
    uuid, uuid, bigint, bigint, uuid, jsonb
  )
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_adapter, vortex_module_owner;

-- Both stored operations are callable only as `vortex_runtime`, the same as
-- every other vortex_record write primitive (transfer_record_ownership,
-- save-record and named-action storage): trusted setup runs in a runtime
-- transaction, and the request-role transaction explicitly re-elevates to
-- vortex_runtime immediately before calling the protected save.
grant execute on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb)
  to vortex_runtime;
grant execute on function vortex_record.save_record_type_lifecycle_policy_for_administration(
  uuid, uuid, bigint, bigint, uuid, jsonb
) to vortex_runtime;

comment on table vortex_record.organization_lifecycle_limits is
  'One trusted-setup revisioned retention/archive ceiling row per organisation; this migration installs initialisation only, never an ungated ceiling change.';
comment on table vortex_record.record_type_lifecycle_policies is
  'One current revisioned lifecycle policy per organisation + storage contract + application scope; policy_id is immutable across revisions.';
comment on function vortex_record.is_record_type_lifecycle_policy(jsonb) is
  'Closed shape check for one complete stored record-type lifecycle policy; guards both the protected save and the stored row.';
comment on function vortex_record.initialize_organization_lifecycle_limits(uuid, jsonb) is
  'Trusted explicit setup of one organisation lifecycle ceiling row at revision 1; identical retries return the existing row and conflicting retries refuse.';
comment on function vortex_record.save_record_type_lifecycle_policy_for_administration(
  uuid, uuid, bigint, bigint, uuid, jsonb
) is 'Protected administrator save (create or update) of one record type''s current lifecycle policy within current organisation limits; stale organisation-limits/policy revisions, uninstalled or unknown targets, unready archive bindings and disallowed actions/destinations are refused. policyId is server-assigned and immutable; successful Activity commits atomically.';

reset role;
revoke references on vortex_definition.roots from vortex_record_owner;

commit;
