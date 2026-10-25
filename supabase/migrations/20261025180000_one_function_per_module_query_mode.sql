-- One function per Module query mode (#3015): rows, exact rows, board column, board columns, group
-- members and tree level, each with typed parameters over the shared protected helpers; the
-- multi-mode run_module_query and its hidden user-input keys are removed.
set local role vortex_record_adapter;

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

create or replace function vortex_record.module_query_scan_plan_internal(
  p_bound jsonb,
  p_sort jsonb,
  p_sort_is_user boolean,
  p_sort_required boolean,
  p_projection_allowed boolean,
  p_after jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  fields_by_id jsonb := p_bound -> 'fieldsById';
  record_type_item jsonb := p_bound -> 'recordType';
  v_storage_contract_id uuid := (p_bound ->> 'storageContractId')::uuid;
  preview_mode boolean := (p_bound ->> 'preview')::boolean;
  direction text := p_bound ->> 'direction';
  page_size integer := (p_bound ->> 'pageSize')::integer;
  readable_field_ids text[];
  declared_sortable_ids text[];
  storage_plan jsonb := p_bound -> 'storagePlan';
  prepared_plan jsonb;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  sort_item jsonb;
  field_key text;
  pushed boolean;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  cursor_sort jsonb := '[]'::jsonb;
  sort_directions text[] := array[]::text[];
  scan_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  sort_index_backed boolean[] := array[]::boolean[];
  sort_stored boolean[] := array[]::boolean[];
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  composite_sort jsonb;
  composite_index_ready boolean := false;
  record_id_direction text := 'ascending';
  scan_record_id_direction text := 'ascending';
  after_sort_key text[];
  after_phase text;
  after_record_id uuid;
  sort_index integer;
  prefix_index integer;
  column_sql text;
  value_sql text;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  segment_predicates text[];
  segment_prefix text;
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  filter_condition jsonb;
  filter_expressions text[];
  filter_predicate text;
  filter_exact boolean;
  scan_source_sql text;
  scan_projection_sql text := 'null::jsonb';
  search_prefilter_sql text := 'true';
  projection_page_scan boolean := false;
  projection_sort_key text;
  projection_plan jsonb;
  projection_predicate jsonb;
begin
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(p_bound -> 'readableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value)), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(p_bound -> 'sortableFieldIds') as item(value);
  -- Sort only on readable fields: validate declared keys, refuse unbounded user keys, and end
  -- with record identity. A withheld published key never changes membership or reveals its value.
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(p_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if p_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      if preview_mode then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    cursor_sort := cursor_sort || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'fieldId', field_key, 'direction', sort_item ->> 'direction',
        'pushed', pushed
      )
    );
    if p_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,op}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        v_storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
        read_time_clock
      );
      if read_time_sql is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
      end if;
      if not pushed then
        continue;
      end if;
      sort_ids := pg_catalog.array_append(sort_ids, field_key);
      sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
      sort_value_sql := pg_catalog.array_append(sort_value_sql, read_time_sql);
      sort_sql_types := pg_catalog.array_append(sort_sql_types, 'boolean');
      sort_index_backed := pg_catalog.array_append(sort_index_backed, false);
      sort_stored := pg_catalog.array_append(sort_stored, false);
      continue;
    end if;
    -- JSON-valued fields (money, links, choice sets, documents) have no total
    -- order here; money in particular is never ordered across currencies.
    if mapping_row.database_value_type not in (
      'integer', 'decimal', 'boolean', 'date', 'timestamp_with_time_zone', 'text', 'uuid'
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if not pushed then
      continue;
    end if;
    sort_ids := pg_catalog.array_append(sort_ids, field_key);
    sort_directions := pg_catalog.array_append(sort_directions, sort_item ->> 'direction');
    sort_value_sql := pg_catalog.array_append(
      sort_value_sql, pg_catalog.format('stored.%I', mapping_row.physical_column_token)
    );
    sort_index_backed := pg_catalog.array_append(sort_index_backed,
      coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false)
        or coalesce((fields_by_id -> field_key ->> 'unique')::boolean, false));
    sort_stored := pg_catalog.array_append(sort_stored, true);
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0 and p_sort_required then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;
  -- The tie-break direction is a property of the declared order, independent
  -- of whether its asynchronous physical index has finished building.
  if pg_catalog.cardinality(sort_ids) > 0 then
    record_id_direction := sort_directions[pg_catalog.cardinality(sort_ids)];
  end if;
  if pg_catalog.cardinality(sort_ids) > 1
    and pg_catalog.cardinality(sort_ids) = pg_catalog.cardinality(declared_sort_ids)
    and not (false = any (sort_stored)) then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fieldId', sort_ids[item.position],
      'direction', sort_directions[item.position]) order by item.position)
    into composite_sort
    from pg_catalog.generate_series(1, pg_catalog.cardinality(sort_ids)) as item(position);
    select coalesce(index_value.indisvalid, false) into composite_index_ready
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = pg_catalog.to_regclass(pg_catalog.format(
      'record_data.%I', 'is_' || pg_catalog.md5(
        v_storage_contract_id::text || ':' || composite_sort::text)));
    composite_index_ready := coalesce(composite_index_ready, false);
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    (p_bound ->> 'moduleRootId')::uuid, (p_bound ->> 'queryId')::uuid,
    (p_bound ->> 'expectedReleaseRevision')::bigint, p_bound -> 'inputValues',
    p_bound -> 'filter', p_bound -> 'filterableFieldIds',
    'complete', p_bound -> 'prepared'
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  if preview_mode and (
    prepared_plan -> 'storage' is distinct from storage_plan -> 'storage'
    or prepared_plan -> 'fieldMappings' is distinct from storage_plan -> 'fieldMappings'
    or prepared_plan -> 'readableFieldIds' is distinct from storage_plan -> 'readableFieldIds'
    or prepared_plan -> 'access' is distinct from storage_plan -> 'access'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_exact := (prepared_plan #>> '{filter,pushedExact}')::boolean is true;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);
  -- The keyset position must fit this exact order. The cursor binds every
  -- declared sort field, direction and whether it was pushed, but carries
  -- values only for readable sort fields. A changed readable subset cannot
  -- reinterpret an old key or put a hidden field value in a cursor.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'phase', 'recordId', 'sort']::text[] <> '{}'::jsonb
      or p_after -> 'sort' is distinct from cursor_sort
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
      or p_after ->> 'phase' not in ('null', 'value')
      or pg_catalog.lower(p_after ->> 'recordId') !~ uuid_pattern
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') as item(value)
        where pg_catalog.jsonb_typeof(item.value) not in ('string', 'null')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality)
    into after_sort_key
    from pg_catalog.jsonb_array_elements(p_after -> 'sortKey') with ordinality as item(value, ordinality);
    after_record_id := (p_after ->> 'recordId')::uuid;
    after_phase := p_after ->> 'phase';
    if after_phase is distinct from (case
      when pg_catalog.cardinality(sort_ids) > 0 and after_sort_key[1] is null then 'null'
      else 'value' end) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
    end if;
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;
  for sort_index in 1 .. pg_catalog.cardinality(sort_directions) loop
    scan_directions := pg_catalog.array_append(scan_directions,
      case when direction = 'forward' then sort_directions[sort_index]
        when sort_directions[sort_index] = 'ascending' then 'descending'
        else 'ascending' end);
  end loop;
  scan_record_id_direction := case when direction = 'forward' then record_id_direction
    when record_id_direction = 'ascending' then 'descending' else 'ascending' end;
  scan_source_sql := pg_catalog.format('record_data.%I as stored', prepared_plan #>> '{storage,physicalTableToken}');
  projection_page_scan := p_projection_allowed and not preview_mode
    and record_type_item ? 'systemProjection'
    and pg_catalog.cardinality(sort_ids) = 1
    and pg_catalog.cardinality(declared_sort_ids) = 1
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        record_type_item #> '{systemProjection,sortableFieldIds}'
      ) as sortable(id)
      where pg_catalog.lower(sortable.id) = sort_ids[1]
    ) and vortex_record.has_bounded_system_projection_reader_internal(
      v_storage_contract_id, fields_by_id -> sort_ids[1] ->> 'key'
    );
  if record_type_item ? 'systemProjection' and not projection_page_scan then
    -- Protected rows have exactly one bounded scan path. Unsupported shapes
    -- must never fall through to generated record_data storage.
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode',
      case when p_projection_allowed then 'sort_invalid' else 'descriptor_invalid' end);
  end if;
  if projection_page_scan then
    projection_sort_key := fields_by_id -> sort_ids[1] ->> 'key';
    if projection_sort_key is null then
      raise exception using errcode = '55000',
        message = 'Protected projection sort field is unavailable';
    end if;
    projection_plan := vortex_record.prepare_system_projection_scan_internal(
      prepared_plan || pg_catalog.jsonb_build_object('queryModuleRootId', p_bound -> 'moduleRootId'),
      p_bound -> 'searchPlan');
    if projection_plan ->> 'outcome' <> 'prepared' then return projection_plan; end if;
    projection_predicate := projection_plan -> 'predicate';
    scan_source_sql := projection_plan ->> 'sourceSql';
    -- The one place the predicate is applied is the reader's scan.
    filter_predicate := 'true';
    filter_exact := true;
    filter_expressions := array[]::text[];
    scan_projection_sql := 'pg_catalog.to_jsonb(projection)';
  end if;
  -- The scan order. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when scan_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_platform.format_timestamp_utc(%s)',
        sort_value_sql[sort_index])
      when 'date' then pg_catalog.format(
        'pg_catalog.to_char(%s, ''YYYY-MM-DD'')', sort_value_sql[sort_index])
      else pg_catalog.format('(%s)::text', sort_value_sql[sort_index]) end);
    if after_record_id is not null then
      value_sql := case when sort_sql_types[sort_index] = 'text'
        then pg_catalog.format('$3[%s] collate "C"', sort_index)
        else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
      if after_sort_key[sort_index] is null then
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when scan_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix ||
      'stored.record_id ' || case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  else
    order_by_sql := order_by_sql || ', stored.record_id ' ||
      case when scan_record_id_direction = 'ascending' then 'asc' else 'desc' end;
  end if;
  if composite_index_ready then
    segment_predicates := array[]::text[];
    if after_record_id is null then
      segment_predicates := array[''];
    else
      -- A mixed-direction lexicographic comparison is one seek per first
      -- differing key. Each scan has an equality prefix and one B-tree range,
      -- including the NULL region in its own segment.
      segment_prefix := '';
      for prefix_index in 1 .. pg_catalog.cardinality(sort_ids) loop
        column_sql := case when sort_sql_types[prefix_index] = 'text'
          then sort_value_sql[prefix_index] || ' collate "C"'
          else sort_value_sql[prefix_index] end;
        if after_sort_key[prefix_index] is null then
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s is null', sort_value_sql[prefix_index]);
        else
          value_sql := case when sort_sql_types[prefix_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', prefix_index)
            else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
          segment_prefix := segment_prefix || pg_catalog.format(
            ' and %s = %s', column_sql, value_sql);
        end if;
      end loop;
      segment_predicates := pg_catalog.array_append(segment_predicates,
        segment_prefix || ' and stored.record_id ' ||
        case when scan_record_id_direction = 'ascending' then '>' else '<' end || ' $4');
      for sort_index in reverse pg_catalog.cardinality(sort_ids) .. 1 loop
        segment_prefix := '';
        for prefix_index in 1 .. sort_index - 1 loop
          column_sql := case when sort_sql_types[prefix_index] = 'text'
            then sort_value_sql[prefix_index] || ' collate "C"'
            else sort_value_sql[prefix_index] end;
          if after_sort_key[prefix_index] is null then
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s is null', sort_value_sql[prefix_index]);
          else
            value_sql := case when sort_sql_types[prefix_index] = 'text'
              then pg_catalog.format('$3[%s] collate "C"', prefix_index)
              else pg_catalog.format('($3[%s])::%s', prefix_index, sort_sql_types[prefix_index]) end;
            segment_prefix := segment_prefix || pg_catalog.format(
              ' and %s = %s', column_sql, value_sql);
          end if;
        end loop;
        column_sql := case when sort_sql_types[sort_index] = 'text'
          then sort_value_sql[sort_index] || ' collate "C"'
          else sort_value_sql[sort_index] end;
        if after_sort_key[sort_index] is null then
          if scan_directions[sort_index] = 'ascending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is not null', sort_value_sql[sort_index]));
          end if;
        else
          value_sql := case when sort_sql_types[sort_index] = 'text'
            then pg_catalog.format('$3[%s] collate "C"', sort_index)
            else pg_catalog.format('($3[%s])::%s', sort_index, sort_sql_types[sort_index]) end;
          segment_predicates := pg_catalog.array_append(segment_predicates,
            segment_prefix || pg_catalog.format(' and %s %s %s', column_sql,
              case when scan_directions[sort_index] = 'ascending' then '>' else '<' end,
              value_sql));
          if scan_directions[sort_index] = 'descending' then
            segment_predicates := pg_catalog.array_append(segment_predicates,
              segment_prefix || pg_catalog.format(' and %s is null', sort_value_sql[sort_index]));
          end if;
        end if;
      end loop;
    end if;
  elsif pg_catalog.cardinality(sort_ids) = 1 and sort_index_backed[1] then
    -- Each segment has one contiguous range in the aligned index. A NULL
    -- cursor finishes its record-id range before the value range begins.
    if scan_directions[1] = 'ascending' then
      if after_record_id is null or after_phase = 'null' then
        segment_predicates := array[
          pg_catalog.format(' and %s is null%s', sort_value_sql[1],
            case when after_record_id is null then '' else ' and stored.record_id > $4' end),
          pg_catalog.format(' and %s is not null', sort_value_sql[1])
        ];
      else
        segment_predicates := array[pg_catalog.format(
          ' and %s is not null and (%s, stored.record_id) > (%s, $4)',
          sort_value_sql[1], column_sql, value_sql
        )];
      end if;
    elsif after_record_id is null then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null', sort_value_sql[1]),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    elsif after_phase = 'value' then
      segment_predicates := array[
        pg_catalog.format(' and %s is not null and (%s, stored.record_id) < (%s, $4)',
          sort_value_sql[1], column_sql, value_sql),
        pg_catalog.format(' and %s is null', sort_value_sql[1])
      ];
    else
      segment_predicates := array[pg_catalog.format(
        ' and %s is null and stored.record_id < $4', sort_value_sql[1])];
    end if;
  else
    segment_predicates := array[keyset_sql];
  end if;
  if projection_page_scan then
    -- The bounded reader has already applied the sealed keyset and order.
    segment_predicates := array[''];
  else
    -- A search narrows the candidate scan, and so the budget, through the one shared
    -- stored-value pre-predicate; the per-row search match below stays the decision.
    search_prefilter_sql := vortex_record.query_search_prefilter_internal(
      v_storage_contract_id, fields_by_id,
      array(select item.value from pg_catalog.jsonb_array_elements_text(p_bound #> '{searchPlan,fieldIds}') as item(value)),
      readable_field_ids, p_bound #>> '{searchPlan,search}', 17, 18);
  end if;
  -- The scan plan: every SQL fragment comes from the storage catalogue and the prepared plan,
  -- every value it compares is a bound parameter of the one scan.
  return p_bound || pg_catalog.jsonb_build_object(
    'outcome', 'planned',
    'prepared', prepared_plan,
    'cursorSort', cursor_sort,
    'sortCount', pg_catalog.cardinality(sort_ids),
    'afterSortKey', pg_catalog.to_jsonb(after_sort_key),
    'after', p_after,
    'afterRecordId', after_record_id,
    'filterCondition', filter_condition,
    'filterExact', filter_exact,
    'filterTypes', coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb),
    'inputTypes', coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb),
    'inputs', coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb),
    'filterPredicate', filter_predicate,
    'filterParameters', coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb),
    'filterFieldIds', coalesce(prepared_plan -> 'filterFieldIds', '[]'::jsonb),
    'filterValuesSql', (select pg_catalog.string_agg(
        filter_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index)
      from (
        select (filter_pair.pair_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            filter_pair.pair_text, ', ' order by filter_pair.pair_number
          ) as pairs_text
        from pg_catalog.unnest(filter_expressions)
          with ordinality as filter_pair(pair_text, pair_number)
        group by (filter_pair.pair_number - 1) / 50
      ) as filter_chunk),
    'sortKeySql', pg_catalog.array_to_string(sort_key_terms, ', '),
    'orderBySql', order_by_sql,
    'segmentPredicates', pg_catalog.to_jsonb(segment_predicates),
    'scanSourceSql', scan_source_sql,
    'scanProjectionSql', scan_projection_sql,
    'searchPrefilterSql', search_prefilter_sql,
    'projectionPageScan', projection_page_scan,
    'projectionSortKey', projection_sort_key,
    'projectionPredicate', projection_predicate,
    'projectionDirection', scan_directions[1]
  );
