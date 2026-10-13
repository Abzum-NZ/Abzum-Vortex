CREATE FUNCTION vortex_record.renew_record_index_build_lease(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_lease_seconds integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_storage_contract_id is null
    or p_field_id is null
    or p_claim_id is null
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and 86400 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  update vortex_record.index_catalogue as catalogue
  set lease_expires_at = pg_catalog.statement_timestamp()
    + pg_catalog.make_interval(secs => p_lease_seconds)
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id
    and catalogue.claim_id = p_claim_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'lease_not_owned'
    );
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'renewed');
end
$$;
alter function vortex_record.renew_record_index_build_lease(uuid,uuid,uuid,integer) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.renew_record_index_build_lease(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_lease_seconds integer) IS 'Confirms the caller still holds one index build claim and extends its lease before the next statement.';

REVOKE ALL ON FUNCTION vortex_record.renew_record_index_build_lease(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_lease_seconds integer) FROM PUBLIC;
