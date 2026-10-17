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
  preview_table_token text;
  record_columns text[];
  field_columns text[];
  readable_columns text[];
  copied_columns text;
  copied_count bigint := 0;
  live_record record;
  row_read record;
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
  select catalogue.physical_table_token into strict live_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
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
  for live_record in
    execute pg_catalog.format(
      'select record_id from record_data.%I order by record_id', live_table_token
    )
  loop
    scanned_count := scanned_count + 1;
    exit when scanned_count > scan_limit;
    select projected.projection, projected.read_bounds into row_read
    from vortex_record.read_record_projection_internal(
      p_record_type_id, live_record.record_id
    ) as projected;
    continue when row_read.projection ->> 'outcome' is distinct from 'allowed';
    if copied_count = copy_limit then
      bounded := true;
      exit;
    end if;
    select coalesce(pg_catalog.array_agg(field_column.value order by field_column.value), array[]::text[])
    into readable_columns
    from pg_catalog.unnest(field_columns) as field_column(value)
    where field_column.value in (
      select 'f_' || pg_catalog.replace(pg_catalog.lower(readable.value #>> '{}'), '-', '')
      from pg_catalog.jsonb_array_elements(row_read.read_bounds -> 'readableFieldIds') as readable(value)
    );
    select pg_catalog.string_agg(pg_catalog.quote_ident(copied.value), ', ')
    into copied_columns
    from pg_catalog.unnest(record_columns || readable_columns) as copied(value);
    execute pg_catalog.format(
      'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I where record_id = $1',
      preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
      live_table_token
    ) using live_record.record_id;
    copied_count := copied_count + 1;
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
