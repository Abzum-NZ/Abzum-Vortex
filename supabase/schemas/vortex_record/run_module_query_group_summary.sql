-- Summarize one explicit grid dimension and its optional measures, including the reader field bound.
create or replace function vortex_record.run_module_query_group_summary(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_search text,
  p_searchable_field_ids uuid[],
  p_grouping jsonb,
  p_totals jsonb,
  p_group_after text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  opened jsonb;
  query_item jsonb;
  planned jsonb;
begin
  if p_group_after is not null and pg_catalog.length(p_group_after) not between 1 and 4096 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  opened := vortex_record.module_summary_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, p_search, p_searchable_field_ids
  );
  if opened ->> 'outcome' is distinct from 'prepared' then return opened; end if;
  query_item := opened -> 'query';
  query_item := vortex_record.grouping_query_internal(query_item, opened -> 'recordType', p_grouping, 50);
  if query_item is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if p_totals is not null or p_grouping -> 'aggregates' is not null then
    query_item := vortex_record.module_summary_totals_internal(query_item,
      coalesce(p_totals, p_grouping -> 'aggregates'), true);
    if query_item ->> 'outcome' = 'refused' then return query_item; end if;
  end if;
  planned := vortex_record.module_summary_plan_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, p_search, p_searchable_field_ids, opened, query_item,
    (p_grouping ->> 'fieldId')::uuid, (p_totals is not null or p_grouping -> 'aggregates' is not null),
    null, null, null,
    pg_catalog.jsonb_build_object(pg_catalog.lower(p_grouping ->> 'fieldId'), p_grouping -> 'dateBucket'),
    ((p_grouping ->> 'limit')::numeric)::integer, p_group_after, null, null
  );
  if planned ->> 'outcome' is distinct from 'planned' then return planned; end if;
  return vortex_record.module_summary_execute_internal(planned,
    vortex_record.module_summary_groups_sql_internal(planned), true);
end
$function$;

alter function vortex_record.run_module_query_group_summary(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_group_summary(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_group_summary(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,text) to vortex_request;
