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
