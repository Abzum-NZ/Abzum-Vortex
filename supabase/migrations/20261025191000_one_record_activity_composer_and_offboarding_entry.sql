-- One Record Activity composer: append_record_activity_internal replaces the five per-kind
-- composers (base save, named action, ownership transfer, delete/restore, lifecycle policy) that
-- each derived the same request context and appended through append_organization_activity_entry.
-- Both account-offboarding transfer entries now enter the one record-change operation,
-- apply_record_changes: the active-record entry no longer calls its lifecycle implementation
-- directly, and the retained or detached record transfer is apply_record_changes' offboarding
-- transfer, which rechecks the inventory's accounts.manage scope.
set role vortex_owner;

create or replace function vortex_record.append_record_activity_internal(
  p_activity_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in (
      'create_record', 'update_record', 'execute_named_action', 'delete_record',
      'restore_record', 'transfer_record_ownership', 'manage_record_lifecycle_policy'
    )
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    )
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    )
    or p_outcome is null
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_action in (
      'create_record', 'update_record', 'delete_record', 'restore_record',
      'transfer_record_ownership'
    )
    and not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record Activity requires an Application context';
  end if;
  append_result := vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action, p_subject_ids, p_changed_field_ids, vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

alter function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  owner to vortex_owner;
revoke all on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text) is
  'The one Record Activity composer: derives the organisation, account, correlation and channel from the validated request context and appends one entry for a record save, named action, delete, restore, ownership transfer or lifecycle policy change.';

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
      perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'manage_record_lifecycle_policy', array[next_policy_id]::uuid[], array[]::uuid[], 'completed');
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

  perform vortex_record.append_record_activity_internal(p_activity_id, 'manage_record_lifecycle_policy', array[next_policy_id]::uuid[], array[]::uuid[], 'completed');

  return full_policy;
end
$$;
alter function vortex_record.save_record_type_lifecycle_policy_for_administration(uuid,uuid,bigint,bigint,uuid,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) IS 'Protected administrator save (create or update) of one record type''s current lifecycle policy within current organisation limits; stale organisation-limits/policy revisions, uninstalled or unknown targets, unready archive bindings and disallowed actions/destinations are refused. policyId is server-assigned and immutable; successful Activity commits atomically.';

REVOKE ALL ON FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) TO vortex_runtime;

reset role;

