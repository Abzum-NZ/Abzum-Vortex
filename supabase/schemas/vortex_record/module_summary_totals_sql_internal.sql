-- Shape an ungrouped summary from the shared candidate and aggregate plan.
create or replace function vortex_record.module_summary_totals_sql_internal(
  p_plan jsonb
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  summary_candidate_limit integer;
  resolved jsonb;
  group_ids text[];
  candidate_sql text;
  selected_sql text;
  summary_totals_sql text;
  p_module_root_id uuid;
  p_query_id uuid;
  summary_sql text;
begin
  summary_candidate_limit := (p_plan ->> 'summary_candidate_limit')::integer;
  resolved := nullif(p_plan -> 'resolved', 'null'::jsonb);
  select case when p_plan -> 'group_ids' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into group_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'group_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  candidate_sql := (p_plan ->> 'candidate_sql')::text;
  selected_sql := (p_plan ->> 'selected_sql')::text;
  summary_totals_sql := (p_plan ->> 'summary_totals_sql')::text;
  p_module_root_id := (p_plan ->> 'p_module_root_id')::uuid;
  p_query_id := (p_plan ->> 'p_query_id')::uuid;
  summary_sql := pg_catalog.format(
    'with candidate as materialized (%s),
     candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
     selected as materialized (%s),
     selected_count as (select pg_catalog.count(*)::integer as value from selected),
     totals as (%s)
     select case when candidate_count.value > %s
       then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
       else pg_catalog.jsonb_build_object(
         ''outcome'', ''completed'',
         ''moduleRootId'', %L,
         ''moduleReleaseVersion'', %L,
         ''queryId'', %L,
         ''groupByFieldIds'', %L::jsonb,
         ''totalRowCount'', selected_count.value,
         ''groups'', ''[]''::jsonb,
         ''aggregates'', totals.aggregate_values
       ) end
     from candidate_count cross join selected_count cross join totals',
    candidate_sql,
    selected_sql,
    summary_totals_sql,
    summary_candidate_limit,
    p_module_root_id::text,
    resolved ->> 'moduleReleaseVersion',
    p_query_id::text,
    pg_catalog.to_jsonb(group_ids)::text
  );
  return summary_sql;
end
$function$;

alter function vortex_record.module_summary_totals_sql_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_summary_totals_sql_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
