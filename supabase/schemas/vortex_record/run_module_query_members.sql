create or replace function vortex_record.run_module_query_members(
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
  member_ids jsonb;
begin
  if p_record_ids is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids,
    pg_catalog.cardinality(p_record_ids), 'forward', p_record_ids);
  if opened ->> 'outcome' <> 'opened' then
    -- System projection exact reads remain unavailable to the general exact-row API. Membership
    -- uses the same bounded projection reader with the already validated identity list.
    if opened ->> 'reasonCode' <> 'descriptor_invalid' then return opened; end if;
    opened := vortex_record.module_query_open_internal(
      p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
      p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
      p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids,
      pg_catalog.cardinality(p_record_ids), 'forward', null);
    if opened ->> 'outcome' <> 'opened' then return opened; end if;
    if not (opened -> 'recordType' ? 'systemProjection') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    opened := pg_catalog.jsonb_set(opened, '{exactRecordIds}', pg_catalog.to_jsonb(p_record_ids));
  end if;
  -- An aggregate without groups has no row gestures. Grouped shapes retain their underlying rows.
  if pg_catalog.jsonb_typeof(opened #> '{query,aggregates}') = 'array'
    and pg_catalog.jsonb_array_length(opened #> '{query,aggregates}') > 0
    and pg_catalog.jsonb_array_length(coalesce(opened #> '{query,groupByFieldIds}', '[]'::jsonb)) = 0 then
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
  select coalesce(pg_catalog.jsonb_agg(item.value -> 'recordId'), '[]'::jsonb)
  into member_ids
  from pg_catalog.jsonb_array_elements(scanned #> '{pages,0,rows}') as item(value);
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'recordIds', member_ids);
end
$function$;

alter function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[])
  to vortex_request;
comment on function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[]) is
  'Returns only identities of supplied records admitted by the installed query filter and current read authority, ignoring grouping while refusing aggregate-only shapes.';
