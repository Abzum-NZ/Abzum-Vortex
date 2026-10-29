create or replace function vortex_record.prepare_record_storage_set_internal(p_changes jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
  change_value jsonb;
  record_type_id_value uuid;
  loaded jsonb;
  record_fact jsonb;
  proposed_values jsonb;
  proposed_records jsonb := '[]'::jsonb;
begin
  storage_changes := vortex_record.combine_record_storage_changes_internal(p_changes);

  for change_value in select item.value from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
  loop
    select storage.record_type_id into strict record_type_id_value
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (change_value ->> 'storageContractId')::uuid;
    loaded := vortex_record.load_record_access_facts_internal(
      record_type_id_value, 'update', (change_value ->> 'recordId')::uuid,
      (change_value ->> 'expectedConcurrencyNumber')::bigint, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or loaded #> '{recordTypeMeta,storageContractId}' is distinct from change_value -> 'storageContractId' then
      raise exception using errcode = '40001', message = 'Prepared record storage closure changed';
    end if;
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded #> '{facts,records}') as item(value)
    where item.value #>> '{recordScope,recordId}' = change_value ->> 'recordId';
    select (loaded -> 'fieldValues') || coalesce(pg_catalog.jsonb_object_agg(
      field.key, change_value -> 'values' -> (field.value ->> 'token')
    ), '{}'::jsonb) into proposed_values
    from pg_catalog.jsonb_each(loaded -> 'columns') as field(key, value)
    where (change_value -> 'values') ? (field.value ->> 'token');
    proposed_records := proposed_records || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', record_type_id_value, 'storageContractId', change_value -> 'storageContractId',
      'recordId', change_value -> 'recordId', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'existingValues', proposed_values,
      'lifecycleState', coalesce(change_value #>> '{values,lifecycle_state}', record_fact ->> 'lifecycleState')
    ));
  end loop;
  return pg_catalog.jsonb_build_object('storageChanges', storage_changes, 'proposedRecords', proposed_records);
end
$function$;

alter function vortex_record.prepare_record_storage_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_storage_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_storage_set_internal(jsonb) is
  'Private preparation of an already-authorized lifecycle closure: composes repeated record changes and supplies proposed logical snapshots for generated-field calculation before any physical write.';
