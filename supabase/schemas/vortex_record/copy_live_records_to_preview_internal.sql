create or replace function vortex_record.copy_live_records_to_preview_internal(
  p_preview_installation_id uuid,
  p_record_type_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- The deliberate preview bound: a preview holds at most this many records of one record type,
  -- the first the builder can read in record order. The seed says when the bound was reached, and
  -- the preview tells the builder so.
  copy_limit constant integer := 2000;
  -- A table the builder can mostly not read is scanned only this far. That is a silent
  -- performance bound: it says nothing about how many live records exist.
  scan_limit constant integer := 20000;
  counter_mapping record;
  copied_maximum numeric;
  scanned_count integer := 0;
  bounded boolean := false;
  live_table_token text;
  source_module_root_id uuid;
  checked_context jsonb;
  live_type jsonb;
  preview_table_token text;
  record_columns text[];
  field_columns text[];
  copied_columns text;
  copied_count bigint := 0;
  row_read record;
  -- Page decisions take at most 201 candidates; a batch is the round number below that.
  batch_size constant integer := 200;
  after_id uuid;
  batch_ids uuid[];
  candidate_id uuid;
  page_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_envelope jsonb;
  page_narrowed boolean;
  decided_ids uuid[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  readable_bounds jsonb;
  readable_field_ids jsonb;
  readable_ids uuid[];
  readable_columns_by_record text[];
  column_sets jsonb := '{}'::jsonb;
  bounds_key text;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record copy selector is invalid';
  end if;
  -- The copy reads as the builder reads the installed Application: never in a preview.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
    is not null then
    raise exception using errcode = '42501', message = 'Preview record copy must read live records';
  end if;
  select catalogue.physical_table_token, catalogue.module_root_id
  into strict live_table_token, source_module_root_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  checked_context := vortex_access.validated_human_request_context();
  live_type := vortex_record.resolve_preview_seed_source_internal(
    (checked_context ->> 'organizationId')::uuid,
    (checked_context ->> 'applicationRootId')::uuid,
    source_module_root_id, p_record_type_id, p_live_storage_contract_id
  );
  if live_type is null or live_type ->> 'table' is distinct from live_table_token then
    raise exception using errcode = '42501', message = 'Preview seed source is not installed';
  end if;
  -- The caller passes the preview's own storage identities; both tables hold this record type.
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.record_type_id = p_record_type_id;

  -- The columns both tables declare with the same type, except the storage identity each table
  -- fixes for itself: the record columns, and each field the live release and the draft share.
  select
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname !~ '^f_[0-9a-f]{32}$'), array[]::text[]),
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname ~ '^f_[0-9a-f]{32}$'), array[]::text[])
  into record_columns, field_columns
  from pg_catalog.pg_attribute as preview_column
  join pg_catalog.pg_class as preview_table on preview_table.oid = preview_column.attrelid
  join pg_catalog.pg_namespace as preview_schema
    on preview_schema.oid = preview_table.relnamespace
  where preview_schema.nspname = 'record_data'
    and preview_table.relname = preview_table_token
    and preview_column.attnum > 0
    and not preview_column.attisdropped
    and preview_column.attname <> 'storage_contract_id'
    and exists (
      select 1
      from pg_catalog.pg_attribute as live_column
      join pg_catalog.pg_class as live_table on live_table.oid = live_column.attrelid
      join pg_catalog.pg_namespace as live_schema on live_schema.oid = live_table.relnamespace
      where live_schema.nspname = 'record_data'
        and live_table.relname = live_table_token
        and live_column.attname = preview_column.attname
        and live_column.attnum > 0
        and not live_column.attisdropped
        and live_column.atttypid = preview_column.atttypid
    );
  if pg_catalog.cardinality(record_columns) = 0
    or not ('record_id' = any(record_columns)) then
    raise exception using errcode = '55000', message = 'Preview record copy has no columns';
  end if;

  -- Only the records the builder reads in the installed Application, each with only the fields
  -- the builder reads there; every other field of a copied record is left empty. Row security
  -- limits the live table to the request's organisation and Application. The bound counts only
  -- readable records, in record order, so the builder gets the first records they can see.
  -- Candidates are scanned in record order in keyset batches. Each batch is decided together by
  -- the page read pass, with the page facts, eligibility and envelope built inside this
  -- invocation from the request's own context, and the readable records of a batch are copied by
  -- one statement per distinct set of readable fields.
  loop
    execute pg_catalog.format(
      'select coalesce(pg_catalog.array_agg(candidate.record_id order by candidate.record_id), array[]::uuid[]) from (select record_id from record_data.%I where $1::uuid is null or record_id > $1 order by record_id limit $2) as candidate',
      live_table_token
    ) into batch_ids using after_id, least(batch_size, scan_limit - scanned_count);
    exit when pg_catalog.cardinality(batch_ids) = 0;
    after_id := batch_ids[pg_catalog.cardinality(batch_ids)];
    scanned_count := scanned_count + pg_catalog.cardinality(batch_ids);

    -- The page facts come from the batch's first record, loaded by the exact loader. A record
    -- type the page pass cannot decide (a protected projection, or readable through another
    -- record) leaves its records to the exact single-record decision.
    decided_ids := array[]::uuid[];
    decided_decisions := array[]::jsonb[];
    decided_bounds := array[]::jsonb[];
    page_eligibility := null;
    page_loaded := vortex_record.load_record_access_facts_from_installation_internal(
      p_record_type_id, 'read', batch_ids[1], null,
      vortex_definition.read_current_active_installation(), null
    );
    if page_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(page_loaded -> 'declaration') = 'object' then
      page_declaration := page_loaded -> 'declaration';
      -- The row decisions and the raw values must refer to the same authoritative storage,
      -- including if the installed pin set changed since the source was resolved.
      if (page_loaded #>> '{facts,binding,storageContractId}')::uuid
          is distinct from p_live_storage_contract_id
        or page_loaded #>> '{recordTypeMeta,table}' is distinct from live_table_token then
        raise exception using errcode = '42501', message = 'Preview seed authorization storage changed';
      end if;
      page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
        page_declaration, checked_context, pg_catalog.clock_timestamp()
      );
      select page.envelope, page.narrowed into page_envelope, page_narrowed
      from vortex_record.read_record_page_envelope_internal(p_record_type_id, page_loaded) as page;
      select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
        coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
        coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
      into decided_ids, decided_decisions, decided_bounds
      from vortex_record.read_record_page_decisions_internal(
        p_record_type_id, page_loaded, page_declaration, page_eligibility,
        batch_ids, page_envelope, page_narrowed
      ) as decided;
    end if;

    readable_ids := array[]::uuid[];
    readable_columns_by_record := array[]::text[];
    foreach candidate_id in array batch_ids loop
      decided_index := pg_catalog.array_position(decided_ids, candidate_id);
      if decided_index is not null
        and decided_decisions[decided_index] ->> 'outcome' is distinct from 'allowed' then
        continue;
      end if;
      if decided_index is not null
        and (decided_decisions[decided_index] ->> 'validUntil')::timestamptz
          > pg_catalog.clock_timestamp()
        and page_eligibility ->> 'outcome' = 'eligible'
        and (page_eligibility ->> 'validUntil')::timestamptz > pg_catalog.clock_timestamp() then
        readable_bounds := decided_bounds[decided_index];
      else
        -- A record the page pass did not decide, or decided only for a moment that has passed,
        -- keeps the exact single-record decision.
        select projected.projection, projected.read_bounds, projected.read_facts into row_read
        from vortex_record.read_record_projection_internal(p_record_type_id, candidate_id) as projected;
        continue when row_read.projection ->> 'outcome' is distinct from 'allowed';
        if (row_read.read_facts #>> '{facts,binding,storageContractId}')::uuid
          is distinct from p_live_storage_contract_id then
          raise exception using errcode = '42501', message = 'Preview seed authorization storage changed';
        end if;
        readable_bounds := row_read.read_bounds;
      end if;
      if copied_count + pg_catalog.cardinality(readable_ids) = copy_limit then
        bounded := true;
        exit;
      end if;
      readable_field_ids := coalesce(readable_bounds -> 'readableFieldIds', '[]'::jsonb);
      bounds_key := readable_field_ids::text;
      if not column_sets ? bounds_key then
        select pg_catalog.string_agg(pg_catalog.quote_ident(copied.value), ', ')
        into copied_columns
        from pg_catalog.unnest(record_columns || coalesce((
          select pg_catalog.array_agg(field_column.value order by field_column.value)
          from pg_catalog.unnest(field_columns) as field_column(value)
          where field_column.value in (
            select 'f_' || pg_catalog.replace(pg_catalog.lower(readable.value #>> '{}'), '-', '')
            from pg_catalog.jsonb_array_elements(readable_field_ids) as readable(value)
          )
        ), array[]::text[])) as copied(value);
        column_sets := column_sets || pg_catalog.jsonb_build_object(bounds_key, copied_columns);
      end if;
      readable_ids := readable_ids || candidate_id;
      readable_columns_by_record := readable_columns_by_record || (column_sets ->> bounds_key);
    end loop;

    for copied_columns in
      select distinct set_columns.value
      from pg_catalog.unnest(readable_columns_by_record) as set_columns(value)
    loop
      execute pg_catalog.format(
        'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I where record_id = any ($1)',
        preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
        live_table_token
      ) using (
        select pg_catalog.array_agg(member.record_id)
        from pg_catalog.unnest(readable_ids, readable_columns_by_record) as member(record_id, columns)
        where member.columns = copied_columns
      );
    end loop;
    copied_count := copied_count + pg_catalog.cardinality(readable_ids);
    exit when bounded or scanned_count >= scan_limit;
  end loop;

  -- Each reference-number counter continues after the highest number among the copied records,
  -- never from the live counter, which would reveal how many live records exist.
  for counter_mapping in
    select mapping.field_id, mapping.physical_column_token
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = p_preview_storage_contract_id
      and mapping.state = 'active'
      and mapping.field_definition ->> 'type' = 'reference_number'
      and mapping.physical_column_token = any(field_columns)
    order by mapping.field_id
  loop
    execute pg_catalog.format(
      'select pg_catalog.max(pg_catalog.substring(%I, ''([0-9]+)[^0-9]*$'')::numeric) from record_data.%I where storage_contract_id = %L::uuid',
      counter_mapping.physical_column_token, preview_table_token, p_preview_storage_contract_id
    ) into copied_maximum;
    if copied_maximum is not null then
      insert into vortex_record.preview_reference_counters (
        preview_installation_id, storage_contract_id, field_id, next_number
      ) values (
        p_preview_installation_id, p_preview_storage_contract_id, counter_mapping.field_id,
        copied_maximum + 1
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('copied', copied_count, 'bounded', bounded);
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record copy storage is unavailable';
end
$function$;

alter function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid) is
  'Seeds one preview record table with the live records of the same record type that the request''s builder reads in the installed Application, each with only the fields they read there, and reference counters that continue after the copied records: the first 2,000 they read, in record order, and whether they read more.';
