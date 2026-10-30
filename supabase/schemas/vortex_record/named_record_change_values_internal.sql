create or replace function vortex_record.named_record_change_values_internal(
  p_named_roles jsonb,
  p_index integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  role_value jsonb := p_named_roles #> array['roles', p_index::text];
  named_subject jsonb;
  target jsonb;
begin
  if role_value is null or role_value ->> 'role' not in ('subject', 'creation') then
    return null;
  end if;
  named_subject := p_named_roles -> 'subjects' -> (role_value ->> 'named')::integer;
  if role_value ->> 'role' = 'subject' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'recordType', p_named_roles #> '{actionContext,recordType}',
      'beforeSaveFlows', p_named_roles -> 'beforeSaveFlows',
      'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
      'readableFieldIds', named_subject -> 'readableFieldIds',
      'existingValues', named_subject -> 'existingValues'
    );
  end if;
  select item.value into target
  from pg_catalog.jsonb_array_elements(named_subject -> 'createTargets') with ordinality as item(value, ordinality)
  where item.ordinality - 1 = (role_value ->> 'creation')::integer;
  if target is null then
    raise exception using errcode = '55000', message = 'Named action creation target is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'recordType', target -> 'recordType',
    'beforeSaveFlows', target -> 'beforeSaveFlows',
    'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
    'readableFieldIds', '[]'::jsonb, 'existingValues', '{}'::jsonb
  );
end
$function$;
alter function vortex_record.named_record_change_values_internal(jsonb,integer) owner to vortex_record_adapter;
revoke all on function vortex_record.named_record_change_values_internal(jsonb,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.named_record_change_values_internal(jsonb,integer) is
  'Private: the calculation inputs of a named command''s subject or declared create (record type, BeforeSave flows, current values and readable fields under the action), or null for an intent ordinary authority prepares.';
