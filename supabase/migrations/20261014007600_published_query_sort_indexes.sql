set local role vortex_owner;

alter table vortex_record.index_catalogue
  add column sort_shape jsonb;
alter table vortex_record.index_catalogue
  drop constraint index_catalogue_storage_contract_id_field_id_key,
  drop constraint index_catalogue_check,
  drop constraint index_catalogue_physical_index_token_check,
  drop constraint index_catalogue_purpose_check;
alter table vortex_record.index_catalogue
  add constraint index_catalogue_purpose_check
    check (purpose in ('uniqueness', 'performance', 'published_sort', 'published_sort_drop')),
  add constraint index_catalogue_physical_index_token_check
    check (physical_index_token ~ '^(ux|ix|is)_[a-f0-9]{32}$'),
  add constraint index_catalogue_shape_check check (
    (purpose in ('uniqueness', 'performance') and sort_shape is null)
    or (purpose in ('published_sort', 'published_sort_drop')
      and pg_catalog.jsonb_typeof(sort_shape) = 'array')
  ),
  add constraint index_catalogue_check check (
    (purpose = 'uniqueness' and physical_index_token =
      'ux_' || pg_catalog.replace(pg_catalog.lower(field_id::text), '-', ''))
    or (purpose = 'performance' and physical_index_token =
      'ix_' || pg_catalog.replace(pg_catalog.lower(field_id::text), '-', ''))
    or (purpose in ('published_sort', 'published_sort_drop') and physical_index_token =
      'is_' || pg_catalog.md5(storage_contract_id::text || ':' || sort_shape::text))
  );
create unique index index_catalogue_field_unique
  on vortex_record.index_catalogue (storage_contract_id, field_id)
  where purpose in ('uniqueness', 'performance');
create unique index index_catalogue_sort_unique
  on vortex_record.index_catalogue (storage_contract_id, sort_shape)
  where purpose in ('published_sort', 'published_sort_drop');

create or replace function vortex_record.published_sort_index_definition_internal(
  p_storage_contract_id uuid, p_sort jsonb
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  storage_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  sort_item jsonb;
  scope_columns text;
  key_columns text[];
  key_names text[];
  key_directions text[];
  field_ids uuid[] := array[]::uuid[];
  direction_value text;
  token text;
  relation_id oid;
  index_id oid;
  index_row pg_catalog.pg_index%rowtype;
  attribute_number smallint;
  position_value integer;
  expected_option integer;
  observed text := 'present';
  definition_value jsonb;
begin
  if p_sort is null or pg_catalog.jsonb_typeof(p_sort) <> 'array'
    or pg_catalog.jsonb_array_length(p_sort) < 2 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  select storage.* into storage_row
  from vortex_record.storage_catalogue as storage
  where storage.storage_contract_id = p_storage_contract_id
    and storage.state = 'active' and storage.physical_schema_token = 'record_data'
    and not (storage.record_type_definition ? 'systemProjection');
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'storage_contract_unavailable');
  end if;
  scope_columns := vortex_record.index_scope_columns(storage_row.storage_scope);
  if scope_columns is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'storage_contract_unavailable');
  end if;
  key_names := pg_catalog.string_to_array(scope_columns, ', ');
  key_columns := key_names;
  key_directions := pg_catalog.array_fill('ascending'::text, array[pg_catalog.cardinality(key_names)]);
  for sort_item in select item.value from pg_catalog.jsonb_array_elements(p_sort) as item(value)
  loop
    if pg_catalog.jsonb_typeof(sort_item) <> 'object'
      or sort_item - array['fieldId', 'direction']::text[] <> '{}'::jsonb
      or not pg_catalog.pg_input_is_valid(sort_item ->> 'fieldId', 'uuid')
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or (sort_item ->> 'fieldId')::uuid = any (field_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.field_id = (sort_item ->> 'fieldId')::uuid
      and mapping.state = 'active';
    if not found or mapping_row.database_value_type not in
      ('integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    field_ids := pg_catalog.array_append(field_ids, mapping_row.field_id);
    direction_value := sort_item ->> 'direction';
    key_names := pg_catalog.array_append(key_names, mapping_row.physical_column_token);
    key_directions := pg_catalog.array_append(key_directions, direction_value);
    key_columns := pg_catalog.array_append(key_columns,
      pg_catalog.format('%I%s %s nulls %s', mapping_row.physical_column_token,
        case when mapping_row.database_value_type = 'text' then ' collate "C"' else '' end,
        case when direction_value = 'ascending' then 'asc' else 'desc' end,
        case when direction_value = 'ascending' then 'first' else 'last' end));
  end loop;
  direction_value := p_sort -> -1 ->> 'direction';
  key_names := pg_catalog.array_append(key_names, 'record_id');
  key_directions := pg_catalog.array_append(key_directions, direction_value);
  key_columns := pg_catalog.array_append(key_columns,
    'record_id ' || case when direction_value = 'ascending'
      then 'asc' else 'desc nulls last' end);
  token := 'is_' || pg_catalog.md5(p_storage_contract_id::text || ':' || p_sort::text);
  definition_value := pg_catalog.jsonb_build_object(
    'table', storage_row.physical_table_token, 'scope', scope_columns,
    'columns', key_columns, 'predicate', 'lifecycle_state = active');
  relation_id := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', storage_row.physical_table_token));
  index_id := pg_catalog.to_regclass(pg_catalog.format('record_data.%I', token));
  if relation_id is null then
    observed := 'invalid';
  elsif index_id is null then
    observed := 'missing';
  else
    select index_value.* into index_row from pg_catalog.pg_index as index_value
    where index_value.indexrelid = index_id;
    if not found or index_row.indrelid <> relation_id or not index_row.indisvalid
      or index_row.indisunique or index_row.indnkeyatts <> pg_catalog.cardinality(key_names)
      or pg_catalog.pg_get_expr(index_row.indpred, relation_id)
        is distinct from '(lifecycle_state = ''active''::text)' then
      observed := 'invalid';
    else
      for position_value in 1 .. pg_catalog.cardinality(key_names) loop
        select attribute.attnum into attribute_number
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = relation_id and attribute.attname = key_names[position_value]
          and attribute.attnum > 0 and not attribute.attisdropped;
        expected_option := case when key_directions[position_value] = 'descending' then 1 else 0 end
          + case when position_value > pg_catalog.cardinality(pg_catalog.string_to_array(scope_columns, ', '))
            and position_value <= pg_catalog.cardinality(key_names) - 1
            and key_directions[position_value] = 'ascending' then 2 else 0 end;
        if attribute_number is null
          or index_row.indkey[position_value - 1] <> attribute_number
          or index_row.indoption[position_value - 1]::integer <> expected_option
          or (position_value > pg_catalog.cardinality(pg_catalog.string_to_array(scope_columns, ', '))
            and position_value <= pg_catalog.cardinality(key_names) - 1
            and key_columns[position_value] like '%collate "C"%'
            and index_row.indcollation[position_value - 1]
              is distinct from 'pg_catalog."C"'::pg_catalog.regcollation) then
          observed := 'invalid';
          exit;
        end if;
      end loop;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'valid', 'indexToken', token,
    'fingerprint', 'sha256:' || pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(definition_value::text, 'UTF8'), 'sha256'), 'hex'),
    'observedState', observed,
    'createStatement', pg_catalog.format(
      'create index concurrently %I on record_data.%I (%s) where lifecycle_state = ''active''',
      token, storage_row.physical_table_token, pg_catalog.array_to_string(key_columns, ', '))
  );
