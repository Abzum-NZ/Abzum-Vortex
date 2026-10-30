create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_subjects jsonb,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  calculation jsonb;
  receipt jsonb;
  prepared jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  parent_record jsonb;
  parent_plan jsonb;
  parent_plans jsonb := '[]'::jsonb;
  reduced_values jsonb;
  catalogue jsonb;
  persisted jsonb;
  plan jsonb;
  subject jsonb;
  saved jsonb;
  projection jsonb;
  result_values jsonb := '[]'::jsonb;
  receipt_results jsonb := '[]'::jsonb;
  changed_fields uuid[];
  event_result jsonb;
  notice_sequence bigint;
  effective_command_id uuid;
  preview_installation jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  calculation := vortex_record.prepare_record_changes(p_command_id, p_subjects);
  if calculation ->> 'outcome' is distinct from 'prepared' then return calculation; end if;
  context_value := vortex_access.validated_human_request_context();
  preview_installation := vortex_record.read_current_preview_installation_internal();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  -- The writer independently derives the exact affected parent identities,
  -- revisions and generated fields; the caller cannot omit or add a parent.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId',
    'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
    'finalFieldIds', coalesce((select pg_catalog.jsonb_agg(field.value ->> 'fieldId' order by field.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(item.value #> '{recordType,fields}') as field(value)
      where field.value ->> 'type' in ('total', 'calculation')), '[]'::jsonb)
  ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'), '[]'::jsonb)
  into expected_parents
  from pg_catalog.jsonb_array_elements(calculation -> 'records') as item(value)
  where not exists (select 1 from pg_catalog.jsonb_array_elements(calculation -> 'subjects') as root(value)
    where root.value -> 'recordKey' = item.value -> 'recordKey');
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId',
    'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
    'finalFieldIds', coalesce((select pg_catalog.jsonb_agg(field.key order by field.key)
      from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(key)), '[]'::jsonb)
  ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'), '[]'::jsonb)
  into supplied_parents
  from pg_catalog.jsonb_array_elements(p_parent_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
  if supplied_parents is distinct from expected_parents
    or pg_catalog.jsonb_array_length(supplied_parents) <> pg_catalog.jsonb_array_length(p_parent_mutations) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_calculation_changed');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, false);
  if receipt ->> 'status' = 'completed' then
    return vortex_record.prepare_record_changes(p_command_id, p_subjects);
  elsif receipt ->> 'status' is distinct from 'claimed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_identity_conflict');
  end if;
  prepared := vortex_record.prepare_record_change_set_internal(effective_command_id, p_subjects);
  if prepared ->> 'outcome' is distinct from 'prepared' then
    perform vortex_record.release_command_receipt_internal('record_changes', effective_command_id);
    return prepared;
  end if;
  catalogue := case when pg_catalog.jsonb_array_length(p_parent_mutations) > 0
    then vortex_record.relationship_total_catalogue_internal() else '{}'::jsonb end;
  for parent_value in select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) as item(value)
  loop
    select item.value into strict parent_record
    from pg_catalog.jsonb_array_elements(calculation -> 'records') as item(value)
    where item.value -> 'recordTypeId' = parent_value -> 'recordTypeId'
      and item.value -> 'recordId' = parent_value -> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(field.key, field.value), '{}'::jsonb) into reduced_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') as field(key, value)
    where field.value is distinct from coalesce(parent_record -> 'existingValues' -> field.key, 'null'::jsonb);
    parent_plan := vortex_record.prepare_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid, (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint, reduced_values, catalogue
    );
    if parent_plan is not null then
      parent_plans := parent_plans || pg_catalog.jsonb_build_array(parent_plan);
      prepared := pg_catalog.jsonb_set(prepared, '{storageChanges}',
        (prepared -> 'storageChanges') || pg_catalog.jsonb_build_array(parent_plan -> 'storageChange'));
    end if;
  end loop;
  persisted := vortex_record.apply_prepared_record_set_internal(prepared);
  for plan in select item.value from pg_catalog.jsonb_array_elements(prepared -> 'plans') as item(value)
    order by (item.value ->> 'index')::integer
  loop
    subject := plan -> 'subject';
    saved := persisted -> 'results' -> (plan ->> 'index')::integer;
    perform vortex_platform.attach_record_files_internal(
      (subject ->> 'recordTypeId')::uuid, (saved ->> 'recordId')::uuid,
      plan #> '{meta,recordType}', subject -> 'finalValues'
    );
    select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[]) into changed_fields
    from pg_catalog.jsonb_object_keys(case when subject ->> 'operation' = 'create'
      then saved -> 'values' else subject -> 'finalValues' end) as key;
    if preview_installation is null then
      perform vortex_record.append_record_activity_internal(
        (subject ->> 'activityId')::uuid,
        case when subject ->> 'operation' = 'create' then 'create_record' else 'update_record' end,
        array[(saved ->> 'recordId')::uuid], changed_fields, 'completed'
      );
      event_result := vortex_platform.append_record_occurrences(
        (plan #>> '{meta,storageContractId}')::uuid, (saved ->> 'recordId')::uuid,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', subject -> 'occurrenceId',
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'recordTypeId', subject -> 'recordTypeId',
            'eventKind', case when subject ->> 'operation' = 'create' then 'created' else 'changed' end
          ),
          'payload', case when subject ->> 'operation' = 'create'
            then pg_catalog.jsonb_build_object('kind', 'created')
            else pg_catalog.jsonb_build_object('kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_fields)) end
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array'
        or pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000', message = 'Record change Event append failed';
      end if;
      if subject ->> 'operation' = 'update' and (
        plan #>> '{meta,storageScope}' = 'application_contained'
        or plan #>> '{meta,recordType,systemProjection,protectedView}' = 'organization_runtime_settings'
      ) then
        begin
          notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
          perform vortex_platform.publish_change_notice(
            (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
            (subject ->> 'recordTypeId')::uuid, (saved ->> 'recordId')::uuid,
            (saved ->> 'concurrencyNumber')::bigint, 'changed', notice_sequence, notice_sequence,
            (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          raise warning 'Record change notice failed: [%] %', sqlstate, sqlerrm;
        end;
      end if;
    end if;
    projection := (vortex_record.read_record(
      (subject ->> 'recordTypeId')::uuid, (saved ->> 'recordId')::uuid
    )) -> 'record';
    if projection ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501', message = 'Changed record projection is unavailable';
    end if;
    receipt_results := receipt_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', subject -> 'recordTypeId', 'recordId', saved -> 'recordId',
      'concurrencyNumber', saved -> 'concurrencyNumber'
    ));
    result_values := result_values || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'outcome', 'saved', 'recordTypeId', subject -> 'recordTypeId', 'recordId', saved -> 'recordId',
      'concurrencyNumber', saved -> 'concurrencyNumber', 'values', projection -> 'values',
      'correlationId', context_value -> 'correlationId',
      'backgroundDelivery', case when preview_installation is null then 'pending' else 'none' end,
      'replayed', false
    ));
  end loop;
  for parent_plan in select item.value from pg_catalog.jsonb_array_elements(parent_plans) as item(value)
  loop
    perform vortex_record.complete_relationship_total_parent_internal(parent_plan);
  end loop;
  perform vortex_record.complete_command_receipt_internal(
    'record_changes', effective_command_id, pg_catalog.jsonb_build_object('results', receipt_results),
    'Record change receipt is stale'
  );
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', result_values, 'replayed', false,
    'recordCount', calculation -> 'recordCount');
end
$function$;
alter function vortex_record.apply_record_changes(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_record_changes(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(uuid,jsonb,jsonb) to vortex_request;
comment on function vortex_record.apply_record_changes(uuid,jsonb,jsonb) is
  'Protected record-set persistence: revalidates the combined calculation graph and all current authority, claims one receipt, merges roots and generated parents once per storage table, appends effects and completes the whole result atomically.';
