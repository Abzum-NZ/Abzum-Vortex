create or replace function vortex_record.prepare_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
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
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  root_snapshot jsonb;
  deletion_result jsonb;
  current_revision bigint;
begin
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
  correlation_value := context_value -> 'correlationId';
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'delete', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'delete', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', null,
      'activityId', p_activity_id,
      'occurrenceId', p_occurrence_id
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
      'outcome', 'deleted',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
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
  deletion_result := vortex_record.soft_delete_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  if deletion_result ->> 'outcome' = 'conflict' then
    current_revision := vortex_record.record_lifecycle_current_revision_internal(
      p_record_type_id, p_record_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when current_revision is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
  end if;
  if deletion_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
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
end
$function$;

revoke all on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) is
  'Protected delete preflight: receipt, recursive soft delete and the locked dependency-total closure of every affected parent.';
