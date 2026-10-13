CREATE FUNCTION vortex_record.ownership_transfer_command_fingerprint_internal(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_operation_identity text, p_source_organization_account_id uuid) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'commandId', p_command_id,
      'operation', 'transfer_ownership',
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'targetKind', p_target_kind,
      'targetId', p_target_id,
      'operationIdentity', p_operation_identity,
      'sourceOrganizationAccountId', p_source_organization_account_id
    )::text, 'UTF8')), 'hex'
  )
$$;
alter function vortex_record.ownership_transfer_command_fingerprint_internal(uuid,uuid,uuid,bigint,text,uuid,text,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.ownership_transfer_command_fingerprint_internal(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_operation_identity text, p_source_organization_account_id uuid) FROM PUBLIC;