end
$function$;

alter function vortex_record.module_query_scan_plan_internal(jsonb,jsonb,boolean,boolean,boolean,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_scan_plan_internal(jsonb,jsonb,boolean,boolean,boolean,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_scan_plan_internal(jsonb,jsonb,boolean,boolean,boolean,jsonb) is
  'Adapter-only third step of every Module query page read: validates the effective sort (a user sort only over declared, record-type sortable fields the reader is guaranteed to see; a published key the reader may not see stays in the cursor binding but never in the scan order), completes the prepared plan with its filter pushdown and the preview pin recheck, validates the sealed keyset position against this exact order, chooses the one bounded system projection reader where the record type has one, and builds the scan order, keyset segments and search pre-predicate as catalogue-derived SQL over bound parameters.';

create or replace function vortex_record.module_query_scan_internal(
  p_plan jsonb,
  p_member jsonb,
  p_prior_decision jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- A page ending at this candidate budget still returns its position for the next request.
  scan_limit constant integer := 500;
  member_kind text := p_member ->> 'kind';
  page_size integer := (p_plan ->> 'pageSize')::integer;
  direction text := p_plan ->> 'direction';
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  v_storage_contract_id uuid := (p_plan ->> 'storageContractId')::uuid;
  context_organization_id uuid := (p_plan ->> 'organizationId')::uuid;
  context_application_root_id uuid := (p_plan ->> 'applicationRootId')::uuid;
  preview_mode boolean := (p_plan ->> 'preview')::boolean;
  fields_by_id jsonb := p_plan -> 'fieldsById';
  storage_plan jsonb := p_plan -> 'storagePlan';
  requested_ids text[];
  system_field_keys text[];
  filter_ids text[];
  search_field_ids text[];
  user_search text := p_plan #>> '{searchPlan,search}';
  filter_condition jsonb := nullif(p_plan -> 'filterCondition', 'null'::jsonb);
  filter_exact boolean := (p_plan ->> 'filterExact')::boolean;
  filter_types jsonb := p_plan -> 'filterTypes';
  parameter_types jsonb := p_plan -> 'inputTypes';
  parameter_values jsonb := p_plan -> 'inputs';
  after_sort_key text[];
  after_record_id uuid := (p_plan ->> 'afterRecordId')::uuid;
  exact_record_ids uuid[];
  access_owner_account_id uuid := nullif(p_plan #>> '{prepared,access,ownerAccountId}', '')::uuid;
  access_owner_group_ids uuid[];
  access_shared_record_ids uuid[];
  segment_predicates text[];
  segment_sql text;
  scan_sql text;
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  read_row record;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  -- The one bounded system projection reader, when the plan chose it.
  projection_page_scan boolean := (p_plan ->> 'projectionPageScan')::boolean;
  projection_sort_key text := p_plan ->> 'projectionSortKey';
  projection_direction text := p_plan ->> 'projectionDirection';
  projection_predicate jsonb := p_plan -> 'projectionPredicate';
  projection_batch jsonb;
  projection_after jsonb := nullif(p_plan -> 'after', 'null'::jsonb);
  projection_batch_size integer;
  projection_candidate_count integer := 0;
  projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  projection_failure text;
  -- The page's access facts, eligibility and validated record types stay those of this one scan.
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  page_first_loaded jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  every_bucket_more boolean := false;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  -- Page state by bucket: one bucket, except a board's shared first pages, where each readable row
  -- goes to the column its readable choice value names.
  bucket_count integer := case when p_member ->> 'kind' = 'choice'
    then pg_catalog.jsonb_array_length(p_member -> 'columns') else 1 end;
  bucket integer;
  bucket_rows jsonb[];
  bucket_capabilities jsonb[];
  bucket_counts integer[];
  bucket_more boolean[];
  bucket_first_keys jsonb[];
  bucket_first_ids uuid[];
  bucket_last_keys jsonb[];
  bucket_last_ids uuid[];
  page_capabilities jsonb;
  rows_value jsonb;
  next_value jsonb;
  opposite_value jsonb;
  pages jsonb := '[]'::jsonb;
  key_value jsonb;
  -- Membership of the closed mode value.
  choice_field_id text := p_member ->> 'choiceFieldId';
  choice_option_values text[];
  group_by_ids text[];
  group_selector_values jsonb := p_member -> 'groupValues';
  group_link_field_id text := p_member ->> 'linkFieldId';
  group_link_cache jsonb := coalesce(p_member -> 'linkCache', '{}'::jsonb);
  group_link_values jsonb[];
  group_candidate_values jsonb;
  member_matches boolean;
  tree_field_id text := p_member ->> 'fieldId';
  tree_parent_id uuid := (p_member ->> 'parentRecordId')::uuid;
  tree_item jsonb;
  tree_root_child_ids uuid[] := array[]::uuid[];
  tree_root_nonroot_ids uuid[];
  tree_root_readable_parent_ids uuid[];
begin
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into requested_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'requestedFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into system_field_keys
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'systemFieldKeys') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{searchPlan,fieldIds}') as item(value);
  select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality) into after_sort_key
  from pg_catalog.jsonb_array_elements(coalesce(nullif(p_plan -> 'afterSortKey', 'null'::jsonb), '[]'::jsonb))
    with ordinality as item(value, ordinality);
  if p_plan -> 'exactRecordIds' <> 'null'::jsonb then
    select pg_catalog.array_agg(item.value::uuid) into exact_record_ids
    from pg_catalog.jsonb_array_elements_text(p_plan -> 'exactRecordIds') as item(value);
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{prepared,access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{prepared,access,sharedRecordIds}') as item(value);
  select pg_catalog.array_agg(item.value) into segment_predicates
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'segmentPredicates') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into choice_option_values
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'optionValues', '[]'::jsonb)) as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into group_by_ids
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'groupByFieldIds', '[]'::jsonb)) as item(value);
  -- A later scan of the same invocation (the next narrowed board column) reuses the first scan's
  -- page decision exactly as one scan reuses it for its next candidates.
  if p_prior_decision is not null then
    page_eligibility_checked := (p_prior_decision ->> 'checked')::boolean;
    page_first_loaded := nullif(p_prior_decision -> 'firstLoaded', 'null'::jsonb);
    page_declaration := nullif(p_prior_decision -> 'declaration', 'null'::jsonb);
    page_eligibility := nullif(p_prior_decision -> 'eligibility', 'null'::jsonb);
    page_shared := nullif(p_prior_decision -> 'shared', 'null'::jsonb);
    page_narrowed := (p_prior_decision ->> 'narrowed')::boolean;
    validated_record_types := nullif(p_prior_decision -> 'validatedRecordTypes', 'null'::jsonb);
  end if;
  bucket_rows := pg_catalog.array_fill('[]'::jsonb, array[bucket_count]);
  bucket_capabilities := bucket_rows;
  bucket_counts := pg_catalog.array_fill(0, array[bucket_count]);
  bucket_more := pg_catalog.array_fill(false, array[bucket_count]);
  bucket_first_keys := pg_catalog.array_fill('null'::jsonb, array[bucket_count]);
  bucket_first_ids := pg_catalog.array_fill(null::uuid, array[bucket_count]);
  bucket_last_keys := bucket_first_keys;
  bucket_last_ids := bucket_first_ids;
  if projection_page_scan then
    projection_batch_size := least(page_size, scan_limit);
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        null::uuid[], projection_sort_key, projection_direction, projection_after,
        projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
        record_id, revision, attribute_values, ordinality);
    exception when sqlstate '22023' then
      get stacked diagnostics projection_failure = message_text;
      if projection_failure in ('filter_field_not_declared', 'predicate_unsupported') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', projection_failure);
      end if;
      raise;
    end;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row,
       %s as group_link_value
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12::uuid[] is null or stored.record_id = any ($12))
       and %s
       and (%s)
        and (case when (%s) then true else false end)
        and (%s)%s
        and (%s)
     order by %s
     limit $5',
    p_plan ->> 'sortKeySql',
    p_plan ->> 'filterValuesSql',
    p_plan ->> 'systemColumnsSql',
    p_plan ->> 'scanProjectionSql',
    coalesce(p_member ->> 'linkValueSql', 'null::jsonb'),
    p_plan ->> 'scanSourceSql',
    case when p_plan #>> '{prepared,storage,storageScope}' = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    p_plan #>> '{prepared,access,predicate}',
    p_plan ->> 'filterPredicate',
    coalesce(p_member ->> 'predicate', 'true'),
    segment_sql,
    p_plan ->> 'searchPrefilterSql',
    p_plan ->> 'orderBySql'
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      p_plan -> 'filterParameters', coalesce(p_plan #> '{prepared,access,parameters}', '[]'::jsonb),
      projection_batch, exact_record_ids,
      p_member ->> 'columnValue', choice_option_values, group_selector_values, tree_parent_id,
      search_field_ids, user_search;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;
    if passes then
      page_access_loaded := null;
      if not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        -- The installation and its access plan are resolved once for the page;
        -- every exact record decision below consumes this local plan.
        page_shared := pg_catalog.jsonb_build_object(
          'installation', case when preview_mode
            then vortex_record.read_current_preview_installation_internal()
            else vortex_definition.read_current_active_installation() end);
        page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
          vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
        page_access_loaded := vortex_record.load_record_access_facts_with_plan_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', page_shared -> 'plan', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          if preview_mode then
            -- Owner authority and the exact storage binding were validated by
            -- preparation and the first loader in this invocation. Bounds are
            -- identical for every copied row of this record type.
            page_shared := page_shared || pg_catalog.jsonb_build_object(
              'previewBounds', vortex_record.preview_record_field_bounds_internal(
                record_type_id_value, v_storage_contract_id, p_plan -> 'recordType'));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if member_kind = 'tree_roots' then
          -- Root membership uses exact batched parent decisions, never the access superset.
          if not (scan_record.record_id = any (tree_root_child_ids)) then
            tree_root_child_ids := array[scan_record.record_id];
            while pg_catalog.cardinality(tree_root_child_ids) <= page_size loop
              fetch scan_cursor into lookahead_record;
              exit when not found;
              tree_root_child_ids := pg_catalog.array_append(tree_root_child_ids, lookahead_record.record_id);
            end loop;
            move absolute cursor_position from scan_cursor;
            tree_item := vortex_record.read_query_tree_relatives_internal(
              true, tree_root_child_ids, (p_member ->> 'relationshipId')::uuid, context_organization_id,
              context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
              p_member -> 'filter');
            if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_nonroot_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'recordIds') as item(value);
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_readable_parent_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'readableParentRecordIds') as item(value);
          end if;
          if scan_record.record_id = any (tree_root_nonroot_ids) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A readable parent outside the filter/search still keeps its link value.
          -- Only an unreadable or absent parent is hidden, using the same exact batch decision.
          if not (scan_record.record_id = any (tree_root_readable_parent_ids)) then
            readable_values := pg_catalog.jsonb_set(readable_values, array[tree_field_id], 'null'::jsonb);
          end if;
        end if;
        -- Filters decide membership, so every referenced value must be readable.
        -- Sorts only decide order: the scan already drops unguaranteed sort keys
        -- and ends with record identity. A withheld published sort field must
        -- neither remove a readable row nor expose its value through ordering.
        if not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) and not exists (
          select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
          where projection_page_scan and user_search is not null
            and not (readable_values ? searched.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          bucket := 1;
          if member_kind = 'choice' then
            -- A board row belongs to the column its readable choice value names, or to the
            -- unassigned column when it names no option. A column that already holds its page
            -- and the card after it does not read the row again.
            bucket := (
              select requested.ordinality::integer
              from pg_catalog.jsonb_array_elements(p_member -> 'columns') with ordinality
                as requested(value, ordinality)
              where case when (readable_values ? choice_field_id)
                  and pg_catalog.jsonb_typeof(readable_values -> choice_field_id) = 'string'
                  and (readable_values ->> choice_field_id) collate "C"
                    = any (choice_option_values)
                then requested.value ->> 'kind' = 'option'
                  and (requested.value ->> 'value') collate "C"
                    = (readable_values ->> choice_field_id) collate "C"
                else requested.value ->> 'kind' = 'unassigned' end
              limit 1
            );
            if bucket is null or bucket_more[bucket] then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'group' then
            member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if member_matches and group_link_field_id is not null
              and group_selector_values -> group_link_field_id = '"not_available"'::jsonb then
              -- The group of unreadable targets: one protected title batch decides the targets of this
              -- row and the page's next candidates together; the cache holds each target once per call.
              if pg_catalog.jsonb_typeof(readable_values -> group_link_field_id) = 'object'
                and not (group_link_cache ? (readable_values -> group_link_field_id ->> 'recordId')) then
                group_link_values := array[readable_values -> group_link_field_id];
                while pg_catalog.cardinality(group_link_values) <= page_size loop
                  fetch scan_cursor into lookahead_record;
                  exit when not found;
                  group_link_values := pg_catalog.array_append(group_link_values, lookahead_record.group_link_value);
                end loop;
                move absolute cursor_position from scan_cursor;
                group_link_cache := vortex_record.group_link_unreadable_internal(
                  group_link_cache, group_link_values, fields_by_id -> group_link_field_id);
              end if;
              member_matches := coalesce(
                (group_link_cache ->> (readable_values -> group_link_field_id ->> 'recordId'))::boolean, false);
            elsif member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, vortex_record.grouping_value_internal(
                readable_values -> grouped.id, fields_by_id -> grouped.id ->> 'type', nullif(p_member -> 'dateBucket', 'null'::jsonb)
              ))
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              member_matches := group_candidate_values = group_selector_values;
            end if;
            if not member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'tree_children' and not (
            pg_catalog.jsonb_typeof(readable_values -> tree_field_id) = 'object'
            and pg_catalog.lower(readable_values -> tree_field_id ->> 'recordId') = pg_catalog.lower(tree_parent_id::text)
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if user_search is not null and not projection_page_scan
            and not vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, user_search
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = page_size then
            -- A full bucket with a matching row after it has more rows; the scan ends only when
            -- every bucket has.
            bucket_more[bucket] := true;
            if pg_catalog.array_position(bucket_more, false) is null then
              every_bucket_more := true;
              exit;
            end if;
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = 0 then
            bucket_first_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
            bucket_first_ids[bucket] := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          bucket_capabilities[bucket] := bucket_capabilities[bucket] || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          bucket_rows[bucket] := bucket_rows[bucket] || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          bucket_counts[bucket] := bucket_counts[bucket] + 1;
          bucket_last_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
          bucket_last_ids[bucket] := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or every_bucket_more or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    null::uuid[], projection_sort_key, projection_direction, projection_after,
    projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
    record_id, revision, attribute_values, ordinality);
  end loop;
  exit when every_bucket_more or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not bucket_more[1] then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  -- Each bucket's page: its rows with their capabilities, in one pass over the page, and its own
  -- continuations, never another bucket's.
  for bucket in 1 .. bucket_count loop
    rows_value := bucket_rows[bucket];
    if bucket_counts[bucket] > 0 then
      page_capabilities := vortex_record.read_record_capabilities_page_internal(
        record_type_id_value, bucket_capabilities[bucket], page_shared -> 'envelope'
      );
      if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
        or pg_catalog.jsonb_array_length(page_capabilities) <> bucket_counts[bucket] then
        raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
          'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    next_value := null;
    opposite_value := null;
    key_value := case when bucket_more[bucket] then bucket_last_keys[bucket]
      when budget_exhausted then pg_catalog.to_jsonb(last_examined_sort_key) end;
    if bucket_more[bucket] or budget_exhausted then
      next_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', key_value,
        'phase', case when pg_catalog.jsonb_array_length(key_value) > 0
          and key_value -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', case when bucket_more[bucket] then bucket_last_ids[bucket]
          else last_examined_record_id end
      );
    end if;
    if bucket_first_ids[bucket] is not null then
      opposite_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', bucket_first_keys[bucket],
        'phase', case when pg_catalog.jsonb_array_length(bucket_first_keys[bucket]) > 0
          and bucket_first_keys[bucket] -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', bucket_first_ids[bucket]
      );
    end if;
    if direction = 'backward' and bucket_counts[bucket] > 1 then
      select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    pages := pages || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'rows', rows_value, 'next', next_value, 'opposite', opposite_value));
  end loop;
  -- The scanned pages and the one page decision a later scan or tree read of this invocation reuses.
  return pg_catalog.jsonb_build_object(
    'outcome', 'scanned',
    'pages', pages,
    'decision', pg_catalog.jsonb_build_object(
      'checked', page_eligibility_checked, 'firstLoaded', page_first_loaded, 'declaration', page_declaration,
      'eligibility', page_eligibility, 'shared', page_shared, 'narrowed', page_narrowed,
      'validatedRecordTypes', validated_record_types)
  );
