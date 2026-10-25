create or replace function vortex_record.module_query_open_internal(
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
  p_direction text,
  p_exact_record_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  exact_ids_refusal text;
  prepared_plan jsonb;
  record_type_item jsonb;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  system_key text;
  system_expressions text[] := array[]::text[];
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_direction not in ('forward', 'backward') or p_direction is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- An exact read names 1..200 distinct, non-nil record ids and asks for exactly that many rows.
  if p_exact_record_ids is not null then
    -- CASE checks dimensions before array_position, which requires one dimension.
    exact_ids_refusal := case
      when pg_catalog.cardinality(p_exact_record_ids) > 200 then 'exact_ids_too_many'
      when pg_catalog.array_ndims(p_exact_record_ids) is distinct from 1
        or pg_catalog.cardinality(p_exact_record_ids) = 0 then 'exact_ids_invalid'
      when pg_catalog.array_position(p_exact_record_ids, null) is not null
        or '00000000-0000-0000-0000-000000000000'::uuid = any (p_exact_record_ids)
        or (select pg_catalog.count(distinct exact_id.id) from pg_catalog.unnest(p_exact_record_ids) as exact_id(id))
          <> pg_catalog.cardinality(p_exact_record_ids) then 'exact_ids_invalid'
      when p_page_size is distinct from pg_catalog.cardinality(p_exact_record_ids) then 'exact_ids_page_invalid'
    end;
    if exact_ids_refusal is not null then
      raise log '%', pg_catalog.jsonb_build_object('part', 'exact_ids', 'reason', exact_ids_refusal);
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
  end if;
  if p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- Every identity list is one-dimensional, distinct and free of nulls; the requested fields are
  -- 1..200, the declared sortable and searchable sets at most 200.
  if p_requested_field_ids is null
    or pg_catalog.cardinality(p_requested_field_ids) not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  p_sortable_field_ids := coalesce(p_sortable_field_ids, array[]::uuid[]);
  p_searchable_field_ids := coalesce(p_searchable_field_ids, array[]::uuid[]);
  p_filterable_field_ids := coalesce(p_filterable_field_ids, array[]::uuid[]);
  if exists (
    select 1
    from (values (p_requested_field_ids), (p_sortable_field_ids), (p_searchable_field_ids)) as list(ids)
    where pg_catalog.cardinality(list.ids) > 200
      or (pg_catalog.cardinality(list.ids) > 0 and (
        pg_catalog.array_ndims(list.ids) is distinct from 1
        or pg_catalog.array_position(list.ids, null) is not null
        or (select pg_catalog.count(distinct item.id) from pg_catalog.unnest(list.ids) as item(id))
          <> pg_catalog.cardinality(list.ids)))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  p_requested_system_field_keys := coalesce(p_requested_system_field_keys, array[]::text[]);
  if pg_catalog.cardinality(p_requested_system_field_keys) > 5
    or (pg_catalog.cardinality(p_requested_system_field_keys) > 0 and (
      pg_catalog.array_ndims(p_requested_system_field_keys) is distinct from 1
      or exists (
        select 1 from pg_catalog.unnest(p_requested_system_field_keys) as item(key)
        where item.key is null
          or item.key not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      )
      or (select pg_catalog.count(distinct item.key) from pg_catalog.unnest(p_requested_system_field_keys) as item(key))
        <> pg_catalog.cardinality(p_requested_system_field_keys))) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  -- The user's sort: the same pair shape as the published sort, bounded; each pair is validated
  -- with the published order once the readable fields are known.
  p_sort := coalesce(p_sort, '[]'::jsonb);
  if pg_catalog.jsonb_typeof(p_sort) <> 'array' or pg_catalog.jsonb_array_length(p_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  foreach system_key in array p_requested_system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_filter, pg_catalog.to_jsonb(p_filterable_field_ids), 'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  record_type_item := prepared_plan -> 'recordType';
  if p_exact_record_ids is not null and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;
  -- The opened request: its bounded inputs and the resolved release. The mode reading it may
  -- replace `query` with its own validated grouping before binding storage and access.
  return pg_catalog.jsonb_build_object(
    'outcome', 'opened',
    'moduleRootId', p_module_root_id,
    'queryId', p_query_id,
    'expectedReleaseRevision', p_expected_release_revision,
    'inputValues', p_input_values,
    'filter', p_filter,
    'filterableFieldIds', pg_catalog.to_jsonb(p_filterable_field_ids),
    'requestedFieldIds', pg_catalog.to_jsonb(p_requested_field_ids),
    'systemFieldKeys', pg_catalog.to_jsonb(p_requested_system_field_keys),
    'systemColumnsSql', pg_catalog.array_to_string(system_expressions, ', '),
    'sortableFieldIds', pg_catalog.to_jsonb(p_sortable_field_ids),
    'searchableFieldIds', pg_catalog.to_jsonb(p_searchable_field_ids),
    'search', p_search,
    'sort', p_sort,
    'pageSize', p_page_size,
    'direction', p_direction,
    'exactRecordIds', pg_catalog.to_jsonb(p_exact_record_ids),
    'prepared', prepared_plan,
    'resolved', prepared_plan -> 'resolved',
    'query', prepared_plan -> 'query',
    'recordType', record_type_item,
    'recordTypeId', prepared_plan -> 'recordTypeId',
    'organizationId', prepared_plan #> '{scope,organizationId}',
    'applicationRootId', prepared_plan #> '{scope,applicationRootId}',
    'fieldsById', fields_by_id
  );
end
$function$;

alter function vortex_record.module_query_open_internal(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,text,uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_open_internal(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,text,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_open_internal(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],integer,text,uuid[]) is
  'Adapter-only first step of every Module query page read: bounds the typed request (direction, page size 1 to 200, distinct requested, sortable and searchable field identities, declared system values, an exact record id list of 1 to 200 that sets the page size, a sort list of at most 20 pairs), resolves the installed or preview release through prepare_module_query_internal and returns the opened request with the resolved query, record type and fields, or the first refusal. It supplies no authority.';
