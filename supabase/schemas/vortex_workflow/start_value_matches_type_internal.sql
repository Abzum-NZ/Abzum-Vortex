create or replace function vortex_workflow.start_value_matches_type_internal(
  p_type text,
  p_value jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  item jsonb;
begin
  if p_type is null or p_value is null then
    return false;
  end if;

  if p_type = 'json' then
    return true;
  elsif p_type = 'yes_no' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_type = 'whole_number' then
    return pg_catalog.jsonb_typeof(p_value) = 'number'
      and p_value::text ~ '^-?(0|[1-9][0-9]*)$'
      and (p_value::text)::numeric between -9007199254740991 and 9007199254740991;
  elsif p_type in ('decimal_number', 'money') then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and p_value #>> '{}' ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$';
  elsif p_type in ('text', 'formatted_text') then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_type in (
    'choice', 'record_reference', 'organization_account_reference',
    'workflow_run_reference', 'relationship_reference', 'file_reference',
    'date', 'date_time'
  ) then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and pg_catalog.length(p_value #>> '{}') > 0;
  elsif p_type in (
    'several_choices', 'record_reference_list', 'relationship_reference_list'
  ) then
    if pg_catalog.jsonb_typeof(p_value) <> 'array' then
      return false;
    end if;
    for item in select value from pg_catalog.jsonb_array_elements(p_value) loop
      if pg_catalog.jsonb_typeof(item) <> 'string'
        or pg_catalog.length(item #>> '{}') = 0 then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return false;
end
$function$;

revoke all on function vortex_workflow.start_value_matches_type_internal(text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_workflow.start_value_matches_type_internal(text, jsonb) is
  'Checks the stored JSON shape of one declared flow input or trigger value; only the start-intent writer calls this private helper.';
