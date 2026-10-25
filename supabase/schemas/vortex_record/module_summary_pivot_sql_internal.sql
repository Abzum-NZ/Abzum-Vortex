-- Shape pivot cells and row, column and grand totals from one grouping-sets statement.
create or replace function vortex_record.module_summary_pivot_sql_internal(
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
  fields_by_id jsonb;
  candidate_sql text;
  selected_sql text;
  group_by_terms text[];
  group_page_limit integer;
  group_after text;
  group_cursor jsonb;
  pivot_row_field_id text;
  pivot_column_field_id text;
  pivot_column_limit integer;
  group_presence_sql text;
  aggregate_object_sql text;
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
  fields_by_id := nullif(p_plan -> 'fields_by_id', 'null'::jsonb);
  candidate_sql := (p_plan ->> 'candidate_sql')::text;
  selected_sql := (p_plan ->> 'selected_sql')::text;
  select case when p_plan -> 'group_by_terms' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into group_by_terms
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'group_by_terms', 'null'::jsonb))
    with ordinality as item(value, position);
  group_page_limit := (p_plan ->> 'group_page_limit')::integer;
  group_after := (p_plan ->> 'group_after')::text;
  group_cursor := nullif(p_plan -> 'group_cursor', 'null'::jsonb);
  pivot_row_field_id := (p_plan ->> 'pivot_row_field_id')::text;
  pivot_column_field_id := (p_plan ->> 'pivot_column_field_id')::text;
  pivot_column_limit := (p_plan ->> 'pivot_column_limit')::integer;
  group_presence_sql := (p_plan ->> 'group_presence_sql')::text;
  aggregate_object_sql := (p_plan ->> 'aggregate_object_sql')::text;
  p_module_root_id := (p_plan ->> 'p_module_root_id')::uuid;
  p_query_id := (p_plan ->> 'p_query_id')::uuid;
  -- One grouping-sets statement yields every cell, each row total, each column total and the
  -- grand total over the full readable filtered set. Averages and extremes are computed for
  -- each set, never combined from cells. Axis values are ordered by (rank, title, canonical
  -- text), so link values follow their readable target title; rows are keyset-paged on that tuple.
  summary_sql := pg_catalog.format(
    'with candidate as materialized (%s),
     candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
     selected as materialized (%s),
     raw_dimensions as materialized (
       select candidate.projected_values, coalesce(%s, ''null''::jsonb) as row_value, coalesce(%s, ''null''::jsonb) as column_value
       from selected as candidate
       where %s and (select value from candidate_count) <= %s
     ),
     row_values as materialized (
       select * from vortex_record.dimension_value_internal(
         (select pg_catalog.array_agg(distinct row_value) from raw_dimensions), %L::jsonb
       )
     ),
     column_values as materialized (
       select * from vortex_record.dimension_value_internal(
         (select pg_catalog.array_agg(distinct column_value) from raw_dimensions), %L::jsonb
       )
     ),
     dimensions as materialized (
       select source.projected_values, rows.normalized as row_value,
         rows.sort_rank as row_rank, rows.sort_title as row_title,
         columns.normalized as column_value,
         columns.sort_rank as column_rank, columns.sort_title as column_title
       from raw_dimensions as source
       join row_values as rows on rows.value = source.row_value
       join column_values as columns on columns.value = source.column_value
     ),
     crossed as materialized (
       select grouping(candidate.row_value, candidate.column_value) as level,
         candidate.row_rank, candidate.row_title, candidate.row_value,
         candidate.column_rank, candidate.column_title, candidate.column_value,
         pg_catalog.count(*)::integer as row_count,
         pg_catalog.jsonb_build_object(%s) as aggregates
       from dimensions as candidate
       group by grouping sets (
         (candidate.row_rank, candidate.row_title, candidate.row_value,
          candidate.column_rank, candidate.column_title, candidate.column_value),
         (candidate.row_rank, candidate.row_title, candidate.row_value),
         (candidate.column_rank, candidate.column_title, candidate.column_value), ()
       )
     ),
     column_axis as materialized (
       select * from crossed where level = 2
     ),
     column_count as (select pg_catalog.count(*)::integer as value from column_axis),
     row_axis as materialized (
       select crossed.*, pg_catalog.jsonb_build_array(
         crossed.row_rank, crossed.row_title, crossed.row_value::text
       )::text as row_key
       from crossed
       where level = 1
         and (%L::text is null or (
           crossed.row_rank, crossed.row_title collate "C", crossed.row_value::text collate "C"
         ) > (%L::integer, %L::text collate "C", %L::text collate "C"))
       order by crossed.row_rank, crossed.row_title collate "C", crossed.row_value::text collate "C"
       limit %s
     ),
     visible_rows as materialized (
       select * from row_axis
       order by row_rank, row_title collate "C", row_value::text collate "C" limit %s
     ),
     visible_cells as materialized (
       select cell.row_value, pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         ''column'', cell.column_value, ''rowCount'', cell.row_count,
         ''aggregates'', cell.aggregates
       ) order by cell.column_rank, cell.column_title collate "C", cell.column_value::text collate "C") as cells
       from crossed as cell
       join visible_rows as visible on visible.row_value = cell.row_value
       where cell.level = 0
       group by cell.row_value
     ),
     grand as (select row_count, aggregates from crossed where level = 3)
     select case
       when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
       when column_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''pivot_columns_exceeded'')
       else pg_catalog.jsonb_build_object(
         ''outcome'', ''completed'',
         ''moduleRootId'', %L,
         ''moduleReleaseVersion'', %L,
         ''queryId'', %L,
         ''groupByFieldIds'', %L::jsonb,
         ''totalRowCount'', grand.row_count,
         ''groups'', ''[]''::jsonb,
         ''aggregates'', grand.aggregates,
         ''nextGroupKey'', case when (select pg_catalog.count(*) from row_axis) > %s
           then (select row_key from visible_rows
             order by row_rank desc, row_title collate "C" desc, row_value::text collate "C" desc limit 1)
           else null end,
         ''pivot'', pg_catalog.jsonb_build_object(
           ''rowFieldId'', %L,
           ''columnFieldId'', %L,
           ''rowGroupCount'', (select pg_catalog.count(*) from crossed where level = 1),
           ''columns'', (
             select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               ''value'', axis.column_value, ''rowCount'', axis.row_count, ''aggregates'', axis.aggregates
             ) order by axis.column_rank, axis.column_title collate "C", axis.column_value::text collate "C"), ''[]''::jsonb)
             from column_axis as axis
           ),
           ''rows'', (
             select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               ''key'', visible.row_key, ''value'', visible.row_value, ''rowCount'', visible.row_count,
               ''aggregates'', visible.aggregates,
               ''cells'', coalesce(row_cells.cells, ''[]''::jsonb)
             ) order by visible.row_rank, visible.row_title collate "C", visible.row_value::text collate "C"), ''[]''::jsonb)
             from visible_rows as visible
             left join visible_cells as row_cells on row_cells.row_value = visible.row_value
           )
         )
       ) end
     from candidate_count cross join column_count cross join grand',
    candidate_sql,
    selected_sql,
    group_by_terms[1],
    group_by_terms[2],
    group_presence_sql,
    summary_candidate_limit,
    (fields_by_id -> pivot_row_field_id)::text,
    (fields_by_id -> pivot_column_field_id)::text,
    aggregate_object_sql,
    group_after, group_cursor ->> 0, group_cursor ->> 1, group_cursor ->> 2,
    group_page_limit + 1, group_page_limit,
    summary_candidate_limit,
    pivot_column_limit,
    p_module_root_id::text,
    resolved ->> 'moduleReleaseVersion',
    p_query_id::text,
    pg_catalog.to_jsonb(group_ids)::text,
    group_page_limit,
    pivot_row_field_id,
    pivot_column_field_id
  );
  return summary_sql;
end
$function$;

alter function vortex_record.module_summary_pivot_sql_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_summary_pivot_sql_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
