create or replace function vortex_record.apply_action_record_changes(
  p_record_type_id uuid,
  p_action jsonb,
  p_subjects jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  subject jsonb;
  subject_index integer;
  subject_result jsonb;
  results jsonb := '[]'::jsonb;
begin
  -- The request role reaches the one record-change operation only through a
  -- named action's identity. The ordinary save and its relationship-total
  -- preparation keep their own entry points, so a caller can never skip them by
  -- calling the operation without an action.
  if p_action is null
    or pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
    or p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) not between 1 and 200 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  -- Every subject is closed: one record, its displayed revision, its composed
  -- values and mutations, and the identities of its own command, Activity and
  -- standard Event.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array[
        'commandId', 'recordId', 'expectedConcurrencyNumber', 'submittedValues',
        'mutations', 'activityId', 'occurrenceId'
      ])
      or item.value - array[
        'commandId', 'recordId', 'expectedConcurrencyNumber', 'submittedValues',
        'mutations', 'activityId', 'occurrenceId'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(item.value -> 'commandId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid')
      or pg_catalog.jsonb_typeof(item.value -> 'recordId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(item.value ->> 'recordId', 'uuid')
      or pg_catalog.jsonb_typeof(item.value -> 'activityId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(item.value ->> 'activityId', 'uuid')
      or pg_catalog.jsonb_typeof(item.value -> 'occurrenceId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(item.value ->> 'occurrenceId', 'uuid')
      or pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
      or pg_catalog.jsonb_typeof(item.value -> 'submittedValues') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'mutations') is distinct from 'array'
  ) or (
    select pg_catalog.count(distinct (item.value ->> 'recordId')::uuid)
    from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
  ) <> pg_catalog.jsonb_array_length(p_subjects)
  or (
    select pg_catalog.count(distinct (item.value ->> 'commandId')::uuid)
    from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
  ) <> pg_catalog.jsonb_array_length(p_subjects) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  -- Subjects are applied in record identity order, whatever order the caller
  -- listed them in, so two overlapping bulk transactions lock rows in the same
  -- order and cannot deadlock. The first refusal returns at once: the caller
  -- owns the transaction and rolls every subject back.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects)
      with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordId')::uuid
  loop
    subject_result := vortex_record.apply_record_changes(
      (subject ->> 'commandId')::uuid, 'update', p_record_type_id,
      (subject ->> 'recordId')::uuid,
      (subject ->> 'expectedConcurrencyNumber')::bigint,
      subject -> 'submittedValues', null, subject -> 'mutations',
      (subject ->> 'activityId')::uuid, (subject ->> 'occurrenceId')::uuid,
      p_action
    );
    if subject_result ->> 'outcome' not in ('saved', 'completed') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'index', subject_index, 'subject', subject_result
      );
    end if;
    results := results || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('index', subject_index, 'result', subject_result)
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'results', (
      select pg_catalog.jsonb_agg(item.value -> 'result' order by (item.value ->> 'index')::integer)
      from pg_catalog.jsonb_array_elements(results) as item(value)
    )
  );
end
$function$;

alter function vortex_record.apply_action_record_changes(uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_action_record_changes(
  uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_action_record_changes(
  uuid, jsonb, jsonb
) to vortex_runtime;

comment on function vortex_record.apply_action_record_changes(
  uuid, jsonb, jsonb
) is
  'The named-action entry to the one protected apply_record_changes operation: refuses a call without an action identity, then applies one to 200 subjects of one record type and one action in record identity order, each with its own revision check, receipt, Activity and Events, in the caller''s one transaction; the first refusal is returned with its subject index and the caller rolls every subject back.';
