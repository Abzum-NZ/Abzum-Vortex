create or replace function vortex_record.preview_named_action_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
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
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  if vortex_record.preview_scoped_command_id_internal(p_command_id) is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_changes', vortex_record.preview_scoped_command_id_internal(p_command_id), true
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
    -- A completed command answers with its own replay of this subject.
    select item.value into projection
    from pg_catalog.jsonb_array_elements(coalesce(vortex_record.replay_record_changes_internal(
      vortex_record.preview_scoped_command_id_internal(p_command_id), receipt_claim -> 'result'
    ) -> 'namedResults', '[]'::jsonb)) as item(value)
    where (item.value ->> 'recordId')::uuid = p_record_id;
    if projection ->> 'outcome' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  prepared := vortex_record.prepare_named_action_subject_internal(
    true, p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_inputs, p_read_loaded, p_action_context
  );
  if prepared ->> 'outcome' = 'subject_permission_refused' then
    return prepared || pg_catalog.jsonb_build_object('outcome', 'permission_refused');
  end if;
  return prepared;
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.preview_named_action_internal(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.preview_named_action_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.preview_named_action_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb
) is
  'Private named-action availability preview: a completed command answers with its own replay of the subject; otherwise the facts, permission decision and bounds of the exact installed action, writing nothing. It may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';
