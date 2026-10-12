CREATE FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  index_token text;
  canonical_scope_columns text;
  definition_fingerprint text;
  observed text;
begin
  canonical_scope_columns := vortex_record.index_scope_columns(p_storage_scope);
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_field_id is null
    or p_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_purpose is null or p_purpose not in ('uniqueness', 'performance')
    or canonical_scope_columns is null
    or p_scope_index_columns is distinct from canonical_scope_columns
    or p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$' then
    raise exception using errcode = '55000',
      message = 'Record field index provisioning is invalid';
  end if;

  index_token := case p_purpose when 'uniqueness' then 'ux_' else 'ix_' end
    || pg_catalog.substr(p_column_token, 3);
  definition_fingerprint := vortex_record.index_definition_fingerprint(
    p_purpose, p_table_token, p_scope_index_columns, p_column_token
  );

  if p_purpose = 'uniqueness' then
    execute pg_catalog.format(
      'create unique index if not exists %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
      index_token, p_table_token, p_scope_index_columns, p_column_token
    );
  else
    execute pg_catalog.format(
      'create index if not exists %I on record_data.%I (%s, %I)',
      index_token, p_table_token, p_scope_index_columns, p_column_token
    );
  end if;

  observed := vortex_record.observe_field_index_internal(
    p_purpose, p_table_token, p_scope_index_columns, p_column_token
  );
  if observed <> 'present' then
    raise exception using errcode = '55000',
      message = 'Provisioned record field index is not ready';
  end if;

  insert into vortex_record.index_catalogue (
    index_contract_id, storage_contract_id, field_id, purpose, physical_index_token,
    desired_definition_fingerprint, observed_state, observed_revision
  ) values (
    vortex_record.index_contract_identity(p_storage_contract_id, p_field_id),
    p_storage_contract_id, p_field_id, p_purpose, index_token,
    definition_fingerprint, observed, 1
  )
  on conflict (storage_contract_id, field_id) do update
  set purpose = excluded.purpose,
      physical_index_token = excluded.physical_index_token,
      desired_definition_fingerprint = excluded.desired_definition_fingerprint,
      observed_state = excluded.observed_state,
      observed_revision = vortex_record.index_catalogue.observed_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
  where vortex_record.index_catalogue.purpose is distinct from excluded.purpose
    or vortex_record.index_catalogue.physical_index_token
      is distinct from excluded.physical_index_token
    or vortex_record.index_catalogue.desired_definition_fingerprint
      is distinct from excluded.desired_definition_fingerprint
    or vortex_record.index_catalogue.observed_state is distinct from excluded.observed_state;
end
$_$;

COMMENT ON FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Private provisioner helper: creates one exact field index and records its desired definition and observed readiness for one storage contract and field.';

REVOKE ALL ON FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;
