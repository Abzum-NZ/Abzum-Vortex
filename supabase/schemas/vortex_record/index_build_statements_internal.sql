CREATE OR REPLACE FUNCTION vortex_record.index_build_statements_internal(p_storage_contract_id uuid, p_field_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  catalogue_row vortex_record.index_catalogue%rowtype;
  storage_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  mapping_purpose text;
  scope_columns text;
  expected_fingerprint text;
  observed text;
  table_relation oid;
  physical_relation oid;
  physical_owner_relation oid;
  physical_valid boolean;
  physical_unique boolean;
  statements jsonb := '[]'::jsonb;
begin
  select catalogue.* into catalogue_row
  from vortex_record.index_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id;
  if catalogue_row.index_contract_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_unknown'
    );
  end if;

  select storage.* into storage_row
  from vortex_record.storage_catalogue as storage
  where storage.storage_contract_id = p_storage_contract_id;
  if storage_row.storage_contract_id is null
    or storage_row.state <> 'active'
    or storage_row.physical_schema_token <> 'record_data' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  select stored.* into mapping_row
  from vortex_record.field_storage_mappings as stored
  where stored.storage_contract_id = p_storage_contract_id
    and stored.field_id = p_field_id;
  if mapping_row.storage_contract_id is null or mapping_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_unavailable'
    );
  end if;

  scope_columns := vortex_record.index_scope_columns(storage_row.storage_scope);
  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', storage_row.physical_table_token)
  );
  if scope_columns is null or table_relation is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  -- The same purpose `read_index_readiness` derives, so the runner builds
  -- exactly the index activation will require.
  mapping_purpose := case
    when coalesce((mapping_row.field_definition ->> 'unique')::boolean, false)
      then 'uniqueness'
    when coalesce((mapping_row.field_definition ->> 'filterable')::boolean, false)
      or coalesce((mapping_row.field_definition ->> 'sortable')::boolean, false)
      then 'performance'
    else null
  end;
  expected_fingerprint := vortex_record.index_definition_fingerprint(
    catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
    mapping_row.physical_column_token
  );
  -- The recorded identity must still describe exactly this physical index; a
  -- drifted row is never built against a definition it does not name.
  if mapping_purpose is distinct from catalogue_row.purpose
    or expected_fingerprint is distinct from catalogue_row.desired_definition_fingerprint
    or catalogue_row.physical_index_token is distinct from
      (case catalogue_row.purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping_row.physical_column_token, 3)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_definition_drifted'
    );
  end if;

  observed := vortex_record.observe_field_index_internal(
    catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
    mapping_row.physical_column_token
  );
  if observed = 'present' then
    return pg_catalog.jsonb_build_object('outcome', 'settled');
  end if;

  -- A concurrent index build or cleanup holds SHARE UPDATE EXCLUSIVE on the
  -- table for its whole duration, including one orphaned by a worker that
  -- died or whose lease expired mid-build. While any other session holds or
  -- awaits that lock the row is left alone, so a cleanup can never drop an
  -- index another session is about to complete. Autovacuum takes the same
  -- lock; the row is simply offered again by a later run.
  if exists (
    select 1
    from pg_catalog.pg_locks as held
    where held.locktype = 'relation'
      and held.database = (
        select database_value.oid
        from pg_catalog.pg_database as database_value
        where database_value.datname = pg_catalog.current_database()
      )
      and held.relation = table_relation
      and held.mode = 'ShareUpdateExclusiveLock'
      and held.pid <> pg_catalog.pg_backend_pid()
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'busy');
  end if;

  physical_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', catalogue_row.physical_index_token)
  );
  if physical_relation is not null then
    select index_value.indrelid, index_value.indisvalid, index_value.indisunique
      into physical_owner_relation, physical_valid, physical_unique
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = physical_relation;
    -- The name is held by something other than an index of this table (the
    -- index namespace is shared across every record table). It is never
    -- dropped from here.
    if not found or physical_owner_relation is distinct from table_relation then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'index_name_conflict'
      );
    end if;
    -- A valid unique index is still enforcing whatever uniqueness it provides,
    -- whatever its purpose or definition. Dropping it would remove that
    -- enforcement, so the row is refused rather than replaced; only an index
    -- that enforces nothing (invalid, or valid but not unique) is recreated.
    if physical_valid and physical_unique then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'uniqueness_enforcement_present'
      );
    end if;
    statements := statements || pg_catalog.jsonb_build_array(
      pg_catalog.format(
        'drop index concurrently if exists record_data.%I',
        catalogue_row.physical_index_token
      )
    );
  end if;

  statements := statements || pg_catalog.jsonb_build_array(
    case catalogue_row.purpose
      when 'uniqueness' then pg_catalog.format(
        'create unique index concurrently %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
        catalogue_row.physical_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token
      )
      else pg_catalog.format(
        'create index concurrently %I on record_data.%I (%s, %I%s asc nulls first, record_id asc) where lifecycle_state = ''active''',
        catalogue_row.physical_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token,
        case when mapping_row.database_value_type = 'text' then ' collate "C"' else '' end
      )
    end
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'indexContractId', catalogue_row.index_contract_id,
    'storageContractId', catalogue_row.storage_contract_id,
    'fieldId', catalogue_row.field_id,
    'purpose', catalogue_row.purpose,
    'desiredDefinitionFingerprint', expected_fingerprint,
    'statements', statements
  );
end
$$;
alter function vortex_record.index_build_statements_internal(uuid,uuid) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.index_build_statements_internal(p_storage_contract_id uuid, p_field_id uuid) IS 'Private derivation of the ordered drop/create statements one catalogue row needs; never granted above vortex_owner.';

REVOKE ALL ON FUNCTION vortex_record.index_build_statements_internal(p_storage_contract_id uuid, p_field_id uuid) FROM PUBLIC;
