create or replace function vortex_record.named_action_deleted_subject_replay_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  receipt_claim jsonb;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'soft_delete_subject'
  ) then
    return null;
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'delete',
    vortex_record.record_lifecycle_command_fingerprint_internal(
      p_command_id, 'delete', p_record_type_id, p_record_id,
      p_expected_concurrency_number
    ),
    p_record_type_id, p_record_id, '{}'::jsonb, '{}'::jsonb, true
  );
  if receipt_claim ->> 'status' is distinct from 'completed' then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'recordId', receipt_claim -> 'recordId',
    'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
    'values', '{}'::jsonb,
    'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
    'backgroundDelivery', 'pending',
    'replayed', true
  );
end
$function$;

revoke all on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) is
  'Private named-action step: for an installed action that declares soft_delete_subject, reports the stored outcome of the completed protected delete carrying the same command identity and revision (the deleted revision and no values), because a deleted subject cannot be projected. Returns null otherwise.';