set role vortex_record_adapter;

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  root_snapshot jsonb;
  deletion_result jsonb;
  current_revision bigint;
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  -- Delete has two calls in one request transaction: null mutations claim the
  -- receipt and traverse, then calculated parent mutations complete the command.
  -- Both calls enter through apply_record_changes; a non-final outcome rolls
  -- back the request transaction, including every traversal write.
  if p_operation = 'delete' then
    if p_mutations is null then
      if p_command_id is null or p_command_id = nil_uuid
        or p_record_type_id is null or p_record_type_id = nil_uuid
        or p_record_id is null or p_record_id = nil_uuid
        or p_activity_id is null or p_activity_id = nil_uuid
        or p_occurrence_id is null or p_occurrence_id = nil_uuid
        or p_expected_concurrency_number is null
        or p_expected_concurrency_number not between 1 and 9007199254740990 then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      context_value := vortex_access.validated_human_request_context();
      if not context_value ? 'applicationRootId' then
        raise exception using errcode = '42501',
          message = 'Record delete requires an Application context';
      end if;
      receipt_claim := vortex_record.claim_command_receipt_internal(
        'record_delete', p_command_id, false
      );
      if receipt_claim ->> 'status' is distinct from 'claimed' then
        if receipt_claim ->> 'status' = 'identity_conflict' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
            'correlationId', context_value -> 'correlationId'
          );
        end if;
        if receipt_claim ->> 'status' is distinct from 'completed' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
          );
        end if;
        return pg_catalog.jsonb_build_object(
          'outcome', 'deleted',
          'recordId', receipt_claim -> 'recordId',
          'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
          'correlationId', context_value -> 'correlationId',
          'replayed', true
        );
      end if;

      -- The evaluator needs the root's last active values. They are captured
      -- before the traversal and only used if that traversal deletes exactly the
      -- revision they were read at.
      root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
        vortex_record.relationship_total_catalogue_internal(),
        p_record_type_id, p_record_id, false
      );

      perform pg_catalog.set_config(
        'vortex_record.lifecycle_command_id', p_command_id::text, true
      );
      begin
        perform vortex_record.soft_delete_record_recursive_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
        );
        deletion_result := pg_catalog.jsonb_build_object('outcome', 'completed');
      exception
        when serialization_failure or deadlock_detected then
          deletion_result := pg_catalog.jsonb_build_object('outcome', 'conflict');
        when no_data_found or insufficient_privilege or object_not_in_prerequisite_state then
          deletion_result := pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'record_unavailable'
          );
        when check_violation then
          deletion_result := pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_refused'
          );
      end;
      perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

      if deletion_result ->> 'outcome' = 'conflict' then
        current_revision := vortex_record.record_lifecycle_current_revision_internal(
          p_record_type_id, p_record_id
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        ) || case when current_revision is null then '{}'::jsonb
          else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
      end if;
      if deletion_result ->> 'outcome' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if root_snapshot is null then
        raise exception using errcode = '55000',
          message = 'Protected record delete root is not installed';
      end if;
      if (root_snapshot ->> 'concurrencyNumber')::bigint
          is distinct from p_expected_concurrency_number then
        raise exception using errcode = '40001',
          message = 'Protected record delete root changed before deletion';
      end if;

      return vortex_record.prepare_record_lifecycle_totals_internal(
        'delete', p_record_type_id, p_record_id, p_command_id, root_snapshot
      );
    end if;
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_delete', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record delete identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this delete.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind = 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;

    -- Closure identity and revisions are re-derived under the held locks rather
    -- than taken from the caller.
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'delete', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001',
        message = 'Protected record delete closure changed';
    end if;
    perform vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, false, p_mutations
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = (context_value ->> 'organizationId')::uuid
        and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then p_occurrence_id
            else pg_catalog.gen_random_uuid() end,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', event_kind,
            'recordTypeId', effect_row.record_type_id
          ),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Protected record delete Event append failed';
      end if;
    end loop;

    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
      into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'delete_record', subject_ids, array[]::uuid[], 'completed');

    perform vortex_record.complete_command_receipt_internal(
      'record_delete', p_command_id, p_record_id, p_expected_concurrency_number + 1,
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_restore', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record restore identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this restore.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind <> 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'restored'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;

    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'restore', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared'
      or (
        select (item.value ->> 'concurrencyNumber')::bigint
        from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
        where item.value ->> 'recordKey' = 'root'
      ) is distinct from p_expected_concurrency_number + 1 then
      raise exception using errcode = '40001',
        message = 'Protected record restore closure changed';
    end if;
    revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, true, p_mutations
    );
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    perform vortex_record.append_record_activity_internal(p_activity_id, 'restore_record', array[p_record_id]::uuid[], array[]::uuid[], 'completed');

    perform vortex_record.complete_command_receipt_internal(
      'record_restore', p_command_id, p_record_id, restored_revision,
      'Protected record restore receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := (vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      )) -> 'record';
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_definition.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_platform.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id, p_record_id, updated_concurrency_number,
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_platform.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_platform.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_platform.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_platform.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private lifecycle implementation reached only through apply_record_changes. Delete claims, traverses and finalises in two calls within one request transaction; restore and ownership transfer retain their own receipt, Activity and Event handling.';

create or replace function vortex_record.apply_named_action_relationship_copies_internal(
  p_plan jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  copy_value jsonb;
  target_row record;
  meta jsonb;
  target_concurrency bigint;
  changed_result jsonb;
  event_result jsonb;
  saved_targets jsonb := '{}'::jsonb;
  target_key text;
  saved_target jsonb;
  saved_record_id uuid;
  saved_concurrency bigint;
  notice_sequence bigint;
  exact_copy_notice boolean;
  preview_installation jsonb;
begin
  if p_plan ->> 'outcome' is distinct from 'planned'
    or pg_catalog.jsonb_typeof(p_plan -> 'copies') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Relationship copy plan is invalid';
  end if;
  for copy_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_plan -> 'copies') item(value)
    order by (item.value ->> 'relationshipId')::uuid,
      (item.value #>> '{value,recordId}')::uuid,
      (item.value ->> 'targetRecordId')::uuid
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      (copy_value ->> 'targetRecordTypeId')::uuid, 'update'
    );
    -- The target row is already locked by the plan; each write bumps its
    -- revision, so the next write is against the revision just reached.
    target_concurrency := null;
    execute pg_catalog.format(
      'select stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active''',
      meta ->> 'table'
    ) into target_concurrency
      using (meta -> 'context' ->> 'organizationId')::uuid,
        (copy_value ->> 'targetRecordId')::uuid;
    if target_concurrency is null then
      raise exception using errcode = '55000', message = 'Relationship copy target lock was lost';
    end if;
    changed_result := vortex_record.change_record_relationship_internal(
      (copy_value ->> 'targetRecordTypeId')::uuid, (copy_value ->> 'targetRecordId')::uuid,
      target_concurrency, (copy_value ->> 'relationshipId')::uuid, copy_value -> 'value'
    );
    if changed_result ->> 'outcome' = 'conflict' then
      raise exception using errcode = '40001', message = 'Relationship copy conflicted';
    end if;
    if changed_result ->> 'outcome' is distinct from 'completed' then
      raise exception using errcode = '42501',
        message = 'Relationship copy was refused',
        detail = coalesce(changed_result ->> 'reasonCode', changed_result ->> 'outcome');
    end if;
    target_key := (copy_value ->> 'targetRecordTypeId')::uuid::text || ':'
      || (copy_value ->> 'targetRecordId')::uuid::text;
    -- The next copy can revise this target again. Keep its last saved tuple so
    -- the grouped owner emits only the revision reached by all of its copies.
    saved_targets := saved_targets || pg_catalog.jsonb_build_object(
      target_key, changed_result
    );
  end loop;

  for target_row in
    select (item.value ->> 'targetRecordTypeId')::uuid as record_type_id,
      (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.array_agg(
        distinct (item.value ->> 'fromFieldId')::uuid
        order by (item.value ->> 'fromFieldId')::uuid
      ) as changed_field_ids
    from pg_catalog.jsonb_array_elements(p_plan -> 'copies') item(value)
    group by 1, 2
    order by 1, 2
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      target_row.record_type_id, 'update'
    );
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    exact_copy_notice := preview_installation is null
      and meta ->> 'storageScope' = 'application_contained';
    if exact_copy_notice then
      target_key := target_row.record_type_id::text || ':' || target_row.record_id::text;
      saved_target := saved_targets -> target_key;
      if pg_catalog.jsonb_typeof(saved_target) is distinct from 'object'
        or saved_target ->> 'outcome' is distinct from 'completed'
        or pg_catalog.jsonb_typeof(saved_target -> 'recordId') is distinct from 'string'
        or not coalesce(pg_catalog.pg_input_is_valid(saved_target ->> 'recordId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(saved_target -> 'concurrencyNumber') is distinct from 'number'
        or not coalesce(pg_catalog.pg_input_is_valid(saved_target ->> 'concurrencyNumber', 'bigint'), false) then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
      saved_record_id := (saved_target ->> 'recordId')::uuid;
      saved_concurrency := (saved_target ->> 'concurrencyNumber')::bigint;
      if saved_record_id is distinct from target_row.record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Relationship copy saved identity is unavailable';
      end if;
    end if;
    perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'execute_named_action', array[target_row.record_id]::uuid[], target_row.changed_field_ids, 'completed');
    event_result := vortex_platform.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid, target_row.record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', pg_catalog.gen_random_uuid(),
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'changed',
          'recordTypeId', target_row.record_type_id
        ),
        'payload', pg_catalog.jsonb_build_object(
          'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(target_row.changed_field_ids)
        )
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000',
        message = 'Relationship copy Event append failed';
    end if;
    if exact_copy_notice then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          (meta -> 'context' ->> 'organizationId')::uuid,
          (meta -> 'context' ->> 'applicationRootId')::uuid,
          target_row.record_type_id, saved_record_id, saved_concurrency, 'changed',
          notice_sequence, notice_sequence,
          (meta -> 'context' ->> 'correlationId')::uuid
        );
      exception
        when others then
          -- Invalidation is advisory; losing a notice must not refuse a copy.
          null;
      end;
    end if;
  end loop;
end
$function$;
alter function vortex_record.apply_named_action_relationship_copies_internal(jsonb) owner to vortex_record_adapter;


