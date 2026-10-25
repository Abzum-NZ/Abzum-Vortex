create or replace function vortex_record.run_module_query_group_members(
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
  p_grouping jsonb,
  p_group_selector jsonb,
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
  group_member jsonb;
  group_selector_values jsonb;
  opened jsonb;
  bound jsonb;
  query_item jsonb;
  group_by_ids text[];
  group_key text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  member jsonb;
  effective_sort jsonb;
  plan jsonb;
  scanned jsonb;
  result_value jsonb;
begin
  group_member := vortex_record.group_member_selector_internal(p_group_selector);
  if group_member is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  group_selector_values := group_member -> 'values';
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids, p_page_size, p_direction, null);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  -- A grid dimension replaces the query's own grouping defaults with one validated field.
  if p_grouping is not null then
    query_item := vortex_record.grouping_query_internal(
      opened -> 'query', opened -> 'recordType', p_grouping, 50);
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    opened := opened || pg_catalog.jsonb_build_object('query', query_item);
  end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  group_by_ids := vortex_record.query_group_member_fields_internal(
    bound -> 'query', bound -> 'fieldsById', p_group_selector -> 'values', group_member -> 'types');
  if group_by_ids is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  member := pg_catalog.jsonb_build_object(
    'kind', 'group', 'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
    'groupValues', group_selector_values, 'dateBucket', p_grouping -> 'dateBucket');
  -- Push membership of a grid dimension through the stored field; the reader rechecks the
  -- projected bucket of every row.
  if p_grouping is not null then
    group_key := pg_catalog.lower(p_grouping ->> 'fieldId');
    if not ((bound -> 'readableFieldIds') ? group_key) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select mapping.* into mapping_row from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = (bound ->> 'storageContractId')::uuid
      and mapping.field_id = group_key::uuid;
    if not found or mapping_row.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    begin
      member := member || pg_catalog.jsonb_build_object('predicate',
        vortex_record.grouping_member_predicate_internal(
          mapping_row.physical_column_token, mapping_row.database_value_type,
          bound #>> array['fieldsById', group_key, 'type'], p_grouping, group_selector_values -> group_key));
    exception when sqlstate 'V3187' then
      -- The forged or stale selector's date bucket is outside the supported year domain.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'value_out_of_range');
    end;
    if member -> 'predicate' = 'null'::jsonb then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if group_selector_values -> group_key = '"not_available"'::jsonb then
      member := member || pg_catalog.jsonb_build_object('linkValueSql',
        pg_catalog.format('stored.%I', mapping_row.physical_column_token));
    end if;
    if bound #>> array['fieldsById', group_key, 'type'] = 'link' then
      member := member || pg_catalog.jsonb_build_object('linkFieldId', group_key,
        'linkCache', vortex_record.group_link_unreadable_internal(
          '{}'::jsonb, array[group_selector_values -> group_key], bound #> array['fieldsById', group_key]));
      if coalesce((member #>> array['linkCache', group_selector_values -> group_key ->> 'recordId'])::boolean, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
    end if;
  end if;
  -- Grouping keys are constant within this exact selector. Remove them from the query's default
  -- member order; record identity still breaks every tie. A user sort replaces it when non-empty.
  if pg_catalog.jsonb_array_length(bound -> 'sort') > 0 then
    effective_sort := bound -> 'sort';
  else
    select coalesce(pg_catalog.jsonb_agg(item.value order by item.position), '[]'::jsonb)
    into effective_sort
    from pg_catalog.jsonb_array_elements(bound #> '{query,sort}') with ordinality as item(value, position)
    where pg_catalog.lower(item.value ->> 'fieldId') <> all (group_by_ids);
  end if;
  plan := vortex_record.module_query_scan_plan_internal(
    bound, effective_sort, pg_catalog.jsonb_array_length(bound -> 'sort') > 0, false, false, p_after);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  scanned := vortex_record.module_query_scan_internal(plan, member, null);
  if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
  result_value := vortex_record.module_query_result_internal(plan);
  if result_value ->> 'outcome' <> 'completed' then return result_value; end if;
  -- A generic group member page also names its exact group.
  return result_value || (scanned #> '{pages,0}') || pg_catalog.jsonb_build_object(
    'groupByFieldIds', pg_catalog.to_jsonb(group_by_ids),
    'groupValues', group_selector_values);
end
$function$;

alter function vortex_record.run_module_query_group_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],jsonb,jsonb,integer,jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_group_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],jsonb,jsonb,integer,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_group_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],jsonb,jsonb,integer,jsonb,text)
  to vortex_request;
comment on function vortex_record.run_module_query_group_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],jsonb,jsonb,integer,jsonb,text) is
  'One bounded keyset page, forward or backward, of the members of one generic group of an installed Module query or exact preview query, grouped by the query''s own grouping or one validated grid dimension: a record is a member only when every grouping value is present in its current readable projection and JSONB-equal to the closed typed selector (missing or withheld values belong to no group, JSON null is a value; date buckets use the authored zone; the unreadable-link group is decided by protected title batches). A grid dimension narrows the stored scan only when the field is guaranteed readable. Returns the rows, capabilities, continuations, group identity and the reader''s field bound.';
