create or replace function vortex_record.module_query_bind_internal(
  p_opened jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  query_item jsonb := p_opened -> 'query';
  prepared_plan jsonb;
  bound_field_ids text[];
  search_plan jsonb;
  selected_ids text[];
begin
  -- Grouped and totalled shapes are not plain rows; the mode reading the page decides which
  -- grouping, if any, it accepts. Here only the shape is bounded.
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) is distinct from 'array'
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_opened -> 'exactRecordIds' = 'null'::jsonb
    and (p_opened ->> 'pageSize')::integer > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    (p_opened ->> 'moduleRootId')::uuid, (p_opened ->> 'queryId')::uuid,
    (p_opened ->> 'expectedReleaseRevision')::bigint, p_opened -> 'inputValues',
    p_opened -> 'filter', p_opened -> 'filterableFieldIds',
    'storage', p_opened -> 'prepared'
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if prepared_plan #>> '{access,predicate}' is null then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no access predicate';
  end if;
  if pg_catalog.jsonb_typeof(prepared_plan -> 'fieldBoundIds') is distinct from 'array' then
    raise exception using errcode = '55000',
      message = 'Prepared record query has no field bound';
  end if;
  select coalesce(pg_catalog.array_agg(item.value order by item.value), array[]::text[])
  into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'fieldBoundIds') as item(value)
  where (p_opened -> 'fieldsById') ? item.value;
  search_plan := vortex_record.query_search_plan_internal(
    pg_catalog.jsonb_build_object('search', p_opened -> 'search'), p_opened -> 'fieldsById',
    array(select pg_catalog.lower(item.value) from pg_catalog.jsonb_array_elements_text(
      p_opened -> 'searchableFieldIds') as item(value)));
  if search_plan ->> 'outcome' <> 'completed' then return search_plan; end if;
  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements_text(p_opened -> 'requestedFieldIds') as requested(id)
    where pg_catalog.lower(requested.id) <> all (selected_ids)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  -- The bound request: the storage and access plan of this reader, the fields it is guaranteed
  -- to see on every record it may read, and the search plan.
  return p_opened || pg_catalog.jsonb_build_object(
    'outcome', 'bound',
    'prepared', prepared_plan,
    'storagePlan', prepared_plan,
    'preview', prepared_plan ? 'preview',
    'storageContractId', prepared_plan #> '{storage,storageContractId}',
    'readableFieldIds', coalesce(prepared_plan -> 'readableFieldIds', '[]'::jsonb),
    'boundFieldIds', pg_catalog.to_jsonb(bound_field_ids),
    'searchPlan', search_plan,
    'selectedFieldIds', pg_catalog.to_jsonb(selected_ids)
  );
end
$function$;

alter function vortex_record.module_query_bind_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_bind_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_bind_internal(jsonb) is
  'Adapter-only second step of every Module query page read: bounds the resolved query shape, its relationship hops and page size, binds the reader''s storage, access predicate, readable fields and guaranteed field bound through prepare_module_query_internal, plans the search over the record type''s searchable fields, and refuses a requested field the published query does not select.';
