create or replace function vortex_record.run_module_query_exact_rows(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids uuid[],
  p_requested_system_field_keys text[],
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_sort jsonb,
  p_search text,
  p_sortable_field_ids uuid[],
  p_searchable_field_ids uuid[],
  p_record_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  opened jsonb;
  bound jsonb;
  plan jsonb;
  scanned jsonb;
  result_value jsonb;
begin
  if p_record_ids is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- The page is exactly the named records: its size is their count.
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids,
    pg_catalog.cardinality(p_record_ids), 'forward', p_record_ids);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  -- Grouped and totalled shapes are not plain rows.
  if vortex_record.module_query_grouped_internal(opened -> 'query') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  plan := vortex_record.module_query_scan_plan_internal(
    bound,
    case when pg_catalog.jsonb_array_length(bound -> 'sort') > 0 then bound -> 'sort' else bound #> '{query,sort}' end,
    pg_catalog.jsonb_array_length(bound -> 'sort') > 0, true, true, null);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  scanned := vortex_record.module_query_scan_internal(plan, '{"kind": "all"}'::jsonb, null);
  if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
  result_value := vortex_record.module_query_result_internal(plan);
  if result_value ->> 'outcome' <> 'completed' then return result_value; end if;
  return result_value || (scanned #> '{pages,0}');
end
$function$;

alter function vortex_record.run_module_query_exact_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_exact_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_exact_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[])
  to vortex_request;
comment on function vortex_record.run_module_query_exact_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[]) is
  'Exactly the named 1 to 200 distinct, non-nil records of one installed Module query or exact preview query in one page, each under the same scope, release, filter, search and read_record decision as any row of the query, returning only those readable now with their capabilities and the reader''s field bound; refuses a system projection record type.';
