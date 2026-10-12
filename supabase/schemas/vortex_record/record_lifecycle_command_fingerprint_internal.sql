CREATE FUNCTION vortex_record.record_lifecycle_command_fingerprint_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'contractVersion', '1.0.0',
        'commandId', p_command_id,
        'operation', p_operation,
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      )::text, 'UTF8'
    )), 'hex'
  )
$$;

REVOKE ALL ON FUNCTION vortex_record.record_lifecycle_command_fingerprint_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) FROM PUBLIC;