end
$function$;

alter function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) is
  'Adapter-only candidate scan of every Module query page read: runs the planned scan of one organisation''s active records (application scope, access predicate, pushed filter, the mode''s stored-value predicate, keyset segment, search pre-predicate) within a 500-candidate budget, decides each candidate through the exact read_record projection with batched page decisions, then admits it only when every filtered field is readable, the closed membership value matches its readable values (all rows, a board column classified from its readable choice value, a generic group equal to its typed selector, the children of one parent, or the roots, decided from exact batched parent reads) and the search matches a readable searchable field. It returns one page per bucket with per-row capabilities and its own keyset continuations, never a hidden value.';

create or replace function vortex_record.module_query_result_internal(
  p_plan jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if (p_plan ->> 'preview')::boolean then
    -- No rows leave this invocation until the builder's authority is current
    -- again. Its role/group path can expire while the page is assembled;
    -- invocation-local reuse must never extend that permission deadline.
    if vortex_record.read_current_preview_installation_internal() -> 'previewInstallationId'
      is distinct from p_plan #> '{prepared,preview,previewInstallationId}' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  -- The reader's current field bound travels with every page, even an empty one: the fields it is
  -- guaranteed to see on every record it may read, and whether a search can match through any.
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', p_plan #> '{resolved,moduleReleaseRevision}',
    'moduleReleaseVersion', p_plan #> '{resolved,moduleReleaseVersion}',
    'fieldBounds', pg_catalog.jsonb_build_object(
      'readableFieldIds', p_plan -> 'boundFieldIds',
      'searchable', exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(p_plan #> '{searchPlan,fieldIds}') as searched(id)
        where (p_plan -> 'boundFieldIds') ? searched.id
      )
    )
  );
