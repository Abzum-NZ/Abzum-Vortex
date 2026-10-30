create or replace function vortex_record.apply_prepared_record_set_internal(p_preparation jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
  edge_changes jsonb := p_preparation -> 'edgeChanges';
  written jsonb;
  plan jsonb;
  subject jsonb;
  restored_subject jsonb;
  restored_subjects jsonb := '[]'::jsonb;
  prepared jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  relationship_value jsonb;
  results jsonb := '[]'::jsonb;
  result_value jsonb;
begin
  if p_preparation ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_typeof(p_preparation -> 'plans') is distinct from 'array'
    or pg_catalog.jsonb_typeof(edge_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Prepared record set is invalid';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  storage_changes := vortex_record.combine_record_storage_changes_internal(p_preparation -> 'storageChanges');
  written := vortex_record.apply_record_storage_changes_internal(storage_changes);

  -- Restores can overlap, and generated totals can change the same row. Reload
  -- the combined persisted values rather than validate a root's partial copy.
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    where item.value #>> '{subject,operation}' = 'restore'
  loop
    for restored_subject in
      select item.value from pg_catalog.jsonb_array_elements(plan #> '{prepared,subjects}') as item(value)
    loop
      loaded := (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (restored_subject ->> 'recordTypeId')::uuid, 'recordId', (restored_subject ->> 'recordId')::uuid))) -> 0);
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '42501', message = 'Restored record is unavailable';
      end if;
      restored_subjects := restored_subjects || pg_catalog.jsonb_build_array(
        restored_subject || pg_catalog.jsonb_build_object(
          'values', loaded -> 'fieldValues'
        )
      );
    end loop;
  end loop;
  edge_changes := edge_changes || vortex_record.prepare_record_restore_edges_internal(restored_subjects);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      item.value -> 'targetStorageContractId', item.value -> 'targetRecordId'
    )) > 1
  ) then
    raise exception using errcode = '23514', message = 'Record relationship changes conflict';
  end if;
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.value ->> 'relationshipId',
    candidate.value ->> 'sourceStorageContractId', candidate.value ->> 'sourceRecordId'), '[]'::jsonb)
  into edge_changes
  from (
    select distinct on (item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId')
      item.value
    from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    order by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
  ) as candidate;
  perform vortex_record.apply_relationship_edges_internal(edge_changes);

  -- Every decision below sees the complete storage and relationship graph. A
  -- refusal raises, so callers cannot commit a partially authorized set.
  perform vortex_record.validate_record_restore_set_internal(restored_subjects);
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    order by (item.value ->> 'index')::integer
  loop
    subject := plan -> 'subject';
    prepared := plan -> 'prepared';
    meta := plan -> 'meta';
    if meta -> 'recordType' ? 'systemProjection' then
      result_value := vortex_access.change_organization_settings_record_internal(
        (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
        prepared -> 'coreValues', prepared -> 'extensionValues'
      );
      if result_value ->> 'outcome' is distinct from 'saved' then
        raise exception using errcode = '40001', message = 'Prepared settings record change was refused';
      end if;
      results := results || pg_catalog.jsonb_build_array(result_value || pg_catalog.jsonb_build_object(
        'recordId', subject -> 'recordId'
      ));
      continue;
    end if;
    if subject ->> 'operation' in ('create', 'update') then
      -- A different intent may have deleted or changed a link target since its
      -- preparation. Recheck target eligibility against the completed graph.
      for relationship_value in
        select item.value from pg_catalog.jsonb_array_elements(meta #> '{recordType,relationships}') as item(value)
        where (subject -> 'finalValues') ? (item.value ->> 'fromFieldId')
      loop
        if plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb then
          perform vortex_record.prepare_named_action_relationship_value_internal(
            (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid,
            (relationship_value ->> 'relationshipId')::uuid,
            subject -> 'finalValues' -> (relationship_value ->> 'fromFieldId'),
            plan #>> '{action,ownerKind}', (plan #>> '{action,ownerId}')::uuid,
            (plan #>> '{action,releaseRevision}')::bigint, (plan #>> '{action,actionId}')::uuid,
            (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid
          );
        else
          perform vortex_record.prepare_relationship_value_internal(
            (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid,
            (relationship_value ->> 'relationshipId')::uuid,
            subject -> 'finalValues' -> (relationship_value ->> 'fromFieldId'), false
          );
        end if;
      end loop;
    end if;
    if subject ->> 'operation' = 'create' then
      result_value := vortex_record.complete_record_create_internal(prepared);
    elsif subject ->> 'operation' = 'update' then
      if plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb then
        loaded := vortex_record.load_named_action_facts_internal(
          plan #>> '{action,ownerKind}', (plan #>> '{action,ownerId}')::uuid,
          (plan #>> '{action,releaseRevision}')::bigint, (plan #>> '{action,actionId}')::uuid,
          (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid, null
        );
      else
        loaded := (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (subject ->> 'recordTypeId')::uuid, 'recordId', (subject ->> 'recordId')::uuid))) -> 0);
      end if;
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '42501', message = 'Changed record is unavailable';
      end if;
      if preview_installation is null then
        decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', meta -> 'declaration', 'recordId', (subject ->> 'recordId')::uuid, 'facts', (loaded -> 'facts') || pg_catalog.jsonb_build_object('binding', meta #> '{declaration,recordBinding}')))) -> 0);
        if decision ->> 'outcome' is distinct from 'allowed' then
          raise exception using errcode = '42501', message = 'Changed record is unavailable';
        end if;
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
      else
        bounds := vortex_record.preview_record_field_bounds_internal(
          (subject ->> 'recordTypeId')::uuid, (meta ->> 'storageContractId')::uuid, meta -> 'recordType'
        );
        if bounds is null then
          raise exception using errcode = '42501', message = 'Changed record is unavailable';
        end if;
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key)
        where not (bounds -> 'changeableFieldIds') ? field.key
      ) then
        raise exception using errcode = '42501', message = 'Changed field is unavailable';
      end if;
      result_value := prepared - array['storageChange', 'edgeChanges']::text[];
    else
      result_value := pg_catalog.jsonb_build_object(
        'outcome', case subject ->> 'operation' when 'delete' then 'deleted' else 'restored' end,
        'recordId', subject -> 'recordId',
        'concurrencyNumber', (subject ->> 'expectedConcurrencyNumber')::bigint + 1
      );
    end if;
    results := results || pg_catalog.jsonb_build_array(result_value);
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', results, 'written', written);
end
$function$;
alter function vortex_record.apply_prepared_record_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_prepared_record_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_prepared_record_set_internal(jsonb) is
  'Private prepared-set persistence: one physical write per storage table and one edge write, followed by current authority and relationship checks over the complete graph; any refusal aborts the set.';