end
$function$;
alter function vortex_record.published_sort_index_definition_internal(uuid,jsonb) owner to vortex_owner;
revoke all on function vortex_record.published_sort_index_definition_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.published_sort_index_definition_internal(uuid,jsonb) to vortex_owner;

create or replace function vortex_record.sync_published_sort_indexes_internal()
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  candidate record;
  definition_value jsonb;
  selected_ids uuid[] := array[]::uuid[];
  skipped jsonb := '[]'::jsonb;
  current_storage uuid;
  shape_count integer := 0;
  index_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex_record.published_sort_indexes', 0));
  -- A Query can be installed by more than one application. Choose from the
  -- complete active binding set, not from one caller's release in isolation.
  for candidate in
    with requested as (
      select storage.storage_contract_id,
        query_item.value -> 'sort' as sort_shape,
        binding.module_root_id, query_item.value ->> 'queryId' as query_id
      from vortex_definition.installation_bindings as binding
      join vortex_definition.releases as release
        on release.root_id = binding.module_root_id
        and release.release_revision = binding.module_release_revision
      cross join lateral pg_catalog.jsonb_array_elements(
        release.compilation_output #> '{canonical,content,queries}') as query_item(value)
      join vortex_record.storage_catalogue as storage
        on storage.module_root_id = (query_item.value #>> '{recordType,moduleRootId}')::uuid
        and storage.record_type_id = (query_item.value #>> '{recordType,recordTypeId}')::uuid
        and storage.state = 'active' and storage.physical_schema_token = 'record_data'
      where binding.state = 'active'
        and query_item.value #>> '{recordType,state}' = 'resolved'
        and pg_catalog.jsonb_typeof(query_item.value -> 'sort') = 'array'
        and pg_catalog.jsonb_array_length(query_item.value -> 'sort') >= 2
    ), distinct_shapes as (
      select storage_contract_id, sort_shape,
        min(module_root_id::text || ':' || query_id) as first_query
      from requested group by storage_contract_id, sort_shape
    )
    select * from distinct_shapes
    order by storage_contract_id, first_query, sort_shape::text
  loop
    if current_storage is distinct from candidate.storage_contract_id then
      current_storage := candidate.storage_contract_id;
      shape_count := 0;
    end if;
    shape_count := shape_count + 1;
    if shape_count > 4 then
      skipped := skipped || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', candidate.storage_contract_id,
        'sort', candidate.sort_shape, 'firstQuery', candidate.first_query,
        'reasonCode', 'published_sort_index_budget_exceeded'));
      continue;
    end if;
    definition_value := vortex_record.published_sort_index_definition_internal(
      candidate.storage_contract_id, candidate.sort_shape);
    if definition_value ->> 'outcome' <> 'valid' then
      skipped := skipped || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', candidate.storage_contract_id,
        'sort', candidate.sort_shape, 'firstQuery', candidate.first_query,
        'reasonCode', definition_value ->> 'reasonCode'));
      continue;
    end if;
    index_id := pg_catalog.md5(
      candidate.storage_contract_id::text || ':' || candidate.sort_shape::text)::uuid;
    selected_ids := pg_catalog.array_append(selected_ids, index_id);
    insert into vortex_record.index_catalogue (
      index_contract_id, storage_contract_id, field_id, purpose, sort_shape,
      physical_index_token, desired_definition_fingerprint, observed_state, observed_revision
    ) values (
      index_id, candidate.storage_contract_id,
      (candidate.sort_shape -> 0 ->> 'fieldId')::uuid, 'published_sort',
      candidate.sort_shape, definition_value ->> 'indexToken',
      definition_value ->> 'fingerprint', definition_value ->> 'observedState', 1
    )
    on conflict (index_contract_id) do update
    set purpose = excluded.purpose,
      sort_shape = excluded.sort_shape,
      physical_index_token = excluded.physical_index_token,
      desired_definition_fingerprint = excluded.desired_definition_fingerprint,
      observed_state = excluded.observed_state,
      observed_revision = vortex_record.index_catalogue.observed_revision + 1,
      claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      changed_at = pg_catalog.statement_timestamp()
    where vortex_record.index_catalogue.purpose is distinct from excluded.purpose
      or vortex_record.index_catalogue.sort_shape is distinct from excluded.sort_shape
      or vortex_record.index_catalogue.desired_definition_fingerprint
        is distinct from excluded.desired_definition_fingerprint
      or (vortex_record.index_catalogue.observed_state is distinct from excluded.observed_state
        and (vortex_record.index_catalogue.claim_id is null
          or vortex_record.index_catalogue.lease_expires_at <= pg_catalog.statement_timestamp()));
  end loop;

  update vortex_record.index_catalogue as catalogue
  set purpose = 'published_sort_drop', observed_state = 'missing',
    observed_revision = catalogue.observed_revision + 1,
    claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
    changed_at = pg_catalog.statement_timestamp()
  where catalogue.purpose = 'published_sort'
    and not (catalogue.index_contract_id = any (selected_ids));
  if skipped <> '[]'::jsonb then
    raise log 'Published Query sort indexes skipped: %', skipped;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'synchronized', 'skippedSorts', skipped,
    'selectedCount', pg_catalog.cardinality(selected_ids));
