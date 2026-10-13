CREATE FUNCTION vortex_record.named_action_command_fingerprint_internal(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0', 'commandId', p_command_id,
      'action', pg_catalog.jsonb_build_object(
        'ownerKind', p_action_owner_kind, 'ownerId', p_action_owner_id,
        'releaseRevision', p_action_release_revision, 'actionId', p_action_id
      ),
      'recordTypeId', p_record_type_id, 'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'inputs', p_inputs
    )::text, 'UTF8')), 'hex')
$$;
alter function vortex_record.named_action_command_fingerprint_internal(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.named_action_command_fingerprint_internal(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb) FROM PUBLIC;
