create or replace function vortex_record.record_change_set_is_valid_internal(p_subjects jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) not between 1 and 200 then return false; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array[
        'operation', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber',
        'submittedValues', 'finalValues', 'selectedGroupId', 'activityId', 'occurrenceId'
      ])
      or item.value - array[
        'operation', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber',
        'submittedValues', 'finalValues', 'selectedGroupId', 'activityId', 'occurrenceId'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(item.value -> 'operation') is distinct from 'string'
      or item.value ->> 'operation' not in ('create', 'update', 'delete', 'restore')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'occurrenceId')
      or pg_catalog.jsonb_typeof(item.value -> 'submittedValues') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'finalValues') is distinct from 'object'
      or (item.value ->> 'operation' = 'create' and (
        item.value -> 'recordId' <> 'null'::jsonb
        or item.value -> 'expectedConcurrencyNumber' <> 'null'::jsonb
        or (item.value -> 'selectedGroupId' <> 'null'::jsonb
          and not vortex_platform.is_non_nil_uuid(item.value ->> 'selectedGroupId'))
      ))
      or (item.value ->> 'operation' <> 'create' and (
        not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') is distinct from 'number'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
        or item.value -> 'selectedGroupId' <> 'null'::jsonb
      ))
      or (item.value ->> 'operation' in ('delete', 'restore') and (
        item.value -> 'submittedValues' <> '{}'::jsonb or item.value -> 'finalValues' <> '{}'::jsonb
      ))
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' <> 'create'
    group by pg_catalog.lower(item.value ->> 'recordTypeId'), pg_catalog.lower(item.value ->> 'recordId')
    having pg_catalog.count(*) > 1
  ) then
    return false;
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' <> 'create'
      and (item.value ->> 'expectedConcurrencyNumber')::bigint not between 1 and 9007199254740990
  ) then
    return false;
  end if;
  return true;
end
$function$;
alter function vortex_record.record_change_set_is_valid_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_change_set_is_valid_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_change_set_is_valid_internal(jsonb) is
  'Validates the one closed internal record-intent storage shape, bounded to 200 unique subjects, before calculation or persistence.';
