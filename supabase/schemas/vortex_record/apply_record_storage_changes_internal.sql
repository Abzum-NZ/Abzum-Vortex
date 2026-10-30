create or replace function vortex_record.apply_record_storage_changes_internal(
  p_changes jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  storage_group record;
  storage_row vortex_record.storage_catalogue%rowtype;
  column_names text;
  source_columns text;
  assignments text;
  result_value jsonb := '[]'::jsonb;
  written jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record storage changes are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array['storageContractId', 'recordId', 'expectedConcurrencyNumber', 'values'])
      or item.value - array['storageContractId', 'recordId', 'expectedConcurrencyNumber', 'values']::text[] <> '{}'::jsonb
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'storageContractId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
      or pg_catalog.jsonb_typeof(item.value -> 'values') is distinct from 'object'
      or (item.value -> 'values') ?| array['organisation_id', 'record_id']
      or (item.value -> 'expectedConcurrencyNumber' <> 'null'::jsonb and (
        pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') <> 'number'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
      ))
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Record storage changes are invalid';
  end if;

  -- Callers have checked current and proposed authority, field policy and all
  -- relationship constraints. Storage identities come from those preparations;
  -- the request role cannot call this primitive or supply a physical table.
  for storage_group in
    select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      pg_catalog.jsonb_agg(item.value order by item.value ->> 'recordId') as changes
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by (item.value ->> 'storageContractId')::uuid
    order by (item.value ->> 'storageContractId')::uuid
  loop
    select storage.* into strict storage_row
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = storage_group.storage_contract_id;
    if storage_row.physical_schema_token is distinct from 'record_data'
      or storage_row.physical_table_token is null then
      raise exception using errcode = '55000', message = 'Record storage is unavailable';
    end if;
    select
      pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' order by attribute.attnum),
      pg_catalog.string_agg(pg_catalog.format('source.%I', attribute.attname), ', ' order by attribute.attnum),
      pg_catalog.string_agg(pg_catalog.format('%I = source.%I', attribute.attname, attribute.attname), ', ' order by attribute.attnum)
        filter (where attribute.attname not in ('organisation_id', 'record_id'))
    into column_names, source_columns, assignments
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', storage_row.physical_schema_token, storage_row.physical_table_token
    )) and attribute.attnum > 0 and not attribute.attisdropped;
    if column_names is null or exists (
      select 1
      from pg_catalog.jsonb_array_elements(storage_group.changes) as item(value)
      cross join lateral pg_catalog.jsonb_object_keys(item.value -> 'values') as supplied(name)
      where not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(pg_catalog.format(
          '%I.%I', storage_row.physical_schema_token, storage_row.physical_table_token
        )) and attribute.attnum > 0 and not attribute.attisdropped
          and attribute.attname = supplied.name
      )
    ) then
      raise exception using errcode = '55000', message = 'Record storage columns disagree with the prepared change';
    end if;

    -- MERGE gives creates and updates of the same storage table one physical
    -- write statement. A missing update or an existing create matches neither
    -- permitted branch, so the count check rejects the entire transaction.
    execute pg_catalog.format(
      'with written as (
        merge into %1$I.%2$I as stored
        using (
          select (item.value ->> ''expectedConcurrencyNumber'')::bigint as expected_revision,
            candidate.*
          from pg_catalog.jsonb_array_elements($1) as item(value)
          left join %1$I.%2$I as current_record
            on current_record.organisation_id = $2
            and current_record.record_id = (item.value ->> ''recordId'')::uuid
          cross join lateral pg_catalog.jsonb_populate_record(null::%1$I.%2$I,
            coalesce(pg_catalog.to_jsonb(current_record), ''{}''::jsonb)
              || (item.value -> ''values'')
              || pg_catalog.jsonb_build_object(
                ''organisation_id'', $2, ''record_id'', item.value -> ''recordId'',
                ''concurrency_number'', coalesce((item.value ->> ''expectedConcurrencyNumber'')::bigint, 0) + 1,
                ''updated_at'', pg_catalog.statement_timestamp(), ''updated_by'', $3
              )
          ) as candidate
        ) as source
        on stored.organisation_id = $2 and stored.record_id = source.record_id
        when matched and source.expected_revision is not null
          and stored.concurrency_number = source.expected_revision
          then update set %3$s
        when not matched and source.expected_revision is null
          then insert (%4$s) values (%5$s)
        returning pg_catalog.jsonb_build_object(
          ''recordId'', stored.record_id, ''storageContractId'', stored.storage_contract_id,
          ''concurrencyNumber'', stored.concurrency_number
        ) as result
      ) select coalesce(pg_catalog.jsonb_agg(written.result), ''[]''::jsonb) from written',
      storage_row.physical_schema_token, storage_row.physical_table_token,
      assignments, column_names, source_columns
    ) into written using storage_group.changes, (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid;
    if pg_catalog.jsonb_array_length(written) <> pg_catalog.jsonb_array_length(storage_group.changes) then
      raise exception using errcode = '40001', message = 'Record storage change revision is stale';
    end if;
    result_value := result_value || written;
  end loop;
  return result_value;
end
$function$;

alter function vortex_record.apply_record_storage_changes_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_record_storage_changes_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_record_storage_changes_internal(jsonb) is
  'Private physical record mutation primitive: merges already-authorized changes with one write per storage table, preserving unsupplied columns and rejecting stale revisions atomically.';
