-- DT-5: the record lifecycle action is delete only. Archiving through a workflow needed a
-- connection granted to the application, and connection_application_grants has had no writer
-- since 20261014011000 dropped grant_connection_application_internal; the only writer of an
-- archive_workflow policy left with the dead lifecycle administration functions. So the action,
-- its archive destinations, its readiness branch and evidence, the readiness helpers it alone
-- called and the grants table go.

set role vortex_owner;

-- Nothing can hold an archive policy: refuse loudly rather than convert one silently.
do $migration$
begin
  if exists (
    select 1 from vortex_record.record_type_lifecycle_policies as policy
    where policy.action <> 'delete'
  ) or exists (
    select 1 from vortex_record.organization_lifecycle_limits as limits
    where limits.initial_policy ->> 'action' is distinct from 'delete'
  ) then
    raise exception using errcode = '23514',
      message = 'A stored lifecycle policy names an action other than delete';
  end if;
end
$migration$;

update vortex_record.organization_lifecycle_limits
set allowed_actions = array['delete']::text[]
where allowed_actions is distinct from array['delete']::text[];

create or replace function vortex_record.is_lifecycle_action_list(p_values text[])
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    p_values is not null
    and pg_catalog.array_ndims(p_values) = 1
    and pg_catalog.cardinality(p_values) > 0
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or item.value <> 'delete'
    )
    and pg_catalog.cardinality(p_values) = (
      select pg_catalog.count(distinct item.value)
      from pg_catalog.unnest(p_values) as item(value)
    ),
    false
  );
$function$;

alter function vortex_record.is_lifecycle_action_list(text[]) owner to vortex_owner;

revoke all on function vortex_record.is_lifecycle_action_list(text[]) from public;

alter table vortex_record.organization_lifecycle_limits
  drop constraint organization_lifecycle_limits_archive_requires_destination,
  drop constraint organization_lifecycle_limits_destinations_shape,
  drop column allowed_archive_destinations;
-- The organisation lifecycle limits setup carries no archive destinations.
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
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_limits is null
    or pg_catalog.jsonb_typeof(p_limits) <> 'object'
    or not p_limits ?& array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'initialPolicy'
    ]
    or p_limits - array[
      'organizationId', 'settingsRevision', 'maxRetentionDays', 'maxRecordCount',
      'allowUnlimitedRetentionDays', 'allowUnlimitedRecordCount', 'allowedActions',
      'initialPolicy'
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
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_limits -> 'allowedActions') = 'array'
          then p_limits -> 'allowedActions' else '[]'::jsonb end
      ) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'string'
    )
    then
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

  if not vortex_record.is_lifecycle_action_list(allowed_actions_value) then
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
      or existing.allowed_actions is distinct from allowed_actions_value then
      raise exception using errcode = '40001',
        message = 'Organisation lifecycle limits are already initialised differently';
    end if;
  else
    begin
      insert into vortex_record.organization_lifecycle_limits (
        organization_id, settings_revision, max_retention_days, max_record_count,
        allow_unlimited_retention_days, allow_unlimited_record_count,
        allowed_actions, initial_policy
      ) values (
        p_organization_id, 1, max_retention_value, max_count_value,
        allow_unlimited_retention_value, allow_unlimited_count_value,
        allowed_actions_value, p_limits -> 'initialPolicy'
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
    'allowedActions', pg_catalog.to_jsonb(existing.allowed_actions)
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

drop function vortex_record.is_lifecycle_destination_list(text[]);
drop function vortex_record.is_lifecycle_destination(text);

alter table vortex_record.record_type_lifecycle_policies
  drop constraint record_type_lifecycle_policies_action_valid,
  add constraint record_type_lifecycle_policies_action_valid check (action = 'delete');

create or replace function vortex_record.is_record_type_lifecycle_policy(p_policy jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_policy is not null
    and pg_catalog.jsonb_typeof(p_policy) = 'object'
    and p_policy ?& array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision', 'action', 'maxAgeDays', 'maxCount',
      'allowUnlimitedAge', 'allowUnlimitedCount'
    ]
    and vortex_platform.is_non_nil_uuid(p_policy ->> 'policyId')
    and vortex_platform.is_non_nil_uuid(p_policy ->> 'organizationId')
    and vortex_platform.is_non_nil_uuid(p_policy ->> 'storageContractId')
    and (
      pg_catalog.jsonb_typeof(p_policy -> 'applicationRootId') = 'null'
      or vortex_platform.is_non_nil_uuid(p_policy ->> 'applicationRootId')
    )
    and vortex_record.is_lifecycle_revision_value(p_policy -> 'policyRevision')
    and p_policy ->> 'action' = 'delete'
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
    and p_policy - array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision', 'action', 'maxAgeDays', 'maxCount',
      'allowUnlimitedAge', 'allowUnlimitedCount', 'recoveryWindowDays'
    ] = '{}'::jsonb
    and (
      not p_policy ? 'recoveryWindowDays'
      or case
        when pg_catalog.jsonb_typeof(p_policy -> 'recoveryWindowDays') = 'number'
          and (p_policy ->> 'recoveryWindowDays') ~ '^[1-9][0-9]{0,8}$'
        then (p_policy ->> 'recoveryWindowDays')::bigint <= 104249991
        else false end
    ),
    false
  );
$function$;

alter function vortex_record.is_record_type_lifecycle_policy(jsonb) owner to vortex_owner;

revoke all on function vortex_record.is_record_type_lifecycle_policy(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.is_record_type_lifecycle_policy(jsonb)
  to vortex_owner;

comment on function vortex_record.is_record_type_lifecycle_policy(jsonb) is
  'Closed shape check for one complete stored record-type lifecycle policy (the one action is delete); guards both the protected save and the stored row.';

create or replace function vortex_record.read_application_lifecycle_policy_readiness(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
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
  -- An installation whose Modules hold no record types yet has no targets and no policies.
  select coalesce(pg_catalog.array_agg(distinct targets.storage_contract_id), array[]::uuid[])
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

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
      'allowedActions', pg_catalog.to_jsonb(limits_row.allowed_actions)
    ),
    'readinessEvidence', pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id
    )
  );
end
$function$;

alter function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) from public;
grant all on function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) to vortex_request;

comment on function vortex_record.read_application_lifecycle_policy_readiness(uuid, uuid, bigint, jsonb) is
  'Complete executable-policy snapshot for one activating Application installation: every owned record type''s current policy and the organisation ceilings. The one lifecycle action is delete, so it carries no archive readiness.';

drop function vortex_platform.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text);
drop function vortex_definition.record_lifecycle_workflow_is_installed_internal(uuid, uuid, uuid, uuid, bigint);
drop table vortex_platform.connection_application_grants;
drop function vortex_platform.enforce_grant_application_root();

reset role;
