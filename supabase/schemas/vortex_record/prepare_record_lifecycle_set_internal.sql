create or replace function vortex_record.prepare_record_lifecycle_set_internal(p_subjects jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  subject jsonb;
  subject_index integer;
  prepared jsonb;
  storage_change jsonb;
  storage_changes jsonb := '[]'::jsonb;
  root_groups jsonb := '{}'::jsonb;
  group_keys jsonb;
  identity_key text;
  record_key text;
  record_type_id_value uuid;
  explicit_subject jsonb;
  explicit_index integer;
  operation_value text;
  meta jsonb;
  loaded jsonb;
  projection jsonb;
  changed_values jsonb;
  proposed_values jsonb;
  snapshot jsonb;
  snapshots jsonb := '[]'::jsonb;
  roots jsonb := '[]'::jsonb;
  proposals jsonb := '[]'::jsonb;
  changes jsonb := '[]'::jsonb;
  subjects jsonb := '[]'::jsonb;
  lifecycle_states jsonb := '{}'::jsonb;
begin
  if not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' in ('delete', 'restore'))
    and vortex_record.read_current_preview_installation_internal() is not null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_effect_refused');
  end if;

  -- These existing preparations own current lifecycle authority, closure locks,
  -- retained revisions and recoverable edge snapshots. They write no records.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    where item.value ->> 'operation' in ('delete', 'restore')
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if subject ->> 'operation' = 'delete' then
      prepared := vortex_record.prepare_record_delete_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, array[]::text[]
      );
    else
      prepared := vortex_record.prepare_record_restore_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint
      );
      if prepared ->> 'outcome' is distinct from 'prepared' then
        return prepared || pg_catalog.jsonb_build_object('index', subject_index);
      end if;
    end if;
    storage_changes := storage_changes || coalesce(prepared -> 'storageChanges', '[]'::jsonb);
    for storage_change in
      select item.value from pg_catalog.jsonb_array_elements(prepared -> 'storageChanges') as item(value)
    loop
      identity_key := (storage_change ->> 'storageContractId') || ':' || (storage_change ->> 'recordId');
      group_keys := coalesce(root_groups -> identity_key, '[]'::jsonb);
      root_groups := root_groups || pg_catalog.jsonb_build_object(identity_key,
        group_keys || pg_catalog.jsonb_build_array('intent:' || subject_index::text));
      if storage_change #>> '{values,lifecycle_state}' is not null then
        if lifecycle_states ? identity_key and lifecycle_states ->> identity_key
          <> storage_change #>> '{values,lifecycle_state}' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
        end if;
        lifecycle_states := lifecycle_states || pg_catalog.jsonb_build_object(
          identity_key, storage_change #> '{values,lifecycle_state}'
        );
      end if;
    end loop;
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
    cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
    group by item.value -> 'storageContractId', item.value -> 'recordId', field.key
    having pg_catalog.count(distinct field.value) > 1
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
  end if;

  for storage_change in
    select item.value from pg_catalog.jsonb_array_elements(
      vortex_record.combine_record_storage_changes_internal(storage_changes)
    ) as item(value)
    order by item.value ->> 'storageContractId', item.value ->> 'recordId'
  loop
    select storage.record_type_id into strict record_type_id_value
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (storage_change ->> 'storageContractId')::uuid
      and storage.state = 'active';
    select item.value, (item.ordinality - 1)::integer into explicit_subject, explicit_index
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    where (item.value ->> 'recordTypeId')::uuid = record_type_id_value
      and item.value -> 'recordId' = storage_change -> 'recordId';
    if explicit_subject ->> 'operation' in ('create', 'update') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
    end if;
    record_key := case when explicit_subject is not null then 'intent:' || explicit_index::text
      else record_type_id_value::text || ':' || (storage_change ->> 'recordId') end;
    operation_value := case storage_change #>> '{values,lifecycle_state}'
      when 'soft_deleted' then 'delete' when 'active' then 'restore' else 'update' end;
    meta := vortex_record.resolve_record_action_context_internal(record_type_id_value, operation_value);
    loaded := vortex_record.load_record_access_facts_internal(
      record_type_id_value, operation_value, (storage_change ->> 'recordId')::uuid, null, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
    end if;
    select coalesce(pg_catalog.jsonb_object_agg(field.key, storage_change -> 'values' -> (field.value ->> 'token')),
      '{}'::jsonb) into changed_values
    from pg_catalog.jsonb_each(meta -> 'columns') as field(key, value)
    where (storage_change -> 'values') ? (field.value ->> 'token');
    proposed_values := (loaded -> 'fieldValues') || changed_values;
    snapshot := pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'recordTypeId', record_type_id_value, 'recordType', meta -> 'recordType',
      'storageContractId', storage_change -> 'storageContractId', 'recordId', storage_change -> 'recordId',
      'concurrencyNumber', storage_change -> 'expectedConcurrencyNumber',
      'definitionRevision', meta -> 'moduleReleaseRevision', 'existingValues', loaded -> 'fieldValues',
      -- Discovery must see the old outgoing links even for a row this command removes.
      -- Actual proposed lifecycle state is supplied separately to total membership.
      'lifecycleState', 'active'
    );
    snapshots := snapshots || pg_catalog.jsonb_build_array(snapshot);
    identity_key := (storage_change ->> 'storageContractId') || ':' || (storage_change ->> 'recordId');
    roots := roots || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'operation', 'update', 'recordTypeId', record_type_id_value,
      'recordId', storage_change -> 'recordId', 'values', changed_values,
      'groupKeys', root_groups -> identity_key
    ));
    proposals := proposals || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'recordTypeId', record_type_id_value, 'recordId', storage_change -> 'recordId',
      'values', proposed_values, 'lifecycleState', case operation_value when 'delete' then 'soft_deleted' else 'active' end
    ));
    changes := changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'operation', operation_value, 'storedValues', loaded -> 'fieldValues',
      'submittedValues', changed_values, 'proposedValues', proposed_values
    ));
    if explicit_subject is not null then
      projection := (vortex_record.read_record(record_type_id_value, (storage_change ->> 'recordId')::uuid)) -> 'record';
      subjects := subjects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordKey', record_key, 'index', explicit_index, 'outcome', 'prepared',
        'recordType', meta -> 'recordType', 'existingValues', loaded -> 'fieldValues',
        'readableFieldIds', case when projection ->> 'outcome' = 'allowed' then
          (select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
           from pg_catalog.jsonb_object_keys(projection -> 'values') as field(key)) else '[]'::jsonb end,
        'correlationId', context_value -> 'correlationId'
      ));
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'roots', roots, 'snapshots', snapshots,
    'proposals', proposals, 'changes', changes, 'subjects', subjects);
exception
  when serialization_failure then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'record_revision_conflict');
  when no_data_found or insufficient_privilege or check_violation then
    raise warning 'Record lifecycle preparation refused: [%] %', sqlstate, sqlerrm;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_lifecycle_refused');
end
$function$;
alter function vortex_record.prepare_record_lifecycle_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_lifecycle_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_lifecycle_set_internal(jsonb) is
  'Private lifecycle calculation inputs for a complete command: authorizes and locks exact per-root delete or restore closures, combines their compatible deltas, and exposes stored rule values and proposed membership without writing records.';
