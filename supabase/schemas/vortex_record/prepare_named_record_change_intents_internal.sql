create or replace function vortex_record.prepare_named_record_change_intents_internal(
  p_named_action jsonb,
  p_subjects jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_reference jsonb;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  copy_plan jsonb;
  creation_plan jsonb;
  subject jsonb;
  subject_index integer;
  expected_fields jsonb;
  supplied_fields jsonb;
  root_fields jsonb;
  root_delete boolean;
  root_seen boolean := false;
  creation_tasks jsonb;
  creation_index integer := 0;
  creation_task jsonb;
  creations jsonb := '[]'::jsonb;
  copy_values jsonb;
  copied_targets uuid[] := array[]::uuid[];
  roles jsonb := '{}'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_named_action) is distinct from 'object'
    or not (p_named_action ?& array['action', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'inputs'])
    or p_named_action - array['action', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'inputs']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named_action ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(p_named_action ->> 'recordId')
    or not coalesce(pg_catalog.pg_input_is_valid(p_named_action ->> 'expectedConcurrencyNumber', 'bigint'), false)
    or (p_named_action ->> 'expectedConcurrencyNumber')::bigint not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_named_action -> 'inputs') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_reference := p_named_action -> 'action';
  if pg_catalog.jsonb_typeof(action_reference) is distinct from 'object'
    or not (action_reference ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId'])
    or action_reference - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId']::text[] <> '{}'::jsonb
    or action_reference ->> 'ownerKind' not in ('application', 'module')
    or not vortex_platform.is_non_nil_uuid(action_reference ->> 'ownerId')
    or not vortex_platform.is_non_nil_uuid(action_reference ->> 'actionId')
    or not coalesce(pg_catalog.pg_input_is_valid(action_reference ->> 'releaseRevision', 'bigint'), false)
    or (action_reference ->> 'releaseRevision')::bigint not between 1 and 9007199254740991 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_context := vortex_record.resolve_named_action_context_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid
  );
  loaded := vortex_record.load_named_action_facts_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, (p_named_action ->> 'recordId')::uuid,
    (p_named_action ->> 'expectedConcurrencyNumber')::bigint
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'stale_revision');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (p_named_action ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  if not vortex_record.validate_named_action_reference_inputs_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, p_named_action -> 'inputs'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_inputs_invalid');
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') as task(value)
    where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  select coalesce(pg_catalog.jsonb_agg(distinct field.key order by field.key), '[]'::jsonb)
  into root_fields
  from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') as task(value)
  cross join lateral pg_catalog.jsonb_object_keys(task.value #> '{properties,values}') as field(key)
  where task.value ->> 'type' = 'record.set_fields';
  root_delete := exists (select 1 from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') as task(value)
    where task.value ->> 'type' = 'record.delete');
  if root_delete and pg_catalog.jsonb_array_length(root_fields) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  select coalesce(pg_catalog.jsonb_agg(task.value || pg_catalog.jsonb_build_object('ordinal', task.ordinality - 1)
    order by task.ordinality), '[]'::jsonb) into creation_tasks
  from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') with ordinality as task(value, ordinality)
  where task.value ->> 'type' = 'record.create';
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, (p_named_action ->> 'recordId')::uuid,
    p_named_action -> 'inputs', action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then return copy_plan; end if;

  -- The four-intent shape stays unchanged. The exact installed action bounds which
  -- subject, creation and copy each intent represents; derived parents come from the graph.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
    into supplied_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key);
    if subject ->> 'operation' = 'create' then
      creation_task := creation_tasks -> creation_index;
      if creation_task is null or subject -> 'recordTypeId' is distinct from creation_task #> '{properties,recordType,recordTypeId}'
        or subject -> 'selectedGroupId' is distinct from 'null'::jsonb then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
      into expected_fields from pg_catalog.jsonb_object_keys(creation_task #> '{properties,values}') as field(key);
      if supplied_fields is distinct from expected_fields then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      creations := creations || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', creation_task -> 'ordinal', 'recordTypeId', subject -> 'recordTypeId',
        'values', subject -> 'submittedValues', 'finalValues', subject -> 'finalValues'
      ));
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'creation');
      creation_index := creation_index + 1;
    elsif subject -> 'recordTypeId' = p_named_action -> 'recordTypeId'
      and subject -> 'recordId' = p_named_action -> 'recordId' then
      if root_seen or subject -> 'expectedConcurrencyNumber' is distinct from p_named_action -> 'expectedConcurrencyNumber'
        or (root_delete and subject ->> 'operation' <> 'delete')
        or (not root_delete and (subject ->> 'operation' <> 'update' or pg_catalog.jsonb_array_length(root_fields) = 0))
        or supplied_fields is distinct from root_fields then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_subject_mismatch');
      end if;
      root_seen := true;
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'subject');
    else
      select pg_catalog.jsonb_object_agg(copy.value ->> 'fromFieldId', copy.value -> 'value')
      into copy_values from pg_catalog.jsonb_array_elements(coalesce(copy_plan -> 'copies', '[]'::jsonb)) as copy(value)
      where copy.value -> 'targetRecordId' = subject -> 'recordId';
      if subject ->> 'operation' <> 'update' or subject -> 'recordTypeId' is distinct from p_named_action -> 'recordTypeId'
        or copy_values is null or subject -> 'submittedValues' is distinct from copy_values
        or (subject ->> 'recordId')::uuid = any(copied_targets) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_copy_plan_mismatch');
      end if;
      copied_targets := pg_catalog.array_append(copied_targets, (subject ->> 'recordId')::uuid);
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'copy');
    end if;
  end loop;
  if root_seen is distinct from (root_delete or pg_catalog.jsonb_array_length(root_fields) > 0)
    or creation_index <> pg_catalog.jsonb_array_length(creation_tasks)
    or exists (select 1 from pg_catalog.jsonb_array_elements(coalesce(copy_plan -> 'copies', '[]'::jsonb)) as copy(value)
      where not ((copy.value ->> 'targetRecordId')::uuid = any(copied_targets))) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_missing');
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, creations, action_context
  );
  if creation_plan ->> 'outcome' is distinct from 'planned' then return creation_plan; end if;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'actionContext', action_context,
    'loaded', loaded, 'bounds', bounds, 'intentRoles', roles, 'createTargets', creation_plan -> 'createTargets');
end
$function$;

alter function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) is
  'Private named-command authority and intent scope: verifies the exact installed action, current subject permission and revision, declared creates, exact relationship copies and optional subject delete before the common record writer prepares its graph.';
