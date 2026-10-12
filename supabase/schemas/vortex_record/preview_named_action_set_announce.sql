CREATE FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select vortex_record.prepare_named_action_set_announce_internal(
    true, p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs, p_activity_id
  )
$$;

REVOKE ALL ON FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) TO vortex_runtime;