alter function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_named_action_relationship_copies_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.apply_named_action_relationship_copies_internal(jsonb) is
  'Private named-action step: writes planned copies against each target''s current revision in edge order, records grouped Activity and changed Events, and publishes one exact notice per live application-contained target using its final saved tuple. Any mutation refusal raises so the whole command rolls back.';

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  copy_plan jsonb;
  preview_installation jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_rows integer;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
  classification_value jsonb;
  delete_effect record;
  offboarding_scope record;
  offboarding_transfer jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership', 'settings')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- An account offboarding transfer of a retained row or of a detached installation's record has
  -- its own facts and the accounts.manage authority of the offboarding inventory, rechecked here
  -- for every record against the access version the inventory was disclosed at.
  if p_operation = 'transfer_ownership'
    and pg_catalog.jsonb_typeof(p_mutations) = 'array'
    and pg_catalog.jsonb_array_length(p_mutations) = 1
    and p_mutations -> 0 ->> 'kind' = 'offboarding_transfer' then
    offboarding_transfer := p_mutations -> 0;
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'expectedAccessVersion') is distinct from 'number'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'sourceOrganizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'targetId') is distinct from 'string' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    select authorized.* into strict offboarding_scope
    from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
    if offboarding_scope.access_version
      is distinct from (offboarding_transfer ->> 'expectedAccessVersion')::bigint then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
    end if;
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      offboarding_transfer ->> 'targetKind', (offboarding_transfer ->> 'targetId')::uuid,
      p_activity_id, p_occurrence_id,
      (offboarding_transfer ->> 'sourceOrganizationAccountId')::uuid
    );
  end if;

  -- Every lifecycle write, including the delete traversal and its finalisation,
  -- enters here. Delete preparation uses null mutations; calculated parent
  -- mutations complete the same receipt within the same request transaction.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    result_value := vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
    if p_operation = 'delete' and result_value ->> 'outcome' = 'deleted'
      and result_value ->> 'replayed' = 'false' then
      context_value := vortex_access.validated_human_request_context();
      -- Publish once per deleted record after totals, Activity, Events and the
      -- receipt are complete. Replays and preparations publish nothing.
      for delete_effect in
        select effect.*
        from vortex_record.record_lifecycle_command_effects as effect
        join vortex_record.storage_catalogue as storage
          on storage.storage_contract_id = effect.storage_contract_id
        where effect.command_id = p_command_id
          and effect.organization_id = (context_value ->> 'organizationId')::uuid
          and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
          and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
          and effect.effect_kind = 'soft_deleted'
          and storage.storage_scope = 'application_contained'
        order by effect.effect_sequence
      loop
        begin
          notice_sequence := pg_catalog.nextval(
            'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
          );
          perform vortex_platform.publish_change_notice(
            delete_effect.organization_id, delete_effect.application_root_id,
            delete_effect.record_type_id, delete_effect.record_id,
            delete_effect.post_concurrency_number, 'deleted',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          raise warning 'Record delete notice failed: [%] %', sqlstate, sqlerrm;
        end;
      end loop;
    end if;
    return result_value;
  end if;

  -- Settings use the same command entry and one settings mutation. Their
  -- physical row belongs to Identity, so the protected implementation below
  -- performs the specialised write and the common Record effects once.
  if p_operation = 'settings' then
    if p_action is not null
      or p_selected_group_id is not null
      or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or (p_mutations -> 0 ->> 'kind') is distinct from 'settings'
      or (p_mutations -> 0) - array['kind', 'values']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'values') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_settings_record_changes_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values,
      p_mutations -> 0 -> 'values', p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations, action_context
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed BeforeSave flow the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasBeforeSaveFlows')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
          );
          select item.value into root_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text);
          select item.value into root_snapshot
          from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
          where item.value ->> 'recordKey' = 'root';
          if root_type is null or root_snapshot is null then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
          for relationship_value, target_type in
            select item.value, target.value
            from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
            join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
              on vortex_record.relationship_declares_target_internal(
                item.value, (target.value ->> 'recordTypeId')::uuid
              )
            where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
            order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
          loop
            relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
            old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
            proposed_relationship_target := old_relationship_target;
            if p_submitted_values ? relationship_field_id then
              proposed_relationship_target := p_submitted_values -> relationship_field_id;
            end if;
            if not (
              (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
                pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
              or
              (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
                pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
            ) then
              continue;
            end if;
            for total_field in
              select field.value
              from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
              where field.value ->> 'type' = 'total'
                and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                  pg_catalog.lower(relationship_value ->> 'relationshipId')
            loop
              if p_submitted_values ? relationship_field_id and
                p_submitted_values -> relationship_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
              dependency_contract := vortex_record.total_dependency_contract_internal(
                catalogue -> 'recordTypes',
                pg_catalog.jsonb_build_array(relationship_value),
                (target_type ->> 'recordTypeId')::uuid, total_field
              );
              for dependency_field_id in
                select item.value
                from pg_catalog.jsonb_array_elements_text(
                  dependency_contract -> 'sourceFieldIds'
                ) item(value)
              loop
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
                    coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                  contributes_to_total := true;
                  exit;
                end if;
              end loop;
              exit when contributes_to_total;
            end loop;
            exit when contributes_to_total;
          end loop;
          if contributes_to_total then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
        end if;
      end if;

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
          preparation_value := null;
        else
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      else
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.lower(field.value ->> 'fieldId')
                order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
              )
              from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
              where field.value ->> 'type' in ('total', 'calculation')
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into expected_parents
        from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
              from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into supplied_parents
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs, action_context
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
  else
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := (vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      )) -> 'record';
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  -- Recheck the ordinary operation at persistence. A named action has its own authority.
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (not action_mode
      and not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false)) then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  classification_value := vortex_record.classify_record_change_values_internal(
    p_record_type_id, final_values, meta, p_submitted_values,
    organization_id_value, application_root_id_value, receipt_kind, effective_command_id
  );
  if classification_value ->> 'outcome' <> 'classified' then
    return classification_value;
  end if;
  relationship_changes := classification_value -> 'relationshipChanges';
  value_final_values := classification_value -> 'valueFinalValues';
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(classification_value -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
      );
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
        else
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null, null::jsonb
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        -- Only a record of this application's own Module uses preview-owner authority.
        -- Borrowed records and live projections still need the builder's current permission.
        if preview_installation is not null
          and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
          and exists (
            select 1 from vortex_definition.roots as root
            where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
              and root.owner_application_root_id = application_root_id_value
          ) then
          target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
        else
          if pg_catalog.jsonb_array_length(
            target_loaded #> '{declaration,requiredPermissions}'
          ) = 0 then
            perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
            );
          end if;
          target_decision := vortex_access.evaluate_organization_record_access_internal(
            pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
              '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
          );
        end if;
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place replaces the per-writer #858 corrections.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
        else
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    elsif not action_mode
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    elsif action_mode
      and p_operation = 'update'
      and preview_installation is null
      and meta ->> 'storageScope' = 'application_contained'
      and pg_catalog.jsonb_array_length(relationship_changes) > 0
      and creation_count = 0
      and pg_catalog.jsonb_typeof(action_parents) = 'array'
      and pg_catalog.jsonb_array_length(action_parents) = 0
      and (case
        when copy_plan is null then true
        when pg_catalog.jsonb_typeof(copy_plan) = 'object'
          and copy_plan ->> 'outcome' = 'planned'
          and pg_catalog.jsonb_typeof(copy_plan -> 'copies') = 'array'
          then pg_catalog.jsonb_array_length(copy_plan -> 'copies') = 0
        else false
      end)
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
        where task.value ->> 'type' = 'record.delete'
      ) then
      -- The named declaration and proposed graph already passed their protected
      -- decisions and target locks. Save one actual subject tuple before edges.
      execute pg_catalog.format(
        'update record_data.%I as stored
         set concurrency_number = stored.concurrency_number + 1,
           updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
           definition_revision = $4
         where stored.organisation_id = $1 and stored.record_id = $2
           and stored.concurrency_number = $5
         returning stored.record_id, stored.concurrency_number',
        loaded ->> 'table'
      ) into saved_record_id, saved_concurrency_number
      using organization_id_value, p_record_id, actor_id_value,
        (loaded ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
      get diagnostics changed_rows = row_count;
      if changed_rows <> 1 then
        raise exception using errcode = '40001',
          message = 'Named relationship change did not apply to exactly one row';
      end if;
      if saved_record_id is distinct from p_record_id
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named relationship saved identity is unavailable';
      end if;
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', saved_record_id,
        'concurrencyNumber', saved_concurrency_number
      );
      named_relationship_subject_saved := true;
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'create_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;
  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  perform vortex_platform.attach_record_files_internal(p_record_type_id, saved_record_id, meta -> 'recordType', final_values);
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  elsif preview_installation is null then
    activity_time := vortex_record.append_record_activity_internal(p_activity_id, case when p_operation = 'create' then 'create_record' else 'update_record' end, array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_platform.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid,
      saved_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', p_record_type_id
        ),
        'payload', event_payload
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := (vortex_record.read_record(p_record_type_id, saved_record_id)) -> 'record';
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  return vortex_record.complete_named_action_changes_internal(
    action_owner_kind, action_owner_id, action_release_revision,
    action_id_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, result_value, subject_written,
    action_context, action_declared_occurrence_ids, creation_count,
    create_targets, action_creations, organization_id_value,
    action_creation_occurrence_ids, original_context_value, copy_plan,
    action_parents, preparation_value, named_action_receipt_pending,
    named_action_receipt_subject_write, effective_command_id, saved_record_id,
    saved_concurrency_number, application_root_id_value, correlation_id_value,
    named_relationship_subject_saved
  );
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one command receipt (a preview command carries its own preview-scoped id) and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

