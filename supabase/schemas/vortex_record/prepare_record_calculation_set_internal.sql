create or replace function vortex_record.prepare_record_calculation_set_internal(p_subjects jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  subject jsonb;
  subject_index integer;
  root_key text;
  roots jsonb := '[]'::jsonb;
  root_keys text[] := array[]::text[];
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  loaded jsonb;
  decision jsonb;
  prepared jsonb;
  subjects jsonb := '[]'::jsonb;
  proposals jsonb;
  graph jsonb;
  meta jsonb;
  projection_records jsonb := '[]'::jsonb;
  preview_installation jsonb;
begin
  if not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  catalogue := case when preview_installation is null
    then vortex_record.relationship_total_catalogue_internal() else '{}'::jsonb end;
  -- Authorize every explicit source before reading or locking its dependencies.
  -- A null expected revision is the existing loader's non-locking read mode.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'index', subject_index, 'reasonCode', 'operation_unavailable'
      );
    end if;
    meta := vortex_record.resolve_record_action_context_internal(
      (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
    );
    if preview_installation is not null or meta -> 'recordType' ? 'systemProjection' then
      prepared := vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
      );
      if prepared ->> 'outcome' is distinct from 'prepared' then
        return prepared || pg_catalog.jsonb_build_object('index', subject_index);
      end if;
      projection_records := projection_records || pg_catalog.jsonb_build_array(
        prepared || pg_catalog.jsonb_build_object(
          'recordKey', 'intent:' || subject_index::text, 'recordTypeId', subject -> 'recordTypeId',
          'canRead', true, 'relationshipSources', '[]'::jsonb
        ) || case when subject ->> 'operation' = 'create' then '{}'::jsonb
          else pg_catalog.jsonb_build_object('recordId', subject -> 'recordId',
            'concurrencyNumber', subject -> 'expectedConcurrencyNumber') end
      );
      continue;
    end if;
    if subject ->> 'operation' = 'update' then
      loaded := vortex_record.load_record_access_facts_internal(
        (subject ->> 'recordTypeId')::uuid, 'update', (subject ->> 'recordId')::uuid, null, null
      );
      if loaded ->> 'outcome' is distinct from 'loaded'
        or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', (subject ->> 'recordId')::uuid, loaded -> 'facts'
      );
      if decision ->> 'outcome' is distinct from 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      if (loaded ->> 'concurrencyNumber')::bigint
        is distinct from (subject ->> 'expectedConcurrencyNumber')::bigint then
        return pg_catalog.jsonb_build_object('outcome', 'conflict', 'index', subject_index);
      end if;
    else
      prepared := vortex_record.prepare_record_values_internal(
        'create', (subject ->> 'recordTypeId')::uuid, null, null, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
      );
      if prepared ->> 'outcome' is distinct from 'prepared' then
        return prepared || pg_catalog.jsonb_build_object('index', subject_index);
      end if;
    end if;
    root_key := 'intent:' || subject_index::text;
    roots := roots || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', root_key, 'operation', subject -> 'operation',
      'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId',
      'values', subject -> 'submittedValues'
    ));
    root_keys := pg_catalog.array_append(root_keys, root_key);
  end loop;
  before_closure := vortex_record.record_change_total_closure_internal(catalogue, roots);
  if before_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
  end if;
  if before_closure ->> 'outcome' = 'refused' then return before_closure; end if;
  if (before_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records) > 1000 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_change_too_large');
  end if;
  for record_value in
    select item.value from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue, (record_value ->> 'recordTypeId')::uuid, (record_value ->> 'recordId')::uuid, true
    ) is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;
  after_closure := vortex_record.record_change_total_closure_internal(catalogue, roots);
  if after_closure ->> 'outcome' = 'refused' then return after_closure; end if;
  if after_closure is null or before_closure -> 'signatures' is distinct from after_closure -> 'signatures'
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- Reuse current access, field policy, metadata and rule preparation after the
  -- complete concrete union is locked. No record or receipt is written here.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    prepared := vortex_record.prepare_record_values_internal(
      subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
      (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
      (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
    );
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('index', subject_index);
    end if;
    subjects := subjects || pg_catalog.jsonb_build_array(prepared || pg_catalog.jsonb_build_object(
      'recordKey', 'intent:' || subject_index::text, 'index', subject_index
    ));
  end loop;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordKey', record.value -> 'recordKey', 'recordTypeId', root.value -> 'recordTypeId',
    'recordId', root.value -> 'recordId', 'values', (record.value -> 'existingValues') || (root.value -> 'values'),
    'lifecycleState', 'active'
  )), '[]'::jsonb) into proposals
  from pg_catalog.jsonb_array_elements(roots) as root(value)
  join pg_catalog.jsonb_array_elements(after_closure -> 'records') as record(value)
    on root.value -> 'recordKey' = record.value -> 'recordKey';
  graph := vortex_record.prepare_record_calculation_graph_internal(
    catalogue, after_closure -> 'records', proposals, root_keys
  );
  if graph ->> 'outcome' is distinct from 'prepared' then return graph; end if;
  return graph || pg_catalog.jsonb_build_object(
    'records', (graph -> 'records') || projection_records,
    'subjects', subjects, 'correlationId', context_value -> 'correlationId',
    'preview', preview_installation is not null,
    'readableFieldIds', '[]'::jsonb,
    'recordCount', (after_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records)
  );
end
$function$;
alter function vortex_record.prepare_record_calculation_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_calculation_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_calculation_set_internal(jsonb) is
  'Private create/update set calculation preflight: authorizes roots, locks their complete dependency union in concrete identity order, repeats current authority and revisions, and returns one rule and total graph.';
