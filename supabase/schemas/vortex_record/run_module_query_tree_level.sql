create or replace function vortex_record.run_module_query_tree_level(
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
  p_parent_field_id uuid,
  p_parent_record_id uuid,
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
  tree_item jsonb;
  relationship_id uuid;
  member jsonb;
  plan jsonb;
  scanned jsonb;
  page jsonb;
  decision jsonb;
  tree_candidates uuid[];
  result_value jsonb;
begin
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids, p_page_size, p_direction, null);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  if pg_catalog.jsonb_array_length(coalesce(bound #> '{query,groupByFieldIds}', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(bound #> '{query,aggregates}', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- The parent link is a one-record link of the record type to itself that the reader is
  -- guaranteed to see.
  tree_item := vortex_record.query_tree_selector_internal(
    pg_catalog.jsonb_build_object('fieldId', p_parent_field_id, 'parentRecordId', p_parent_record_id),
    bound -> 'recordType',
    array(select item.value from pg_catalog.jsonb_array_elements_text(bound -> 'boundFieldIds') as item(value)));
  if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
  relationship_id := (tree_item ->> 'relationshipId')::uuid;
  plan := vortex_record.module_query_scan_plan_internal(
    bound,
    case when pg_catalog.jsonb_array_length(bound -> 'sort') > 0 then bound -> 'sort' else bound #> '{query,sort}' end,
    pg_catalog.jsonb_array_length(bound -> 'sort') > 0, true, false, p_after);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  -- Every tree relative read applies the query's own filter and the viewer's search, exactly as
  -- the level scan does: the pushed predicate, the filtered fields' readability and the residual.
  member := pg_catalog.jsonb_build_object(
    'kind', case when p_parent_record_id is null then 'tree_roots' else 'tree_children' end,
    'fieldId', tree_item ->> 'fieldId',
    'parentRecordId', p_parent_record_id,
    'relationshipId', relationship_id,
    'filter', pg_catalog.jsonb_build_object(
      'predicate', plan -> 'filterPredicate', 'parameters', plan -> 'filterParameters',
      'exact', plan -> 'filterExact', 'condition', plan -> 'filterCondition',
      'fieldTypes', plan -> 'filterTypes', 'inputTypes', plan -> 'inputTypes', 'inputs', plan -> 'inputs',
      'fieldIds', plan -> 'filterFieldIds', 'valuesSql', plan -> 'filterValuesSql',
      'searchFieldIds', plan #> '{searchPlan,fieldIds}', 'search', plan #> '{searchPlan,search}'));
  if p_parent_record_id is not null then
    -- The children of one parent: the stored edge narrows the scan; the readable link decides.
    member := member || pg_catalog.jsonb_build_object('predicate', pg_catalog.format(
      'exists (select 1 from vortex_record.relationship_edges as tree_edge'
      || ' where tree_edge.relationship_id = %1$L::uuid and tree_edge.from_organisation_id = stored.organisation_id'
      || ' and tree_edge.from_storage_contract_id = %2$L::uuid and tree_edge.from_record_id = stored.record_id'
      || ' and tree_edge.to_record_id = $16)',
      relationship_id, plan ->> 'storageContractId'));
  end if;
  scanned := vortex_record.module_query_scan_internal(plan, member, null);
  if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
  page := scanned #> '{pages,0}';
  if pg_catalog.jsonb_array_length(page -> 'rows') > 0 then
    decision := scanned -> 'decision';
    select pg_catalog.array_agg((item.value ->> 'recordId')::uuid) into tree_candidates
    from pg_catalog.jsonb_array_elements(page -> 'rows') as item(value);
    tree_item := vortex_record.read_query_tree_relatives_internal(
      false, tree_candidates, relationship_id, (plan ->> 'organizationId')::uuid,
      (plan ->> 'applicationRootId')::uuid, plan -> 'storagePlan', (plan ->> 'recordTypeId')::uuid,
      decision -> 'firstLoaded', decision -> 'declaration', nullif(decision -> 'eligibility', 'null'::jsonb),
      decision -> 'shared', (decision ->> 'narrowed')::boolean,
      nullif(decision -> 'validatedRecordTypes', 'null'::jsonb), member -> 'filter');
    if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
    -- A parent the examination budget did not decide has no answer yet: null, never a refusal.
    select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
        'hasChildren', case when (tree_item -> 'undecidedIds') ? (item.value ->> 'recordId') then null
          else (tree_item -> 'recordIds') ? (item.value ->> 'recordId') end) order by item.ordinality)
    into page
    from pg_catalog.jsonb_array_elements(page -> 'rows') with ordinality as item(value, ordinality);
    page := pg_catalog.jsonb_build_object('rows', page,
      'next', scanned #> '{pages,0,next}', 'opposite', scanned #> '{pages,0,opposite}');
  end if;
  result_value := vortex_record.module_query_result_internal(plan);
  if result_value ->> 'outcome' <> 'completed' then return result_value; end if;
  return result_value || page;
end
$function$;

alter function vortex_record.run_module_query_tree_level(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid,uuid,integer,jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_tree_level(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid,uuid,integer,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_tree_level(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid,uuid,integer,jsonb,text)
  to vortex_request;
comment on function vortex_record.run_module_query_tree_level(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid,uuid,integer,jsonb,text) is
  'One bounded keyset page, forward or backward, of one level of a tree over a one-record link of an installed Module query''s record type to itself that the reader is guaranteed to see: the roots (records whose parent no readable record matching the query''s filter and search holds, so an unreadable parent is never revealed, a readable parent link stays visible outside the filter or search, and a matching record under a non-matching parent stays reachable) or the children of one parent, through the same keyset order, access scan, filter, search and exact per-row read_record decision as a plain page. Each returned record reports, from one bounded set of rounds over the whole page, whether the reader may read a child of it that matches the query, or null when the rounds'' budget ran out.';
