CREATE FUNCTION vortex_record.soft_delete_record_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    perform vortex_record.soft_delete_record_recursive_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or insufficient_privilege or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
    when check_violation then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
  end;
end
$$;

COMMENT ON FUNCTION vortex_record.soft_delete_record_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) IS 'Private revision-checked recoverable delete primitive with current Access and declared incoming relationship handling; it sets no recovery policy.';

REVOKE ALL ON FUNCTION vortex_record.soft_delete_record_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) FROM PUBLIC;