create or replace function vortex_record.apply_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  catalogue jsonb;
  snapshot jsonb;
  context_value jsonb;
  field_value jsonb;
  column_value jsonb;
  entry record;
  assignments text[] := array[]::text[];
  changed_field_ids uuid[] := array[]::uuid[];
  update_sql text;
  saved_record_id uuid;
  new_revision bigint;
  preview_installation jsonb;
  notice_sequence bigint;
  pending_exact_notice boolean := false;
  event_result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Relationship total parent mutation is invalid';
  end if;
  if p_final_values = '{}'::jsonb then return; end if;
  catalogue := vortex_record.relationship_total_catalogue_internal();
  snapshot := vortex_record.relationship_total_record_snapshot_internal(
    catalogue, p_record_type_id, p_record_id, true
  );
  if snapshot is null or (snapshot ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    raise exception using errcode = '40001', message = 'Relationship total parent revision changed';
  end if;
  context_value := vortex_access.validated_human_request_context();
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(snapshot -> 'recordType' -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Relationship total parent field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = (snapshot ->> 'storageContractId')::uuid
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Relationship total parent value is invalid';
    end if;
    assignments := pg_catalog.array_append(assignments, pg_catalog.format(
      '%I = %s', column_value ->> 'token',
      case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
      else case column_value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
        when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
        when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
        when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
        when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
        when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
        else pg_catalog.format('%L::text', entry.value #>> '{}') end end
    ));
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);
  update_sql := pg_catalog.format(
    'update record_data.%I stored set %s,
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $4
     returning stored.record_id, stored.concurrency_number',
    (select stored.physical_table_token from vortex_record.storage_catalogue stored
     where stored.storage_contract_id = (snapshot ->> 'storageContractId')::uuid),
    pg_catalog.array_to_string(assignments, ', ')
  );
  execute update_sql into saved_record_id, new_revision using
    (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid, p_expected_concurrency_number,
    (snapshot ->> 'definitionRevision')::bigint;
  if new_revision is null then
    raise exception using errcode = '40001', message = 'Relationship total parent write is stale';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and snapshot #>> '{recordType,storageScope}' = 'application_contained' then
    pending_exact_notice := true;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (snapshot ->> 'storageContractId')::uuid,
      case when snapshot #>> '{recordType,storageScope}' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'update_record', array[p_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (snapshot ->> 'storageContractId')::uuid, p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', pg_catalog.gen_random_uuid(),
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Relationship total parent Event append failed';
  end if;
  if pending_exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        p_record_type_id, saved_record_id, new_revision, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the parent write.
        null;
    end;
  end if;
end
$function$;
alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;


alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) is
  'Applies protected generated parent totals and calculations with the actual saved revision, Activity and standard Events in the original transaction. Live application-contained writes publish an advisory content-free notice for the actual saved Record; other scopes and previews retain their existing invalidation behavior.';

create or replace function vortex_record.apply_settings_record_changes_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  receipt_claim jsonb;
  access_result jsonb;
  projection jsonb;
  event_result jsonb;
  correlation_id_value uuid;
  application_root_id_value uuid;
  notice_sequence bigint;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    if p_command_id is not null then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value ->> 'key' is distinct from 'organization_settings'
    or record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not vortex_definition.is_system_projection_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  application_root_id_value := (meta -> 'context' ->> 'applicationRootId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null, null::jsonb
  );
  if loaded ->> 'outcome' <> 'loaded' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_record.decide_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := meta #>> array['columns', field_id, 'databaseValueType'];
    if database_type is null then
      raise exception using errcode = '55000',
        message = 'Organization settings field storage is unavailable';
    end if;

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' = 'completed' then
      projection := (vortex_record.read_record(p_record_type_id, p_record_id)) -> 'record';
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', correlation_id_value
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'saved',
        'recordId', projection -> 'recordId',
        'concurrencyNumber', projection -> 'concurrencyNumber',
        'values', projection -> 'values',
        'correlationId', correlation_id_value,
        'backgroundDelivery', 'pending',
        'replayed', true
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'none' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'reasonCode', 'command_pending',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'record_revision_conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', correlation_id_value
    );
  end if;

  access_result := vortex_access.change_organization_settings_record_internal(
    p_record_id, p_expected_concurrency_number, core_values, extension_values
  );
  if access_result ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return access_result || pg_catalog.jsonb_build_object(
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_conflict'),
      'correlationId', correlation_id_value
    );
  end if;
  if access_result ->> 'outcome' <> 'saved' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_refused'),
      'correlationId', correlation_id_value
    );
  end if;

  perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[p_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Organization settings Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id,
    (access_result ->> 'concurrencyNumber')::bigint,
    'Organization settings record save receipt is stale'
  );
  projection := (vortex_record.read_record(p_record_type_id, p_record_id)) -> 'record';
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved organisation settings projection is unavailable';
  end if;
  begin
    notice_sequence := pg_catalog.nextval(
      'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
    );
    perform vortex_platform.publish_change_notice(
      p_record_id, application_root_id_value, p_record_type_id,
      p_record_id, (access_result ->> 'concurrencyNumber')::bigint, 'changed',
      notice_sequence, notice_sequence, correlation_id_value
    );
  exception when others then
    -- Invalidation is advisory after the protected settings change completes,
    -- but its failure is logged with the cause so a stale view can be diagnosed.
    raise warning 'RECORD_INVALIDATION_FAILED settings record %: % %',
      p_record_id, sqlstate, sqlerrm;
  end;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save conflicted: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'database_conflict_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save refused: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'database_refused_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
