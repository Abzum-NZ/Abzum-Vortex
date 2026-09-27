create or replace function vortex_record.canonical_record_value_matches(
  p_value jsonb,
  p_field_type text,
  p_database_value_type text
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  -- Canonical exact decimal text: no exponent, no leading zero, no trailing
  -- fractional zero, and no negative zero -- exactly what
  -- `normalizeExactDecimal` emits (contracts/src/exact-decimal.ts:49-72).
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
  uuid_pattern constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  nil_uuid_text constant text := '00000000-0000-0000-0000-000000000000';
  date_pattern constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  date_time_pattern constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  value_text text;
begin
  if p_value is null then
    return false;
  end if;
  -- A JSON null clears the column, whatever the declared type.
  if pg_catalog.jsonb_typeof(p_value) = 'null' then
    return true;
  end if;

  if p_field_type = 'money'
    or (p_field_type in ('calculation', 'total') and p_database_value_type = 'json') then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['amount', 'currency']::text[] = '{}'::jsonb
      and p_value ?& array['amount', 'currency']
      and pg_catalog.jsonb_typeof(p_value -> 'amount') = 'string'
      and (p_value ->> 'amount') ~ canonical_decimal
      and pg_catalog.jsonb_typeof(p_value -> 'currency') = 'string'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$';
  elsif p_field_type = 'link_to_person' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value - array['organizationAccountId']::text[] = '{}'::jsonb
      and p_value ? 'organizationAccountId'
      and pg_catalog.jsonb_typeof(p_value -> 'organizationAccountId') = 'string'
      and (p_value ->> 'organizationAccountId') ~ uuid_pattern
      and pg_catalog.lower(p_value ->> 'organizationAccountId') <> nil_uuid_text;
  elsif p_field_type = 'several_choices' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
      );
  elsif p_field_type = 'attachment' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1 from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
          or (member.value #>> '{}') !~ uuid_pattern
          or pg_catalog.lower(member.value #>> '{}') = nil_uuid_text
      );
  elsif p_field_type = 'table' then
    return pg_catalog.jsonb_typeof(p_value) = 'array';
  elsif p_field_type = 'formatted_text' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and pg_catalog.jsonb_typeof(p_value -> 'blocks') = 'array';
  end if;

  -- Every remaining field type is decided by its storage type.
  if p_database_value_type = 'decimal' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ canonical_decimal;
  elsif p_database_value_type = 'integer' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    return value_text ~ '^-?(?:0|[1-9][0-9]*)$'
      and value_text::numeric between -9223372036854775808 and 9223372036854775807;
  elsif p_database_value_type = 'boolean' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_database_value_type = 'date' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    if value_text !~ date_pattern then
      return false;
    end if;
    begin
      perform value_text::date;
    exception when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation then
      return false;
    end;
    return true;
  elsif p_database_value_type = 'timestamp_with_time_zone' then
    -- The instant is stored; the offset it arrived with is not preserved, and
    -- the read codec returns UTC `Z`. The pattern requires an explicit offset,
    -- so the stored instant never depends on the session time zone.
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'string' then
      return false;
    end if;
    value_text := p_value #>> '{}';
    if value_text !~ date_time_pattern then
      return false;
    end if;
    begin
      perform value_text::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow
      or invalid_text_representation then
      return false;
    end;
    return true;
  elsif p_database_value_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_database_value_type = 'json' then
    return true;
  end if;
  return false;
end
$function$;

alter function vortex_record.canonical_record_value_matches(jsonb, text, text) owner to vortex_record_adapter;

revoke all on function vortex_record.canonical_record_value_matches(jsonb, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.canonical_record_value_matches(jsonb, text, text) is
  'Private pure check that one value is the canonical V2 shape for its declared field type; never raises and decides no authority.';
