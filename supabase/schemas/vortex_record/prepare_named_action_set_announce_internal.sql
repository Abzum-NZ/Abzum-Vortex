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
  projection jsonb;
  prepared jsonb;
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
    -- A deleting action's subject is soft-deleted, so it cannot be
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

  prepared := vortex_record.prepare_named_action_subject_internal(
    p_preview, p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_inputs, p_read_loaded, p_action_context
  );
  if prepared ->> 'outcome' = 'subject_permission_refused' then
    if p_preview then
      return prepared || pg_catalog.jsonb_build_object('outcome', 'permission_refused');
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action',
      array[p_record_id]::uuid[], array[]::uuid[], 'refused');
    return prepared || pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  return prepared;
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
