create or replace function vortex_record.prepare_record_change_set_internal(
  p_command_id uuid,
  p_subjects jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subject jsonb;
  ordinal integer;
  meta jsonb;
  prepared jsonb;
  receipt vortex_record.command_receipts%rowtype;
  plans jsonb := '[]'::jsonb;
  storage_changes jsonb := '[]'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  effects jsonb := '[]'::jsonb;
  restore_subject jsonb;
  submitted_fields uuid[];
  normalized_edges jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array[
        'operation', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber',
        'submittedValues', 'finalValues', 'selectedGroupId', 'activityId', 'occurrenceId'
      ])
      or item.value - array[
        'operation', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber',
        'submittedValues', 'finalValues', 'selectedGroupId', 'activityId', 'occurrenceId'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(item.value -> 'operation') is distinct from 'string'
      or item.value ->> 'operation' not in ('create', 'update', 'delete', 'restore')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'occurrenceId')
      or pg_catalog.jsonb_typeof(item.value -> 'submittedValues') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'finalValues') is distinct from 'object'
      or (item.value ->> 'operation' = 'create' and (
        item.value -> 'recordId' <> 'null'::jsonb
        or item.value -> 'expectedConcurrencyNumber' <> 'null'::jsonb
        or (item.value -> 'selectedGroupId' <> 'null'::jsonb
          and not vortex_platform.is_non_nil_uuid(item.value ->> 'selectedGroupId'))
      ))
      or (item.value ->> 'operation' <> 'create' and (
        not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') is distinct from 'number'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
        or item.value -> 'selectedGroupId' <> 'null'::jsonb
      ))
      or (item.value ->> 'operation' in ('delete', 'restore') and (
        item.value -> 'submittedValues' <> '{}'::jsonb or item.value -> 'finalValues' <> '{}'::jsonb
      ))
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' <> 'create'
    group by item.value -> 'recordTypeId', item.value -> 'recordId'
    having pg_catalog.count(*) > 1
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' <> 'create'
      and (item.value ->> 'expectedConcurrencyNumber')::bigint not between 1 and 9007199254740990
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  perform vortex_access.validated_human_request_context();
  receipt := vortex_record.lock_command_receipt_internal('record_changes', p_command_id);
  if receipt.command_id is null or receipt.result is not null then
    raise exception using errcode = '42501', message = 'Record set receipt is unavailable';
  end if;

  -- Existing row locks are acquired in stable record-type/record identity order.
  -- Creation identities are allocated by the private create preparation itself.
  for subject, ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordTypeId')::uuid,
      (item.value ->> 'recordId')::uuid nulls last, item.ordinality
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
    );
    if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or (subject ->> 'operation' in ('create', 'update')
        and not coalesce((meta #> '{recordType,standardActions}') ? (subject ->> 'operation'), false)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'index', ordinal, 'reasonCode', 'record_unavailable'
      );
    end if;
    if subject ->> 'operation' = 'create' then
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as key;
      prepared := vortex_record.prepare_record_create_internal(
        (subject ->> 'recordTypeId')::uuid, subject -> 'finalValues', submitted_fields,
        (subject ->> 'selectedGroupId')::uuid
      );
      if prepared ->> 'outcome' = 'prepared' then
        storage_changes := storage_changes || pg_catalog.jsonb_build_array(prepared -> 'storageChange');
        edge_changes := edge_changes || (prepared -> 'edgeChanges');
      end if;
    elsif subject ->> 'operation' = 'update' then
      prepared := vortex_record.prepare_record_update_internal(
        p_command_id, 'record_changes', (subject ->> 'recordTypeId')::uuid,
        (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
        subject -> 'submittedValues', subject -> 'finalValues', (subject ->> 'activityId')::uuid,
        null, meta
      );
      if prepared ->> 'outcome' = 'allowed' then
        storage_changes := storage_changes || pg_catalog.jsonb_build_array(prepared -> 'storageChange');
        edge_changes := edge_changes || (prepared -> 'edgeChanges');
      end if;
    elsif subject ->> 'operation' = 'delete' then
      prepared := vortex_record.prepare_record_delete_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, array[]::text[]
      );
      storage_changes := storage_changes || (prepared -> 'storageChanges');
      edge_changes := edge_changes || (prepared -> 'edgeChanges');
      effects := effects || (prepared -> 'effects');
      prepared := prepared || pg_catalog.jsonb_build_object('outcome', 'prepared');
    else
      prepared := vortex_record.prepare_record_restore_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint
      );
      if prepared ->> 'outcome' = 'prepared' then
        storage_changes := storage_changes || (prepared -> 'storageChanges');
        for restore_subject in
          select item.value from pg_catalog.jsonb_array_elements(prepared -> 'subjects') as item(value)
        loop
          effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'effectKind', case when (restore_subject ->> 'deleted')::boolean then 'restored' else 'links_restored' end,
            'storageContractId', restore_subject -> 'storageContractId',
            'recordTypeId', restore_subject -> 'recordTypeId', 'recordId', restore_subject -> 'recordId',
            'preConcurrencyNumber', restore_subject -> 'expectedConcurrencyNumber',
            'relationshipId', null, 'previousValue', null,
            'restoresCommandId', prepared -> 'deleteCommandId',
            'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId'
            ))
          ));
        end loop;
      end if;
    end if;
    if prepared ->> 'outcome' not in ('allowed', 'prepared') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'subject', prepared);
    end if;
    plans := plans || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'index', ordinal, 'subject', subject, 'meta', meta, 'prepared', prepared
    ));
  end loop;

  -- Overlapping delete closures can repeat the same field delta. Conflicting
  -- explicit intentions are refused before any physical record is written.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
    cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
    group by item.value -> 'storageContractId', item.value -> 'recordId', field.key
    having pg_catalog.count(distinct field.value) > 1
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      item.value -> 'targetStorageContractId', item.value -> 'targetRecordId'
    )) > 1
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
  end if;
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.value ->> 'relationshipId',
    candidate.value ->> 'sourceStorageContractId', candidate.value ->> 'sourceRecordId'), '[]'::jsonb)
  into normalized_edges
  from (
    select distinct on (item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId')
      item.value
    from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    order by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
  ) as candidate;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'plans', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'index')::integer)
      from pg_catalog.jsonb_array_elements(plans) as item(value)),
    'storageChanges', vortex_record.combine_record_storage_changes_internal(storage_changes),
    'edgeChanges', normalized_edges, 'effects', effects
  );
end
$function$;
alter function vortex_record.prepare_record_change_set_internal(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_change_set_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_change_set_internal(uuid,jsonb) is
  'Private closed preparation of up to 200 record intents under one claimed set receipt; reuses create, update and lifecycle authority checks, gathers closure effects, and combines compatible deltas for one physical write per storage table.';