end
$function$;
alter function vortex_record.sync_published_sort_indexes_internal() owner to vortex_owner;
revoke all on function vortex_record.sync_published_sort_indexes_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.sync_published_sort_indexes_internal() to vortex_owner;

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
  sortable_unique boolean := false;
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
    select coalesce((mapping.field_definition ->> 'sortable')::boolean, false)
      into sortable_unique
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_storage_contract_id
      and mapping.field_id = p_field_id and mapping.state = 'active';
    if not found then
      raise exception using errcode = '55000', message = 'Record field index mapping is missing';
    end if;
  end if;

  if p_purpose = 'uniqueness' then
    execute pg_catalog.format(
      'create unique index if not exists %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
      index_token, p_table_token, p_scope_index_columns, p_column_token
    );
  end if;
  if p_purpose = 'performance' or sortable_unique then
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
      case when sortable_unique then 'ix_' || pg_catalog.substr(p_column_token, 3)
        else index_token end,
      p_table_token, p_scope_index_columns, p_column_token,
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
  on conflict (storage_contract_id, field_id)
    where purpose in ('uniqueness', 'performance') do update
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

CREATE OR REPLACE FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_id uuid;
  catalogue_purpose text;
  catalogue_token text;
  catalogue_fingerprint text;
  catalogue_observed text;
  catalogue_revision bigint;
  ready boolean;
  target_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index readiness command is invalid';
  end if;

  -- The same protected activation target fact the lifecycle-policy readiness
  -- read uses; the organisation is re-derived from the validated human request
  -- context inside it and is never taken from the caller.
  select pg_catalog.array_agg(distinct targets.storage_contract_id)
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  if target_storage_contract_ids is null
    or pg_catalog.cardinality(target_storage_contract_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Index activation targets are incomplete';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    for mapping in
      select stored.field_id, stored.physical_column_token, stored.field_definition
      from vortex_record.field_storage_mappings as stored
      where stored.storage_contract_id = target.storage_contract_id
        and stored.state = 'active'
        and (
          coalesce((stored.field_definition ->> 'unique')::boolean, false)
          or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
          or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
        )
      order by stored.field_id
    loop
      purpose := case
        when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
          then 'uniqueness'
        else 'performance'
      end;
      scope_columns := vortex_record.index_scope_columns(target.storage_scope);
      index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping.physical_column_token, 3);
      definition_fingerprint := vortex_record.index_definition_fingerprint(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );
      observed := vortex_record.observe_field_index_internal(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );

      select stored_index.index_contract_id, stored_index.purpose,
        stored_index.physical_index_token, stored_index.desired_definition_fingerprint,
        stored_index.observed_state, stored_index.observed_revision
      into catalogue_id, catalogue_purpose, catalogue_token, catalogue_fingerprint,
        catalogue_observed, catalogue_revision
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
        and stored_index.purpose in ('uniqueness', 'performance')
      for share;

      ready := observed = 'present'
        and catalogue_id is not null
        and catalogue_purpose = purpose
        and catalogue_token = index_token
        and catalogue_fingerprint = definition_fingerprint;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'observedState', observed,
        'recordedObservedState', catalogue_observed,
        'observedRevision', catalogue_revision,
        'ready', ready
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never an
  -- implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$$;