end
$function$;
alter function vortex_record.apply_settings_record_changes_internal(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Internal settings change reached only through apply_record_changes: rechecks the installed system projection, protected permission and revision, then writes once with one Activity, Event and change notice.';

alter function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

create or replace function vortex_record.complete_named_action_changes_internal(
  action_owner_kind text,
  action_owner_id uuid,
  action_release_revision bigint,
  action_id_value uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  result_value jsonb,
  subject_written boolean,
  action_context jsonb,
  action_declared_occurrence_ids jsonb,
  creation_count integer,
  create_targets jsonb,
  action_creations jsonb,
  organization_id_value uuid,
  action_creation_occurrence_ids jsonb,
  original_context_value jsonb,
  copy_plan jsonb,
  action_parents jsonb,
  preparation_value jsonb,
  named_action_receipt_pending boolean,
  named_action_receipt_subject_write boolean,
  effective_command_id uuid,
  saved_record_id uuid,
  saved_concurrency_number bigint,
  application_root_id_value uuid,
  correlation_id_value uuid,
  named_relationship_subject_saved boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  event_loaded jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  public_created_records jsonb := '{}'::jsonb;
  created_record_tuples jsonb := '[]'::jsonb;
  first_created_record_tuples jsonb := '[]'::jsonb;
  inserted_value jsonb;
  final_created_tuple jsonb;
  saved_tuple jsonb;
  seen_created_ordinals integer[] := array[]::integer[];
  seen_created_ids uuid[] := array[]::uuid[];
  created_ordinal integer;
  created_concurrency_number bigint;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  loaded jsonb;
  target_record_id uuid;
  notice_sequence bigint;
  changed_field_ids uuid[];
  event_result jsonb;
begin
  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- Reauthorize the complete new graph before any created-row Activity or
    -- Event is visible. This barrier is intentionally whole-command, not per row.
    first_created_record_tuples :=
      vortex_record.authorize_created_records_for_command_internal(
        action_creations, created_records, original_context_value
      );
    if pg_catalog.jsonb_typeof(first_created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(first_created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;

    -- Append each created-row Activity and its standard Event only after the
    -- complete set passed ordinary CREATE authorization.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'execute_named_action', array[created_record_id]::uuid[], changed_field_ids, 'completed');
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_typeof(event_result -> 0) is distinct from 'object'
        or event_result -> 0 ->> 'occurrenceId' is distinct from occurrence_id_value::text then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;

  if creation_count > 0 then
    -- Re-load and reauthorize the entire graph after every mandatory created-row,
    -- copy and parent effect. These actual final target tuples drive both receipt
    -- completion and the narrow advisory created-notice attempts below.
    created_record_tuples := vortex_record.authorize_created_records_for_command_internal(
      action_creations, created_records, original_context_value
    );
    if pg_catalog.jsonb_typeof(created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    for final_created_tuple in
      select item.value
      from pg_catalog.jsonb_array_elements(created_record_tuples) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(final_created_tuple) is distinct from 'object'
        or not (final_created_tuple ?& array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ])
        or final_created_tuple - array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ]::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'ordinal') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'ordinal', 'integer'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'concurrencyNumber') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'concurrencyNumber', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'organizationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'organizationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') not in ('string', 'null')
        or (pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') = 'string'
          and coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'applicationRootId', 'uuid'), true))
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleRootId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleRootId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordTypeId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordTypeId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageContractId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'storageContractId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleReleaseRevision') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageScope') is distinct from 'string'
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'correlationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'correlationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'eligible') is distinct from 'boolean' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is malformed';
      end if;
      created_ordinal := (final_created_tuple ->> 'ordinal')::integer;
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      if created_ordinal < 0
        or created_ordinal = any (seen_created_ordinals)
        or created_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or created_record_id = any (seen_created_ids)
        or created_concurrency_number not between 1 and 9007199254740991
        or (final_created_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or (final_created_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
        or (final_created_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
        or (final_created_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
        or ((final_created_tuple ->> 'storageScope') = 'application_contained'
          and (final_created_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
        or ((final_created_tuple ->> 'storageScope') = 'organization_shared'
          and final_created_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
        or (final_created_tuple ->> 'eligible')::boolean is distinct from
          ((final_created_tuple ->> 'storageScope') = 'application_contained') then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is invalid';
      end if;
      inserted_value := created_records -> created_ordinal::text;
      saved_tuple := inserted_value -> '_savedTuple';
      if inserted_value is null
        or final_created_tuple -> 'recordId' is distinct from inserted_value -> 'recordId'
        or final_created_tuple -> 'organizationId' is distinct from saved_tuple -> 'organizationId'
        or final_created_tuple -> 'applicationRootId' is distinct from saved_tuple -> 'applicationRootId'
        or final_created_tuple -> 'moduleRootId' is distinct from saved_tuple -> 'moduleRootId'
        or final_created_tuple -> 'recordTypeId' is distinct from saved_tuple -> 'recordTypeId'
        or final_created_tuple -> 'storageContractId' is distinct from saved_tuple -> 'storageContractId'
        or final_created_tuple -> 'moduleReleaseRevision' is distinct from saved_tuple -> 'moduleReleaseRevision'
        or final_created_tuple -> 'storageScope' is distinct from saved_tuple -> 'storageScope'
        or final_created_tuple -> 'correlationId' is distinct from saved_tuple -> 'correlationId'
        or final_created_tuple -> 'eligible' is distinct from saved_tuple -> 'eligible' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple changed';
      end if;
      seen_created_ordinals := pg_catalog.array_append(seen_created_ordinals, created_ordinal);
      seen_created_ids := pg_catalog.array_append(seen_created_ids, created_record_id);
      public_created_records := public_created_records || pg_catalog.jsonb_build_object(
        created_ordinal::text, pg_catalog.jsonb_build_object(
          'recordId', inserted_value -> 'recordId',
          'storageContractId', inserted_value -> 'storageContractId',
          'values', inserted_value -> 'values'
        )
      );
    end loop;
    if pg_catalog.cardinality(seen_created_ordinals) <> creation_count
      or pg_catalog.cardinality(seen_created_ids) <> creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation set is incomplete';
    end if;

    if not named_action_receipt_pending then
      raise exception using errcode = '55000',
        message = 'Named action receipt completion is unavailable';
    end if;
    if named_action_receipt_subject_write then
      if saved_record_id is null
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named action receipt completion tuple is unavailable';
      end if;
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, saved_record_id, saved_concurrency_number,
        'Record save receipt is stale'
      );
    else
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id, p_record_id, p_expected_concurrency_number,
        'Named action receipt is stale'
      );
    end if;
    named_action_receipt_pending := false;
  end if;

  -- Only the new created-row notice attempt is advisory. All tuple and context
  -- validation above is outside this per-tuple catch; allocation, safe sequence
  -- validation and exact publication share one narrow failure boundary.
  for final_created_tuple in
    select item.value from pg_catalog.jsonb_array_elements(created_record_tuples) item(value)
  loop
    if (final_created_tuple ->> 'eligible')::boolean then
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Created Record notice sequence is unavailable';
        end if;
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value,
          (final_created_tuple ->> 'recordTypeId')::uuid,
          created_record_id, created_concurrency_number, 'created',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  if named_relationship_subject_saved then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        organization_id_value, application_root_id_value, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Invalidation is advisory after the protected named action is complete.
      null;
    end;
  end if;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', public_created_records);
end
$function$;

alter function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean)
  to vortex_record_adapter;

comment on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean) is
  'Private terminal step of apply_record_changes: preserves declared Events, ordered creations and edges, whole-graph authorization, parent effects, receipt completion and advisory notices in the caller transaction and restricted record role.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := (vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    )) -> 'record';
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- Ordinary saves require the explicit operation; named actions use their own preparation.
  if not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false) then
    raise log 'Record save preparation refused: standard operation % is not declared', p_operation;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'correlationId', correlation_id_value
    );
  end if;
  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_system_projection_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- The owning Module release's BeforeSave flows for this record type, run by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.prepare_named_action_command_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_creations jsonb,
  p_activity_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  root_type jsonb;
  creation_count integer;
  before_closure jsonb;
  after_closure jsonb;
  link_targets jsonb;
  lock_plan jsonb;
  lock_entry jsonb;
  locked_value jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  creation jsonb;
  rule_module_root_id uuid;
  rule_release_revision bigint;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object'
    or pg_catalog.jsonb_typeof(coalesce(p_creations, '[]'::jsonb)) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  creation_count := pg_catalog.jsonb_array_length(coalesce(p_creations, '[]'::jsonb));
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;
  -- A set-only action still uses the terminal writer's total probe. A command
  -- with creations carries the exact release's BeforeSave flows for every closure record
  -- to the existing Record evaluator before any row is written.
  if creation_count = 0
    and coalesce((catalogue ->> 'hasBeforeSaveFlows')::boolean, false) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  -- Authorize the subject without a row lock before discovering or locking any
  -- concrete dependency, through the installed named declaration. Executing a
  -- permitted action still requires no ordinary read or update authority.
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if access_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);

  before_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  link_targets := vortex_record.named_action_command_link_targets_internal(
    catalogue, p_record_type_id, p_submitted_values, p_creations
  );
  if before_closure is null or link_targets is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- One canonical row pass over the union of closure records (`for update`) and
  -- concrete link targets (`for share`). Taking both here, in one ascending
  -- concrete identity order, is what keeps a later `for share` inside the edge
  -- writer from queueing behind an exclusive waiter while this command already
  -- holds a resource that waiter needs.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storageContractId', grouped.storage_contract_id,
      'recordId', grouped.record_id,
      'recordTypeId', grouped.record_type_id,
      'mode', case when grouped.exclusive then 'update' else 'share' end
    ) order by grouped.storage_contract_id, grouped.record_id
  ), '[]'::jsonb)
  into lock_plan
  from (
    select entry.storage_contract_id, entry.record_id, entry.record_type_id,
      pg_catalog.bool_or(entry.exclusive) as exclusive
    from (
      select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
        (item.value ->> 'recordId')::uuid as record_id,
        (item.value ->> 'recordTypeId')::uuid as record_type_id,
        true as exclusive
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      union all
      select (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid,
        (item.value ->> 'recordTypeId')::uuid,
        false
      from pg_catalog.jsonb_array_elements(link_targets) item(value)
    ) entry
    group by entry.storage_contract_id, entry.record_id, entry.record_type_id
  ) grouped;

  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(lock_plan) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if lock_entry ->> 'mode' = 'update' then
      locked_value := vortex_record.relationship_total_record_snapshot_internal(
        catalogue, (lock_entry ->> 'recordTypeId')::uuid,
        (lock_entry ->> 'recordId')::uuid, true
      );
      if locked_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'restart');
      end if;
    elsif not vortex_record.share_lock_named_action_target_internal(
      catalogue, (lock_entry ->> 'recordTypeId')::uuid, (lock_entry ->> 'recordId')::uuid
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  -- A creation's link target is an ordinary record and keeps the ordinary read
  -- requirement. Deciding it here, under the lock and before any write, turns
  -- an unreadable target into a clean refusal instead of a late rollback. The
  -- command's own subject is excluded: the named authority decided above is
  -- sufficient for it, and requiring ordinary read would contradict #50.
  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if (lock_entry ->> 'recordTypeId')::uuid = p_record_type_id
      and (lock_entry ->> 'recordId')::uuid = p_record_id then
      continue;
    end if;
    target_loaded := vortex_record.load_record_access_facts_internal(
      (lock_entry ->> 'recordTypeId')::uuid, 'read',
      (lock_entry ->> 'recordId')::uuid, null, null::jsonb
    );
    if target_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_loaded -> 'declaration', (lock_entry ->> 'recordId')::uuid,
      target_loaded -> 'facts'
    );
    if target_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  after_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if access_loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);

  -- `not_required` is decided over the union of the subject type and every
  -- creation target type, and only after the locks above, so a command that
  -- needs no total still acquires its resources in the canonical order.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    join pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
      on true
    where field.value ->> 'type' = 'total'
  ) and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where pg_catalog.jsonb_array_length(
      coalesce(item.value -> 'recordType' -> 'relationships', '[]'::jsonb)
    ) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' and prepared_record ? 'recordId' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or not (prepared_record ? 'recordId')
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        rule_module_root_id,
        rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      source_records := '[]'::jsonb;
      if prepared_record ? 'recordId' then
        for edge_value in
          select edge.* from vortex_record.relationship_edges edge
          where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
            and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
            and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
            and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
            and edge.from_organisation_id = context_organization_id
            and edge.to_organisation_id = context_organization_id
            and edge.from_application_root_id is not distinct from case
              when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end
            and edge.to_application_root_id is not distinct from case
              when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
          order by edge.from_storage_contract_id, edge.from_record_id
        loop
          source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, false
          );
          if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
            return pg_catalog.jsonb_build_object('outcome', 'restart');
          end if;
          select item.value ->> 'recordKey' into source_key
          from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
          where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
            and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fieldValues', source_snapshot -> 'existingValues'
            ) || case when source_key is null then '{}'::jsonb
              else pg_catalog.jsonb_build_object('recordKey', source_key) end
          );
        end loop;
      end if;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then
          proposed_target := p_submitted_values -> source_field_id;
        end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;

      -- Each creation that links to this parent through this relationship joins
      -- its membership. A created record has no edges yet, so nothing is
      -- removed; the evaluator substitutes its computed values by record key.
      for creation in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
          with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') <>
          pg_catalog.lower((creation ->> 'recordTypeId')::uuid::text) then
          continue;
        end if;
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        proposed_target := creation -> 'values' -> source_field_id;
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and pg_catalog.lower(proposed_target ->> 'recordTypeId') =
            pg_catalog.lower(prepared_record ->> 'recordTypeId')
          and pg_catalog.lower(proposed_target ->> 'recordId') =
            pg_catalog.lower(prepared_record ->> 'recordId') then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordKey', 'create:' || (creation ->> 'ordinal'),
              'fieldValues', '{}'::jsonb
            )
          );
        end if;
      end loop;

      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';

