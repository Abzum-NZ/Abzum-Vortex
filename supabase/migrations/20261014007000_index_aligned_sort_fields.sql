set local role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'schemaToken', 'record_data',
    'tableToken', p_table_token,
    'columns', pg_catalog.string_to_array(p_scope_index_columns, ', ') ||
      case when p_purpose = 'performance' then array[
        p_column_token || case when exists (
          select 1 from pg_catalog.pg_attribute as attribute
          where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('record_data.%I', p_table_token)
          )
            and attribute.attname = p_column_token
            and attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
        ) then ' COLLATE "C"' else '' end || ' NULLS FIRST',
        'record_id'
      ] else array[p_column_token] end,
    'unique', p_purpose = 'uniqueness',
    'predicate', case when p_purpose = 'uniqueness'
      then 'lifecycle_state in (active, soft_deleted, removal_pending)'
      else 'lifecycle_state = active' end
  )
$$;
alter function vortex_record.index_definition(text,text,text,text) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select 'sha256:' || pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        vortex_record.index_definition(
          p_purpose, p_table_token, p_scope_index_columns, p_column_token
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;
alter function vortex_record.index_definition_fingerprint(text,text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Canonical sha256 fingerprint of one exact desired field-index definition, using the same convention as record storage content fingerprints.';

REVOKE ALL ON FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  table_relation oid;
  index_relation oid;
  index_row record;
  expected_columns text[];
  key_position integer;
  sort_position integer;
  expected_attnum smallint;
  text_column boolean;
begin
  if p_purpose is null or p_purpose not in ('uniqueness', 'performance')
    or p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$' then
    return 'invalid';
  end if;

  expected_columns := pg_catalog.string_to_array(p_scope_index_columns, ', ')
    || p_column_token;
  if p_purpose = 'performance' then
    expected_columns := expected_columns || array['record_id'];
  end if;
  if pg_catalog.cardinality(expected_columns) < 2 then
    return 'invalid';
  end if;

  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_table_token)
  );
  if table_relation is null then
    return 'invalid';
  end if;

  index_relation := pg_catalog.to_regclass(
    pg_catalog.format(
      'record_data.%I',
      case p_purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(p_column_token, 3)
    )
  );
  if index_relation is null then
    return 'missing';
  end if;

  select index_value.* into index_row
  from pg_catalog.pg_index as index_value
  where index_value.indexrelid = index_relation;
  if not found
    or index_row.indrelid is distinct from table_relation
    or index_row.indisvalid is not true
    or index_row.indnkeyatts is distinct from pg_catalog.cardinality(expected_columns) then
    return 'invalid';
  end if;

  for key_position in 1 .. index_row.indnkeyatts
  loop
    select attribute.attnum into expected_attnum
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = table_relation
      and attribute.attname = expected_columns[key_position]
      and attribute.attnum > 0 and not attribute.attisdropped;
    if expected_attnum is null
      or index_row.indkey[key_position - 1] is distinct from expected_attnum then
      return 'invalid';
    end if;
  end loop;

  if (p_purpose = 'uniqueness') <> index_row.indisunique then
    return 'invalid';
  end if;
  if p_purpose = 'uniqueness' then
    if index_row.indpred is null then
      return 'invalid';
    end if;
  else
    sort_position := pg_catalog.cardinality(expected_columns) - 1;
    select attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      into text_column
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = table_relation and attribute.attname = p_column_token;
    if index_row.indpred is null
      or pg_catalog.pg_get_expr(index_row.indpred, table_relation)
        is distinct from '(lifecycle_state = ''active''::text)'
      or (index_row.indoption[sort_position - 1]::integer & 2) <> 2
      or (index_row.indoption[sort_position - 1]::integer & 1) <> 0
      or index_row.indoption[sort_position]::integer <> 0
      or (text_column and index_row.indcollation[sort_position - 1]
        is distinct from 'pg_catalog."C"'::pg_catalog.regcollation) then
      return 'invalid';
    end if;
  end if;

  return 'present';
