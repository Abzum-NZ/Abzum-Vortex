create or replace function vortex_record.run_module_query_rows(
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
  p_page_size integer,
  p_after jsonb,
  p_direction text
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
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids, p_page_size, p_direction, null);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  -- Grouped and totalled shapes are not plain rows.
  if pg_catalog.jsonb_array_length(coalesce(bound #> '{query,groupByFieldIds}', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(bound #> '{query,aggregates}', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- The user's order replaces the published order only when it is non-empty.
  plan := vortex_record.module_query_scan_plan_internal(
    bound,
    case when pg_catalog.jsonb_array_length(bound -> 'sort') > 0 then bound -> 'sort' else bound #> '{query,sort}' end,
    pg_catalog.jsonb_array_length(bound -> 'sort') > 0, true, true, p_after);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  scanned := vortex_record.module_query_scan_internal(plan, '{"kind": "all"}'::jsonb, null);
  if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
  result_value := vortex_record.module_query_result_internal(plan);
  if result_value ->> 'outcome' <> 'completed' then return result_value; end if;
  return result_value || (scanned #> '{pages,0}');
end
$function$;

alter function vortex_record.run_module_query_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,jsonb,text)
  to vortex_request;
comment on function vortex_record.run_module_query_rows(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,jsonb,text) is
  'One bounded keyset page, forward or backward, of the plain rows of one installed Module query, or one exact current human-owned preview query over isolated preview storage: each row readable through read_record now, with its concurrency number, per-row capabilities and only the declared system values, plus the reader''s current field bound, or one refusal before any row is exposed. The viewer''s sort, typed filter and search only narrow or reorder within the component-declared and record-type sets over fields the reader is guaranteed to see; the shared protected path is module_query_open, bind, scan_plan and scan.';
