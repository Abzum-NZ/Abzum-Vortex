create or replace function vortex_record.complete_named_record_subject_internal(
  p_named_roles jsonb,
  p_subject jsonb,
  p_field_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  field_values jsonb := p_field_values;
  loaded jsonb;
  event_result jsonb;
begin
  -- A subject write already recorded the action with its changed fields.
  if not (p_subject ->> 'writesSubject')::boolean then
    perform vortex_record.append_record_activity_internal(
      (p_subject ->> 'activityId')::uuid, 'execute_named_action',
      array[(p_subject ->> 'recordId')::uuid], array[]::uuid[], 'completed'
    );
  end if;
  if pg_catalog.jsonb_array_length(p_subject -> 'declaredOccurrenceIds') = 0 then
    return;
  end if;
  if field_values is null then
    loaded := vortex_record.load_named_action_facts_internal(
      p_subject #>> '{action,ownerKind}', (p_subject #>> '{action,ownerId}')::uuid,
      (p_subject #>> '{action,releaseRevision}')::bigint, (p_subject #>> '{action,actionId}')::uuid,
      (p_named_roles ->> 'recordTypeId')::uuid, (p_subject ->> 'recordId')::uuid, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded' then
      raise exception using errcode = '55000', message = 'Named action Event values are unavailable';
    end if;
    field_values := loaded -> 'fieldValues';
  end if;
  event_result := vortex_record.append_declared_named_action_occurrences_internal(
    (p_named_roles #>> '{actionContext,storageContractId}')::uuid, (p_subject ->> 'recordId')::uuid,
    p_named_roles #> '{actionContext,eventDescriptors}', p_subject -> 'declaredOccurrenceIds', field_values
  );
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array'
    or pg_catalog.jsonb_array_length(event_result)
      is distinct from pg_catalog.jsonb_array_length(p_subject -> 'declaredOccurrenceIds')
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality as appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(p_subject -> 'declaredOccurrenceIds')
        with ordinality as expected(value, ordinal) using (ordinal)
      where (appended.value ->> 'occurrenceId') is distinct from (expected.value #>> '{}')
    ) then
    raise exception using errcode = '55000', message = 'Named action declared Event append failed';
  end if;
end
$function$;
alter function vortex_record.complete_named_record_subject_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_named_record_subject_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_named_record_subject_internal(jsonb,jsonb,jsonb) is
  'Private named-command finalisation for one subject: the action''s Activity entry when no subject write recorded it, and its declared Events against the given (or current) subject values.';