end
$_$;
alter function vortex_record.observe_field_index_internal(text,text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Physical observation of one exact field index: missing, invalid or present from the live catalogs, never raising.';

REVOKE ALL ON FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  index_token text;
  canonical_scope_columns text;
  definition_fingerprint text;
  observed text;
  text_column boolean;
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
    select attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      into text_column
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format('record_data.%I', p_table_token)
    ) and attribute.attname = p_column_token and attribute.attnum > 0
      and not attribute.attisdropped;
    if text_column is null then
      raise exception using errcode = '55000', message = 'Record field index column is missing';
    end if;
    execute pg_catalog.format(
      'create index if not exists %I on record_data.%I (%s, %I%s asc nulls first, record_id asc) where lifecycle_state = ''active''',
      index_token, p_table_token, p_scope_index_columns, p_column_token,
      case when text_column then ' collate "C"' else '' end
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
alter function vortex_record.ensure_field_index_internal(uuid,uuid,text,text,text,text,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) IS 'Private provisioner helper: creates one exact field index and records its desired definition and observed readiness for one storage contract and field.';

REVOKE ALL ON FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) FROM PUBLIC;

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

create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  projection_expression_pair record;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  stored_projection_role text;
  requested_projection_role text;
  stored_database_type text;
  requested_database_type text;
  stored_sql_type text;
  requested_sql_type text;
  stored_expression jsonb;
  requested_expression jsonb;
  shape_fingerprint text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
  is_projection boolean;
  protected_view_key text;
  reader_schema_value text;
  reader_function_value text;
  field_columns_sql text;
  projection_view_sql text;
  existing_columns text[];
  expected_columns text[];
