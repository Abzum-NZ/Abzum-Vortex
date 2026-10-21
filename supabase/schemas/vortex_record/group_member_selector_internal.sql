create or replace function vortex_record.group_member_selector_internal(
  p_group_member jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  group_selector_item jsonb;
  group_selector_value jsonb;
  group_selector_values jsonb := '{}'::jsonb;
  group_selector_types jsonb := '{}'::jsonb;
  group_key text;
  group_field_type text;
  group_value_valid boolean;
begin
  -- The closed, typed generic group selector; null when any part of it is malformed.
  if pg_catalog.jsonb_typeof(p_group_member) is distinct from 'object' then
    return null;
  end if;
  if p_group_member - array['values']::text[] <> '{}'::jsonb
    or not (p_group_member ? 'values')
    or pg_catalog.jsonb_typeof(p_group_member -> 'values') is distinct from 'array' then
    return null;
  end if;
  if pg_catalog.jsonb_array_length(p_group_member -> 'values') not between 1 and 10 then
    return null;
  end if;
  for group_selector_item in
    select item.value from pg_catalog.jsonb_array_elements(p_group_member -> 'values') as item(value)
  loop
    if pg_catalog.jsonb_typeof(group_selector_item) is distinct from 'object' then
      return null;
    end if;
    if group_selector_item - array['fieldId', 'fieldType', 'value']::text[] <> '{}'::jsonb
      or not (group_selector_item ? 'fieldId')
      or not (group_selector_item ? 'fieldType')
      or not (group_selector_item ? 'value')
      or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldId') is distinct from 'string'
      or pg_catalog.lower(group_selector_item ->> 'fieldId') !~ uuid_pattern
      or pg_catalog.lower(group_selector_item ->> 'fieldId') = '00000000-0000-0000-0000-000000000000'
      or pg_catalog.jsonb_typeof(group_selector_item -> 'fieldType') is distinct from 'string'
      or group_selector_item ->> 'fieldType' not in (
        'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
        'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
        'link', 'link_to_one_of_several'
      ) then
      return null;
    end if;
    group_key := pg_catalog.lower(group_selector_item ->> 'fieldId');
    if group_selector_types ? group_key then
      return null;
    end if;
    group_field_type := group_selector_item ->> 'fieldType';
    group_selector_value := group_selector_item -> 'value';
    group_value_valid := group_selector_value = 'null'::jsonb;
    if not group_value_valid then
      case group_field_type
        when 'text', 'reference_number', 'email_address', 'phone_number', 'web_address' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string';
        when 'choice' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and pg_catalog.length(group_selector_value #>> '{}') between 1 and 120;
        when 'whole_number' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'number'
            and case when pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'numeric') then
              (group_selector_value #>> '{}')::numeric = pg_catalog.trunc((group_selector_value #>> '{}')::numeric)
              and pg_catalog.abs((group_selector_value #>> '{}')::numeric) <= 9007199254740991
            else false end;
        when 'decimal_number' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and group_selector_value #>> '{}' ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$';
        when 'yes_no' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'boolean';
        when 'date' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'date');
        when 'date_time' then
          group_value_valid := pg_catalog.jsonb_typeof(group_selector_value) = 'string'
            and group_selector_value #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
            and pg_catalog.substr(group_selector_value #>> '{}', 12, 2) between '00' and '23'
            and pg_catalog.substr(group_selector_value #>> '{}', 15, 2) between '00' and '59'
            and (pg_catalog.substr(group_selector_value #>> '{}', 17, 1) <> ':'
              or pg_catalog.substr(group_selector_value #>> '{}', 18, 2) between '00' and '59')
            and pg_catalog.pg_input_is_valid(group_selector_value #>> '{}', 'timestamp with time zone');
        when 'link', 'link_to_one_of_several' then
          -- The group of links to targets the reader cannot read is the one fixed text.
          group_value_valid := case
            when group_field_type = 'link' and group_selector_value = '"not_available"'::jsonb then true
            when pg_catalog.jsonb_typeof(group_selector_value) = 'object' then
            group_selector_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
            and group_selector_value ? 'recordTypeId' and group_selector_value ? 'recordId'
            and pg_catalog.jsonb_typeof(group_selector_value -> 'recordTypeId') = 'string'
            and pg_catalog.lower(group_selector_value ->> 'recordTypeId') ~ uuid_pattern
            and pg_catalog.lower(group_selector_value ->> 'recordTypeId') <> '00000000-0000-0000-0000-000000000000'
            and pg_catalog.jsonb_typeof(group_selector_value -> 'recordId') = 'string'
            and pg_catalog.lower(group_selector_value ->> 'recordId') ~ uuid_pattern
            and pg_catalog.lower(group_selector_value ->> 'recordId') <> '00000000-0000-0000-0000-000000000000'
          else false end;
        else
          group_value_valid := false;
      end case;
    end if;
    if not group_value_valid then
      return null;
    end if;
    group_selector_types := group_selector_types || pg_catalog.jsonb_build_object(group_key, group_field_type);
    group_selector_values := group_selector_values || pg_catalog.jsonb_build_object(group_key, group_selector_value);
  end loop;
  return pg_catalog.jsonb_build_object('types', group_selector_types, 'values', group_selector_values);
end
$function$;

alter function vortex_record.group_member_selector_internal(jsonb)
  owner to vortex_owner;
revoke all on function vortex_record.group_member_selector_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.group_member_selector_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.group_member_selector_internal(jsonb) is
  'Owner-only parser of a generic group member selector: the typed grouping values keyed by lower-case field identity with their declared field types (a link is a target identity or the fixed not_available text), or null when the selector is malformed.';
