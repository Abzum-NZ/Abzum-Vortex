create or replace function vortex_record.grouping_query_internal(
  p_query jsonb,
  p_record_type jsonb,
  p_grouping jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  field_item jsonb;
  options jsonb;
  p_field_id text := pg_catalog.lower(p_grouping ->> 'fieldId');
  bucket jsonb := p_grouping -> 'dateBucket';
begin
  -- Grid state chooses one selected dimension; query grouping/totals are defaults only.
  if pg_catalog.jsonb_typeof(p_grouping) is distinct from 'object' then return null; end if;
  if p_grouping - array['fieldId', 'dateBucket', 'limit']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_grouping -> 'fieldId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_grouping -> 'limit') is distinct from 'number' then
    return null;
  end if;
  if (p_grouping ->> 'limit')::numeric <> pg_catalog.trunc((p_grouping ->> 'limit')::numeric)
    or (p_grouping ->> 'limit')::numeric not between 1 and 200 then
    return null;
  end if;
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
  if field_item ->> 'type' not in ('choice', 'date', 'date_time')
    or field_item is null
    or (field_item ->> 'filterable')::boolean is distinct from true then
    return null;
  end if;
  if field_item ->> 'type' = 'choice' then
    if p_grouping ? 'dateBucket' then return null; end if;
    options := field_item #> '{settings,options}';
    if pg_catalog.jsonb_typeof(options) is distinct from 'array' then return null; end if;
    if pg_catalog.jsonb_array_length(options) not between 1 and 50 then return null; end if;
  else
    if pg_catalog.jsonb_typeof(bucket) is distinct from 'object' then return null; end if;
    if bucket - array['unit', 'timeZone']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(bucket -> 'unit') is distinct from 'string'
      or bucket ->> 'unit' not in ('day', 'week', 'month', 'quarter', 'year')
      or pg_catalog.jsonb_typeof(bucket -> 'timeZone') is distinct from 'string'
      or not exists (select 1 from pg_catalog.pg_timezone_names as zone
        where pg_catalog.lower(zone.name) = pg_catalog.lower(bucket ->> 'timeZone')) then
      return null;
    end if;
  end if;
  return p_query || pg_catalog.jsonb_build_object(
    'groupByFieldIds', pg_catalog.jsonb_build_array(p_field_id), 'aggregates', '[]'::jsonb
  );
end
$function$;

alter function vortex_record.grouping_query_internal(jsonb,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.grouping_query_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.grouping_query_internal(jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.grouping_query_internal(jsonb,jsonb,jsonb) is
  'Owner-only validation of one selected filterable choice or date dimension, an explicit group page cap and an authored date bucket/time zone. Returns the query with its grouping defaults replaced, or null. Each reader checks live field policy before disclosure.';
