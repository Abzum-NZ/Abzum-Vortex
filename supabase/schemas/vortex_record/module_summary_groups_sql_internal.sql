-- Shape a keyset page of canonical groups while retaining totals over the full readable selection.
create or replace function vortex_record.module_summary_groups_sql_internal(
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
  group_values_sql text;
  group_page_limit integer;
  group_after text;
  group_cursor jsonb;
  group_presence_sql text;
  group_dimension_sql text;
  group_axis_ctes_sql text;
  aggregate_object_sql text;
  summary_totals_sql text;
  p_module_root_id uuid;
  p_query_id uuid;
  summary_sql text;
  groups_json_sql text;
begin
  summary_candidate_limit := (p_plan ->> 'summary_candidate_limit')::integer;
  resolved := nullif(p_plan -> 'resolved', 'null'::jsonb);
  select case when p_plan -> 'group_ids' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into group_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'group_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  candidate_sql := (p_plan ->> 'candidate_sql')::text;
  selected_sql := (p_plan ->> 'selected_sql')::text;
  group_values_sql := (p_plan ->> 'group_values_sql')::text;
  group_page_limit := (p_plan ->> 'group_page_limit')::integer;
  group_after := (p_plan ->> 'group_after')::text;
  group_cursor := nullif(p_plan -> 'group_cursor', 'null'::jsonb);
  group_presence_sql := (p_plan ->> 'group_presence_sql')::text;
  group_dimension_sql := (p_plan ->> 'group_dimension_sql')::text;
  group_axis_ctes_sql := (p_plan ->> 'group_axis_ctes_sql')::text;
  aggregate_object_sql := (p_plan ->> 'aggregate_object_sql')::text;
  summary_totals_sql := (p_plan ->> 'summary_totals_sql')::text;
  p_module_root_id := (p_plan ->> 'p_module_root_id')::uuid;
  p_query_id := (p_plan ->> 'p_query_id')::uuid;
  -- Groups are ordered and keyset-paged on (rank, title, canonical value); the group key a member
  -- read selects by stays the canonical value text.
  groups_json_sql := pg_catalog.format(
    '(select coalesce(pg_catalog.jsonb_agg(
       pg_catalog.jsonb_build_object(
         ''groupKey'', grouped.group_values::text,
         ''groupValues'', grouped.group_values,
         ''rowCount'', grouped.row_count,
         ''aggregates'', grouped.aggregates
       ) order by grouped.sort_rank, grouped.sort_title collate "C", grouped.group_values::text collate "C"
     ), ''[]''::jsonb) from visible_groups as grouped)'
  );
  summary_sql := pg_catalog.format(
    'with candidate as materialized (%s),
     candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
     selected as materialized (%s),
     selected_count as (select pg_catalog.count(*)::integer as value from selected),
     totals as (%s),
     raw_dimensions as materialized (
       select candidate.projected_values, %s as group_values
       from selected as candidate
       where %s and (select value from candidate_count) <= %s
     ),
     %saxis_values as materialized (%s),
     dimensions as materialized (
       select source.projected_values, axis.normalized as group_values, axis.sort_rank, axis.sort_title
       from raw_dimensions as source
       join axis_values as axis on axis.value = source.group_values
     ),
     grouped as (
       select candidate.group_values, candidate.sort_rank, candidate.sort_title,
         pg_catalog.count(*)::integer as row_count,
         pg_catalog.jsonb_build_object(%s) as aggregates
       from dimensions as candidate
       group by candidate.group_values, candidate.sort_rank, candidate.sort_title
     ),
     paged_groups as materialized (
       select * from grouped
       where %L::text is null or (
         grouped.sort_rank, grouped.sort_title collate "C", grouped.group_values::text collate "C"
       ) > (%L::integer, %L::text collate "C", %L::text collate "C")
       order by grouped.sort_rank, grouped.sort_title collate "C", grouped.group_values::text collate "C"
       limit %s
     ),
     visible_groups as materialized (
       select * from paged_groups
       order by sort_rank, sort_title collate "C", group_values::text collate "C" limit %s
     )
     select case when candidate_count.value > %s
       then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
       else pg_catalog.jsonb_build_object(
         ''outcome'', ''completed'',
         ''moduleRootId'', %L,
         ''moduleReleaseVersion'', %L,
         ''queryId'', %L,
         ''groupByFieldIds'', %L::jsonb,
         ''totalRowCount'', selected_count.value,
         ''groups'', %s,
         ''aggregates'', totals.aggregate_values,
         ''nextGroupKey'', case when (select pg_catalog.count(*) from paged_groups) > %s
           then (select pg_catalog.jsonb_build_array(sort_rank, sort_title, group_values::text)::text
             from visible_groups
             order by sort_rank desc, sort_title collate "C" desc, group_values::text collate "C" desc limit 1)
           else null end
       ) end
     from candidate_count cross join selected_count cross join totals',
    candidate_sql,
    selected_sql,
    summary_totals_sql,
    group_values_sql,
    group_presence_sql,
    summary_candidate_limit,
    group_axis_ctes_sql,
    group_dimension_sql,
    aggregate_object_sql,
    group_after, group_cursor ->> 0, group_cursor ->> 1, group_cursor ->> 2,
    group_page_limit + 1, group_page_limit,
    summary_candidate_limit,
    p_module_root_id::text,
    resolved ->> 'moduleReleaseVersion',
    p_query_id::text,
    pg_catalog.to_jsonb(group_ids)::text,
    groups_json_sql,
    group_page_limit
  );
  return summary_sql;
end
$function$;

alter function vortex_record.module_summary_groups_sql_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_summary_groups_sql_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