alter function vortex_record.read_index_readiness(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Live readiness of every exact field index an activating Application installation owns: uniqueness indexes are activation requirements, performance indexes are advisory.';

REVOKE ALL ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;

CREATE OR REPLACE FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  authority jsonb;
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_row vortex_record.index_catalogue%rowtype;
  index_state text;
  ready boolean;
  lease_active boolean;
  conflict_outcome jsonb;
  conflict_value jsonb;
  target_count integer := 0;
  index_count integer := 0;
  ready_count integer := 0;
  pending_count integer := 0;
  running_count integer := 0;
  interrupted_count integer := 0;
  conflicting_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = nil_uuid
    or p_application_root_id is null
    or p_application_root_id = nil_uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index status command is invalid';
  end if;

  authority := vortex_record.authorize_index_status_internal(
    p_organization_id, p_application_root_id
  );

  -- The same protected active-installation target fact `read_index_readiness`
  -- uses; the organisation is re-derived from the validated request context
  -- inside it and the supplied value must match it.
  select pg_catalog.array_agg(distinct targets.storage_contract_id)
    into target_storage_contract_ids
  from vortex_definition.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  if target_storage_contract_ids is null
    or pg_catalog.cardinality(target_storage_contract_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Index status activation targets are incomplete';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token, catalogue.record_type_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    for mapping in
      select stored.field_id, stored.physical_column_token, stored.field_definition
      from vortex_record.field_storage_mappings as stored
      where stored.storage_contract_id = target.storage_contract_id
        and stored.state = 'active'
        and (
          coalesce((stored.field_definition ->> 'unique')::boolean, false)
          or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
          or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
        )
      order by stored.field_id
    loop
      index_count := index_count + 1;

      purpose := case
        when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
          then 'uniqueness'
        else 'performance'
      end;
      scope_columns := vortex_record.index_scope_columns(target.storage_scope);
      index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping.physical_column_token, 3);
      definition_fingerprint := vortex_record.index_definition_fingerprint(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );
      observed := vortex_record.observe_field_index_internal(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );

      select stored_index.* into catalogue_row
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
        and stored_index.purpose in ('uniqueness', 'performance')
      for share;

      ready := observed = 'present'
        and catalogue_row.index_contract_id is not null
        and catalogue_row.purpose = purpose
        and catalogue_row.physical_index_token = index_token
        and catalogue_row.desired_definition_fingerprint = definition_fingerprint;

      -- A lease that has not expired is an active build. An expired lease or
      -- an invalid physical index is an interrupted build awaiting a later
      -- claim. Neither is ever projected as ready.
      lease_active := catalogue_row.index_contract_id is not null
        and catalogue_row.claim_id is not null
        and catalogue_row.lease_expires_at > pg_catalog.statement_timestamp();

      -- Only a uniqueness index that is neither ready nor actively building
      -- can be blocked by its own data. The conflict search is only attempted
      -- then, and its exact outcome decides the state.
      conflict_outcome := null;
      conflict_value := null;
      if not ready and not lease_active and purpose = 'uniqueness' then
        conflict_outcome := vortex_record.read_index_conflict_references_internal(
          target.record_type_id, target.physical_table_token, scope_columns,
          mapping.physical_column_token
        );
      end if;

      if ready then
        index_state := 'ready';
        ready_count := ready_count + 1;
      elsif lease_active then
        index_state := 'running';
        running_count := running_count + 1;
      elsif conflict_outcome is not null and conflict_outcome ->> 'outcome' <> 'none' then
        index_state := 'conflicting';
        conflicting_count := conflicting_count + 1;
        conflict_value := case conflict_outcome ->> 'outcome'
          when 'unreadable' then pg_catalog.jsonb_build_object('state', 'unreadable')
          else pg_catalog.jsonb_build_object(
            'state', 'readable',
            'records', coalesce(conflict_outcome -> 'records', '[]'::jsonb)
          )
        end;
      elsif observed = 'invalid' or catalogue_row.claim_id is not null then
        index_state := 'interrupted';
        interrupted_count := interrupted_count + 1;
      else
        index_state := 'pending';
        pending_count := pending_count + 1;
      end if;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_row.index_contract_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'state', index_state,
        'observedState', observed,
        'recordedObservedState', catalogue_row.observed_state,
        'observedRevision', catalogue_row.observed_revision,
        'ready', ready,
        'failureCode', case index_state
          when 'interrupted' then 'build_interrupted'
          when 'conflicting' then 'uniqueness_conflict'
          else null
        end,
        'conflict', conflict_value
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never
  -- an implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index status activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', authority ->> 'organizationId',
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'progress', pg_catalog.jsonb_build_object(
      'total', index_count,
      'ready', ready_count,
      'pending', pending_count,
      'running', running_count,
      'interrupted', interrupted_count,
      'conflicting', conflicting_count
    ),
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$$;
alter function vortex_record.read_application_index_status(uuid,uuid,bigint,jsonb) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) IS 'Protected live status of every exact field index one active Application installation owns: pending, running, ready, interrupted or conflicting, with bounded progress and no physical detail.';

REVOKE ALL ON FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) TO vortex_request;

drop function vortex_record.index_build_statements_internal(uuid,uuid);

CREATE OR REPLACE FUNCTION vortex_record.index_build_statements_internal(p_index_contract_id uuid) RETURNS jsonb
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
  sortable_only boolean := false;
  target_index_token text;
  sort_definition jsonb;
  create_statement text;
  statements jsonb := '[]'::jsonb;
begin
  select catalogue.* into catalogue_row
  from vortex_record.index_catalogue as catalogue
  where catalogue.index_contract_id = p_index_contract_id;
  if catalogue_row.index_contract_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_unknown'
    );
  end if;

  select storage.* into storage_row
  from vortex_record.storage_catalogue as storage
  where storage.storage_contract_id = catalogue_row.storage_contract_id;
  if storage_row.storage_contract_id is null
    or storage_row.state <> 'active'
    or storage_row.physical_schema_token <> 'record_data' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
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

  if catalogue_row.purpose in ('published_sort', 'published_sort_drop') then
    sort_definition := vortex_record.published_sort_index_definition_internal(
      catalogue_row.storage_contract_id, catalogue_row.sort_shape);
    if sort_definition ->> 'outcome' <> 'valid'
      or catalogue_row.physical_index_token is distinct from sort_definition ->> 'indexToken'
      or catalogue_row.desired_definition_fingerprint
        is distinct from sort_definition ->> 'fingerprint' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'index_definition_drifted');
    end if;
    observed := sort_definition ->> 'observedState';
    if (catalogue_row.purpose = 'published_sort' and observed = 'present')
      or (catalogue_row.purpose = 'published_sort_drop' and observed = 'missing') then
      return pg_catalog.jsonb_build_object('outcome', 'settled');
    end if;
    expected_fingerprint := sort_definition ->> 'fingerprint';
    target_index_token := sort_definition ->> 'indexToken';
    create_statement := sort_definition ->> 'createStatement';
  else
  select stored.* into mapping_row
  from vortex_record.field_storage_mappings as stored
  where stored.storage_contract_id = catalogue_row.storage_contract_id
    and stored.field_id = catalogue_row.field_id;
  if mapping_row.storage_contract_id is null or mapping_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_unavailable'
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
  sortable_only := catalogue_row.purpose = 'uniqueness'
    and coalesce((mapping_row.field_definition ->> 'sortable')::boolean, false)
    and vortex_record.observe_field_index_internal(
      'uniqueness_base', storage_row.physical_table_token, scope_columns,
      mapping_row.physical_column_token
    ) = 'present';
  target_index_token := case when sortable_only
    then 'ix_' || pg_catalog.substr(mapping_row.physical_column_token, 3)
    else catalogue_row.physical_index_token end;
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
    pg_catalog.format('record_data.%I', target_index_token)
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
        target_index_token
      )
    );
  end if;

  if catalogue_row.purpose <> 'published_sort_drop' then
  statements := statements || pg_catalog.jsonb_build_array(
    case when catalogue_row.purpose = 'published_sort' then create_statement else
    case catalogue_row.purpose
      when 'uniqueness' then case when not sortable_only then pg_catalog.format(
        'create unique index concurrently %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
        catalogue_row.physical_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token
      ) else pg_catalog.format(
        'create index concurrently %I on record_data.%I (%s, %I%s asc nulls first, record_id asc) where lifecycle_state = ''active''',
        target_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token,
        case when mapping_row.database_value_type = 'text' then ' collate "C"' else '' end
      ) end
      else pg_catalog.format(
        'create index concurrently %I on record_data.%I (%s, %I%s asc nulls first, record_id asc) where lifecycle_state = ''active''',
        catalogue_row.physical_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token,
        case when mapping_row.database_value_type = 'text' then ' collate "C"' else '' end
      )
    end end
  );
  end if;

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
alter function vortex_record.index_build_statements_internal(uuid) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.index_build_statements_internal(p_index_contract_id uuid) IS 'Private derivation of the ordered drop/create statements one catalogue row needs; never granted above vortex_owner.';