end
$function$;

alter function vortex_record.module_query_result_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_result_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_result_internal(jsonb) is
  'Adapter-only last step of every Module query page read: refuses a preview page whose builder authority changed while it was assembled, and otherwise returns the completed envelope with the resolved release and the reader''s current field bound (guaranteed-readable fields and whether any searchable field is among them).';

create or replace function vortex_record.module_query_board_member_internal(
  p_bound jsonb,
  p_selector jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  fields_by_id jsonb := p_bound -> 'fieldsById';
  query_item jsonb := p_bound -> 'query';
  board_choice_field_id text := p_selector ->> 'choiceFieldId';
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_choice_column text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
begin
  -- A board reads members of its query's sole grouping key: one filterable choice field of 1..12
  -- closed options that the query selects.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if pg_catalog.lower(query_item #>> '{groupByFieldIds,0}') is distinct from board_choice_field_id
    or not ((p_bound -> 'selectedFieldIds') ? board_choice_field_id)
    or not (fields_by_id ? board_choice_field_id)
    or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
    or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
  if pg_catalog.jsonb_typeof(board_options) is distinct from 'array'
    or pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  for board_option in select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value) loop
    if pg_catalog.jsonb_typeof(board_option) is distinct from 'object'
      or board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
      or not (board_option ? 'value') or not (board_option ? 'label')
      or pg_catalog.jsonb_typeof(board_option -> 'value') is distinct from 'string'
      or coalesce(pg_catalog.length(board_option ->> 'value'), 0) not between 1 and 120
      or pg_catalog.jsonb_typeof(board_option -> 'label') is distinct from 'string'
      or coalesce(pg_catalog.length(pg_catalog.btrim(board_option ->> 'label')), 0) not between 1 and 60
      or (board_option ? 'requiredPermissionId' and (
        pg_catalog.jsonb_typeof(board_option -> 'requiredPermissionId') is distinct from 'string'
        or pg_catalog.lower(board_option ->> 'requiredPermissionId') !~ uuid_pattern
        or pg_catalog.lower(board_option ->> 'requiredPermissionId') = '00000000-0000-0000-0000-000000000000'
      ))
      or (board_option ->> 'value') collate "C" = any (board_option_values) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_option_values := pg_catalog.array_append(board_option_values, board_option ->> 'value');
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_selector -> 'columns') as requested(value)
    where requested.value ->> 'kind' = 'option'
      and not ((requested.value ->> 'value') collate "C" = any (board_option_values))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- A column reads only its own cards. When the reader is guaranteed to see the
  -- choice field on every row the scan examines, the stored choice value is the
  -- readable value, so the column's membership narrows the candidate scan and the
  -- budget is spent on that column's members only. Otherwise the scan stays
  -- unnarrowed and membership is decided from each readable projection, so
  -- a withheld value never decides which rows are examined.
  if (p_bound -> 'readableFieldIds') ? board_choice_field_id then
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = (p_bound ->> 'storageContractId')::uuid
      and mapping.field_id = board_choice_field_id::uuid;
    if not found or mapping_row.state is distinct from 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    if mapping_row.database_value_type = 'text' then
      board_choice_column := mapping_row.physical_column_token;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'kind', 'choice',
    'choiceFieldId', board_choice_field_id,
    'optionValues', pg_catalog.to_jsonb(board_option_values),
    'columns', p_selector -> 'columns',
    'choiceColumn', board_choice_column
  );
