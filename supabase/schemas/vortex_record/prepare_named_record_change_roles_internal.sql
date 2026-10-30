create or replace function vortex_record.prepare_named_record_change_roles_internal(
  p_subjects jsonb,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_reference jsonb;
  named_subject jsonb;
  named_position integer;
  slice jsonb;
  prepared jsonb;
  action_context jsonb;
  roles jsonb := '{}'::jsonb;
  subjects jsonb := '[]'::jsonb;
  intent_index integer;
  slice_position integer;
  creation_position integer;
  role text;
  covered integer[] := array[]::integer[];
begin
  if pg_catalog.jsonb_typeof(p_named) is distinct from 'object'
    or not (p_named ?& array['action', 'recordTypeId', 'subjects'])
    or p_named - array['action', 'recordTypeId', 'subjects']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_named -> 'subjects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_named -> 'subjects') not between 1 and 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['recordId', 'expectedConcurrencyNumber', 'inputs',
          'intentIndexes', 'activityId', 'declaredOccurrenceIds'])
        or item.value - array['recordId', 'expectedConcurrencyNumber', 'inputs',
          'intentIndexes', 'activityId', 'declaredOccurrenceIds']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
        or pg_catalog.jsonb_typeof(item.value -> 'intentIndexes') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'declaredOccurrenceIds') is distinct from 'array'
        or exists (select 1 from pg_catalog.jsonb_array_elements(item.value -> 'intentIndexes') as entry(value)
          where pg_catalog.jsonb_typeof(entry.value) is distinct from 'number'
            or not coalesce(pg_catalog.pg_input_is_valid(entry.value #>> '{}', 'integer'), false)
            or (entry.value #>> '{}')::integer not between 0 and pg_catalog.jsonb_array_length(p_subjects) - 1)
        or exists (select 1 from pg_catalog.jsonb_array_elements(item.value -> 'declaredOccurrenceIds') as entry(value)
          where not vortex_platform.is_non_nil_uuid(entry.value #>> '{}'))
    )
    or (select pg_catalog.count(distinct pg_catalog.lower(item.value ->> 'recordId'))
      from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value))
      <> pg_catalog.jsonb_array_length(p_named -> 'subjects') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_reference := p_named -> 'action';
  -- Subjects are validated in record identity order so overlapping commands lock alike.
  for named_subject, named_position in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_named -> 'subjects') with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordId')::uuid
  loop
    select coalesce(pg_catalog.jsonb_agg(p_subjects -> (entry.value #>> '{}')::integer order by entry.ordinality), '[]'::jsonb)
    into slice
    from pg_catalog.jsonb_array_elements(named_subject -> 'intentIndexes') with ordinality as entry(value, ordinality);
    prepared := vortex_record.prepare_named_record_change_intents_internal(
      pg_catalog.jsonb_build_object(
        'action', action_reference, 'recordTypeId', p_named -> 'recordTypeId',
        'recordId', named_subject -> 'recordId',
        'expectedConcurrencyNumber', named_subject -> 'expectedConcurrencyNumber',
        'inputs', named_subject -> 'inputs'
      ),
      slice
    );
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('namedIndex', named_position);
    end if;
    action_context := prepared -> 'actionContext';
    if pg_catalog.jsonb_array_length(named_subject -> 'declaredOccurrenceIds')
      <> pg_catalog.jsonb_array_length(coalesce(action_context -> 'eventDescriptors', '[]'::jsonb)) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid',
        'namedIndex', named_position);
    end if;
    creation_position := 0;
    for intent_index, slice_position in
      select (entry.value #>> '{}')::integer, (entry.ordinality - 1)::integer
      from pg_catalog.jsonb_array_elements(named_subject -> 'intentIndexes') with ordinality as entry(value, ordinality)
    loop
      if intent_index = any(covered) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
      end if;
      covered := pg_catalog.array_append(covered, intent_index);
      role := prepared #>> array['intentRoles', slice_position::text];
      roles := roles || pg_catalog.jsonb_build_object(intent_index::text, pg_catalog.jsonb_build_object(
        'role', role, 'named', named_position,
        'creation', case when role = 'creation' then pg_catalog.to_jsonb(creation_position) end
      ));
      if role = 'creation' then creation_position := creation_position + 1; end if;
    end loop;
    subjects := subjects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'position', named_position, 'recordId', named_subject -> 'recordId',
      'expectedConcurrencyNumber', named_subject -> 'expectedConcurrencyNumber',
      'activityId', named_subject -> 'activityId',
      'declaredOccurrenceIds', named_subject -> 'declaredOccurrenceIds',
      'deletes', exists (select 1 from pg_catalog.jsonb_array_elements(slice) as item(value)
        where item.value ->> 'operation' = 'delete'),
      'writesSubject', exists (select 1 from pg_catalog.jsonb_array_elements(slice) as item(value)
        where item.value ->> 'operation' = 'update'
          and item.value -> 'recordId' = named_subject -> 'recordId'),
      'action', action_reference || pg_catalog.jsonb_build_object('inputs', named_subject -> 'inputs'),
      'existingValues', prepared #> '{loaded,fieldValues}',
      'readableFieldIds', prepared #> '{bounds,readableFieldIds}',
      'createTargets', prepared -> 'createTargets'
    ));
  end loop;
  -- A named command carries only the effects its action declares: no other intent.
  if pg_catalog.cardinality(covered) <> pg_catalog.jsonb_array_length(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'roles', roles, 'actionContext', action_context,
    'recordTypeId', p_named -> 'recordTypeId',
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      (p_named ->> 'recordTypeId')::uuid
    ),
    'subjects', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'position')::integer)
      from pg_catalog.jsonb_array_elements(subjects) as item(value))
  );
end
$function$;
alter function vortex_record.prepare_named_record_change_roles_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_change_roles_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_record_change_roles_internal(jsonb,jsonb) is
  'Private named-command scope: for one installed action over up to 200 subjects, verifies each subject''s current action authority and revision and that every intent is one of that subject''s declared effects (subject write or delete, declared create, exact relationship copy), returning each intent''s role.';