REVOKE ALL ON FUNCTION vortex_record.index_build_statements_internal(p_index_contract_id uuid) FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) RETURNS jsonb
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
  sort_definition jsonb;
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
  order by (catalogue.claim_id = p_claim_id) desc nulls last, catalogue.index_contract_id
  limit 1
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

  if catalogue_row.purpose in ('published_sort', 'published_sort_drop') then
    sort_definition := vortex_record.published_sort_index_definition_internal(
      p_storage_contract_id, catalogue_row.sort_shape);
    if catalogue_row.desired_definition_fingerprint
        is distinct from p_expected_definition_fingerprint
      or sort_definition ->> 'outcome' <> 'valid'
      or sort_definition ->> 'fingerprint' is distinct from p_expected_definition_fingerprint
      or sort_definition ->> 'indexToken' is distinct from catalogue_row.physical_index_token then
      update vortex_record.index_catalogue as catalogue
      set claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null
      where catalogue.index_contract_id = catalogue_row.index_contract_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'desired_definition_changed');
    end if;
    observed := sort_definition ->> 'observedState';
    if catalogue_row.purpose = 'published_sort_drop' and observed = 'missing' then
      delete from vortex_record.index_catalogue as catalogue
      where catalogue.index_contract_id = catalogue_row.index_contract_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'dropped', 'indexContractId', catalogue_row.index_contract_id);
    end if;
    update vortex_record.index_catalogue as catalogue
    set observed_state = observed,
      observed_revision = case when observed is distinct from catalogue_row.observed_state
        then catalogue_row.observed_revision + 1 else catalogue_row.observed_revision end,
      claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      changed_at = pg_catalog.statement_timestamp()
    where catalogue.index_contract_id = catalogue_row.index_contract_id;
    return pg_catalog.jsonb_build_object(
      'outcome', observed, 'indexContractId', catalogue_row.index_contract_id,
      'storageContractId', catalogue_row.storage_contract_id,
      'fieldId', catalogue_row.field_id, 'purpose', catalogue_row.purpose,
      'desiredDefinitionFingerprint', p_expected_definition_fingerprint,
      'observedState', observed);
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
alter function vortex_record.record_index_build_result(uuid,uuid,uuid,text) owner to vortex_owner;


COMMENT ON FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) IS 'Records the observed physical state of a leased index build, marking present only when the live definition matches the claimed fingerprint.';

REVOKE ALL ON FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) FROM PUBLIC;

