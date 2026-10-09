create or replace function vortex_access.typed_condition_value_matches_internal(
  p_value jsonb,
  p_semantic_type text,
  p_nullable boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  numeric_value double precision;
  canonical_decimal constant text :=
    '^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-(?:0\.[0-9]*[1-9]|[1-9][0-9]*(?:\.[0-9]*[1-9])?))$';
begin
  if p_value is null then
    return false;
  end if;
  if p_value = 'null'::jsonb then
    return p_nullable;
  end if;

  if p_semantic_type = 'text' then
    return pg_catalog.jsonb_typeof(p_value) = 'string';
  elsif p_semantic_type = 'number' then
    if pg_catalog.jsonb_typeof(p_value) is distinct from 'number' then
      return false;
    end if;
    begin
      numeric_value := (p_value #>> '{}')::double precision;
    exception when numeric_value_out_of_range or invalid_text_representation then
      return false;
    end;
    return numeric_value::text not in ('Infinity', '-Infinity', 'NaN');
  elsif p_semantic_type = 'decimal_number' then
    -- Integer JSON literals and legacy number parameters can participate in an
    -- exact comparison. Trusted field values and explicit exact parameters are
    -- separately required to use canonical text by the outer evaluator.
    return (
      pg_catalog.jsonb_typeof(p_value) = 'string'
      and (p_value #>> '{}') ~ canonical_decimal
    ) or (
      pg_catalog.jsonb_typeof(p_value) = 'number'
      and (p_value #>> '{}') ~ '^-?(?:0|[1-9][0-9]*)$'
    );
  elsif p_semantic_type = 'money' then
    return pg_catalog.jsonb_typeof(p_value) = 'object'
      and p_value ?& array['amount', 'currency']
      and not exists (
        select 1 from pg_catalog.jsonb_object_keys(p_value) as supplied(key)
        where supplied.key <> all (array['amount', 'currency'])
      )
      and pg_catalog.jsonb_typeof(p_value -> 'amount') = 'string'
      and (p_value ->> 'amount') ~ canonical_decimal
      and pg_catalog.jsonb_typeof(p_value -> 'currency') = 'string'
      and (p_value ->> 'currency') ~ '^[A-Z]{3}$';
  elsif p_semantic_type = 'boolean' then
    return pg_catalog.jsonb_typeof(p_value) = 'boolean';
  elsif p_semantic_type = 'date' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_access.typed_condition_temporal_value_internal(p_value #>> '{}', 'date') is not null;
  elsif p_semantic_type = 'date_time' then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_access.typed_condition_temporal_value_internal(p_value #>> '{}', 'date_time') is not null;
  elsif p_semantic_type = 'text_collection' then
    return pg_catalog.jsonb_typeof(p_value) = 'array'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_value) as member(value)
        where pg_catalog.jsonb_typeof(member.value) is distinct from 'string'
      );
  elsif p_semantic_type in ('record_reference', 'organization_account_reference') then
    return pg_catalog.jsonb_typeof(p_value) = 'string'
      and vortex_context.is_non_nil_uuid(p_value #>> '{}');
  elsif p_semantic_type = 'opaque_json' then
    return true;
  end if;
  return false;
end
$function$;

comment on function vortex_access.typed_condition_value_matches_internal(jsonb,text,boolean) is null;

alter function vortex_access.typed_condition_value_matches_internal(jsonb,text,boolean) owner to postgres;

revoke execute on function vortex_access.typed_condition_value_matches_internal(jsonb, text, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.typed_condition_value_matches_internal(jsonb,text,boolean) to vortex_access_owner;
