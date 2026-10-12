CREATE FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  catalogue_row vortex_record.index_catalogue%rowtype;
  storage_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  mapping_purpose text;
  scope_columns text;
  derived_fingerprint text;
  observed text;
  refusal_reason text;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_field_id is null
    or p_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_id is null
    or p_expected_definition_fingerprint is null
    or p_expected_definition_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.index_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id
  for update;
  if catalogue_row.index_contract_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_unknown'
    );
  end if;
  if catalogue_row.claim_id is distinct from p_claim_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'lease_not_owned'
    );
  end if;

  -- A newer or different desired definition superseded this build.
  if catalogue_row.desired_definition_fingerprint
      is distinct from p_expected_definition_fingerprint then
    refusal_reason := 'desired_definition_changed';
  end if;

  if refusal_reason is null then
    select storage.* into storage_row
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = p_storage_contract_id;
    select stored.* into mapping_row
    from vortex_record.field_storage_mappings as stored
    where stored.storage_contract_id = p_storage_contract_id
      and stored.field_id = p_field_id;
    scope_columns := vortex_record.index_scope_columns(storage_row.storage_scope);
    if storage_row.storage_contract_id is null
      or storage_row.state <> 'active'
      or storage_row.physical_schema_token <> 'record_data'
      or mapping_row.storage_contract_id is null
      or mapping_row.state <> 'active'
      or scope_columns is null then
      refusal_reason := 'storage_contract_unavailable';
    end if;
  end if;

  if refusal_reason is null then
    mapping_purpose := case
      when coalesce((mapping_row.field_definition ->> 'unique')::boolean, false)
        then 'uniqueness'
      when coalesce((mapping_row.field_definition ->> 'filterable')::boolean, false)
        or coalesce((mapping_row.field_definition ->> 'sortable')::boolean, false)
        then 'performance'
      else null
    end;
    derived_fingerprint := vortex_record.index_definition_fingerprint(
      catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
      mapping_row.physical_column_token
    );
    if mapping_purpose is distinct from catalogue_row.purpose
      or derived_fingerprint is distinct from p_expected_definition_fingerprint
      or catalogue_row.physical_index_token is distinct from
        (case catalogue_row.purpose when 'uniqueness' then 'ux_' else 'ix_' end
          || pg_catalog.substr(mapping_row.physical_column_token, 3)) then
      refusal_reason := 'definition_mismatch';
    end if;
  end if;

  if refusal_reason is not null then
    update vortex_record.index_catalogue as catalogue
    set claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null
    where catalogue.storage_contract_id = p_storage_contract_id
      and catalogue.field_id = p_field_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', refusal_reason
    );
  end if;

  observed := vortex_record.observe_field_index_internal(
    catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
    mapping_row.physical_column_token
  );

  update vortex_record.index_catalogue as catalogue
  set observed_state = observed,
    observed_revision = case when observed is distinct from catalogue_row.observed_state
      then catalogue_row.observed_revision + 1
      else catalogue_row.observed_revision end,
    claim_id = null,
    claimed_by = null,
    claimed_at = null,
    lease_expires_at = null,
    changed_at = pg_catalog.statement_timestamp()
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id;

  return pg_catalog.jsonb_build_object(
    'outcome', observed,
    'indexContractId', catalogue_row.index_contract_id,
    'storageContractId', catalogue_row.storage_contract_id,
    'fieldId', catalogue_row.field_id,
    'purpose', catalogue_row.purpose,
    'desiredDefinitionFingerprint', derived_fingerprint,
    'observedState', observed
  );
end
$_$;

COMMENT ON FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) IS 'Records the observed physical state of a leased index build, marking present only when the live definition matches the claimed fingerprint.';

REVOKE ALL ON FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) FROM PUBLIC;