create or replace function vortex_record.prepare_named_action_set_announce_internal(
  p_preview boolean,
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_activity_id uuid,
  p_read_loaded jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt_claim jsonb;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  projection jsonb;
  copy_plan jsonb;
  copy_targets jsonb := '[]'::jsonb;
  copy_target record;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  record_type_meta jsonb;
  reused_read_facts boolean := false;
begin
  if p_preview is null or p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    -- #571: a deleting action's subject is soft-deleted, so it cannot be
    -- projected; its replay is the delete's own stored outcome.
    if projection ->> 'outcome' <> 'completed' then
      projection := coalesce(
        vortex_record.named_action_deleted_subject_replay_internal(
          p_command_id, p_action_owner_kind, p_action_owner_id,
          p_action_release_revision, p_action_id, p_record_type_id
        ),
        projection
      );
    end if;
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  -- The context depends only on the action and the record type: a page that previews
  -- one action for many records resolves it once and passes it here; null resolves it now.
  action_context := coalesce(p_action_context, vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  ));
  if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'tasks') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'tasks'
      ) item(value)
      where item.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null, action_context
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- A preview of a record its caller has just read in this invocation reuses
  -- that read's facts when they are exactly the facts the named loader would
  -- build: the record alone, with no inherited owner, no edge and no
  -- relationship route on any of the action's permissions. Only the fixed
  -- record adapter can pass them; the action's own decision is still made below.
  record_type_meta := p_read_loaded -> 'recordTypeMeta';
  if p_preview and p_read_loaded ->> 'outcome' = 'loaded'
    and not (p_read_loaded ? 'previewInstallationId')
    and (p_read_loaded ->> 'isSystemProjection')::boolean is false
    and p_read_loaded -> 'context' = context_value
    and pg_catalog.jsonb_typeof(record_type_meta) = 'object'
    and pg_catalog.lower(record_type_meta ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and coalesce(record_type_meta ->> 'ownershipMode', '') <> 'inherited'
    and p_read_loaded #> '{facts,binding}' = action_context #> '{declaration,recordBinding}'
    and pg_catalog.jsonb_array_length(p_read_loaded #> '{facts,records}') = 1
    and p_read_loaded #>> '{facts,records,0,recordScope,recordId}' = pg_catalog.lower(p_record_id::text)
    and p_read_loaded #> '{facts,edges}' = '[]'::jsonb
    and pg_catalog.jsonb_typeof(action_context #> '{declaration,requiredPermissions}') = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(action_context #> '{declaration,requiredPermissions}') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    loaded := pg_catalog.jsonb_build_object(
      'outcome', 'loaded',
      'declaration', action_context -> 'declaration',
      'facts', p_read_loaded -> 'facts',
      'concurrencyNumber', p_read_loaded -> 'concurrencyNumber',
      'fieldValues', p_read_loaded -> 'fieldValues'
    );
    reused_read_facts := true;
  else
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      case when p_preview then null else p_expected_concurrency_number end
    );
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if p_preview and (loaded ->> 'concurrencyNumber')::bigint <>
      p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- Read facts reused above keep the record types their read decision
  -- validated in this invocation; the named loader's own facts are validated in full.
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts', null,
    case when reused_read_facts then loaded #> '{facts,recordTypes}' end
  );
  if decision ->> 'outcome' <> 'allowed' then
    if p_preview then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  -- Use the same locked copy plan the writer re-derives. Only rows with an
  -- actual new edge are evaluated; a no-op copy does not save its target.
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_inputs, action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  for copy_target in
    select (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.jsonb_object_agg(
        item.value ->> 'fromFieldId', item.value -> 'value'
      ) as submitted_values
    from pg_catalog.jsonb_array_elements(
      coalesce(copy_plan -> 'copies', '[]'::jsonb)
    ) item(value)
    group by 1
    order by 1
  loop
    target_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    target_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', copy_target.record_id, null, null::jsonb
    );
    if target_loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_meta -> 'declaration', copy_target.record_id,
      (target_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', target_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if target_decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(copy_target.submitted_values) field_id
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements_text(
          vortex_record.decide_record_field_bounds_internal(target_decision)
            -> 'changeableFieldIds'
        ) allowed(value)
        where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id)
      )
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    copy_targets := copy_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', copy_target.record_id,
        'existingValues', target_loaded -> 'fieldValues',
        'submittedValues', copy_target.submitted_values
      )
    );
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- #578: the owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType',
          'beforeSaveFlows', item.value -> 'beforeSaveFlows'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'copyTargets', copy_targets,
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    -- A singleton required permission was decided by the named-action access
    -- check above. The Record port may use it for a choice gated by that exact
    -- permission; a multi-permission declaration grants no such shortcut.
    'singleRequiredPermissionId', case
      when pg_catalog.jsonb_array_length(
        loaded #> '{declaration,requiredPermissions}'
      ) = 1 then loaded #> '{declaration,requiredPermissions,0,permissionId}'
      else 'null'::jsonb
    end,
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid, jsonb, jsonb
) is
  'Private named-action preparation: replays or refuses by command receipt, then returns the facts, permission decision and bounds of the exact installed action, writing nothing; a preview may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';

