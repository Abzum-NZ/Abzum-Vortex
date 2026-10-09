create or replace function vortex_record.prepare_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  request_started_at timestamptz := pg_catalog.statement_timestamp();
  request_timeout interval;
  request_lock_timeout interval;
  request_deadline_at timestamptz;
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  capability_value jsonb;
  inventory_value jsonb;
  restore_result jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  proof_value jsonb;
  proof_digest text;
  original_deleted_at timestamptz;
  expected_policy_revision bigint;
  recovery_window_days integer;
  changed_rows integer;
  refusal_reason text;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  begin
    request_timeout := pg_catalog.current_setting('statement_timeout')::interval;
    request_lock_timeout := pg_catalog.current_setting('lock_timeout')::interval;
  exception when invalid_text_representation then
    request_timeout := interval '0';
    request_lock_timeout := interval '0';
  end;
  request_deadline_at := request_started_at + request_timeout;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';
  if request_timeout <= interval '0' or request_timeout > interval '30 seconds'
    or request_lock_timeout <= interval '0'
    or request_lock_timeout > interval '5 seconds'
    or request_deadline_at <= pg_catalog.clock_timestamp()
    or pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id,
    p_expected_concurrency_number
  );
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'restore', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', null,
      'activityId', p_activity_id,
      'occurrenceId', null
    ), false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_value
      );
    end if;
    capability_value := vortex_record.read_record_capabilities(
      p_record_type_id, p_record_id
    );
    if capability_value is null
      or not coalesce((capability_value -> 'actions') ? 'restore', false) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
      'replayed', true
    );
  end if;

  if request_deadline_at <= pg_catalog.clock_timestamp() then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  inventory_value := vortex_record.lock_record_restore_file_inventory_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if inventory_value ->> 'outcome' is distinct from 'locked'
    or pg_catalog.jsonb_typeof(inventory_value -> 'attachmentFields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(inventory_value -> 'originalDeletedAt') is distinct from 'string'
    or pg_catalog.jsonb_typeof(inventory_value -> 'recoveryPolicyRevision') is distinct from 'number'
    or pg_catalog.jsonb_typeof(inventory_value -> 'recoveryWindowDays') is distinct from 'number' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  original_deleted_at := (inventory_value ->> 'originalDeletedAt')::timestamptz;
  expected_policy_revision := (inventory_value ->> 'recoveryPolicyRevision')::bigint;
  recovery_window_days := (inventory_value ->> 'recoveryWindowDays')::integer;
  if recovery_window_days not between 1 and 104249991 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  refusal_reason := case
    when original_deleted_at is null then 'malformed_input'
    when pg_catalog.clock_timestamp() >= original_deleted_at
      + pg_catalog.make_interval(days => recovery_window_days)
      then 'recovery_window_expired'
    else null end;
  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_ineligible',
      'recoveryReason', refusal_reason,
      'governingPolicyRevision', expected_policy_revision,
      'correlationId', correlation_value
    );
  end if;

  if request_deadline_at <= pg_catalog.clock_timestamp() then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_value
    );
  end if;
  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  restore_result := vortex_record.restore_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);
  if restore_result ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when pg_catalog.jsonb_typeof(restore_result -> 'concurrencyNumber') = 'number'
      then pg_catalog.jsonb_build_object(
        'concurrencyNumber', restore_result -> 'concurrencyNumber'
      ) else '{}'::jsonb end;
  end if;
  if restore_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(restore_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;

  select effect.* into strict effect_row
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = p_command_id
    and effect.effect_kind = 'restored'
    and effect.record_type_id = p_record_type_id
    and effect.record_id = p_record_id
    and effect.pre_concurrency_number = p_expected_concurrency_number
  for update;
  if (
    select pg_catalog.count(*)
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = effect_row.organization_id
      and effect.application_root_id = effect_row.application_root_id
      and effect.actor_organization_account_id = effect_row.actor_organization_account_id
      and effect.command_id = effect_row.command_id
  ) <> 1 then
    raise exception using errcode = '55000',
      message = 'Protected record restore effect is incomplete';
  end if;
  proof_value := pg_catalog.jsonb_build_object(
    'version', 1,
    'commandId', effect_row.command_id,
    'organizationId', effect_row.organization_id,
    'applicationRootId', effect_row.application_root_id,
    'actorOrganizationAccountId', effect_row.actor_organization_account_id,
    'storageContractId', effect_row.storage_contract_id,
    'moduleRootId', (inventory_value ->> 'moduleRootId')::uuid,
    'moduleReleaseRevision', (inventory_value ->> 'moduleReleaseRevision')::bigint,
    'recordTypeId', effect_row.record_type_id,
    'recordId', effect_row.record_id,
    'preConcurrencyNumber', effect_row.pre_concurrency_number,
    'postConcurrencyNumber', effect_row.post_concurrency_number,
    'originalDeletedAt', vortex_context.format_timestamp_utc(original_deleted_at),
    'recoveryPolicyRevision', expected_policy_revision,
    'recoveryWindowDays', recovery_window_days,
    'requestDeadlineAt', vortex_context.format_timestamp_utc(request_deadline_at),
    'attachmentFields', inventory_value -> 'attachmentFields'
  );
  proof_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(proof_value::text, 'UTF8')),
    'hex'
  );
  update vortex_record.record_lifecycle_command_effects as effect
  set file_cascade_proof_digest = proof_digest,
    file_cascade_settled = false,
    restore_original_deleted_at = original_deleted_at,
    restore_policy_revision = expected_policy_revision,
    restore_recovery_window_days = recovery_window_days,
    restore_request_deadline_at = request_deadline_at
  where effect.organization_id = effect_row.organization_id
    and effect.application_root_id = effect_row.application_root_id
    and effect.actor_organization_account_id = effect_row.actor_organization_account_id
    and effect.command_id = effect_row.command_id
    and effect.effect_sequence = effect_row.effect_sequence
    and effect.effect_kind = 'restored'
    and effect.file_cascade_settled = false
    and effect.file_cascade_proof_digest is null
    and effect.restore_original_deleted_at is null
    and effect.restore_policy_revision is null
    and effect.restore_recovery_window_days is null
    and effect.restore_request_deadline_at is null;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 or request_deadline_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '40001',
      message = 'Protected record restore proof became stale';
  end if;
  return vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
end
$function$;

alter function vortex_record.prepare_protected_record_restore(uuid,uuid,uuid,bigint,uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) is
  'Protected restore preflight: current authorized replay, original bounded deadline, complete restore File inventory locks, restore primitive, private original-policy proof and dependency-total closure.';
