create or replace function vortex_access.condition_field_type_internal(p_field jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  -- Mirrors conditionFieldType in packages/platform/src/rules/condition-types.ts: the one
  -- field-kind to condition semantic-type mapping. Calculation and total fields compare as their
  -- declared result type; an unknown or undeclared kind has no type (null) and the caller refuses it.
  select case kind.value
    when 'text' then 'text'
    when 'whole_number' then 'whole_number'
    when 'decimal_number' then 'decimal_number'
    when 'money' then 'money'
    when 'yes_no' then 'yes_no'
    when 'date' then 'date'
    when 'date_time' then 'date_time'
    when 'long_text' then 'text'
    when 'choice' then 'text'
    when 'reference_number' then 'text'
    when 'email_address' then 'text'
    when 'phone_number' then 'text'
    when 'web_address' then 'text'
    when 'link' then 'record_reference'
    when 'link_to_one_of_several' then 'record_reference'
    when 'several_choices' then 'text_collection'
    when 'table' then 'opaque_json'
    when 'attachment' then 'opaque_json'
    when 'formatted_text' then 'opaque_json'
    else null
  end
  from (select case
    when p_field ->> 'type' in ('calculation', 'total') then p_field #>> '{settings,resultType}'
    else p_field ->> 'type'
  end as value) as kind
$function$;

alter function vortex_access.condition_field_type_internal(jsonb) owner to vortex_owner;

revoke all on function vortex_access.condition_field_type_internal(jsonb) from public;
grant execute on function vortex_access.condition_field_type_internal(jsonb)
  to vortex_owner, vortex_record_adapter, postgres;

comment on function vortex_access.condition_field_type_internal(jsonb) is
  'Private: the one field-kind to condition semantic-type mapping, mirroring the compiler; calculation and total fields use their declared result type and an unknown kind has no type.';
