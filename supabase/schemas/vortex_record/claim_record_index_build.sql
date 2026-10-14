CREATE OR REPLACE FUNCTION vortex_record.claim_record_index_build(p_lease_seconds integer DEFAULT 300) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  candidate record;
  derivation jsonb;
  refusal_reason text;
  claim_value uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 86400 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  for candidate in
    select catalogue.index_contract_id, catalogue.purpose
    from vortex_record.index_catalogue as catalogue
    join vortex_record.storage_catalogue as storage
      on storage.storage_contract_id = catalogue.storage_contract_id
      and storage.state = 'active'
      and storage.physical_schema_token = 'record_data'
    join vortex_record.field_storage_mappings as stored
      on stored.storage_contract_id = catalogue.storage_contract_id
      and stored.field_id = catalogue.field_id
      and stored.state = 'active'
    where catalogue.observed_state <> 'present'
      and (catalogue.lease_expires_at is null
        or catalogue.lease_expires_at <= pg_catalog.statement_timestamp())
    order by catalogue.changed_at asc, catalogue.index_contract_id asc
    for update of catalogue skip locked
  loop
    derivation := vortex_record.index_build_statements_internal(
      candidate.index_contract_id
    );
    if derivation ->> 'outcome' = 'claimed' then
      claim_value := pg_catalog.gen_random_uuid();
      update vortex_record.index_catalogue as catalogue
      set claim_id = claim_value,
        claimed_by = session_user::text,
        claimed_at = pg_catalog.statement_timestamp(),
        lease_expires_at = pg_catalog.statement_timestamp()
          + pg_catalog.make_interval(secs => p_lease_seconds)
      where catalogue.index_contract_id = candidate.index_contract_id;
      return derivation || pg_catalog.jsonb_build_object('claimId', claim_value);
    elsif derivation ->> 'outcome' = 'settled' then
      if candidate.purpose = 'published_sort_drop' then
        delete from vortex_record.index_catalogue as catalogue
        where catalogue.index_contract_id = candidate.index_contract_id;
        continue;
      end if;
      -- The live index already matches but the recorded observation is stale
      -- (for example the runner recorded before a crash). Converge the row and
      -- clear any expired lease without rebuilding anything.
      update vortex_record.index_catalogue as catalogue
      set observed_state = 'present',
        observed_revision = catalogue.observed_revision + 1,
        claim_id = null,
        claimed_by = null,
        claimed_at = null,
        lease_expires_at = null,
        changed_at = pg_catalog.statement_timestamp()
      where catalogue.index_contract_id = candidate.index_contract_id;
    elsif derivation ->> 'outcome' = 'refused' and refusal_reason is null then
      refusal_reason := derivation ->> 'reasonCode';
    end if;
  end loop;

  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', refusal_reason
    );
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'none');
end
$$;
alter function vortex_record.claim_record_index_build(integer) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.claim_record_index_build(p_lease_seconds integer) IS 'Operational claim leasing one non-present, buildable index catalogue row for a bounded concurrent build.';

REVOKE ALL ON FUNCTION vortex_record.claim_record_index_build(p_lease_seconds integer) FROM PUBLIC;