create or replace function vortex_definition.activate_application_installation(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_definition.installation_bindings%rowtype;
  storage_provision record;
  expected_count integer;
  pin_count integer;
  all_provisioned boolean;
  all_active boolean;
  changed_value boolean;
  binding_evidence jsonb;
  sort_index_status jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Application installation activation command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision
    and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
    and release.compilation_output #>> '{kind}' = 'application'
    and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
    and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'));

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_definition.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  select pg_catalog.bool_and(coalesce(
      binding.state = 'provisioned'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_provisioned, all_active
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  if all_provisioned is null or (not all_provisioned and not all_active)
    or exists (
      select 1 from vortex_definition.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select binding.* into strict locked_binding
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;

    if locked_binding.storage_contract_ids <> storage_provision.storage_contract_ids then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;
  end loop;

  select snapshot.* into permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if not found
    or permission_snapshot.release_revision <> p_application_release_revision
    or permission_snapshot.definition_key <> (
      select root.key from vortex_definition.roots as root
      where root.root_id = p_application_root_id
    )
    or permission_snapshot.release_version <> application_release.release_version
    or permission_snapshot.validation_contract_version <> application_release.validation_contract_version
    or permission_snapshot.content_fingerprint <> application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint <> application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  changed_value := all_provisioned;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_definition.installation_bindings as binding
    set state = 'active', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state = 'provisioned';
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
    end if;
    sort_index_status := vortex_record.sync_published_sort_indexes_internal();
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'active', 'changed', changed_value,
    'sortIndexes', sort_index_status,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Application installation activation command is invalid';
end
$function$;

alter function vortex_definition.activate_application_installation(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.activate_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.activate_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_definition.activate_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic activation of the complete exact Module pin set for one Application release.';

create or replace function vortex_definition.detach_application_installation(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  pin record;
  expected_count integer;
  pin_count integer;
  all_active boolean;
  all_provisioned boolean;
  all_detached boolean;
  changed_value boolean;
  binding_evidence jsonb;
  sort_index_status jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) = 0
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or not item.value ?& array['moduleRootId', 'bindingRevision']
        or item.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
        or (item.value ->> 'moduleRootId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (item.value ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
      group by (item.value ->> 'moduleRootId')::uuid
      having pg_catalog.count(*) <> 1
    )
    or p_expected_module_bindings is distinct from (
      select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'moduleRootId')::uuid)
      from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
    ) then
    raise exception using errcode = '22023',
      message = 'Application installation detach command is invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release on release.root_id = root.root_id
    where root.root_id = p_application_root_id
      and root.organization_id = initial_authority.organization_id
      and root.kind = 'application'
      and release.release_revision = p_application_release_revision
      and release.validation_contract_version = any (vortex_definition.accepted_contract_version('application'))
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' = p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (vortex_definition.accepted_contract_version('application'))
  ) then
    raise exception using errcode = 'P0002',
      message = 'Exact Application release is unavailable';
  end if;

  select pg_catalog.count(*)::integer into pin_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if pin_count = 0 or expected_count <> pin_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_definition.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
    perform 1
    from vortex_definition.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for update;
  end loop;

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  if current_authority.organization_id <> initial_authority.organization_id
    or current_authority.organization_account_id <> initial_authority.organization_account_id
    or current_authority.access_version <> initial_authority.access_version
    or current_authority.correlation_id <> initial_authority.correlation_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  -- Each accepted state must hold for the complete exact set; mixed states are refused.
  select pg_catalog.bool_and(coalesce(
      binding.state = 'active'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'provisioned'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    )),
    pg_catalog.bool_and(coalesce(
      binding.state = 'detached'
      and binding.binding_revision = expected.binding_revision
      and binding.application_release_revision = p_application_release_revision
      and binding.module_release_revision = required.target_release_revision, false
    ))
  into all_active, all_provisioned, all_detached
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  left join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id
  left join lateral (
    select (expected.value ->> 'bindingRevision')::bigint as binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
  ) as expected on true
  ;
  if all_active is null or (not all_active and not all_provisioned and not all_detached)
    or exists (
      select 1 from vortex_definition.installation_bindings as binding
      where binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.state <> 'detached'
        and not exists (
          select 1 from vortex_definition.reachable_module_dependency_edges(
            p_application_root_id, p_application_release_revision
          ) as required
          where required.target_root_id = binding.module_root_id
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Application installation bindings changed or are incomplete';
  end if;

  changed_value := all_active or all_provisioned;
  if changed_value then
    if exists (
      select 1 from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = initial_authority.organization_id
        and binding.application_root_id = p_application_root_id
        and binding.module_root_id = required.target_root_id
      where binding.binding_revision = 9007199254740991
    ) then
      raise exception using errcode = '22003',
        message = 'Application installation binding revision is exhausted';
    end if;
    update vortex_definition.installation_bindings as binding
    set state = 'detached', binding_revision = binding.binding_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = required.target_root_id
      and binding.state in ('active', 'provisioned');
    if not found then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed';
    end if;
    sort_index_status := vortex_record.sync_published_sort_indexes_internal();
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organizationId', binding.organization_id,
    'applicationRootId', binding.application_root_id,
    'moduleRootId', binding.module_root_id,
    'bindingRevision', binding.binding_revision,
    'applicationReleaseRevision', binding.application_release_revision,
    'moduleReleaseRevision', binding.module_release_revision,
    'state', binding.state
  ) order by binding.module_root_id) into binding_evidence
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  ) as required
  join vortex_definition.installation_bindings as binding
    on binding.organization_id = initial_authority.organization_id
    and binding.application_root_id = p_application_root_id
    and binding.module_root_id = required.target_root_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'state', 'detached', 'changed', changed_value,
    'sortIndexes', sort_index_status,
    'moduleBindings', binding_evidence
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application installation evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application installation evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Application installation detach command is invalid';
end
$function$;

alter function vortex_definition.detach_application_installation(uuid,bigint,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.detach_application_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.detach_application_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_definition.detach_application_installation(uuid, bigint, jsonb) is
  'Revision-checked atomic detach of one complete Application Module binding set while retaining storage and records.';

select vortex_record.sync_published_sort_indexes_internal();

set local role vortex_record_adapter;

create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb;
  storage_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  v_storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_exact boolean;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_sql text;
  segment_prefix text;
  prefix_index integer;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  -- Whether each sort key has the aligned field index (stored and sortable or unique).
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  read_row record;
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_record record;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  row_capabilities jsonb;
  capability_rows jsonb[] := array[]::jsonb[];
  page_capabilities jsonb;
  capability_index integer;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  next_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
  board_member_mode boolean := false;
  group_member_mode boolean := false;
  board_member jsonb;
  board_choice_field_id text;
  board_column_kind text;
  board_column_value text;
  board_options jsonb;
  board_option_values text[] := array[]::text[];
  board_option jsonb;
  board_member_matches boolean;
  group_member jsonb;
  group_selector jsonb;
  group_selector_item jsonb;
  group_selector_value jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_candidate_values jsonb;
  group_by_ids text[] := array[]::text[];
  group_key text;
  group_field_type text;
  group_value_valid boolean;
  group_member_matches boolean;
  preview_mode boolean := false;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;

  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;

  -- User-facing sort and search, plus the user filter passed to shared
  -- preparation. The component's declared field sets only narrow user input;
  -- they never supply authority or replace the published query contract.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  board_member_mode := p_user_inputs ? 'boardMember';
  group_member_mode := p_user_inputs ? 'groupMember';
  if board_member_mode and group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds',
      'boardMember', 'groupMember'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if group_member_mode then
    group_member := p_user_inputs -> 'groupMember';
    if pg_catalog.jsonb_typeof(group_member) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if group_member - array['values']::text[] <> '{}'::jsonb
      or not (group_member ? 'values')
      or pg_catalog.jsonb_typeof(group_member -> 'values') is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(group_member -> 'values') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    group_selector := group_member -> 'values';
    for group_selector_item in
      select item.value from pg_catalog.jsonb_array_elements(group_selector) as item(value)
    loop
      if pg_catalog.jsonb_typeof(group_selector_item) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      if group_selector_item - array['fieldId', 'fieldType', 'value']::text[] <> '{}'::jsonb
        or not (group_selector_item ? 'fieldId')
        or not (group_selector_item ? 'fieldType')
        or not (group_selector_item ? 'value')
        or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldId') is distinct from 'string'
        or pg_catalog.lower(group_selector_item ->> 'fieldId') !~ uuid_pattern
        or pg_catalog.lower(group_selector_item ->> 'fieldId') = '00000000-0000-0000-0000-000000000000'
        or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldType') is distinct from 'string'
        or group_selector_item ->> 'fieldType' not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several', 'link_to_person'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      group_key := pg_catalog.lower(group_selector_item ->> 'fieldId');
      if group_selector_types ? group_key then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      group_field_type := group_selector_item ->> 'fieldType';
      group_selector_value := group_selector_item -> 'value';
      group_value_valid := group_selector_value = 'null'::jsonb;
      if not group_value_valid then
        case group_field_type
          when 'text', 'reference_number', 'email_address', 'phone_number', 'web_address' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string';
          when 'choice' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and pg_catalog.length(group_selector_value #>> '{}') between 1 and 120;
          when 'whole_number' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'number'
              and case when pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'numeric') then
                (group_selector_value #>> '{}')::numeric = pg_catalog.trunc((group_selector_value #>> '{}')::numeric)
                and pg_catalog.abs((group_selector_value #>> '{}')::numeric) <= 9007199254740991
              else false end;
          when 'decimal_number' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and group_selector_value #>> '{}' ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$';
          when 'yes_no' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'boolean';
          when 'date' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
              and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'date');
          when 'date_time' then
            group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
              and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
              and pg_catalog.substr(group_selector_value #>> '{}', 12, 2) between '00' and '23'
              and pg_catalog.substr(group_selector_value #>> '{}', 15, 2) between '00' and '59'
              and (pg_catalog.substr(group_selector_value #>> '{}', 17, 1) <> ':'
                or pg_catalog.substr(group_selector_value #>> '{}', 18, 2) between '00' and '59')
              and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'timestamp with time zone');
          when 'link', 'link_to_one_of_several' then
            group_value_valid := case when pg_catalog.jsonb_typeof(group_selector_value) = 'object' then
              group_selector_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
              and group_selector_value ? 'recordTypeId' and group_selector_value ? 'recordId'
              and pg_catalog.jsonb_typeof(group_selector_value -> 'recordTypeId') = 'string'
              and pg_catalog.lower(group_selector_value ->> 'recordTypeId') ~ uuid_pattern
              and pg_catalog.lower(group_selector_value ->> 'recordTypeId') <> '00000000-0000-0000-0000-000000000000'
              and pg_catalog.jsonb_typeof(group_selector_value -> 'recordId') = 'string'
              and pg_catalog.lower(group_selector_value ->> 'recordId') ~ uuid_pattern
              and pg_catalog.lower(group_selector_value ->> 'recordId') <> '00000000-0000-0000-0000-000000000000'
            else false end;
          when 'link_to_person' then
            group_value_valid := case when pg_catalog.jsonb_typeof(group_selector_value) = 'object' then
              group_selector_value - array['organizationAccountId']::text[] = '{}'::jsonb
              and group_selector_value ? 'organizationAccountId'
              and pg_catalog.jsonb_typeof(group_selector_value -> 'organizationAccountId') = 'string'
              and pg_catalog.lower(group_selector_value ->> 'organizationAccountId') ~ uuid_pattern
              and pg_catalog.lower(group_selector_value ->> 'organizationAccountId') <> '00000000-0000-0000-0000-000000000000'
            else false end;
          else
            group_value_valid := false;
        end case;
      end if;
      if not group_value_valid then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      group_selector_types := group_selector_types || pg_catalog.jsonb_build_object(group_key, group_field_type);
      group_selector_values := group_selector_values || pg_catalog.jsonb_build_object(group_key, group_selector_value);
    end loop;
  end if;
  if board_member_mode then
    board_member := p_user_inputs -> 'boardMember';
    if pg_catalog.jsonb_typeof(board_member) is distinct from 'object'
      or board_member - array['choiceFieldId', 'column']::text[] <> '{}'::jsonb
      or not (board_member ? 'choiceFieldId') or not (board_member ? 'column')
      or pg_catalog.jsonb_typeof(board_member -> 'choiceFieldId') is distinct from 'string'
      or pg_catalog.lower(board_member ->> 'choiceFieldId') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_choice_field_id := pg_catalog.lower(board_member ->> 'choiceFieldId');
    if pg_catalog.jsonb_typeof(board_member -> 'column') is distinct from 'object'
      or pg_catalog.jsonb_typeof(board_member #> '{column,kind}') is distinct from 'string' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_column_kind := board_member #>> '{column,kind}';
    if board_column_kind = 'option' then
      if (board_member #> '{column}') - array['kind', 'value']::text[] <> '{}'::jsonb
        or not ((board_member #> '{column}') ? 'value')
        or pg_catalog.jsonb_typeof(board_member #> '{column,value}') is distinct from 'string'
        or coalesce(pg_catalog.length(board_member #>> '{column,value}'), 0) not between 1 and 120 then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_column_value := board_member #>> '{column,value}';
    elsif board_column_kind = 'unassigned' then
      if (board_member #> '{column}') - array['kind']::text[] <> '{}'::jsonb then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_column_value := null;
    else
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;

  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);

  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);
  if (board_member_mode or group_member_mode) and (
    pg_catalog.jsonb_array_length(user_sort) <> 0
    or user_search is not null
    or pg_catalog.cardinality(declared_sortable_ids) <> 0
    or pg_catalog.cardinality(declared_searchable_ids) <> 0
    or (group_member_mode and p_user_inputs ? 'search'
      and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') is distinct from 'null')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;

  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  if preview_mode and (
    board_member_mode or group_member_mode or pg_catalog.cardinality(system_field_keys) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  -- Grouped and totalled shapes are not plain rows. Only separately validated
  -- board and generic group member modes may read members from those Queries.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if group_member_mode then
    if pg_catalog.jsonb_array_length(query_item -> 'groupByFieldIds') not between 1 and 10 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(query_item -> 'groupByFieldIds') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) is distinct from 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = '00000000-0000-0000-0000-000000000000' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_key := pg_catalog.lower(field_item #>> '{}');
      group_field_type := coalesce(fields_by_id -> group_key ->> 'type', '');
      if group_key = any (group_by_ids)
        or group_field_type not in (
          'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
          'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
          'link', 'link_to_one_of_several', 'link_to_person'
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      group_by_ids := pg_catalog.array_append(group_by_ids, group_key);
    end loop;
    if pg_catalog.jsonb_array_length(group_selector) <> pg_catalog.cardinality(group_by_ids)
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(group_selector_types) as supplied(key)
        where supplied.key <> all (group_by_ids)
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    foreach group_key in array group_by_ids loop
      if group_selector_types ->> group_key is distinct from fields_by_id -> group_key ->> 'type' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
    end loop;
  elsif board_member_mode then
    if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  storage_plan := prepared_plan;
  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  preview_mode := prepared_plan ? 'preview';
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := prepared_plan #>> '{access,predicate}';
  if access_sql is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;

  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  if board_member_mode then
    if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
      or not (board_choice_field_id = any (selected_ids))
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
      or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
        or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
        or not (board_option ? 'value') or not (board_option ? 'label')
        or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
        or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
        or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
        or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
        or (board_option ? 'requiredPermissionId' and (
          pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
          or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
        ))
        or (board_option ->> 'value') collate "C" = any (board_option_values) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
    end loop;
    if board_column_kind = 'option'
      and not (board_column_value collate "C" = any (board_option_values)) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;

  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if board_member_mode or group_member_mode then
    effective_sort := '[]'::jsonb;
    effective_sort_is_user := false;
  elsif pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0
    and not board_member_mode and not group_member_mode then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;

  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 1 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;

  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);

  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;

  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when sort_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);

    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id asc';
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;

  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if sort_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when sort_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if sort_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1
    and sort_directions[1] = 'ascending'
    and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if after_record_id is null or after_phase = 'null' then
      segment_predicates := array[
        pg_catalog.format(' and %s is null%s', sort_value_sql[1],
          case when after_record_id is null then '' else ' and stored.record_id > $4' end),
        pg_catalog.format(' and %s is not null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
        sort_value_sql[1], column_sql, value_sql
      )];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;

  foreach segment_sql in array segment_predicates loop
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and %s
       and (%s)
        and (case when (%s) then true else false end)%s
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    physical_table_token,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    segment_sql,
    order_by_sql
  );

  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  for scan_record in execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters
  loop
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;

    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;

    if passes then
      if not preview_mode and not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        page_access_loaded := vortex_record.load_record_access_facts_internal(
          record_type_id_value, 'read', scan_record.record_id, null
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
      end if;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types
      ) as row_read;
      projection := read_row.projection;
      if validated_record_types is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(declared_sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if board_member_mode then
            if board_column_kind = 'option' then
              board_member_matches := (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = board_column_value collate "C";
            else
              board_member_matches := not (
                (readable_values ? board_choice_field_id)
                and pg_catalog.jsonb_typeof(readable_values -> board_choice_field_id) = 'string'
                and (readable_values ->> board_choice_field_id) collate "C"
                  = any (board_option_values)
              );
            end if;
            if not board_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if group_member_mode then
            group_member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if group_member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, readable_values -> grouped.id)
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              group_member_matches := group_candidate_values = group_selector_values;
            end if;
            if not group_member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          capability_rows := pg_catalog.array_append(
            capability_rows,
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id,
              'readFacts', read_row.read_facts,
              'readBounds', read_row.read_bounds
            )
          );
          rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ));
          row_count := row_count + 1;
          if pg_catalog.cardinality(system_field_keys) > 0 then
            rows_value := pg_catalog.jsonb_set(
              rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
            );
          end if;
          last_returned_sort_key := scan_record.sort_key;
          last_returned_record_id := scan_record.record_id;
        end if;
      end if;
    end if;

    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  exit when more_rows or budget_exhausted;
  end loop;
  if row_count > 0 then
    page_capabilities := vortex_record.read_record_capabilities_page_internal(
      record_type_id_value, pg_catalog.to_jsonb(capability_rows)
    );
    if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_capabilities) <> row_count then
      raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
    end if;
    for capability_index in 0..row_count - 1 loop
      row_capabilities := page_capabilities -> capability_index;
      if pg_catalog.jsonb_typeof(row_capabilities) is distinct from 'object' then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      rows_value := pg_catalog.jsonb_set(
        rows_value, array[capability_index::text, 'capabilities'], row_capabilities
      );
    end loop;
  end if;

  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'phase', case when pg_catalog.cardinality(last_returned_sort_key) > 0
        and last_returned_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sort', cursor_sort,
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'phase', case when pg_catalog.cardinality(last_examined_sort_key) > 0
        and last_examined_sort_key[1] is null then 'null' else 'value' end,
      'recordId', last_examined_record_id
    );
  end if;

  if group_member_mode then
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
      'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
      'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
      'groupValues', group_selector_values,
      'rows', rows_value,
      'next', next_value
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value
  );
end
$function$;

alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, or one exact current human-owned preview query over isolated preview storage, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows an installed scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the installed scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; validates every preview stage against the current human, candidate revision and exact release and storage pins, uses only active preview catalogue mappings and preview field bounds, and never falls through to installed resolution; works out read-time fields, such as a deadline-passed calculation, inside an installed query at one statement timestamp in the organisation time zone, so no installed query is refused for freshness; admits board members only through a separately validated board selector over the sole filterable choice grouping key, classifies those columns from current readable values, and admits generic grouped members only when every installed grouping value is present in the current readable projection and JSONB-equal to the closed typed selector; missing or withheld values belong to no generic group while JSON null is a value, and generic group membership never uses hidden stored values or affects scan order or budget; orders board and generic group pages by record identity, returns generic group identity even for empty pages, and binds each member operation, selector and projection in its own uncached continuation; refuses preview member, grouped, aggregate and system projection modes.';

reset role;
