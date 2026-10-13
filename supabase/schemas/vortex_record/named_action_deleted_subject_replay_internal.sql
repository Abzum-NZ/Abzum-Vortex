create or replace function vortex_record.named_action_deleted_subject_replay_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid
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
      action_context -> 'action' -> 'tasks'
    ) item(value)
    where item.value ->> 'type' = 'record.delete'
  ) then
    return null;
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, true
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

alter function vortex_record.named_action_deleted_subject_replay_internal(uuid,text,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid
) is
  'Private named-action step: for an installed action that declares record.delete, reports the stored outcome of the completed protected delete carrying the same command identity and revision (the deleted revision and no values), because a deleted subject cannot be projected. Returns null otherwise.';
