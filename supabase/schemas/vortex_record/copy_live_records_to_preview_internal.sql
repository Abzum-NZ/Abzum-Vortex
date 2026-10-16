create or replace function vortex_record.copy_live_records_to_preview_internal(
  p_preview_installation_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  live_table_token text;
  preview_table_token text;
  copied_columns text;
  copied_count bigint;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record copy selector is invalid';
  end if;
  select catalogue.physical_table_token into strict live_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.module_root_id = (
      select live.module_root_id from vortex_record.storage_catalogue as live
      where live.storage_contract_id = p_live_storage_contract_id
    )
    and catalogue.record_type_id = (
      select live.record_type_id from vortex_record.storage_catalogue as live
      where live.storage_contract_id = p_live_storage_contract_id
    );

  -- Every column both tables have, except the storage identity each table fixes for itself: the
  -- record columns and each field the live release and the previewed draft both declare.
  select pg_catalog.string_agg(
    pg_catalog.quote_ident(preview_column.attname), ', ' order by preview_column.attnum
  )
  into copied_columns
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
  if copied_columns is null then
    raise exception using errcode = '55000', message = 'Preview record copy has no columns';
  end if;

  -- Row security limits both tables to the request's organisation and Application.
  execute pg_catalog.format(
    'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I',
    preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
    live_table_token
  );
  get diagnostics copied_count = row_count;

  insert into vortex_record.preview_reference_counters (
    preview_installation_id, storage_contract_id, field_id, next_number
  )
  select p_preview_installation_id, p_preview_storage_contract_id, counter.field_id,
    counter.next_number
  from vortex_record.record_reference_counters as counter
  where counter.storage_contract_id = p_live_storage_contract_id
    and counter.organization_id = vortex_platform.organization_id()
    and counter.next_number >= 2;
  return copied_count;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record copy storage is unavailable';
end
$function$;

alter function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid) is
  'Seeds one preview record table with the request organisation''s live records of the same record type and their reference counters; only columns both tables declare are copied.';
