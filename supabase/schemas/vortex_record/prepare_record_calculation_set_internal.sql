create or replace function vortex_record.prepare_record_calculation_set_internal(
  p_subjects jsonb,
  p_named_roles jsonb
)
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
  prepared_subjects jsonb[] := array[]::jsonb[];
  proposals jsonb;
  graph jsonb;
  meta jsonb;
  projection_records jsonb := '[]'::jsonb;
  preview_installation jsonb;
  lifecycle jsonb;
  named_prepared jsonb;
  meta_cache jsonb := '{}'::jsonb;
  cache_key text;
  update_targets jsonb := '[]'::jsonb;
  update_indexes integer[] := array[]::integer[];
  update_loaded jsonb := '{}'::jsonb;
  update_decisions jsonb := '{}'::jsonb;
  loaded_set jsonb;
  decision_set jsonb;
  set_position integer;
  target_position integer;
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
  lifecycle := vortex_record.prepare_record_lifecycle_set_internal(p_subjects);
  if lifecycle ->> 'outcome' is distinct from 'prepared' then return lifecycle; end if;
  catalogue := catalogue || pg_catalog.jsonb_build_object('proposedRecords', lifecycle -> 'snapshots');
  roots := lifecycle -> 'roots';
  subjects := lifecycle -> 'subjects';
  select coalesce(pg_catalog.array_agg(item.value ->> 'recordKey'), array[]::text[]) into root_keys
  from pg_catalog.jsonb_array_elements(subjects) as item(value);
  -- Resolve each record type's context once, and decide the access of every plain update
  -- source with one facts load and one decision for the whole set.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      continue;
    end if;
    cache_key := (subject ->> 'recordTypeId') || ':' || (subject ->> 'operation');
    if not meta_cache ? cache_key then
      meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
        vortex_record.resolve_record_action_context_internal(
          (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
        ));
    end if;
    if subject ->> 'operation' = 'update' and preview_installation is null
      and not (meta_cache -> cache_key -> 'recordType' ? 'systemProjection')
      and vortex_record.named_record_change_values_internal(p_named_roles, subject_index) is null then
      update_targets := update_targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId'
      ));
      update_indexes := pg_catalog.array_append(update_indexes, subject_index);
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(update_targets) > 0 then
    loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'declaration', loaded.value -> 'declaration',
        'recordId', update_targets -> (loaded.ordinality - 1)::integer -> 'recordId',
        'facts', loaded.value -> 'facts'
      ) order by loaded.ordinality)
    into decision_set
    from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality)
    where loaded.value ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(loaded.value -> 'declaration') = 'object';
    if decision_set is not null then
      decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
    end if;
    set_position := 0;
    for target_position in 1 .. pg_catalog.jsonb_array_length(loaded_set) loop
      update_loaded := update_loaded || pg_catalog.jsonb_build_object(
        update_indexes[target_position]::text, loaded_set -> (target_position - 1)
      );
      if loaded_set -> (target_position - 1) ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded_set -> (target_position - 1) -> 'declaration') = 'object' then
        update_decisions := update_decisions || pg_catalog.jsonb_build_object(
          update_indexes[target_position]::text, decision_set -> set_position
        );
        set_position := set_position + 1;
      end if;
    end loop;
  end if;
  -- Authorize every explicit source before reading or locking its dependencies.
  -- A null expected revision is the existing loader's non-locking read mode.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      continue;
    end if;
    named_prepared := vortex_record.named_record_change_values_internal(p_named_roles, subject_index);
    meta := meta_cache -> ((subject ->> 'recordTypeId') || ':' || (subject ->> 'operation'));
    if preview_installation is not null or meta -> 'recordType' ? 'systemProjection' then
      prepared := coalesce(named_prepared, vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
      ));
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
    if named_prepared is not null then
      -- The action's own authority and revision were verified with the named scope.
      null;
    elsif subject ->> 'operation' = 'update' then
      loaded := update_loaded -> subject_index::text;
      if loaded ->> 'outcome' is distinct from 'loaded'
        or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      decision := update_decisions -> subject_index::text;
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
      -- A plain create has no stored record to authorize here; its values are prepared once
      -- below, after the closure is locked.
      null;
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
    if subject ->> 'operation' not in ('create', 'update') then continue; end if;
    prepared := coalesce(
      vortex_record.named_record_change_values_internal(p_named_roles, subject_index),
      vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
      )
    );
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('index', subject_index);
    end if;
    prepared_subjects := pg_catalog.array_append(prepared_subjects, prepared || pg_catalog.jsonb_build_object(
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
    on root.value -> 'recordKey' = record.value -> 'recordKey'
  where not exists (select 1 from pg_catalog.jsonb_array_elements(lifecycle -> 'proposals') as changed(value)
    where changed.value -> 'recordKey' = root.value -> 'recordKey');
  proposals := proposals || (lifecycle -> 'proposals');
  -- Restored records calculate from the recovered values, while their rule
  -- execution retains the stored deleted snapshot supplied in lifecycleChanges.
  select pg_catalog.jsonb_agg(case when changed.value ->> 'operation' = 'restore'
      then item.value || pg_catalog.jsonb_build_object('existingValues', changed.value -> 'proposedValues')
      else item.value end order by item.value ->> 'recordKey') into prepared
  from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
  left join pg_catalog.jsonb_array_elements(lifecycle -> 'changes') as changed(value)
    on changed.value -> 'recordKey' = item.value -> 'recordKey';
  graph := vortex_record.prepare_record_calculation_graph_internal(
    catalogue, coalesce(prepared, '[]'::jsonb), proposals, root_keys
  );
  if graph ->> 'outcome' is distinct from 'prepared' then return graph; end if;
  return graph || pg_catalog.jsonb_build_object(
    'records', (graph -> 'records') || projection_records,
    'subjects', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'index')::integer)
      from (select existing.value from pg_catalog.jsonb_array_elements(subjects) as existing(value)
        union all select added.value from pg_catalog.unnest(prepared_subjects) as added(value)) as item(value)),
    'lifecycleChanges', lifecycle -> 'changes', 'lifecycleProposals', lifecycle -> 'proposals',
    'correlationId', context_value -> 'correlationId',
    'preview', preview_installation is not null,
    'readableFieldIds', '[]'::jsonb,
    'recordCount', (after_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records)
  );
end
$function$;
alter function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb) is
  'Private record-set calculation preflight: authorizes roots (a named command''s subject and declared creates by its action) and lifecycle closures, locks their complete dependency union, repeats current authority and revisions, and returns one rule and total graph for all four intents.';