end
$function$;

alter function vortex_record.module_query_board_member_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_member_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_member_internal(jsonb,jsonb) is
  'Adapter-only board membership of a bound Module query page read: requires the query''s sole grouping key to be the selected, filterable choice field the board names with 1 to 12 closed options, every requested option column to be one of them, and returns the closed choice membership value with the stored choice column only when the reader is guaranteed to see the choice field on every scanned row.';

create or replace function vortex_record.module_query_board_column_predicate_internal(
  p_member jsonb,
  p_column jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  -- The narrowed candidate scan of one column, only over a guaranteed-readable stored choice.
  select case
    when p_member ->> 'choiceColumn' is null then null
    when p_column ->> 'kind' = 'option' then pg_catalog.format(
      'stored.%I collate "C" = $13 collate "C"', p_member ->> 'choiceColumn')
    else pg_catalog.format(
      '(stored.%1$I is null or not (stored.%1$I collate "C" = any ($14::text[])))',
      p_member ->> 'choiceColumn')
  end
$function$;

alter function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb) is
  'Adapter-only stored-value predicate of one board column: the stored choice equals the bound column value, or names no option for the unassigned column; null when the choice field is not guaranteed readable and membership is decided from each readable projection only.';

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
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  if pg_catalog.jsonb_array_length(coalesce(bound #> '{query,groupByFieldIds}', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(bound #> '{query,aggregates}', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
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

create or replace function vortex_record.run_module_query_board_column(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids uuid[],
  p_requested_system_field_keys text[],
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_choice_field_id uuid,
  p_board_column jsonb,
  p_page_size integer,
  p_after jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  selector jsonb;
  opened jsonb;
  bound jsonb;
  member jsonb;
  plan jsonb;
  scanned jsonb;
  result_value jsonb;
begin
  selector := vortex_record.board_column_selector_internal(
    pg_catalog.jsonb_build_object('choiceFieldId', p_choice_field_id, 'column', p_board_column), false);
  if selector is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- A board column has one fixed order, record identity, and no search.
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    '[]'::jsonb, null, null, null, p_page_size, 'forward', null);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  member := vortex_record.module_query_board_member_internal(bound, selector);
  if member ->> 'outcome' <> 'completed' then return member; end if;
  plan := vortex_record.module_query_scan_plan_internal(bound, '[]'::jsonb, false, false, false, p_after);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  scanned := vortex_record.module_query_scan_internal(plan, member || pg_catalog.jsonb_build_object(
    'columnValue', p_board_column -> 'value',
    'predicate', vortex_record.module_query_board_column_predicate_internal(member, p_board_column)), null);
  if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
  result_value := vortex_record.module_query_result_internal(plan);
  if result_value ->> 'outcome' <> 'completed' then return result_value; end if;
  return result_value || (scanned #> '{pages,0}');
end
$function$;

alter function vortex_record.run_module_query_board_column(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_board_column(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_board_column(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer,jsonb)
  to vortex_request;
comment on function vortex_record.run_module_query_board_column(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer,jsonb) is
  'One bounded keyset page, in record identity order, of one board column of an installed Module query or exact preview query grouped by its sole filterable choice field: the readable records whose current readable choice value is the closed column option, or names no option for the unassigned column, each decided through read_record with its capabilities, plus the reader''s field bound. The stored choice narrows the candidate scan only when the reader is guaranteed to see the choice field on every scanned row.';

create or replace function vortex_record.run_module_query_board_columns(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids uuid[],
  p_requested_system_field_keys text[],
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_choice_field_id uuid,
  p_board_columns jsonb,
  p_page_size integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  selector jsonb;
  opened jsonb;
  bound jsonb;
  member jsonb;
  plan jsonb;
  scanned jsonb;
  decision jsonb;
  column_item jsonb;
  column_pages jsonb := '[]'::jsonb;
  result_value jsonb;
begin
  selector := vortex_record.board_column_selector_internal(
    pg_catalog.jsonb_build_object('choiceFieldId', p_choice_field_id, 'columns', p_board_columns), true);
  if selector is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  -- A board's first pages: every requested column, each from its start, in record identity order.
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    '[]'::jsonb, null, null, null, p_page_size, 'forward', null);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  member := vortex_record.module_query_board_member_internal(bound, selector);
  if member ->> 'outcome' <> 'completed' then return member; end if;
  plan := vortex_record.module_query_scan_plan_internal(bound, '[]'::jsonb, false, false, false, null);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  if member ->> 'choiceColumn' is null then
    -- The choice field is not guaranteed readable: the table is read once for every column, each
    -- readable row going to the column its readable value names, each column with its own page.
    scanned := vortex_record.module_query_scan_internal(plan, member, null);
    if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'column', requested.value,
        'rows', scanned #> array['pages', (requested.ordinality - 1)::text, 'rows'],
        'next', scanned #> array['pages', (requested.ordinality - 1)::text, 'next'])
      order by requested.ordinality)
    into column_pages
    from pg_catalog.jsonb_array_elements(selector -> 'columns') with ordinality as requested(value, ordinality);
  else
    -- Each column's candidate scan is narrowed to its own stored choice value, with its own budget
    -- and position; the columns share this invocation's one page decision.
    for column_item in
      select requested.value from pg_catalog.jsonb_array_elements(selector -> 'columns')
        with ordinality as requested(value, ordinality) order by requested.ordinality
    loop
      scanned := vortex_record.module_query_scan_internal(plan, member || pg_catalog.jsonb_build_object(
        'columns', pg_catalog.jsonb_build_array(column_item),
        'columnValue', column_item -> 'value',
        'predicate', vortex_record.module_query_board_column_predicate_internal(member, column_item)), decision);
      if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
      decision := scanned -> 'decision';
      column_pages := column_pages || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'column', column_item, 'rows', scanned #> '{pages,0,rows}', 'next', scanned #> '{pages,0,next}'));
    end loop;
  end if;
  result_value := vortex_record.module_query_result_internal(plan);
  if result_value ->> 'outcome' <> 'completed' then return result_value; end if;
  return result_value || pg_catalog.jsonb_build_object('columns', column_pages);
end
$function$;

alter function vortex_record.run_module_query_board_columns(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_board_columns(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_board_columns(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer)
  to vortex_request;
comment on function vortex_record.run_module_query_board_columns(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],uuid,jsonb,integer) is
  'The first page of every requested board column (1 to 13 closed columns, unassigned at most once) of an installed Module query or exact preview query in one invocation, each column with its own rows, capabilities and continuation, plus the reader''s field bound. When the choice field is guaranteed readable on every scanned row each column''s candidate scan is narrowed to its own stored value with its own budget; otherwise the table is read once and each readable row goes to the column its readable choice value names.';

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

drop function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb, text, uuid[]);

reset role;
