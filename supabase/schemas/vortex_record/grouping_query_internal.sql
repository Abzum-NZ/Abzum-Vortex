create or replace function vortex_record.grouping_query_internal(
  p_query jsonb,
  p_record_type jsonb,
  p_field_id text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  field_item jsonb;
  options jsonb;
begin
  -- Grid state chooses one selected choice field; query grouping/totals are defaults only.
  if p_field_id is null or p_field_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(p_query -> 'selectedFieldIds') as selected(id)
      where pg_catalog.lower(selected.id) = p_field_id
    ) then
    return null;
  end if;
  select item.value into field_item
  from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as item(value)
  where pg_catalog.lower(item.value ->> 'fieldId') = p_field_id;
  if field_item ->> 'type' is distinct from 'choice'
    or (field_item ->> 'filterable')::boolean is distinct from true then
    return null;
  end if;
  options := field_item #> '{settings,options}';
  if pg_catalog.jsonb_typeof(options) is distinct from 'array' then
    return null;
  end if;
  if pg_catalog.jsonb_array_length(options) not between 1 and 50 then
    return null;
  end if;
  return p_query || pg_catalog.jsonb_build_object(
    'groupByFieldIds', pg_catalog.jsonb_build_array(p_field_id), 'aggregates', '[]'::jsonb
  );
end
$function$;

alter function vortex_record.grouping_query_internal(jsonb,jsonb,text) owner to vortex_owner;
revoke all on function vortex_record.grouping_query_internal(jsonb,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.grouping_query_internal(jsonb,jsonb,text)
  to vortex_record_adapter;

comment on function vortex_record.grouping_query_internal(jsonb,jsonb,text) is
  'Owner-only validation of grid choice grouping against selected, filterable installed fields, capped at fifty choices; returns the query with its grouping defaults replaced, or null. Live field policy is checked by each reader before disclosure.';
