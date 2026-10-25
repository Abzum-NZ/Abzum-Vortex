-- Validate visible-column totals and replace the query aggregates without changing their calculation path.
create or replace function vortex_record.module_summary_totals_internal(
  p_query jsonb,
  p_totals jsonb,
  p_grouped boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  query_item jsonb := p_query;
  aggregate_item jsonb;
begin
    if pg_catalog.jsonb_typeof(p_totals) is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_array_length(p_totals) not between 1 and 6 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for aggregate_item in select item.value from pg_catalog.jsonb_array_elements(p_totals) as item(value) loop
      if pg_catalog.jsonb_typeof(aggregate_item) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if aggregate_item - array['fieldId', 'operation', 'alias']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(aggregate_item -> 'fieldId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(aggregate_item -> 'operation') is distinct from 'string'
        or pg_catalog.jsonb_typeof(aggregate_item -> 'alias') is distinct from 'string'
        or aggregate_item ->> 'operation' not in ('count', 'sum', 'average', 'minimum', 'maximum', 'distinct_count')
        or not exists (select 1 from pg_catalog.jsonb_array_elements_text(query_item -> 'selectedFieldIds') as selected(id)
          where pg_catalog.lower(selected.id) = pg_catalog.lower(aggregate_item ->> 'fieldId')) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
    end loop;
    query_item := query_item || pg_catalog.jsonb_build_object('aggregates', p_totals,
      'groupByFieldIds', case when p_grouped then query_item -> 'groupByFieldIds' else '[]'::jsonb end);
  return query_item;
end
$function$;

alter function vortex_record.module_summary_totals_internal(jsonb,jsonb,boolean) owner to vortex_record_adapter;
revoke all on function vortex_record.module_summary_totals_internal(jsonb,jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
