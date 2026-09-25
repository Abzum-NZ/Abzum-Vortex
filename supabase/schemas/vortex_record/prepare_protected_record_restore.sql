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
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  restore_result jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  policy_value jsonb;
  refusal_reason text;
  expected_policy_revision bigint;
  deleted_value timestamptz;
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
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';

  -- The recovery window is decided from this record's own deletion time, read
  -- before the restore primitive clears it, and from the stored policy of its
  -- exact target, share-locked until commit. The row is read unlocked: the
  -- primitive locks it and accepts only the expected revision, and a revision
  -- only ever advances, so a matching read is the same deleted row. Nothing
  -- from this read is returned unless the primitive has accepted the actor.
  select catalogue.* into storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  if found then
    policy_value := vortex_record.lock_record_recovery_policy_internal(
      (context_value ->> 'organizationId')::uuid,
      storage_row.storage_contract_id,
      case when storage_row.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
    expected_policy_revision := (policy_value ->> 'policyRevision')::bigint;
    execute pg_catalog.format(
      'select stored.deleted_at from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is not distinct from $3
         and stored.lifecycle_state = ''soft_deleted''
         and stored.concurrency_number = $4',
      storage_row.physical_table_token
    ) into deleted_value using
      (context_value ->> 'organizationId')::uuid, p_record_id,
      case when storage_row.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end,
      p_expected_concurrency_number;
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'restore', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', expected_policy_revision,
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
    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
      'replayed', true
    );
  end if;

  restore_result := vortex_record.restore_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
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

  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  perform vortex_record.append_record_lifecycle_effect_internal(
    'restored', storage_row.storage_contract_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, null
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  policy_value := vortex_record.lock_record_recovery_policy_internal(
    (context_value ->> 'organizationId')::uuid,
    storage_row.storage_contract_id,
    case when storage_row.storage_scope = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end
  );
  refusal_reason := case
    when policy_value is null then 'policy_unavailable'
    when policy_value ->> 'action' is distinct from 'delete' then 'recovery_action_ineligible'
    when (policy_value ->> 'policyRevision')::bigint
      is distinct from expected_policy_revision then 'policy_revision_stale'
    when pg_catalog.jsonb_typeof(policy_value -> 'recoveryWindowDays')
      is distinct from 'number' then 'policy_unavailable'
    when deleted_value is null then 'malformed_input'
    when pg_catalog.date_part(
      'epoch', pg_catalog.statement_timestamp() - deleted_value
    ) >= (policy_value ->> 'recoveryWindowDays')::numeric * 86400
      then 'recovery_window_expired'
    else null end;
  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_ineligible',
      'recoveryReason', refusal_reason,
      'governingPolicyRevision', policy_value -> 'policyRevision',
      'correlationId', correlation_value
    );
  end if;

  return vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
end
$function$;

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
  'Protected restore preflight: receipt, restore primitive, share-locked recovery-policy check, the recovery window from the record''s own deletion time and the locked dependency-total closure.';
