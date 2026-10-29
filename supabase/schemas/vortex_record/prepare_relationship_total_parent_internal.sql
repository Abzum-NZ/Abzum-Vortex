create or replace function vortex_record.prepare_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_catalogue jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  catalogue jsonb;
  snapshot jsonb;
  field_value jsonb;
  column_value jsonb;
  entry record;
  physical_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Relationship total parent mutation is invalid';
  end if;
  if p_final_values = '{}'::jsonb then return null; end if;
  catalogue := p_catalogue;
  snapshot := vortex_record.relationship_total_record_snapshot_internal(
    catalogue, p_record_type_id, p_record_id, true
  );
  if snapshot is null or (snapshot ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    raise exception using errcode = '40001', message = 'Relationship total parent revision changed';
  end if;
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(snapshot -> 'recordType' -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Relationship total parent field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = (snapshot ->> 'storageContractId')::uuid
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Relationship total parent value is invalid';
    end if;
    physical_values := physical_values || pg_catalog.jsonb_build_object(column_value ->> 'token', entry.value);
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);
  return pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id, 'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids), 'snapshot', snapshot,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', snapshot -> 'storageContractId', 'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object('definition_revision', snapshot -> 'definitionRevision')
    )
  );
end
$function$;

alter function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb) is
  'Prepares protected generated totals and calculations against a locked current or proposed snapshot for the shared record storage writer.';
