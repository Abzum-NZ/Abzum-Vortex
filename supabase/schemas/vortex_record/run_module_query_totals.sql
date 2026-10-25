-- Summarize selected visible columns, replacing the installed query grouping and aggregate defaults.
create or replace function vortex_record.run_module_query_totals(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_search text,
  p_searchable_field_ids uuid[],
  p_totals jsonb,
  p_group_limit integer,
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
  if (p_group_limit is not null and p_group_limit not between 1 and 200)
    or (p_group_after is not null and pg_catalog.length(p_group_after) not between 1 and 4096) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  opened := vortex_record.module_summary_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, p_search, p_searchable_field_ids
  );
  if opened ->> 'outcome' is distinct from 'prepared' then return opened; end if;
  query_item := opened -> 'query';
  query_item := vortex_record.module_summary_totals_internal(query_item, p_totals, false);
  if query_item ->> 'outcome' = 'refused' then return query_item; end if;
  planned := vortex_record.module_summary_plan_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, p_search, p_searchable_field_ids, opened, query_item, null, true, null, null,
    null, '{}'::jsonb, p_group_limit, p_group_after, null, null
  );
  if planned ->> 'outcome' is distinct from 'planned' then return planned; end if;
  return vortex_record.module_summary_execute_internal(planned,
    vortex_record.module_summary_totals_sql_internal(planned), false);
end
$function$;

alter function vortex_record.run_module_query_totals(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,integer,text) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_totals(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,integer,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_totals(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,integer,text) to vortex_request;
