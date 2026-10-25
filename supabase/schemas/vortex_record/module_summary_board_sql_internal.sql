-- Shape one protected board summary from the shared candidate and aggregate plan.
create or replace function vortex_record.module_summary_board_sql_internal(
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
  fast_path boolean;
  candidate_sql text;
  selected_sql text;
  aggregate_object_sql text;
  board_choice_field_id text;
  board_options jsonb;
  board_requested_positions integer[];
  p_module_root_id uuid;
  p_query_id uuid;
  summary_sql text;
  board_option jsonb;
  board_bucket_sql text;
  board_option_position integer;
  board_totals_sql text;
  board_empty_aggregates_sql text;
begin
  summary_candidate_limit := (p_plan ->> 'summary_candidate_limit')::integer;
  resolved := nullif(p_plan -> 'resolved', 'null'::jsonb);
  fast_path := (p_plan ->> 'fast_path')::boolean;
  candidate_sql := (p_plan ->> 'candidate_sql')::text;
  selected_sql := (p_plan ->> 'selected_sql')::text;
  aggregate_object_sql := (p_plan ->> 'aggregate_object_sql')::text;
  board_choice_field_id := (p_plan ->> 'board_choice_field_id')::text;
  board_options := nullif(p_plan -> 'board_options', 'null'::jsonb);
  select case when p_plan -> 'board_requested_positions' = '[]'::jsonb then array[]::integer[]
    else pg_catalog.array_agg(item.value::integer order by item.position) end into board_requested_positions
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'board_requested_positions', 'null'::jsonb))
    with ordinality as item(value, position);
  p_module_root_id := (p_plan ->> 'p_module_root_id')::uuid;
  p_query_id := (p_plan ->> 'p_query_id')::uuid;
  board_bucket_sql := pg_catalog.format(
    'case when pg_catalog.jsonb_typeof(candidate.projected_values -> %L) = ''string'' then case ',
    board_choice_field_id
  );
  board_option_position := 0;
  for board_option in
    select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
  loop
    board_option_position := board_option_position + 1;
    board_bucket_sql := board_bucket_sql || pg_catalog.format(
      'when (candidate.projected_values ->> %L) collate "C" = %L collate "C" then %s ',
      board_choice_field_id, board_option ->> 'value', board_option_position
    );
  end loop;
  board_bucket_sql := board_bucket_sql || 'else 0 end else 0 end';
  -- Requested buckets are data, validated against the installed options. Only these buckets
  -- enter the existing capped aggregate path; unread columns retain navigation metadata only.
  if aggregate_object_sql = '' then
    board_totals_sql := 'select ''{}''::jsonb as aggregate_values';
    board_empty_aggregates_sql := 'select ''{}''::jsonb as aggregates';
  else
    board_totals_sql := pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as aggregate_values
       from normalized as candidate',
      aggregate_object_sql
    );
    board_empty_aggregates_sql := pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as aggregates
       from (select null::jsonb as projected_values) as candidate where false',
      aggregate_object_sql
    );
  end if;
  if fast_path then
    -- One grouping-set scan computes both each bucket and the grand total.
    -- The raw candidate count is retained separately for the existing limit.
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as (%s),
       normalized as (
         select bucket.projected_values, bucket.bucket_index
         from (select candidate.projected_values, %s as bucket_index
           from selected as candidate) as bucket
         where bucket.bucket_index = any (%L::integer[])
       ),
       aggregate_rows as materialized (
         select grouping(candidate.bucket_index) as is_total,
           candidate.bucket_index,
           pg_catalog.count(*)::integer as row_count,
           %s as aggregates
         from normalized as candidate
         group by rollup(candidate.bucket_index)
       ),
       totals as (select row_count, aggregates from aggregate_rows where is_total = 1),
       grouped as (select bucket_index, row_count, aggregates from aggregate_rows where is_total = 0),
       installed_options as (
         select choice_option.value, choice_option.position::integer as position
         from pg_catalog.jsonb_array_elements(%L::jsonb)
           with ordinality as choice_option(value, position)
       ),
       empty_aggregates as (%s),
       columns_result as (
         select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             ''value'', installed.value ->> ''value'',
             ''label'', installed.value ->> ''label'',
             ''rowCount'', case when installed.position = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
             ''aggregates'', case when installed.position = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
           ) order by installed.position
         ), ''[]''::jsonb) as value
         from installed_options as installed
         left join grouped on grouped.bucket_index = installed.position
         cross join empty_aggregates
       ),
       unassigned_result as (
         select pg_catalog.jsonb_build_object(
           ''rowCount'', case when 0 = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
           ''aggregates'', case when 0 = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
         ) as value
         from (select 0::integer as bucket_index) as unassigned
         left join grouped on grouped.bucket_index = unassigned.bucket_index
         cross join empty_aggregates
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''choiceFieldId'', %L,
           ''totalRowCount'', totals.row_count,
           ''columns'', columns_result.value,
           ''unassigned'', unassigned_result.value,
           ''aggregates'', totals.aggregates
         ) end
       from candidate_count cross join totals
         cross join columns_result cross join unassigned_result',
      candidate_sql,
      selected_sql,
      board_bucket_sql,
      board_requested_positions::text,
      case when aggregate_object_sql = '' then '''{}''::jsonb'
        else pg_catalog.format('pg_catalog.jsonb_build_object(%s)', aggregate_object_sql) end,
      board_options::text,
      board_empty_aggregates_sql,
      board_requested_positions::text, board_requested_positions::text,
      board_requested_positions::text, board_requested_positions::text,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      board_choice_field_id
    );
  else
  summary_sql := pg_catalog.format(
    'with candidate as materialized (%s),
     candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
     selected as materialized (%s),
     normalized as materialized (
       select bucket.projected_values, bucket.bucket_index
       from (select candidate.projected_values, %s as bucket_index
         from selected as candidate) as bucket
       where bucket.bucket_index = any (%L::integer[])
     ),
     selected_count as (select pg_catalog.count(*)::integer as value from normalized),
     installed_options as (
       select choice_option.value, choice_option.position::integer as position
       from pg_catalog.jsonb_array_elements(%L::jsonb)
         with ordinality as choice_option(value, position)
     ),
     totals as (%s),
     grouped as (
       select candidate.bucket_index,
         pg_catalog.count(*)::integer as row_count,
         pg_catalog.jsonb_build_object(%s) as aggregates
       from normalized as candidate
       group by candidate.bucket_index
     ),
     empty_aggregates as (%s),
     columns_result as (
       select coalesce(pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           ''value'', installed.value ->> ''value'',
           ''label'', installed.value ->> ''label'',
           ''rowCount'', case when installed.position = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
           ''aggregates'', case when installed.position = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
         ) order by installed.position
       ), ''[]''::jsonb) as value
       from installed_options as installed
       left join grouped on grouped.bucket_index = installed.position
       cross join empty_aggregates
     ),
     unassigned_result as (
       select pg_catalog.jsonb_build_object(
         ''rowCount'', case when 0 = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
         ''aggregates'', case when 0 = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
       ) as value
       from (select 0::integer as bucket_index) as unassigned
       left join grouped on grouped.bucket_index = unassigned.bucket_index
       cross join empty_aggregates
     )
     select case when candidate_count.value > %s
       then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
       else pg_catalog.jsonb_build_object(
         ''outcome'', ''completed'',
         ''moduleRootId'', %L,
         ''moduleReleaseVersion'', %L,
         ''queryId'', %L,
         ''choiceFieldId'', %L,
         ''totalRowCount'', selected_count.value,
         ''columns'', columns_result.value,
         ''unassigned'', unassigned_result.value,
         ''aggregates'', totals.aggregate_values
       ) end
     from candidate_count cross join selected_count cross join totals
       cross join columns_result cross join unassigned_result',
    candidate_sql,
    selected_sql,
    board_bucket_sql,
    board_requested_positions::text,
    board_options::text,
    board_totals_sql,
    aggregate_object_sql,
    board_empty_aggregates_sql,
    board_requested_positions::text, board_requested_positions::text,
    board_requested_positions::text, board_requested_positions::text,
    summary_candidate_limit,
    p_module_root_id::text,
    resolved ->> 'moduleReleaseVersion',
    p_query_id::text,
    board_choice_field_id
  );
  end if;
  return summary_sql;
end
$function$;

alter function vortex_record.module_summary_board_sql_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_summary_board_sql_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
