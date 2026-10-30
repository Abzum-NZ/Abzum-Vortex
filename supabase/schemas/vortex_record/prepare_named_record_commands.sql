create or replace function vortex_record.prepare_named_record_commands(
  p_command_id uuid,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  effective_command_id uuid;
  receipt jsonb;
  action_reference jsonb;
  action_context jsonb;
  named_subject jsonb;
  named_position integer;
  prepared jsonb;
  subjects jsonb := '[]'::jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or pg_catalog.jsonb_typeof(p_named) is distinct from 'object'
    or not (p_named ?& array['action', 'recordTypeId', 'subjects'])
    or p_named - array['action', 'recordTypeId', 'subjects']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_named -> 'action') is distinct from 'object'
    or not ((p_named -> 'action') ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId'])
    or (p_named -> 'action') - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId']::text[] <> '{}'::jsonb
    or p_named #>> '{action,ownerKind}' not in ('application', 'module')
    or not vortex_platform.is_non_nil_uuid(p_named #>> '{action,ownerId}')
    or not vortex_platform.is_non_nil_uuid(p_named #>> '{action,actionId}')
    or not coalesce(pg_catalog.pg_input_is_valid(p_named #>> '{action,releaseRevision}', 'bigint'), false)
    or pg_catalog.jsonb_typeof(p_named -> 'subjects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_named -> 'subjects') not between 1 and 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['recordId', 'expectedConcurrencyNumber', 'inputs', 'activityId'])
        or item.value - array['recordId', 'expectedConcurrencyNumber', 'inputs', 'activityId']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
        or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint'), false)
        or pg_catalog.jsonb_typeof(item.value -> 'inputs') is distinct from 'object'
    )
    or (select pg_catalog.count(distinct pg_catalog.lower(item.value ->> 'recordId'))
      from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value))
      <> pg_catalog.jsonb_array_length(p_named -> 'subjects') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, true);
  if receipt ->> 'status' = 'completed' then
    return vortex_record.replay_record_changes_internal(effective_command_id, receipt -> 'result');
  elsif receipt ->> 'status' <> 'none' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId');
  end if;
  action_reference := p_named -> 'action';
  action_context := vortex_record.resolve_named_action_context_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named ->> 'recordTypeId')::uuid
  );
  -- Subjects are locked in record identity order; the results keep the order given.
  for named_subject, named_position in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_named -> 'subjects') with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordId')::uuid
  loop
    prepared := vortex_record.prepare_named_action_subject_internal(
      false, action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
      (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
      (p_named ->> 'recordTypeId')::uuid, (named_subject ->> 'recordId')::uuid,
      (named_subject ->> 'expectedConcurrencyNumber')::bigint, named_subject -> 'inputs', null, action_context
    );
    if prepared ->> 'outcome' = 'subject_permission_refused' then
      perform vortex_record.append_record_activity_internal((named_subject ->> 'activityId')::uuid,
        'execute_named_action', array[(named_subject ->> 'recordId')::uuid], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded', 'namedIndex', named_position,
        'correlationId', context_value -> 'correlationId');
    end if;
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('namedIndex', named_position,
        'correlationId', context_value -> 'correlationId');
    end if;
    subjects := subjects || pg_catalog.jsonb_build_array(prepared || pg_catalog.jsonb_build_object(
      'position', named_position, 'concurrencyNumber', named_subject -> 'expectedConcurrencyNumber'));
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'correlationId', context_value -> 'correlationId',
    'subjects', (select pg_catalog.jsonb_agg(item.value - 'position' order by (item.value ->> 'position')::integer)
      from pg_catalog.jsonb_array_elements(subjects) as item(value)));
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
end
$function$;
alter function vortex_record.prepare_named_record_commands(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_commands(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_record_commands(uuid,jsonb) to vortex_request;
comment on function vortex_record.prepare_named_record_commands(uuid,jsonb) is
  'Protected named-command preflight for one installed action over up to 200 subjects: replays a completed command, or locks each subject at its expected revision and returns what its action flow composes from (facts, declared creates and relationship copies), writing only the refused Activity of a subject the action may not act on.';