begin
  if not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array'
    or pg_catalog.jsonb_array_length(record_types) < 1 then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision;
    if result_storage_ids is distinct from (
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    if (
      select pg_catalog.count(*) > 8
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field_item(value)
      where field_item.value ->> 'sortable' = 'true'
    ) then
      raise exception using errcode = '23514',
        message = 'A record type may declare at most eight sortable fields';
    end if;
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    -- A system projection record type has no generated storage. It is read
    -- through one registered protected view, created here as an ordinary
    -- record_data relation so the fixed read adapters resolve it unchanged,
    -- while the projection itself keeps every row-visibility rule inside the
    -- registered function. The view exposes exactly the record type's declared
    -- fields as record-data columns, plus the protected row identity and
    -- revision, and is read-only: the projection has no ordinary write path.
    -- Every projection value is reset per record type, so a generated record
    -- type provisioned after a projection never inherits its protected key.
    is_projection := record_type ? 'systemProjection';
    protected_view_key := null;
    reader_schema_value := null;
    reader_function_value := null;
    projection_view_sql := null;
    if is_projection then
      protected_view_key := record_type #>> '{systemProjection,protectedView}';
      select registered.reader_schema, registered.reader_function
      into reader_schema_value, reader_function_value
      from vortex_record.protected_read_model_views as registered
      where registered.protected_read_model_key = protected_view_key;
      if not found then
        raise exception using errcode = '42501',
          message = 'Protected projection view is unavailable';
      end if;
      if storage_scope_value <> 'organization_shared' then
        raise exception using errcode = '42501',
          message = 'Protected projection storage must be organisation shared';
      end if;
      field_columns_sql := '';
      expected_columns := array[]::text[];
      for field_value in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
        order by item.value ->> 'fieldId'
      loop
        begin
          field_id_value := (field_value ->> 'fieldId')::uuid;
        exception when invalid_text_representation then
          raise exception using errcode = '42501',
            message = 'Record field storage identity is invalid';
        end;
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        database_type := vortex_record.database_value_type(field_value);
        if database_type is null then
          raise exception using errcode = '23514',
            message = 'Record field storage type is unsupported';
        end if;
        sql_type := vortex_record.sql_value_type(database_type);
        expected_columns := expected_columns || column_token;
        if field_value ->> 'fieldId' = record_type #>> '{systemProjection,organizationFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.organization_id::text as %I, ', column_token);
        elsif field_value ->> 'fieldId' = record_type #>> '{systemProjection,revisionFieldId}' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format('projection.revision::%s as %I, ', sql_type, column_token);
        elsif database_type = 'json' then
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values -> %L) as %I, ', field_value ->> 'key', column_token
            );
        else
          field_columns_sql := field_columns_sql
            || pg_catalog.format(
              '(projection.attribute_values ->> %L)::%s as %I, ',
              field_value ->> 'key', sql_type, column_token
            );
        end if;
      end loop;
      select pg_catalog.array_agg(item.column_name order by item.column_name)
      into expected_columns
      from pg_catalog.unnest(expected_columns) as item(column_name);
      field_columns_sql := pg_catalog.left(
        field_columns_sql, pg_catalog.length(field_columns_sql) - 2
      );
      projection_view_sql := pg_catalog.format(
        'create view record_data.%I as select
           projection.organization_id as organisation_id,
           %L::uuid as module_root_id,
           %L::uuid as record_type_id,
           %L::uuid as storage_contract_id,
           projection.record_id,
           null::uuid as application_root_id,
           %L::bigint as definition_revision,
           null::uuid as owner_organisation_account_id,
           null::uuid as owner_group_id,
           ''active''::text as lifecycle_state,
           projection.revision as concurrency_number,
           null::timestamptz as created_at,
           null::uuid as created_by,
           null::timestamptz as updated_at,
           null::uuid as updated_by,
           null::timestamptz as deleted_at,
           null::uuid as deleted_by,
           null::timestamptz as removal_due_at,
           %s
         from %I.%I(null::uuid, null::integer) as projection',
        table_token, p_module_root_id, record_type_id_value, storage_id,
        p_module_release_revision, field_columns_sql,
        reader_schema_value, reader_function_value
      );
    end if;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      if is_projection then
        execute projection_view_sql;
        execute pg_catalog.format(
          'grant select on record_data.%I to vortex_record_adapter', table_token
        );
      else
        perform vortex_record.create_record_storage_table_internal(
          storage_id, p_module_root_id, record_type_id_value,
          storage_scope_value, ownership_mode_value
        );
      end if;

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, content_fingerprint, record_type_definition, protected_read_model_key
      ) values (
        storage_id,
        case when is_projection then 'system_projection' else 'record_data' end,
        table_token, p_module_root_id, record_type_id_value, storage_scope_value,
        p_module_release_revision, p_module_release_revision, 'active',
        shape_fingerprint, record_type, protected_view_key
      );
      any_change := true;
    else
      if is_projection then
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'system_projection'
          or stored_catalogue.protected_read_model_key is distinct from protected_view_key
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
        if pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition) is distinct from 'object'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'fields') is distinct from 'array'
          or pg_catalog.jsonb_typeof(stored_catalogue.record_type_definition -> 'systemProjection') is distinct from 'object'
          or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object' then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;

        -- The catalogue keeps the newest compatible exact definition. Compare
        -- only shared field identities so an older subset and newer additions
        -- retain their existing release-order behavior. These descriptors
        -- mirror the source expressions assembled above, including the
        -- protected attribute key, JSON/text extraction, and cast.
        for projection_expression_pair in
          select requested_item.value as requested_field,
            stored_item.value as stored_field
          from pg_catalog.jsonb_array_elements(record_type -> 'fields') as requested_item(value)
          join pg_catalog.jsonb_array_elements(
            stored_catalogue.record_type_definition -> 'fields'
          ) as stored_item(value)
            on stored_item.value ->> 'fieldId' = requested_item.value ->> 'fieldId'
          order by requested_item.value ->> 'fieldId'
        loop
          stored_projection_role := case
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.stored_field ->> 'fieldId'
              = stored_catalogue.record_type_definition #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          requested_projection_role := case
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,organizationFieldId}'
              then 'organization'
            when projection_expression_pair.requested_field ->> 'fieldId'
              = record_type #>> '{systemProjection,revisionFieldId}'
              then 'revision'
            else 'attribute'
          end;
          stored_database_type := vortex_record.database_value_type(
            projection_expression_pair.stored_field
          );
          requested_database_type := vortex_record.database_value_type(
            projection_expression_pair.requested_field
          );
          if stored_projection_role is distinct from requested_projection_role
            or stored_database_type is null
            or requested_database_type is null then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
          stored_sql_type := vortex_record.sql_value_type(stored_database_type);
          requested_sql_type := vortex_record.sql_value_type(requested_database_type);
          stored_expression := case stored_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.revision',
              'cast', stored_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', stored_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.stored_field ->> 'key',
              'extraction', case when stored_database_type = 'json' then '->' else '->>' end,
              'cast', case when stored_database_type = 'json' then null else stored_sql_type end
            )
          end;
          requested_expression := case requested_projection_role
            when 'organization' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.organization_id',
              'cast', 'text'
            )
            when 'revision' then pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.revision',
              'cast', requested_sql_type
            )
            else pg_catalog.jsonb_build_object(
              'role', requested_projection_role,
              'source', 'projection.attribute_values',
              'key', projection_expression_pair.requested_field ->> 'key',
              'extraction', case when requested_database_type = 'json' then '->' else '->>' end,
              'cast', case when requested_database_type = 'json' then null else requested_sql_type end
            )
          end;
          if stored_expression is distinct from requested_expression then
            raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
          end if;
        end loop;

        select coalesce(
            pg_catalog.array_agg(attribute.attname order by attribute.attname),
            array[]::text[]
          )
        into existing_columns
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('%I.%I', 'record_data', table_token)
          )
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attname like 'f\_%';
        -- The view always carries the newest compatible release's shape, as a
        -- generated table keeps every column a newer release added. A newer
        -- release, or the newest one with a different field set, recreates it
        -- exactly; an older release, which the field checks below prove is a
        -- compatible subset, leaves the newer view alone. The projection has no
        -- indexes or dependent objects.
        if p_module_release_revision > stored_catalogue.last_compatible_release_revision
          or (p_module_release_revision = stored_catalogue.last_compatible_release_revision
            and existing_columns is distinct from expected_columns) then
          execute pg_catalog.format('drop view record_data.%I', table_token);
          execute projection_view_sql;
          execute pg_catalog.format(
            'grant select on record_data.%I to vortex_record_adapter', table_token
          );
          any_change := true;
        end if;
      else
        if stored_catalogue.module_root_id <> p_module_root_id
          or stored_catalogue.record_type_id <> record_type_id_value
          or stored_catalogue.storage_scope <> storage_scope_value
          or stored_catalogue.state <> 'active'
          or stored_catalogue.physical_schema_token <> 'record_data'
          or stored_catalogue.physical_table_token <> table_token
          or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
          raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
        end if;
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if not is_projection then
          if stored_catalogue.storage_contract_id is not null
            and (field_value ->> 'required')::boolean then
            raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
          end if;
          execute pg_catalog.format(
            'alter table record_data.%I add column %I %s%s',
            table_token, column_token, sql_type,
            case when (field_value ->> 'required')::boolean then ' not null' else '' end
          );
        end if;
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        -- A projection field lives in the protected view, which carries no
        -- indexes; the projection's own protected function applies visibility,
        -- ordering and filtering, so no generated index is provisioned.
        if is_projection then
          null;
        elsif (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    -- Only a field this Module itself introduced can prove a removed field. A
    -- field another Module contributed keeps its retained lineage and never
    -- refuses this Module's own storage.
    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_by_module_root_id = p_module_root_id
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  select pg_catalog.array_agg(value order by value) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

alter function vortex_record.provision_exact_module_storage(uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_exact_module_storage(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_exact_module_storage(uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_exact_module_storage(uuid, bigint) is
  'Private exact-release Module storage provisioner: creates or evolves the generated record_data storage, or the read-only record_data view over one registered protected projection reader for a system projection record type, for one published Module release and records its immutable provision evidence.';

do $migration$
declare
  item record;
begin
  for item in
    select catalogue.physical_index_token, catalogue.storage_contract_id,
      catalogue.field_id, storage.storage_scope, storage.physical_table_token,
      mapping.physical_column_token
    from vortex_record.index_catalogue as catalogue
    join vortex_record.storage_catalogue as storage
      on storage.storage_contract_id = catalogue.storage_contract_id
    join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = catalogue.storage_contract_id
      and mapping.field_id = catalogue.field_id
    where catalogue.purpose = 'performance' and storage.state = 'active'
      and mapping.state = 'active'
    order by catalogue.storage_contract_id, catalogue.field_id
  loop
    execute pg_catalog.format('drop index if exists record_data.%I', item.physical_index_token);
    perform vortex_record.ensure_field_index_internal(
      item.storage_contract_id, item.field_id, 'performance', item.storage_scope,
      item.physical_table_token, vortex_record.index_scope_columns(item.storage_scope),
      item.physical_column_token
    );
  end loop;
end
 $migration$;

reset role;
