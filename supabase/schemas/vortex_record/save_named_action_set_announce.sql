create or replace function vortex_record.save_named_action_set_announce(
  p_command_id uuid, p_record_type_id uuid, p_record_id uuid,
  p_expected_concurrency_number bigint, p_submitted_values jsonb,
  p_final_values jsonb, p_activity_id uuid, p_standard_occurrence_id uuid,
  p_declared_occurrence_ids jsonb, p_action_owner_kind text,
  p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  result_value jsonb;
  event_result jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  set_field_ids jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'effects'
      ) effect(value)
      where effect.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'soft_delete_subject', 'announce_event')
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'unsupported');
  end if;
  select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
  into set_field_ids
  from (
    select distinct pg_catalog.lower(effect.value ->> 'fieldId') as field_id
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects') effect(value)
    where effect.value ->> 'kind' = 'set_field'
  ) fields;
  if pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_declared_occurrence_ids) is distinct from 'array'
    or set_field_ids is distinct from coalesce((
      select pg_catalog.jsonb_agg(key order by key collate "C")
      from pg_catalog.jsonb_object_keys(p_submitted_values) key
    ), '[]'::jsonb)
    or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
      pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  -- A create-only action whose created record moves one of the subject's own
  -- totals still has to write the subject. The fixed writer already accepts a
  -- final-value map of generated fields with an empty submitted-field set
  -- (`20260912011556:1149-1192`), so the only change here is reaching it when
  -- `p_final_values` is non-empty rather than only when a `set_field` exists.
  if pg_catalog.jsonb_array_length(set_field_ids) > 0 or p_final_values <> '{}'::jsonb then
    result_value := vortex_record.save_named_action_set_fields_internal(
      p_command_id, 'update', p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_final_values, null,
      p_activity_id, p_standard_occurrence_id, p_action_owner_kind,
      p_action_owner_id, p_action_release_revision, p_action_id, p_inputs
    );
    if result_value ->> 'outcome' <> 'saved'
      or coalesce((result_value ->> 'replayed')::boolean, false) then
      return result_value;
    end if;
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', p_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_array_length(event_result) <>
      pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    return result_value;
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
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
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, 'named_action', fingerprint_value,
    p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
      'actionOwnerKind', p_action_owner_kind,
      'actionOwnerId', p_action_owner_id,
      'actionReleaseRevision', p_action_release_revision,
      'actionId', p_action_id
    ), '{}'::jsonb, false
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
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
  end if;
  perform vortex_record.append_named_action_activity_internal(
    p_activity_id, p_record_id, array[]::uuid[], 'completed'
  );
  event_result := vortex_record.append_declared_named_action_occurrences_internal(
    (action_context ->> 'storageContractId')::uuid, p_record_id,
    action_context -> 'eventDescriptors', p_declared_occurrence_ids,
    loaded -> 'fieldValues'
  );
  if pg_catalog.jsonb_array_length(event_result) <>
    pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
    raise exception using errcode = '55000',
      message = 'Named action declared Event append failed';
  end if;
  perform vortex_record.complete_command_receipt_internal(
    'named_action', p_command_id, null, p_expected_concurrency_number,
    'Named action receipt is stale'
  );
  result_value := vortex_record.project_named_action_record_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id
  );
  if result_value ->> 'outcome' <> 'completed' then
    raise exception using errcode = '55000',
      message = 'Named action Record projection is unavailable';
  end if;
  return result_value || pg_catalog.jsonb_build_object('replayed', false);
end
$function$;

revoke all on function vortex_record.save_named_action_set_announce(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, text, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.save_named_action_set_announce(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, text, uuid, bigint, uuid, jsonb
) is
  'Terminal named-action writer for the announce-only shape: claims the command receipt and writes its Activity and declared Events in one transaction.';
