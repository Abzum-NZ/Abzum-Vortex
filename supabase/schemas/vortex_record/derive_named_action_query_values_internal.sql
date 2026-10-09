create or replace function vortex_record.derive_named_action_query_values_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_module_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  action_value jsonb;
  task_value jsonb;
  node_value jsonb;
  field_key text;
  field_value jsonb;
  settings_value jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  initial_context jsonb;
  current_context jsonb;
  query_plan jsonb;
  query_value jsonb;
  initial_plan jsonb;
  page_value jsonb;
  row_value jsonb;
  cursor_value jsonb := null;
  next_value jsonb;
  seen_cursors jsonb[] := array[]::jsonb[];
  seen_rows uuid[] := array[]::uuid[];
  row_id uuid;
  row_revision bigint;
  row_decimal jsonb;
  decimal_text text;
  maximum_value numeric;
  result_value numeric;
  result_text text;
  subject_seen boolean := false;
  page_number integer;
  page_size_value integer;
  node_count integer;
  digits_value integer;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_module_release_revision,
    p_action_id, p_record_type_id
  );
  action_value := action_context -> 'action';
  select pg_catalog.count(*) into node_count
  from pg_catalog.jsonb_array_elements(action_value -> 'tasks') task(value)
  cross join lateral pg_catalog.jsonb_each(coalesce(task.value #> '{properties,values}', '{}'::jsonb)) entry
  where entry.value ->> 'kind' = 'protected_query_decimal_max_plus_quantum';
  if node_count = 0 then return '[]'::jsonb; end if;

  -- One fixed action-only reduction; no caller selectors, other effects or preview fallback.
  if p_action_owner_kind is distinct from 'module' or node_count <> 1
    or action_value ->> 'sharing' is distinct from 'refused'
    or pg_catalog.jsonb_array_length(action_value -> 'tasks') <> 1
    or action_value -> 'inputs' is distinct from '[]'::jsonb
    or action_context ->> 'moduleRootId' is distinct from p_action_owner_id::text
    or (action_context ->> 'moduleReleaseRevision')::bigint is distinct from p_module_release_revision
    or action_context -> 'recordType' ? 'systemProjection' then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  task_value := action_value -> 'tasks' -> 0;
  if task_value ->> 'type' is distinct from 'record.set_fields'
    or pg_catalog.jsonb_typeof(task_value #> '{properties,values}') is distinct from 'object'
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(task_value #> '{properties,values}')) <> 1 then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  select entry.key, entry.value into strict field_key, node_value
  from pg_catalog.jsonb_each(task_value #> '{properties,values}') entry;
  if node_value - array['kind','queryId','fieldId','quantum']::text[] <> '{}'::jsonb
    or not (node_value ?& array['kind','queryId','fieldId','quantum'])
    or pg_catalog.jsonb_typeof(node_value -> 'queryId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(node_value -> 'fieldId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(node_value -> 'quantum') is distinct from 'string'
    or node_value ->> 'kind' is distinct from 'protected_query_decimal_max_plus_quantum'
    or node_value ->> 'fieldId' is distinct from field_key
    or pg_catalog.pg_input_is_valid(node_value ->> 'queryId', 'uuid') is distinct from true
    or pg_catalog.pg_input_is_valid(field_key, 'uuid') is distinct from true
    or node_value ->> 'quantum' is distinct from '0.000000000001' then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  select item.value into strict field_value
  from pg_catalog.jsonb_array_elements(action_context #> '{recordType,fields}') item(value)
  where item.value ->> 'fieldId' = field_key;
  settings_value := field_value -> 'settings';
  if field_value ->> 'type' is distinct from 'decimal_number'
    or (settings_value ->> 'decimalPlaces')::integer <> 12 then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  digits_value := (settings_value ->> 'digitsBeforeDecimal')::integer;
  if digits_value not between 1 and 30 then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  initial_context := vortex_access.validated_human_request_context();
  if initial_context ->> 'callerKind' is distinct from 'human'
    or pg_catalog.clock_timestamp() >= (initial_context ->> 'expiresAt')::timestamptz
    or pg_catalog.current_setting('transaction_isolation') is distinct from 'repeatable read' then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_module_release_revision, p_action_id,
    p_record_type_id, p_record_id, p_expected_revision
  );
  if loaded ->> 'outcome' is distinct from 'loaded' then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  if decision ->> 'outcome' is distinct from 'allowed'
    or (bounds -> 'readableFieldIds' ? field_key) is distinct from true
    or (bounds -> 'changeableFieldIds' ? field_key) is distinct from true then
    raise exception using errcode = '42501', message = 'Named action Query value is unavailable';
  end if;

  for page_number in 1..50 loop
    current_context := vortex_access.validated_human_request_context();
    if current_context is distinct from initial_context
      or pg_catalog.clock_timestamp() >= (current_context ->> 'expiresAt')::timestamptz then
      raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
    end if;
    query_plan := vortex_record.prepare_module_query_internal(
      p_action_owner_id, (node_value ->> 'queryId')::uuid, p_module_release_revision,
      '{}'::jsonb, null, '[]'::jsonb, 'resolution', null
    );
    query_value := query_plan -> 'query';
    if query_plan ->> 'outcome' is distinct from 'prepared' or query_plan ? 'preview'
      or (query_plan ->> 'recordTypeId')::uuid is distinct from p_record_type_id
      or query_value -> 'inputs' is distinct from '[]'::jsonb
      or query_value -> 'groupByFieldIds' is distinct from '[]'::jsonb
      or query_value -> 'aggregates' is distinct from '[]'::jsonb
      or (query_value ->> 'relationshipHops')::integer is distinct from 0
      or not (query_value -> 'selectedFieldIds' ? field_key) then
      raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
    end if;
    if initial_plan is null then initial_plan := query_plan;
    elsif query_plan is distinct from initial_plan then
      raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
    end if;
    page_size_value := (query_value ->> 'pageSize')::integer;
    if page_size_value not between 1 and 200 then
      raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
    end if;
    page_value := vortex_record.run_module_query(
      p_action_owner_id, (node_value ->> 'queryId')::uuid, p_module_release_revision,
      '{}'::jsonb, pg_catalog.jsonb_build_array(field_key), page_size_value,
      cursor_value, '[]'::jsonb, '{}'::jsonb
    );
    if page_value ->> 'outcome' is distinct from 'completed'
      or page_value -> 'moduleReleaseRevision' is distinct from query_plan #> '{resolved,moduleReleaseRevision}'
      or page_value -> 'moduleReleaseVersion' is distinct from query_plan #> '{resolved,moduleReleaseVersion}'
      or pg_catalog.jsonb_typeof(page_value -> 'rows') is distinct from 'array'
      or pg_catalog.jsonb_array_length(page_value -> 'rows') > page_size_value
      or not (page_value ? 'next') then
      raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
    end if;
    for row_value in select item.value from pg_catalog.jsonb_array_elements(page_value -> 'rows') item(value) loop
      if pg_catalog.jsonb_typeof(row_value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(row_value -> 'recordId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(row_value -> 'revision') is distinct from 'number'
        or pg_catalog.pg_input_is_valid(row_value ->> 'recordId', 'uuid') is distinct from true
        or pg_catalog.pg_input_is_valid(row_value ->> 'revision', 'bigint') is distinct from true
        or pg_catalog.jsonb_typeof(row_value -> 'values') is distinct from 'object'
        or not (row_value -> 'values' ? field_key) then
        raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
      end if;
      row_id := (row_value ->> 'recordId')::uuid;
      row_revision := (row_value ->> 'revision')::bigint;
      if row_id = '00000000-0000-0000-0000-000000000000'::uuid
        or row_id = any(seen_rows) or row_revision not between 1 and 9007199254740991
        or pg_catalog.cardinality(seen_rows) >= 10000 then
        raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
      end if;
      seen_rows := pg_catalog.array_append(seen_rows, row_id);
      if row_id = p_record_id then
        if row_revision is distinct from p_expected_revision then
          raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
        end if;
        subject_seen := true;
      end if;
      row_decimal := row_value -> 'values' -> field_key;
      if row_decimal <> 'null'::jsonb then
        decimal_text := row_decimal #>> '{}';
        if pg_catalog.jsonb_typeof(row_decimal) is distinct from 'string'
          or decimal_text !~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' or decimal_text = '-0'
          or not pg_catalog.pg_input_is_valid(decimal_text, 'numeric')
          or pg_catalog.scale(decimal_text::numeric) > 12
          or pg_catalog.abs(decimal_text::numeric) >= pg_catalog.power(10::numeric, digits_value)
          or (settings_value ? 'minimum' and decimal_text::numeric < (settings_value ->> 'minimum')::numeric)
          or (settings_value ? 'maximum' and decimal_text::numeric > (settings_value ->> 'maximum')::numeric) then
          raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
        end if;
        if row_id <> p_record_id then
          maximum_value := case when maximum_value is null then decimal_text::numeric
            else greatest(maximum_value, decimal_text::numeric) end;
        end if;
      end if;
    end loop;
    next_value := page_value -> 'next';
    if next_value = 'null'::jsonb then exit; end if;
    if page_number = 50 or pg_catalog.cardinality(seen_rows) >= 10000
      or pg_catalog.jsonb_typeof(next_value) is distinct from 'object'
      or next_value - array['sortKey','recordId']::text[] <> '{}'::jsonb
      or not (next_value ?& array['sortKey','recordId'])
      or pg_catalog.jsonb_typeof(next_value -> 'recordId') is distinct from 'string'
      or pg_catalog.pg_input_is_valid(next_value ->> 'recordId', 'uuid') is distinct from true
      or next_value ->> 'recordId' = '00000000-0000-0000-0000-000000000000'
      or pg_catalog.jsonb_typeof(next_value -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(next_value -> 'sortKey') <> pg_catalog.jsonb_array_length(query_value -> 'sort')
      or exists(select 1 from pg_catalog.jsonb_array_elements(next_value -> 'sortKey') item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string','null'))
      or next_value = any(seen_cursors) then
      raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
    end if;
    seen_cursors := pg_catalog.array_append(seen_cursors, next_value);
    cursor_value := next_value;
  end loop;
  current_context := vortex_access.validated_human_request_context();
  if not subject_seen or next_value is distinct from 'null'::jsonb
    or current_context is distinct from initial_context
    or pg_catalog.clock_timestamp() >= (current_context ->> 'expiresAt')::timestamptz then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  result_value := coalesce(maximum_value, 0::numeric) + 0.000000000001::numeric;
  if pg_catalog.abs(result_value) >= pg_catalog.power(10::numeric, digits_value)
    or (settings_value ? 'minimum' and result_value < (settings_value ->> 'minimum')::numeric)
    or (settings_value ? 'maximum' and result_value > (settings_value ->> 'maximum')::numeric) then
    raise exception using errcode = '55000', message = 'Named action Query value is unavailable';
  end if;
  result_text := pg_catalog.trim_scale(result_value)::text;
  return pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'taskId', task_value -> 'id', 'fieldId', field_key, 'value', result_text, 'node', node_value,
    'source', pg_catalog.jsonb_build_object(
      'moduleId', p_action_owner_id, 'moduleReleaseRevision', p_module_release_revision,
      'moduleReleaseVersion', initial_plan #> '{resolved,moduleReleaseVersion}',
      'queryId', node_value -> 'queryId', 'recordTypeId', p_record_type_id,
      'subjectRecordId', p_record_id, 'subjectRevision', p_expected_revision,
      'organizationAccountId', initial_context -> 'organizationAccountId',
      'accessVersion', initial_context -> 'accessVersion'
    )
  ));
end
$function$;

alter function vortex_record.derive_named_action_query_values_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;
revoke all on function vortex_record.derive_named_action_query_values_internal(text,uuid,bigint,uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_module_owner;
comment on function vortex_record.derive_named_action_query_values_internal(text,uuid,bigint,uuid,uuid,uuid,bigint) is
  'Owner-only action-bound complete installed Query decimal reduction at the fixed HUMAN repeatable-read snapshot; subject lock and current named field authority, at most fifty uncached pages and ten thousand rows, exact decimal maximum excluding the subject plus one fixed quantum, complete-or-unavailable with no raw rows, counts or maximum in its private preparation proof.';
