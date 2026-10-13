CREATE OR REPLACE FUNCTION vortex_record.load_offboarding_ownership_transfer_facts_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  installation jsonb;
  loaded jsonb;
begin
  begin
    installation := vortex_definition.read_current_active_installation();
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    return loaded || pg_catalog.jsonb_build_object('installationState', 'active');
  exception
    when no_data_found then
      installation := vortex_definition.read_current_detached_installation_for_transfer_internal();
      loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
        p_record_type_id, p_record_id, p_expected_concurrency_number, installation
      );
      return loaded || pg_catalog.jsonb_build_object('installationState', 'detached');
  end;
end
$$;
alter function vortex_record.load_offboarding_ownership_transfer_facts_internal(uuid,uuid,bigint) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.load_offboarding_ownership_transfer_facts_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) FROM PUBLIC;