create or replace function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  access_loaded jsonb;
  access_decision jsonb;
  parent_read jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
  rule_module_root_id uuid;
  rule_release_revision bigint;
begin
  if p_operation not in ('create', 'update')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'update' and p_selected_group_id is not null)
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  -- Receipt resolution remains owned by prepare_base_record_save. Merely seeing
  -- an existing identity here avoids dependency reads or locks on replays and
  -- changed-input duplicates.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(root_type -> 'fields') field(value)
    where field.value ->> 'type' = 'total'
  ) and pg_catalog.jsonb_array_length(root_type -> 'relationships') = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  -- Authorize the old source without a row lock before discovering or locking
  -- any concrete dependency. A denied update is deferred to the base prepare,
  -- which owns the existing content-free refusal Activity.
  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, null, null::jsonb
    );
    if access_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'defer');
    end if;
    if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[context_organization_id]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);
  end if;

  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if before_closure is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if after_closure is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- A concurrent exact or changed-input duplicate may have completed while
  -- this transaction waited for the source/parent locks. Let the existing
  -- receipt owner distinguish replay from command-identity conflict.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if p_operation = 'update' and (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if access_loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_bounds := vortex_record.decide_record_field_bounds_internal(access_decision);
  end if;

  -- Materialize only the declared aggregate sources for each locked affected
  -- record. The initial source's proposed move replaces its old membership in
  -- this transaction-visible snapshot.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' then
      -- Use the established exact-record read path while the parent is locked.
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        rule_module_root_id, rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then proposed_target := p_submitted_values -> source_field_id; end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private Stage 2B preflight: discovers old/proposed concrete total closure, locks it canonically, re-reads it, and returns only declared evaluator inputs.';

CREATE OR REPLACE FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
  return pg_catalog.jsonb_build_object(
    'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
  );
end
$$;
alter function vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) TO vortex_runtime;

-- The protected entry revokes EXECUTE from its owner. Restore it only long enough for
-- CREATE OR REPLACE; the canonical definition revokes it again.
grant execute on function vortex_record.transfer_offboarding_active_owned_record(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint) to vortex_record_adapter;

create or replace function vortex_record.transfer_offboarding_active_owned_record(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_expected_access_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

  begin
    return vortex_record.apply_record_changes(
      p_command_id, 'transfer_ownership', p_record_type_id, p_record_id,
      p_expected_concurrency_number, '{}'::jsonb, null,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'transfer_ownership',
        'targetKind', p_target_kind,
        'targetId', p_target_id
      )),
      p_activity_id, p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- Identical per-record boundary to the retained entry: a contested final
      -- update rolls back its own pending receipt and is reported as a
      -- conflict, so one contested record never fails the whole batch.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$function$;

alter function vortex_record.transfer_offboarding_active_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) to vortex_request;
comment on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) is
  'Protected request entry for one disclosed account-offboarding transfer of an ordinary active record; it rechecks accounts.manage scope and delegates all target, owner, lifecycle, authority and revision checks to the one record-change operation''s terminal ownership transfer.';

