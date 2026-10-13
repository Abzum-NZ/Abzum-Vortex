CREATE FUNCTION vortex_record.base_save_command_fingerprint_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to((
      pg_catalog.jsonb_build_object(
        'contractVersion', '2.0.0',
        'commandId', p_command_id,
        'operation', p_operation,
        'recordTypeId', p_record_type_id,
        'submittedValues', p_submitted_values
      ) || case when p_operation = 'create' then
        case when p_selected_group_id is null then '{}'::jsonb
          else pg_catalog.jsonb_build_object(
            'selectedOwnerGroupId', p_selected_group_id
          ) end
      else pg_catalog.jsonb_build_object(
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      ) end
    )::text, 'UTF8')), 'hex'
  )
$$;
alter function vortex_record.base_save_command_fingerprint_internal(uuid,text,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.base_save_command_fingerprint_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid) FROM PUBLIC;
