create or replace function vortex_record.reconcile_preview_records_internal(
  p_record_type_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  live_table_token text;
  preview_table_token text;
  field_columns text[];
  readable_columns text[];
  cleared_columns text;
  preview_record record;
  row_read record;
  changed_count bigint := 0;
begin
  if not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record check selector is invalid';
  end if;
  -- The check reads as the builder reads the installed Application: never in a preview.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
    is not null then
    raise exception using errcode = '42501', message = 'Preview record check must read live records';
  end if;
  select catalogue.physical_table_token into strict live_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.record_type_id = p_record_type_id;

  -- The field columns a copy could have filled: the ones both tables declare with the same type.
  select coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum), array[]::text[])
  into field_columns
  from pg_catalog.pg_attribute as preview_column
  join pg_catalog.pg_class as preview_table on preview_table.oid = preview_column.attrelid
  join pg_catalog.pg_namespace as preview_schema on preview_schema.oid = preview_table.relnamespace
  where preview_schema.nspname = 'record_data'
    and preview_table.relname = preview_table_token
    and preview_column.attnum > 0
    and not preview_column.attisdropped
    and preview_column.attname ~ '^f_[0-9a-f]{32}$'
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

  -- Every copied record is decided again by the builder's live access: one they can no longer
  -- read leaves the preview, and a field they can no longer read is emptied. A record created in
  -- the preview has no live row and stays.
  for preview_record in
    execute pg_catalog.format(
      'select preview_row.record_id from record_data.%I as preview_row where exists (select 1 from record_data.%I as live_row where live_row.record_id = preview_row.record_id) order by preview_row.record_id',
      preview_table_token, live_table_token
    )
  loop
    select projected.projection, projected.read_bounds into row_read
    from vortex_record.read_record_projection_internal(
      p_record_type_id, preview_record.record_id
    ) as projected;
    if row_read.projection ->> 'outcome' is distinct from 'allowed' then
      execute pg_catalog.format('delete from record_data.%I where record_id = $1', preview_table_token)
        using preview_record.record_id;
      changed_count := changed_count + 1;
      continue;
    end if;
    select coalesce(pg_catalog.array_agg(readable.column_name), array[]::text[])
    into readable_columns
    from (
      select 'f_' || pg_catalog.replace(pg_catalog.lower(readable_id.value #>> '{}'), '-', '') as column_name
      from pg_catalog.jsonb_array_elements(row_read.read_bounds -> 'readableFieldIds') as readable_id(value)
    ) as readable;
    select pg_catalog.string_agg(pg_catalog.format('%I = null', field_column.value), ', ')
    into cleared_columns
    from pg_catalog.unnest(field_columns) as field_column(value)
    where not (field_column.value = any(readable_columns));
    if cleared_columns is not null then
      execute pg_catalog.format('update record_data.%I set %s where record_id = $1',
        preview_table_token, cleared_columns)
        using preview_record.record_id;
      changed_count := changed_count + 1;
    end if;
  end loop;
  return changed_count;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record check storage is unavailable';
end
$function$;

alter function vortex_record.reconcile_preview_records_internal(uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.reconcile_preview_records_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.reconcile_preview_records_internal(uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.reconcile_preview_records_internal(uuid, uuid, uuid) is
  'Decides every copied record of one preview record table again by the request''s builder''s live access in the installed Application: removes a record they can no longer read and empties each field they can no longer read. Records created in the preview stay.';