-- The protected entry revokes EXECUTE from its owner. Restore it only long enough for
-- CREATE OR REPLACE; the canonical definition revokes it again.
grant execute on function vortex_record.transfer_offboarding_owned_record(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid, bigint) to vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
begin
  -- Refuse early when the accounts.manage scope moved; the one record-change
  -- operation rechecks it, reloads the record facts, locks the target and
  -- requires the caller's expected concurrency number before it mutates anything.
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

  begin
    return vortex_record.apply_record_changes(
      p_command_id, 'transfer_ownership', p_record_type_id, p_record_id,
      p_expected_concurrency_number, '{}'::jsonb, null,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'offboarding_transfer',
        'targetKind', p_target_kind,
        'targetId', p_target_id,
        'sourceOrganizationAccountId', p_source_organization_account_id,
        'expectedAccessVersion', p_expected_access_version
      )),
      p_activity_id, p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- A contested final update is an expected per-record result. The nested
      -- exception block rolls back its pending receipt before returning it.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$$;
alter function vortex_record.transfer_offboarding_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) IS 'Protected request entry for one disclosed account-offboarding retained or disabled-installation transfer; it rechecks accounts.manage scope and delegates all target, owner, lifecycle and revision checks to the fixed adapter-only operation.';

REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) TO vortex_request;

create or replace function vortex_record.transfer_record_ownership_for_offboarding_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_source_organization_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb; organization_id_value uuid; application_root_id_value uuid;
  actor_id_value uuid; receipt_claim jsonb;
  loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
  updated_record_id uuid; updated_organization_id uuid; updated_application_root_id uuid;
  storage_scope_value text; preview_installation jsonb;
  exact_notice boolean := false; notice_sequence bigint;
  correlation_id_value uuid;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is distinct from 'organization_account' or p_target_id is null
    or p_activity_id is null or p_occurrence_id is null
    or p_source_organization_account_id is null
    or p_source_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.lock_human_request_access_version_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  if correlation_id_value is null or not vortex_platform.is_non_nil_uuid(correlation_id_value::text) then
    raise exception using errcode='42501',message='Offboarding ownership transfer authority is unavailable';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',(receipt_claim ->> 'recordId')::uuid,
      'concurrencyNumber',(receipt_claim ->> 'concurrencyNumber')::bigint,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
    or loaded ->> 'installationState' is null
    or loaded ->> 'installationState' not in ('active', 'detached')
    or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,records}') is distinct from 'array'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,recordTypes}') is distinct from 'array' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  storage_scope_value := record_fact #>> '{recordScope,storageScope}';
  if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
    or pg_catalog.jsonb_typeof(type_fact) is distinct from 'object'
    or record_fact ->> 'lifecycleState' is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' is distinct from 'soft_deleted')
    or type_fact ->> 'ownershipMode' is distinct from 'organization_account'
    or storage_scope_value is null
    or storage_scope_value not in ('application_contained', 'organization_shared')
    or (record_fact #>> '{recordScope,organizationId}')::uuid is distinct from organization_id_value
    or (record_fact #>> '{recordScope,recordTypeId}')::uuid is distinct from p_record_type_id
    or (record_fact #>> '{recordScope,storageContractId}')::uuid is distinct from (type_fact ->> 'storageContractId')::uuid
    or type_fact ->> 'storageContractId' is null
    or not vortex_platform.is_non_nil_uuid(type_fact ->> 'storageContractId')
    or (storage_scope_value = 'application_contained'
      and (record_fact #>> '{recordScope,applicationRootId}')::uuid is distinct from application_root_id_value)
    or (record_fact ->> 'ownerOrganizationAccountId')::uuid is distinct from p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  -- Retained rows are never restored.  The unchanged complete Access
  -- evaluator sees only this locked target as active in an in-memory facts
  -- view, preserving every existing transfer route and condition.
  evaluation_facts := loaded -> 'facts';
  if record_fact ->> 'lifecycleState' = 'soft_deleted' then
    evaluation_facts := evaluation_facts || pg_catalog.jsonb_build_object(
      'records',
      (
        select pg_catalog.jsonb_agg(
          case
            when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
              then pg_catalog.jsonb_set(
                item.value, '{lifecycleState}', '"active"'::jsonb, false
              )
            else item.value
          end
          order by item.ordinal
        )
        from pg_catalog.jsonb_array_elements(evaluation_facts -> 'records')
          with ordinality as item(value, ordinal)
      )
    );
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, evaluation_facts
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.record_id,stored.concurrency_number,stored.organisation_id,%s',
    loaded ->> 'table',
    case when storage_scope_value = 'application_contained'
      then 'stored.application_root_id' else 'null::uuid' end
  ) into updated_record_id,updated_concurrency,updated_organization_id,updated_application_root_id
    using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  if updated_record_id is distinct from p_record_id
    or not vortex_platform.is_non_nil_uuid(updated_record_id::text)
    or updated_organization_id is distinct from organization_id_value
    or updated_concurrency is null
    or updated_concurrency not between 1 and 9007199254740991
    or (storage_scope_value = 'application_contained'
      and updated_application_root_id is distinct from application_root_id_value) then
    raise exception using errcode='40001',message='Offboarding ownership transfer revision changed';
  end if;
  perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode='42501',message='Preview Record context is unavailable';
  end if;
  exact_notice := preview_installation is null
    and loaded ->> 'installationState' = 'active'
    and storage_scope_value = 'application_contained';
  if exact_notice then
    -- Defer the exact notice until the protected transfer is complete.
    null;
  else
    perform vortex_record.bump_record_data_version_internal(
      organization_id_value, (type_fact ->> 'storageContractId')::uuid,
      case when storage_scope_value = 'application_contained'
        then application_root_id_value else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_platform.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_platform.append_record_occurrences(
      (type_fact ->> 'storageContractId')::uuid, p_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId',p_occurrence_id,
        'descriptor',pg_catalog.jsonb_build_object(
          'kind','standard','eventKind','reassigned','recordTypeId',p_record_type_id
        ),
        'payload',pg_catalog.jsonb_build_object('kind','reassigned')
      ))
    );
  end if;
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
    raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed';
  end if;
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, updated_record_id, updated_concurrency,
    'Offboarding ownership transfer receipt is stale'
  );
  if exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode='22023',message='Invalidation notice command is invalid';
      end if;
      perform vortex_platform.publish_change_notice(
        updated_organization_id, updated_application_root_id, p_record_type_id,
        updated_record_id, updated_concurrency, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Notice allocation and publication are advisory after the protected transfer is complete.
      null;
    end;
  end if;
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',updated_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

alter function vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Private offboarding single-record ownership transfer: the public transfer contract, with the command receipt, Activity and Event, for a named source owner.';

reset role;

set role vortex_owner;
drop function vortex_record.append_base_save_activity_internal(uuid,text,uuid,uuid[],text);
drop function vortex_record.append_lifecycle_policy_activity_internal(uuid,uuid);
drop function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text);
drop function vortex_record.append_ownership_transfer_activity_internal(uuid,uuid,text);
drop function vortex_record.append_record_lifecycle_activity_internal(uuid,text,uuid[]);
reset role;
