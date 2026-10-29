create or replace function vortex_record.combine_record_storage_changes_internal(p_changes jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
begin
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Prepared record storage changes are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
    having pg_catalog.count(distinct item.value -> 'expectedConcurrencyNumber') > 1
  ) then
    raise exception using errcode = '40001', message = 'Prepared record revisions disagree';
  end if;

  -- Different closure members may change separate fields on the same record.
  -- Compose those changes before the one physical write.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'storageContractId', subject.storage_id, 'recordId', subject.record_id,
    'expectedConcurrencyNumber', subject.revision,
    'values', (
      select pg_catalog.jsonb_object_agg(field.key, field.value order by item.ordinality)
      from pg_catalog.jsonb_array_elements(p_changes) with ordinality as item(value, ordinality)
      cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
      where item.value -> 'storageContractId' = subject.storage_id
        and item.value -> 'recordId' = subject.record_id
    )
  ) order by subject.storage_id, subject.record_id), '[]'::jsonb) into storage_changes
  from (
    select item.value -> 'storageContractId' as storage_id,
      item.value -> 'recordId' as record_id,
      pg_catalog.max((item.value ->> 'expectedConcurrencyNumber')::bigint) as revision
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
  ) as subject;

  return storage_changes;
end
$function$;
alter function vortex_record.combine_record_storage_changes_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.combine_record_storage_changes_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.combine_record_storage_changes_internal(jsonb) is
  'Combines prepared field deltas for each storage and record identity, preserving one expected revision and ordered final values for its single physical write.';
