create or replace function vortex_record.run_module_query(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids jsonb,
  p_page_size integer,
  p_after jsonb,
  p_requested_system_field_keys jsonb,
  p_user_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- The most candidate rows one request examines. A page that the budget ends
  -- early still returns a position, so a later request resumes exactly there.
  scan_limit constant integer := 500;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  storage_contract_id uuid;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  selected_ids text[];
  requested_ids text[] := array[]::text[];
  sort_item jsonb;
  sort_ids text[] := array[]::text[];
  declared_sort_ids text[] := array[]::text[];
  sort_directions text[] := array[]::text[];
  sort_value_sql text[] := array[]::text[];
  sort_sql_types text[] := array[]::text[];
  filter_condition jsonb;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  after_sort_key text[];
  after_record_id uuid;
  sort_index integer;
  column_sql text;
  value_sql text;
  pushed boolean;
  after_terms text[] := array[]::text[];
  equal_prefix text := '';
  keyset_sql text := '';
  order_terms text[] := array[]::text[];
  sort_key_terms text[] := array[]::text[];
  order_by_sql text;
  scan_sql text;
  readable_field_ids text[] := array[]::text[];
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  physical_table_token text;
  storage_scope text;
  scan_record record;
  examined integer := 0;
  budget_exhausted boolean := false;
  more_rows boolean := false;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  row_capabilities jsonb;
  rows_value jsonb := '[]'::jsonb;
  row_count integer := 0;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  last_returned_sort_key text[];
  last_returned_record_id uuid;
  next_value jsonb := null;
  system_field_keys text[] := array[]::text[];
  system_key text;
  system_expressions text[] := array[]::text[];
  system_columns_sql text;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  list_key text;
  declared_list jsonb;
  parsed_ids text[];
  declared_lists jsonb := '{}'::jsonb;
  declared_sortable_ids text[] := array[]::text[];
  declared_searchable_ids text[] := array[]::text[];
  user_sort jsonb;
  user_search text;
  user_search_folded text;
  effective_sort jsonb;
  effective_sort_is_user boolean := false;
  search_candidate_ids text[] := array[]::text[];
  search_field_ids text[] := array[]::text[];
  search_matches boolean;
begin
  -- Request shape. Nothing here is authority; it only bounds the work.
  if p_requested_field_ids is null
    or pg_catalog.jsonb_typeof(p_requested_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_field_ids) not between 1 and 200
    or p_page_size is null or p_page_size not between 1 and 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in select item.value from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value) loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(field_item #>> '{}') = any (requested_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    requested_ids := pg_catalog.array_append(requested_ids, pg_catalog.lower(field_item #>> '{}'));
  end loop;

  -- Declared system values: a closed set, each named at most once.
  if p_requested_system_field_keys is null then
    p_requested_system_field_keys := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_requested_system_field_keys) <> 'array'
    or pg_catalog.jsonb_array_length(p_requested_system_field_keys) > 5 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(p_requested_system_field_keys) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or (field_item #>> '{}') not in ('created_at', 'created_by', 'updated_at', 'updated_by', 'owner')
      or (field_item #>> '{}') = any (system_field_keys) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    system_field_keys := pg_catalog.array_append(system_field_keys, field_item #>> '{}');
  end loop;

  -- User-facing sort and search, plus the user filter passed to shared
  -- preparation. The component's declared field sets only narrow user input;
  -- they never supply authority or replace the published query contract.
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
    where supplied.key not in (
      'sort', 'filter', 'search', 'sortableFieldIds', 'filterableFieldIds', 'searchableFieldIds'
    )
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The list-only sortable and searchable allow-lists contain distinct field
  -- identities. Query preparation validates the filterable allow-list.
  for list_key in
    select pg_catalog.unnest(array['sortableFieldIds', 'searchableFieldIds'])
  loop
    declared_list := coalesce(p_user_inputs -> list_key, '[]'::jsonb);
    if pg_catalog.jsonb_typeof(declared_list) <> 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    if pg_catalog.jsonb_array_length(declared_list) > 200 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := array[]::text[];
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(declared_list) as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'string'
        or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern
        or pg_catalog.lower(field_item #>> '{}') = any (parsed_ids) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
      end if;
      parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(field_item #>> '{}'));
    end loop;
    declared_lists := declared_lists || pg_catalog.jsonb_build_object(list_key, pg_catalog.to_jsonb(parsed_ids));
  end loop;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_sortable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'sortableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into declared_searchable_ids
  from pg_catalog.jsonb_array_elements_text(declared_lists -> 'searchableFieldIds') as item(value);

  -- The user's sort: the same pair shape as the published sort, bounded and each
  -- direction valid. It replaces the published order only when it is non-empty.
  user_sort := coalesce(p_user_inputs -> 'sort', '[]'::jsonb);
  if pg_catalog.jsonb_typeof(user_sort) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(user_sort) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;

  -- The user's search: one bounded, non-blank text term; a blank term is absent.
  if p_user_inputs ? 'search'
    and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search := pg_catalog.btrim(p_user_inputs ->> 'search');
  if user_search = '' then
    user_search := null;
  end if;
  if user_search is not null and pg_catalog.length(user_search) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_search_folded := pg_catalog.lower(user_search);

  foreach system_key in array system_field_keys loop
    system_expressions := pg_catalog.array_append(system_expressions, pg_catalog.format('%L, %s', system_key,
      case system_key
        when 'created_at' then
          'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.created_at))'
        when 'updated_at' then
          'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(stored.updated_at))'
        when 'created_by' then 'pg_catalog.to_jsonb(stored.created_by)'
        when 'updated_by' then 'pg_catalog.to_jsonb(stored.updated_by)'
        else
          'case when stored.owner_organisation_account_id is not null then pg_catalog.jsonb_build_object(''kind'', ''organization_account'', ''organizationAccountId'', stored.owner_organisation_account_id) when stored.owner_group_id is not null then pg_catalog.jsonb_build_object(''kind'', ''group'', ''groupId'', stored.owner_group_id) else ''null''::jsonb end'
      end));
  end loop;
  system_columns_sql := pg_catalog.array_to_string(system_expressions, ', ');

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;

  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;

  -- Grouped and totalled shapes are arrangements (#573); relationship hops have
  -- no declared path in this contract. Neither is run as plain rows.
  if pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 0
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if p_page_size > coalesce((query_item ->> 'pageSize')::integer, 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'page_size_invalid');
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
  physical_table_token := prepared_plan #>> '{storage,physicalTableToken}';
  storage_scope := prepared_plan #>> '{storage,storageScope}';
  access_sql := coalesce(prepared_plan #>> '{access,predicate}', 'true');
  access_parameters := coalesce(prepared_plan #> '{access,parameters}', '[]'::jsonb);
  access_owner_account_id := nullif(prepared_plan #>> '{access,ownerAccountId}', '')::uuid;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{access,sharedRecordIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  -- Search authority: the record type's own declared search priority. A component
  -- with only a search box declares no per-field list, so an empty declared set
  -- searches every field the record type marks searchable; a declared set narrows
  -- it. A row matches only through a field the reader can see on that row, so a
  -- hidden searchable value never decides a match.
  if pg_catalog.cardinality(declared_searchable_ids) > 0 then
    search_candidate_ids := declared_searchable_ids;
  else
    select coalesce(pg_catalog.array_agg(item.key), array[]::text[])
    into search_candidate_ids
    from pg_catalog.jsonb_object_keys(fields_by_id) as item(key);
  end if;
  foreach field_key in array search_candidate_ids loop
    if (fields_by_id ? field_key)
      and (fields_by_id -> field_key ->> 'searchPriority') in ('first', 'normal', 'last') then
      search_field_ids := pg_catalog.array_append(search_field_ids, field_key);
    end if;
  end loop;

  -- Projection: only fields the published query selects.
  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')), array[]::text[])
  into selected_ids
  from pg_catalog.jsonb_array_elements(query_item -> 'selectedFieldIds') as item(value);
  if exists (select 1 from pg_catalog.unnest(requested_ids) as requested(id) where requested.id <> all (selected_ids)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;

  -- Order: the published sort, or the user's chosen sort when one is supplied,
  -- over orderable typed columns, then the record id. A published sort field the
  -- reader is not guaranteed to see is validated but never pushed, so the scan
  -- order never depends on a value it may withhold. A user sort must instead be a
  -- field the component declares sortable, the record type declares sortable and
  -- the reader is guaranteed to see: silently ordering by something else would be
  -- wrong, so it is refused rather than pushed away.
  if pg_catalog.jsonb_array_length(user_sort) > 0 then
    effective_sort := user_sort;
    effective_sort_is_user := true;
  else
    effective_sort := query_item -> 'sort';
    effective_sort_is_user := false;
  end if;
  for sort_item in
    select item.value from pg_catalog.jsonb_array_elements(effective_sort) as item(value)
  loop
    field_key := pg_catalog.lower(sort_item ->> 'fieldId');
    if field_key is null or not (fields_by_id ? field_key)
      or sort_item ->> 'direction' not in ('ascending', 'descending')
      or field_key = any (declared_sort_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    if effective_sort_is_user
      and (not (field_key = any (declared_sortable_ids))
        or coalesce((fields_by_id -> field_key ->> 'sortable')::boolean, false) is not true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    select mapping.* into mapping_row
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_contract_id
      and mapping.field_id = field_key::uuid;
    if not found or mapping_row.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record storage disagrees with the installed definition';
    end if;
    declared_sort_ids := pg_catalog.array_append(declared_sort_ids, field_key);
    pushed := field_key = any (readable_field_ids);
    if effective_sort_is_user and not pushed then
      -- The user's order must actually be the scan order.
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
    end if;
    -- A read-time field is worked out inside this statement, from the
    -- record's own stored values and one statement timestamp; it is never a
    -- stored column here.
    read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
      and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
        or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
    if read_time_field then
      read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
      read_time_sql := vortex_record.read_time_deadline_expression_internal(
        storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
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
    sort_sql_types := pg_catalog.array_append(sort_sql_types, case mapping_row.database_value_type
      when 'integer' then 'bigint'
      when 'decimal' then 'numeric'
      when 'boolean' then 'boolean'
      when 'date' then 'date'
      when 'timestamp_with_time_zone' then 'timestamp with time zone'
      when 'uuid' then 'uuid'
      else 'text' end);
  end loop;
  if pg_catalog.cardinality(declared_sort_ids) = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'sort_invalid');
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'complete', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  filter_condition := prepared_plan #> '{filter,residualCondition}';
  if filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  filter_nulls := coalesce(prepared_plan #> '{filter,residualNullValues}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_expressions
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}') as item(value);

  -- The keyset position, which must fit this exact order. The cursor carries
  -- only the readable sort fields' values and a record identity, so it never
  -- carries a hidden field value.
  if p_after is not null and p_after <> 'null'::jsonb then
    if pg_catalog.jsonb_typeof(p_after) <> 'object'
      or p_after - array['sortKey', 'recordId']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_after -> 'sortKey') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_after -> 'sortKey') <> pg_catalog.cardinality(sort_ids)
      or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
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
    for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
      if after_sort_key[sort_index] is not null
        and not pg_catalog.pg_input_is_valid(after_sort_key[sort_index], sort_sql_types[sort_index]) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_invalid');
      end if;
    end loop;
  end if;

  -- The scan. Identifiers come only from the storage catalogue; every value is
  -- a bound parameter. Nulls order first ascending and last descending. The
  -- order always ends with the record id, so the keyset stays total even when
  -- no readable sort field may be pushed.
  for sort_index in 1 .. pg_catalog.cardinality(sort_ids) loop
    column_sql := case when sort_sql_types[sort_index] = 'text'
      then sort_value_sql[sort_index] || ' collate "C"'
      else sort_value_sql[sort_index] end;
    order_terms := pg_catalog.array_append(order_terms, column_sql || case
      when sort_directions[sort_index] = 'ascending' then ' asc nulls first'
      else ' desc nulls last' end);
    sort_key_terms := pg_catalog.array_append(sort_key_terms, case sort_sql_types[sort_index]
      when 'timestamp with time zone' then pg_catalog.format(
        'vortex_context.format_timestamp_utc(%s)',
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
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('(%s) is not null', sort_value_sql[sort_index])
          else 'false' end);
        equal_prefix := equal_prefix
          || pg_catalog.format('(%s) is null and ', sort_value_sql[sort_index]);
      else
        after_terms := pg_catalog.array_append(after_terms, equal_prefix || case
          when sort_directions[sort_index] = 'ascending'
            then pg_catalog.format('coalesce(%s > %s, false)', column_sql, value_sql)
          else pg_catalog.format('((%s) is null or coalesce(%s < %s, false))',
            sort_value_sql[sort_index], column_sql, value_sql) end);
        equal_prefix := equal_prefix
          || pg_catalog.format('coalesce(%s = %s, false) and ', column_sql, value_sql);
      end if;
    end if;
  end loop;
  if after_record_id is not null then
    after_terms := pg_catalog.array_append(after_terms, equal_prefix || 'stored.record_id > $4');
    keyset_sql := ' and ((' || pg_catalog.array_to_string(after_terms, ') or (') || '))';
  end if;
  order_by_sql := pg_catalog.array_to_string(order_terms, ', ');
  if order_by_sql = '' then
    order_by_sql := 'stored.record_id asc';
  else
    order_by_sql := order_by_sql || ', stored.record_id asc';
  end if;

  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values
     from record_data.%I as stored
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and %s
       and (%s)
       and (%s)%s
     order by %s
     limit $5',
    pg_catalog.array_to_string(sort_key_terms, ', '),
    (select pg_catalog.string_agg(
       filter_chunk.pairs_text,
       ') || pg_catalog.jsonb_build_object(' order by filter_chunk.chunk_index
     )
     from (
       select (filter_pair.pair_number - 1) / 50 as chunk_index,
         pg_catalog.string_agg(
           filter_pair.pair_text, ', ' order by filter_pair.pair_number
         ) as pairs_text
       from pg_catalog.unnest(filter_expressions)
         with ordinality as filter_pair(pair_text, pair_number)
       group by (filter_pair.pair_number - 1) / 50
     ) as filter_chunk),
    system_columns_sql,
    physical_table_token,
    case when storage_scope = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    access_sql,
    filter_predicate,
    keyset_sql,
    order_by_sql
  );

  for scan_record in execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      filter_parameters, access_parameters
  loop
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;

    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered and sorted field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    if filter_condition is null then
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
      projection := vortex_record.read_record(record_type_id_value, scan_record.record_id);
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if not exists (
          select 1 from pg_catalog.unnest(declared_sort_ids || filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if user_search is not null then
            search_matches := false;
            foreach field_key in array search_field_ids loop
              if readable_values ? field_key and (
                (pg_catalog.jsonb_typeof(readable_values -> field_key) in ('string', 'number')
                  and pg_catalog.strpos(
                    pg_catalog.lower(readable_values ->> field_key), user_search_folded
                  ) > 0)
                or (pg_catalog.jsonb_typeof(readable_values -> field_key) = 'array'
                  and exists (
                    select 1
                    from pg_catalog.jsonb_array_elements(readable_values -> field_key) as member(value)
                    where pg_catalog.jsonb_typeof(member.value) = 'string'
                      and pg_catalog.strpos(
                        pg_catalog.lower(member.value #>> '{}'), user_search_folded
                      ) > 0
                  ))
              ) then
                search_matches := true;
                exit;
              end if;
            end loop;
            if not search_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          end if;
          if row_count = p_page_size then
            more_rows := true;
            exit;
          end if;
          -- Every returned row carries the record's concurrency number from
          -- read_record and its per-row capabilities, each action decided exactly
          -- as its own writer decides it and only for a row read_record admits.
          -- The capabilities are computed only for a returned row; a row whose
          -- capabilities cannot be computed is withheld rather than exposed
          -- without them.
          row_capabilities := vortex_record.read_record_capabilities(
            record_type_id_value, scan_record.record_id
          );
          if row_capabilities is not null then
            rows_value := rows_value || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id,
              'revision', projection -> 'concurrencyNumber',
              'capabilities', row_capabilities,
              'values', coalesce((
                select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
                from pg_catalog.unnest(requested_ids) as requested(id)
                where readable_values ? requested.id
              ), '{}'::jsonb)
            ));
            row_count := row_count + 1;
            if pg_catalog.cardinality(system_field_keys) > 0 then
              rows_value := pg_catalog.jsonb_set(
                rows_value, array[(row_count - 1)::text, 'systemValues'], scan_record.system_values
              );
            end if;
            last_returned_sort_key := scan_record.sort_key;
            last_returned_record_id := scan_record.record_id;
          end if;
        end if;
      end if;
    end if;

    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;

  if more_rows then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_returned_sort_key),
      'recordId', last_returned_record_id
    );
  elsif budget_exhausted then
    next_value := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(last_examined_sort_key),
      'recordId', last_examined_record_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'rows', rows_value,
    'next', next_value
  );
end
$function$;

alter function vortex_record.run_module_query(uuid,uuid,bigint,jsonb,jsonb,integer,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query(uuid, uuid, bigint, jsonb, jsonb, integer, jsonb, jsonb, jsonb) is
  'One bounded keyset page of rows readable through read_record for one installed Module query, each carrying the record''s concurrency number and the per-row capabilities from read_record_capabilities, each action decided exactly as its own writer decides it, with only the declared Record system values, or one refusal before any row is exposed; accepts a bound list component''s declared sortable, filterable and searchable field sets together with the viewer''s chosen sort, typed filter and search term, refuses a sort or filter outside the declared sets, keeps a user sort only over a field the record type declares sortable and the reader is guaranteed to see, ANDs the user filter with the published filter so it can only narrow, and matches a search only through searchable fields the returned row exposes to the reader; requires every filtered field to be declared filterable; pushes a filter or a sort into the candidate scan only for fields the reader is guaranteed to see for the whole record type, evaluates a filter on a possibly-withheld field per row, and keeps the keyset cursor over readable sort values and a record identity so no cursor carries a hidden field value and the scan order and budget never depend on one; narrows the scan with one predicate that OR-s every eligible alternative''s exact owner, owner-group and direct-share route test with its saved condition compiled over the record''s own catalogue columns where that condition can be expressed as a superset of the per-row decision, leaves the scan unrestricted where a route or condition has no exact stored form, and still decides every returned row through read_record; works out read-time fields, such as a deadline-passed calculation, inside the query at one statement timestamp in the organisation time zone, so no query is refused for freshness.';
