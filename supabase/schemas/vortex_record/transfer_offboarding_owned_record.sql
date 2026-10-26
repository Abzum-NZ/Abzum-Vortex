CREATE OR REPLACE FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  -- The one record-change operation checks the accounts.manage scope and its access version,
  -- reloads the record facts, locks the target and requires the caller's expected concurrency
  -- number before it mutates anything.
  begin
    return vortex_record.apply_record_changes(
      p_command_id, 'transfer_ownership', p_record_type_id, p_record_id,
      p_expected_concurrency_number, '{}'::jsonb, null,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'offboarding_transfer',
        'targetKind', p_target_kind,
        'targetId', p_target_id,
        'sourceOrganizationAccountId', p_source_organization_account_id,
        'expectedAccessVersion', p_expected_access_version
      )),
      p_activity_id, p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- A contested final update is an expected per-record result. The nested
      -- exception block rolls back its pending receipt before returning it.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$$;
alter function vortex_record.transfer_offboarding_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) IS 'The one protected request entry for a disclosed account-offboarding transfer of a retained or disabled-installation record; the record-change operation checks the accounts.manage scope, access version, target, owner, lifecycle and revision.';

REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) TO vortex_request;
