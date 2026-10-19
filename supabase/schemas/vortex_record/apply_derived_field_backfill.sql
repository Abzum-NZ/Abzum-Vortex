create or replace function vortex_record.apply_derived_field_backfill(
  p_record_type_id uuid,
  p_records jsonb,
  p_last_page boolean
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope jsonb;
  preview_installation jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  application_scope uuid;
  record_item jsonb;
  entry record;
  column_value jsonb;
  assignments text[];
  written_record_id uuid;
  written integer := 0;
begin
  if p_record_type_id is null
    or p_last_page is null
    or pg_catalog.jsonb_typeof(p_records) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_records) > 100 then
    raise exception using errcode = '22023', message = 'Derived field backfill is invalid';
  end if;
  scope := vortex_record.derived_field_backfill_scope_internal();
  record_type_key := pg_catalog.lower(p_record_type_id::text);
  field_ids := scope -> 'targets' -> record_type_key;
  type_meta := scope -> 'plan' -> 'recordTypes' -> record_type_key;
  if field_ids is null or type_meta is null then
    raise exception using errcode = '42501', message = 'Derived field backfill target is unavailable';
  end if;
  application_scope := case when type_meta ->> 'storageScope' = 'application_contained'
    then (scope ->> 'applicationRootId')::uuid else null end;

  for record_item in
    select item.value from pg_catalog.jsonb_array_elements(p_records) as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) is distinct from 'object'
      or not record_item ?& array['recordId', 'expectedConcurrencyNumber', 'values']
      or pg_catalog.jsonb_typeof(record_item -> 'values') is distinct from 'object'
      or record_item -> 'values' = '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Derived field backfill is invalid';
    end if;
    assignments := array[]::text[];
    -- Only the fields this backfill works out, each value in its column's canonical form.
    for entry in
      select pg_catalog.lower(item.key) as key, item.value
      from pg_catalog.jsonb_each(record_item -> 'values') as item(key, value)
    loop
      column_value := type_meta -> 'columns' -> entry.key;
      if not field_ids ? entry.key or column_value is null
        or not vortex_record.canonical_record_value_matches(
          entry.value, column_value ->> 'type', column_value ->> 'databaseValueType'
        ) then
        raise exception using errcode = '23514', message = 'Derived field backfill value is invalid';
      end if;
      assignments := pg_catalog.array_append(assignments, pg_catalog.format(
        '%I = %s', column_value ->> 'token',
        case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
          when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
          else pg_catalog.format('%L::text', entry.value #>> '{}') end end
      ));
    end loop;
    -- Working out a new field is not a change anyone made: no Activity or Event, and the
    -- record's last change stays as it was. Its revision moves, so an open form refreshes.
    execute pg_catalog.format(
      'update record_data.%I as stored set %s, concurrency_number = stored.concurrency_number + 1
       where stored.organisation_id = $1
         and stored.application_root_id is not distinct from $2
         and stored.record_id = $3
         and stored.concurrency_number = $4
         and stored.lifecycle_state = ''active''
       returning stored.record_id',
      type_meta ->> 'table', pg_catalog.array_to_string(assignments, ', ')
    ) into written_record_id
    using (scope ->> 'organizationId')::uuid, application_scope,
      (record_item ->> 'recordId')::uuid, (record_item ->> 'expectedConcurrencyNumber')::bigint;
    if written_record_id is null then
      raise exception using errcode = '40001', message = 'Derived field backfill record changed';
    end if;
    written := written + 1;
  end loop;

  if written > 0 then
    perform vortex_record.bump_record_data_version_internal(
      (scope ->> 'organizationId')::uuid, (type_meta ->> 'storageContractId')::uuid,
      application_scope
    );
  end if;
  -- With a preview's last page, the record type's derived fields are worked out: its seed ledger
  -- says so in this same transaction.
  if p_last_page then
    preview_installation := vortex_record.read_current_preview_installation_internal();
    if preview_installation is not null then
      perform vortex_definition.mark_preview_derived_ready_internal(
        (preview_installation ->> 'previewInstallationId')::uuid, p_record_type_id
      );
    end if;
  end if;
  return written;
end
$function$;

alter function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean)
  to vortex_runtime;
comment on function vortex_record.apply_derived_field_backfill(uuid, jsonb, boolean) is
  'Server-only derived-field backfill write: stores the totals and stored calculations the platform worked out for a page of existing records it read with read_derived_field_backfill, only for the fields the backfill provisions. With the last page of a preview''s record type, its seed ledger records that the type''s derived fields are worked out.';
