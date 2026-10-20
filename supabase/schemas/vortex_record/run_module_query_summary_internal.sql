create or replace function vortex_record.run_module_query_summary_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_inputs jsonb,
  p_prepared_plan jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  summary_candidate_limit constant integer := 100000;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb := p_prepared_plan;
  user_search text := nullif(pg_catalog.btrim(p_user_inputs ->> 'search'), '');
  search_field_ids text[] := array[]::text[];
  declared_searchable_ids jsonb := coalesce(p_user_inputs -> 'searchableFieldIds', '[]'::jsonb);
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  v_storage_contract_id uuid;
  physical_table_token text;
  storage_scope text;
  access_sql text;
  access_parameters jsonb := '[]'::jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[] := array[]::uuid[];
  access_shared_record_ids uuid[] := array[]::uuid[];
  readable_field_ids text[] := array[]::text[];
  filter_condition jsonb;
  filter_types jsonb := '{}'::jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  filter_ids text[] := array[]::text[];
  filter_predicate text := 'true';
  filter_parameters jsonb := '[]'::jsonb;
  filter_expression_pairs text[] := array[]::text[];
  filter_values_sql text := '''{}''::jsonb';
  group_ids text[] := array[]::text[];
  aggregate_items jsonb := '[]'::jsonb;
  aggregate_item jsonb;
  aggregate_aliases text[] := array[]::text[];
  summary_field_ids text[] := array[]::text[];
  fast_field_ids text[] := array[]::text[];
  fields_by_id jsonb := '{}'::jsonb;
  field_item jsonb;
  field_key text;
  field_type text;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  fast_path boolean := false;
  fast_path_fields_valid boolean := true;
  search_prefilter_sql text := 'true';
  scan_sql text;
  candidate_sql text;
  selected_sql text;
  summary_sql text;
  expression_pairs text[] := array[]::text[];
  group_value_pairs text[] := array[]::text[];
  group_by_terms text[] := array[]::text[];
  group_presence_terms text[] := array[]::text[];
  group_values_sql text;
  group_value_sql text;
  group_page_limit integer;
  group_after text := p_user_inputs ->> 'groupAfter';
  pivot_mode boolean := false;
  pivot_row_field_id text;
  pivot_column_field_id text;
  pivot_measure_field_id text;
  pivot_buckets jsonb := '{}'::jsonb;
  group_bucket jsonb;
  pivot_column_limit constant integer := 50;
  group_by_sql text;
  group_presence_sql text;
  aggregate_object_sql text := '';
  summary_totals_sql text;
  aggregate_result_sql text;
  aggregate_count_sql text;
  aggregate_sum_sql text;
  aggregate_average_sql text;
  aggregate_present_sql text;
  aggregate_value_sql text;
  aggregate_currency_sql text;
  aggregate_amount_sql text;
  aggregate_mixed_currency_sql text;
  aggregate_operation text;
  aggregate_field_id text;
  aggregate_field_type text;
  aggregate_original_field_type text;
  aggregate_alias text;
  average_places integer;
  value_expression text;
  groups_json_sql text := '''[]''::jsonb';
  board_summary_mode boolean := false;
  board_choice_field_id text;
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_bucket_sql text;
  board_requested_columns jsonb := p_user_inputs #> '{boardSummary,columns}';
  board_requested_positions integer[] := array[]::integer[];
  board_requested_column jsonb;
  board_option_position integer;
  board_totals_sql text;
  board_empty_aggregates_sql text;
  result_value jsonb;
begin
  board_summary_mode := p_user_inputs ? 'boardSummary';
  if board_summary_mode then
    board_choice_field_id := pg_catalog.lower(p_user_inputs #>> '{boardSummary,choiceFieldId}');
  end if;
  resolved := prepared_plan -> 'resolved';
  query_item := prepared_plan -> 'query';
  record_type_item := prepared_plan -> 'recordType';
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;

  if p_user_inputs ? 'grouping' then
    query_item := vortex_record.grouping_query_internal(
      query_item, record_type_item, p_user_inputs -> 'grouping', 50
    );
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;
  pivot_mode := p_user_inputs ? 'pivot';
  if pivot_mode then
    query_item := vortex_record.pivot_query_internal(
      query_item, record_type_item, p_user_inputs -> 'pivot'
    );
    if query_item is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    pivot_row_field_id := pg_catalog.lower(p_user_inputs #>> '{pivot,rowFieldId}');
    pivot_column_field_id := pg_catalog.lower(p_user_inputs #>> '{pivot,columnFieldId}');
    pivot_measure_field_id := pg_catalog.lower(p_user_inputs #>> '{pivot,measure,fieldId}');
    pivot_buckets := pg_catalog.jsonb_build_object(
      pivot_row_field_id, p_user_inputs #> '{pivot,rowDateBucket}',
      pivot_column_field_id, p_user_inputs #> '{pivot,columnDateBucket}'
    );
  elsif p_user_inputs ? 'grouping' then
    pivot_buckets := pg_catalog.jsonb_build_object(
      pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}'), p_user_inputs #> '{grouping,dateBucket}'
    );
  end if;
  group_page_limit := case
    when pivot_mode then ((p_user_inputs #>> '{pivot,rowLimit}')::numeric)::integer
    when p_user_inputs ? 'grouping' then ((p_user_inputs #>> '{grouping,limit}')::numeric)::integer
    else summary_candidate_limit end;
  if pg_catalog.jsonb_typeof(declared_searchable_ids) is distinct from 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.jsonb_array_length(declared_searchable_ids) > 200 or exists (
    select 1 from pg_catalog.jsonb_array_elements(declared_searchable_ids) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'string' or pg_catalog.lower(item.value #>> '{}') !~ uuid_pattern
  ) or (select pg_catalog.count(*) <> pg_catalog.count(distinct pg_catalog.lower(item.value #>> '{}'))
        from pg_catalog.jsonb_array_elements(declared_searchable_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if coalesce((query_item ->> 'relationshipHops')::integer, 0) <> 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_invalid');
  end if;
  if pg_catalog.jsonb_typeof(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) > 10
    or pg_catalog.jsonb_typeof(coalesce(query_item -> 'aggregates', '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_array_length(coalesce(query_item -> 'aggregates', '[]'::jsonb)) > 20 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if board_summary_mode
    and pg_catalog.jsonb_array_length(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(record_type_item -> 'fields', '[]'::jsonb)) as item(value)
  loop
    fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'), field_item
    );
  end loop;

  select coalesce(pg_catalog.array_agg(field.key), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_each(fields_by_id) as field(key, value)
  where field.value ->> 'searchPriority' in ('first', 'normal', 'last')
    and (pg_catalog.jsonb_array_length(declared_searchable_ids) = 0 or exists (
      select 1 from pg_catalog.jsonb_array_elements_text(declared_searchable_ids) as selected(id)
      where pg_catalog.lower(selected.id) = field.key
    ));

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'groupByFieldIds', '[]'::jsonb)) as item(value)
  loop
    if pg_catalog.jsonb_typeof(field_item) <> 'string'
      or pg_catalog.lower(field_item #>> '{}') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    field_key := pg_catalog.lower(field_item #>> '{}');
    field_type := coalesce(fields_by_id -> field_key ->> 'type', '');
    if field_key = any (group_ids)
      or field_type not in (
        'text', 'whole_number', 'decimal_number', 'yes_no', 'date', 'date_time',
        'choice', 'reference_number', 'email_address', 'phone_number', 'web_address',
        'link', 'link_to_one_of_several'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    group_ids := pg_catalog.array_append(group_ids, field_key);
    if not (field_key = any (summary_field_ids)) then
      summary_field_ids := pg_catalog.array_append(summary_field_ids, field_key);
      fast_field_ids := pg_catalog.array_append(fast_field_ids, field_key);
    end if;
  end loop;

  if board_summary_mode then
    if pg_catalog.cardinality(group_ids) <> 1
      or group_ids[1] is distinct from board_choice_field_id
      or not (fields_by_id ? board_choice_field_id)
      or fields_by_id -> board_choice_field_id ->> 'type' is distinct from 'choice'
      or coalesce((fields_by_id -> board_choice_field_id ->> 'filterable')::boolean, false) is not true
      or pg_catalog.jsonb_typeof(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) is distinct from 'array'
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'selectedFieldIds', '[]'::jsonb)) as selected(value)
        where pg_catalog.jsonb_typeof(selected.value) = 'string'
          and pg_catalog.lower(selected.value #>> '{}') = board_choice_field_id
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    board_options := fields_by_id #> array[board_choice_field_id, 'settings', 'options'];
    if pg_catalog.jsonb_typeof(board_options) is distinct from 'array' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_array_length(board_options) not between 1 and 12 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      if pg_catalog.jsonb_typeof(board_option) is distinct from 'object' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if board_option - array['value', 'label', 'requiredPermissionId']::text[] <> '{}'::jsonb
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
  end if;

  aggregate_items := coalesce(query_item -> 'aggregates', '[]'::jsonb);
  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    if aggregate_operation not in ('count', 'sum', 'minimum', 'maximum', 'average', 'distinct_count')
      or aggregate_alias is null
      or aggregate_alias !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or pg_catalog.length(aggregate_alias) > 40
      or aggregate_alias = any (aggregate_aliases)
      or (aggregate_item ? 'fieldId' and aggregate_field_id is null)
      or (aggregate_operation <> 'count' and aggregate_field_id is null)
      or (aggregate_operation = 'count' and aggregate_field_id is not null) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    aggregate_aliases := pg_catalog.array_append(aggregate_aliases, aggregate_alias);
    if aggregate_field_id is not null then
      if aggregate_field_id !~ uuid_pattern or not (fields_by_id ? aggregate_field_id) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_operation = 'distinct_count'
        and (fields_by_id -> aggregate_field_id ->> 'filterable')::boolean is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if aggregate_original_field_type = 'calculation' then
        if (fields_by_id -> aggregate_field_id) #>> '{settings,expression,kind}' is distinct from 'numeric'
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if (aggregate_operation in ('sum', 'average')
          and aggregate_field_type not in ('whole_number', 'decimal_number', 'money'))
        or (aggregate_operation in ('minimum', 'maximum')
          and aggregate_field_type not in (
            'text', 'whole_number', 'decimal_number', 'yes_no', 'money', 'date', 'date_time'
          )) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      if not (aggregate_field_id = any (summary_field_ids)) then
        summary_field_ids := pg_catalog.array_append(summary_field_ids, aggregate_field_id);
        fast_field_ids := pg_catalog.array_append(fast_field_ids, aggregate_field_id);
      end if;
    end if;
  end loop;

  v_storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
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

  if p_user_inputs ? 'grouping' and not (
    pg_catalog.lower(p_user_inputs #>> '{grouping,fieldId}') = any (readable_field_ids)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
  end if;
  -- A pivot axis or measure withheld from the viewer on any record is refused, so a withheld
  -- value never appears as a row, a column or a measure.
  if pivot_mode and not (
    pivot_row_field_id = any (readable_field_ids)
    and pivot_column_field_id = any (readable_field_ids)
    and (pivot_measure_field_id is null or pivot_measure_field_id = any (readable_field_ids))
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
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
  -- The compiler already applied an exact predicate over guaranteed readable
  -- columns. Re-evaluating it for each selected row adds no decision.
  if (prepared_plan #>> '{filter,pushedExact}')::boolean is true then
    filter_condition := null;
  end if;
  filter_types := coalesce(prepared_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types := coalesce(prepared_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values := coalesce(prepared_plan #> '{filter,residualInputs}', '{}'::jsonb);
  filter_predicate := coalesce(prepared_plan #>> '{filter,pushedPredicate}', 'true');
  filter_parameters := coalesce(prepared_plan #> '{filter,pushedParameters}', '[]'::jsonb);
  select coalesce(pg_catalog.array_agg(item.value order by item.position), array[]::text[])
  into filter_expression_pairs
  from pg_catalog.jsonb_array_elements_text(prepared_plan #> '{filter,expressions}')
    with ordinality as item(value, position);
  if pg_catalog.cardinality(filter_expression_pairs) > 0 then
    select pg_catalog.string_agg(
      'pg_catalog.jsonb_build_object(' || chunk.pairs_text || ')', ' || '
      order by chunk.chunk_index
    )
    into filter_values_sql
    from (
      select (pair.position - 1) / 50 as chunk_index,
        pg_catalog.string_agg(pair.value, ', ' order by pair.position) as pairs_text
      from pg_catalog.unnest(filter_expression_pairs)
        with ordinality as pair(value, position)
      group by (pair.position - 1) / 50
    ) as chunk;
  end if;
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'filterFieldIds') as item(value);

  -- The plan is exact only when every candidate is readable and every field
  -- used by grouping, aggregates or filtering is readable on every candidate.
  -- Derived filter and aggregate fields can lose their projection on an
  -- individual record when an input is withheld, so both require read_record.
  -- A search may match through a field readable on only some records; read_record
  -- remains authoritative for each match rather than searching hidden stored values.
  fast_path := user_search is null and pg_catalog.cardinality(readable_field_ids) > 0
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as required(id)
      where fields_by_id -> required.id ->> 'type' in ('calculation', 'total')
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and fields_by_id -> pg_catalog.lower(item.value ->> 'fieldId') ->> 'type'
          in ('calculation', 'total')
    )
    and not exists (
      select 1 from pg_catalog.unnest(group_ids || filter_ids) as required(id)
      where required.id <> all (readable_field_ids)
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
      where item.value ? 'fieldId'
        and pg_catalog.lower(item.value ->> 'fieldId') <> all (readable_field_ids)
    );

  if fast_path then
    foreach field_key in array fast_field_ids loop
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = v_storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state <> 'active' then
        fast_path_fields_valid := false;
        exit;
      end if;
      field_type := fields_by_id -> field_key ->> 'type';
      fast_path_fields_valid := fast_path_fields_valid and case field_type
        when 'whole_number' then mapping_row.database_value_type = 'integer'
        when 'decimal_number' then mapping_row.database_value_type = 'decimal'
        when 'yes_no' then mapping_row.database_value_type = 'boolean'
        when 'date' then mapping_row.database_value_type = 'date'
        when 'date_time' then mapping_row.database_value_type = 'timestamp_with_time_zone'
        when 'money' then mapping_row.database_value_type = 'json'
        when 'link' then mapping_row.database_value_type = 'json'
        when 'link_to_one_of_several' then mapping_row.database_value_type = 'json'
        when 'text' then mapping_row.database_value_type = 'text'
        when 'long_text' then mapping_row.database_value_type = 'text'
        when 'formatted_text' then mapping_row.database_value_type = 'json'
        when 'choice' then mapping_row.database_value_type = 'text'
        when 'reference_number' then mapping_row.database_value_type = 'text'
        when 'email_address' then mapping_row.database_value_type = 'text'
        when 'phone_number' then mapping_row.database_value_type = 'text'
        when 'web_address' then mapping_row.database_value_type = 'text'
        when 'several_choices' then mapping_row.database_value_type = 'json'
        when 'table' then mapping_row.database_value_type = 'json'
        when 'attachment' then mapping_row.database_value_type = 'json'
        else false end;
      if not fast_path_fields_valid then
        exit;
      end if;
      value_expression := case mapping_row.database_value_type
        when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
        when 'timestamp_with_time_zone' then pg_catalog.format(
          'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
          mapping_row.physical_column_token
        )
        when 'date' then pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
          mapping_row.physical_column_token
        )
        else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
      end;
      expression_pairs := pg_catalog.array_append(
        expression_pairs, pg_catalog.format('%L, %s', field_key, value_expression)
      );
    end loop;
    fast_path := fast_path_fields_valid;
  end if;

  -- A search narrows the candidate scan, and so the ceiling, with the authoritative
  -- search predicate evaluated over the stored values of the searched fields, built
  -- from the same value expression read_record projects from. A projection only omits
  -- stored values, so every record whose readable values match also matches here: the
  -- narrowing is a superset and read_record stays the decision for each counted match.
  -- A searched field without an active column, or derived (calculation, total), has no
  -- such proof, so the scan is then not narrowed at all.
  if user_search is not null and pg_catalog.cardinality(search_field_ids) > 0 and not exists (
    select 1
    from pg_catalog.unnest(search_field_ids) as searched(id)
    left join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = v_storage_contract_id
      and mapping.field_id = searched.id::uuid
    where mapping.storage_contract_id is null
      or mapping.state <> 'active'
      or fields_by_id -> searched.id ->> 'type' in ('calculation', 'total')
  ) then
    search_prefilter_sql := pg_catalog.format(
      'vortex_record.query_search_matches_internal(pg_catalog.jsonb_build_object(%s), $18::text[], $19::text)',
      vortex_record.named_action_storage_columns_internal(
        v_storage_contract_id,
        (select pg_catalog.jsonb_agg(fields_by_id -> searched.id)
         from pg_catalog.unnest(search_field_ids) as searched(id))
      ) ->> 'valueExpression'
    );
  end if;

  for aggregate_item in
    select item.value from pg_catalog.jsonb_array_elements(aggregate_items) as item(value)
  loop
    aggregate_operation := aggregate_item ->> 'operation';
    aggregate_alias := aggregate_item ->> 'alias';
    aggregate_field_id := nullif(pg_catalog.lower(aggregate_item ->> 'fieldId'), '');
    aggregate_count_sql := 'pg_catalog.count(*)';
    aggregate_present_sql := 'true';
    aggregate_value_sql := 'pg_catalog.to_jsonb(pg_catalog.count(*))';
    aggregate_mixed_currency_sql := 'false';
    if aggregate_field_id is not null then
      aggregate_original_field_type := coalesce(fields_by_id -> aggregate_field_id ->> 'type', '');
      aggregate_field_type := aggregate_original_field_type;
      if aggregate_original_field_type = 'calculation' then
        if (fields_by_id -> aggregate_field_id) #>> '{settings,expression,kind}' is distinct from 'numeric'
          or (fields_by_id -> aggregate_field_id) #>> '{settings,evaluation}' is distinct from 'stored'
          or coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,resultType}', '')
            not in ('whole_number', 'decimal_number') then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        aggregate_field_type := (fields_by_id -> aggregate_field_id) #>> '{settings,resultType}';
      elsif aggregate_original_field_type = 'total' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
      end if;
      aggregate_present_sql := pg_catalog.format(
        '(candidate.projected_values ? %L and candidate.projected_values -> %L <> ''null''::jsonb)',
        aggregate_field_id, aggregate_field_id
      );
      aggregate_count_sql := pg_catalog.format(
        'pg_catalog.count(*) filter (where %s)', aggregate_present_sql
      );
      value_expression := pg_catalog.format('(candidate.projected_values -> %L)', aggregate_field_id);
      aggregate_currency_sql := pg_catalog.format(
        '(candidate.projected_values -> %L ->> ''currency'')', aggregate_field_id
      );
      aggregate_amount_sql := pg_catalog.format(
        '((candidate.projected_values -> %L ->> ''amount'')::numeric)', aggregate_field_id
      );
      if aggregate_operation = 'count' then
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', aggregate_count_sql);
      elsif aggregate_operation = 'distinct_count' then
        -- SQL numeric equality folds differently scaled exact decimal text. Money
        -- includes its currency; counting different values never adds currencies.
        value_expression := case aggregate_field_type
          when 'decimal_number' then pg_catalog.format(
            'pg_catalog.to_jsonb((candidate.projected_values ->> %L)::numeric)', aggregate_field_id)
          when 'money' then pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', %s)',
            aggregate_amount_sql, aggregate_currency_sql)
          else value_expression end;
        aggregate_value_sql := pg_catalog.format(
          'pg_catalog.to_jsonb(pg_catalog.count(distinct %s) filter (where %s))',
          value_expression, aggregate_present_sql
        );
      elsif aggregate_field_type = 'money' then
        aggregate_mixed_currency_sql := pg_catalog.format(
          '(pg_catalog.count(distinct %s) filter (where %s)) > 1',
          aggregate_currency_sql, aggregate_present_sql
        );
        if aggregate_operation = 'minimum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s asc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        elsif aggregate_operation = 'maximum' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by %s desc, %s collate "C" asc) filter (where %s))[1]',
            value_expression, aggregate_amount_sql, aggregate_currency_sql, aggregate_present_sql
          );
          aggregate_value_sql := value_expression;
        else
          average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
          if average_places not between 0 and 12 then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
          end if;
          if aggregate_operation = 'sum' then
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale(pg_catalog.sum(%s) filter (where %s))::text',
              aggregate_amount_sql, aggregate_present_sql
            );
          else
            aggregate_sum_sql := pg_catalog.format(
              'pg_catalog.sum(%s) filter (where %s)', aggregate_amount_sql, aggregate_present_sql
            );
            aggregate_average_sql := pg_catalog.format(
              'case when %3$s = 0 then null else
                 pg_catalog.sign(%1$s) * (
                   pg_catalog.div(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   )
                   + case when 2 * pg_catalog.mod(
                       pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                       (%3$s)::numeric
                     ) >= (%3$s)::numeric then 1 else 0 end
                 ) / pg_catalog.power(10::numeric, %2$s)
               end',
              aggregate_sum_sql, average_places, aggregate_count_sql
            );
            value_expression := pg_catalog.format(
              'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
            );
          end if;
          aggregate_value_sql := pg_catalog.format(
            'pg_catalog.jsonb_build_object(''amount'', %s, ''currency'', (pg_catalog.array_agg(%s order by %s collate "C" asc) filter (where %s))[1])',
            value_expression, aggregate_currency_sql, aggregate_currency_sql, aggregate_present_sql
          );
        end if;
      elsif aggregate_operation in ('minimum', 'maximum') then
        if aggregate_field_type = 'text' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L) collate "C" %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'yes_no' then
          value_expression := pg_catalog.format(
            '(pg_catalog.array_agg(%s order by (candidate.projected_values ->> %L)::boolean %s) filter (where %s))[1]',
            value_expression, aggregate_field_id,
            case aggregate_operation when 'minimum' then 'asc' else 'desc' end,
            aggregate_present_sql
          );
        elsif aggregate_field_type = 'whole_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s((candidate.projected_values ->> %L)::bigint) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'decimal_number' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.trim_scale(pg_catalog.%s((candidate.projected_values ->> %L)::numeric) filter (where %s))::text)',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        elsif aggregate_field_type = 'date' then
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(pg_catalog.%s(candidate.projected_values ->> %L) filter (where %s))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        else
          value_expression := pg_catalog.format(
            'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(pg_catalog.%s((candidate.projected_values ->> %L)::timestamp with time zone) filter (where %s)))',
            case aggregate_operation when 'minimum' then 'min' else 'max' end,
            aggregate_field_id, aggregate_present_sql
          );
        end if;
        aggregate_value_sql := value_expression;
      else
        average_places := coalesce((aggregate_item ->> 'decimalPlaces')::integer, 2);
        if aggregate_operation = 'average' and average_places not between 0 and 12 then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        if aggregate_operation = 'sum' then
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale(pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s))::text',
            aggregate_field_id, aggregate_present_sql
          );
        else
          aggregate_sum_sql := pg_catalog.format(
            'pg_catalog.sum((candidate.projected_values ->> %L)::numeric) filter (where %s)',
            aggregate_field_id, aggregate_present_sql
          );
          aggregate_average_sql := pg_catalog.format(
            'case when %3$s = 0 then null else
               pg_catalog.sign(%1$s) * (
                 pg_catalog.div(
                   pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                   (%3$s)::numeric
                 )
                 + case when 2 * pg_catalog.mod(
                     pg_catalog.abs(%1$s) * pg_catalog.power(10::numeric, %2$s),
                     (%3$s)::numeric
                   ) >= (%3$s)::numeric then 1 else 0 end
               ) / pg_catalog.power(10::numeric, %2$s)
             end',
            aggregate_sum_sql, average_places, aggregate_count_sql
          );
          value_expression := pg_catalog.format(
            'pg_catalog.trim_scale((%s))::text', aggregate_average_sql
          );
        end if;
        aggregate_value_sql := pg_catalog.format('pg_catalog.to_jsonb(%s)', value_expression);
      end if;
      if aggregate_operation in ('count', 'distinct_count') then
        aggregate_result_sql := pg_catalog.format(
          'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', %s)',
          aggregate_count_sql, aggregate_value_sql
        );
      else
        aggregate_result_sql := pg_catalog.format(
          'case when %s then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''mixed_currency'') else pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', %s, ''value'', case when %s = 0 then ''null''::jsonb else %s end) end',
          aggregate_mixed_currency_sql, aggregate_count_sql, aggregate_count_sql, aggregate_value_sql
        );
      end if;
    else
      aggregate_result_sql := pg_catalog.format(
        'pg_catalog.jsonb_build_object(''outcome'', ''completed'', ''valueCount'', pg_catalog.count(*), ''value'', pg_catalog.to_jsonb(pg_catalog.count(*)))'
      );
    end if;
    -- A missing projected key is withheld, whereas a readable empty field remains JSON null.
    -- Never present a partial total (or an empty total) as the aggregate of the whole bucket.
    if aggregate_field_id is not null then
      aggregate_result_sql := pg_catalog.format(
        'case when coalesce(pg_catalog.bool_or(not (candidate.projected_values ? %L)), false)
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''read_forbidden'')
           else %s end',
        aggregate_field_id, aggregate_result_sql
      );
    end if;
    if aggregate_object_sql <> '' then
      aggregate_object_sql := aggregate_object_sql || ', ';
    end if;
    aggregate_object_sql := aggregate_object_sql || pg_catalog.format('%L, %s', aggregate_alias, aggregate_result_sql);
  end loop;

  -- A count-only grouping has no authored aggregate expressions. Its totals
  -- must still be exactly one row when the selection is empty or over budget.
  summary_totals_sql := case when aggregate_object_sql = '' then
    'select ''{}''::jsonb as aggregate_values'
    else pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as aggregate_values from selected as candidate',
      aggregate_object_sql) end;

  foreach field_key in array group_ids loop
    group_bucket := nullif(pivot_buckets -> field_key, 'null'::jsonb);
    group_value_sql := pg_catalog.format(
      'vortex_record.grouping_value_internal(candidate.projected_values -> %L, %L, %L::jsonb)',
      field_key, fields_by_id -> field_key ->> 'type', group_bucket::text
    );
    group_value_pairs := pg_catalog.array_append(
      group_value_pairs, pg_catalog.format('%L, %s', field_key, group_value_sql)
    );
    group_by_terms := pg_catalog.array_append(group_by_terms, group_value_sql);
    group_presence_terms := pg_catalog.array_append(
      group_presence_terms, pg_catalog.format('(candidate.projected_values ? %L)', field_key)
    );
  end loop;
  group_values_sql := 'pg_catalog.jsonb_build_object(' || pg_catalog.array_to_string(group_value_pairs, ', ') || ')';
  group_by_sql := pg_catalog.array_to_string(group_by_terms, ', ');
  group_presence_sql := pg_catalog.array_to_string(group_presence_terms, ' and ');

  if fast_path then
    candidate_sql := pg_catalog.format(
      'select pg_catalog.jsonb_build_object(%s) as projected_values,
         %s as filter_values
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
       limit $5',
      pg_catalog.array_to_string(expression_pairs, ', '),
      filter_values_sql,
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate
    );
  else
    -- The access predicate supplies only the planner's candidate superset.
    -- Decide every scanned row through read_record before evaluating its Query
    -- filter, so a withheld field can never decide whether it counts.
    scan_sql := pg_catalog.format(
      'select stored.record_id
       from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.lifecycle_state = ''active''
         and %s
         and (%s)
         and (%s)
         and (%s)
       limit $5',
      physical_table_token,
      case when storage_scope = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql,
      filter_predicate,
      search_prefilter_sql
    );
    candidate_sql := scan_sql;
  end if;

  -- A compiled predicate may be a superset. The fast path still evaluates the
  -- complete condition over values the exact plan proves readable; the raw
  -- candidate count remains the ceiling, before any totals are returned.
  if fast_path then
    selected_sql := case when filter_condition is not null then
      'select candidate.projected_values from candidate where
         vortex_access.evaluate_query_condition_internal(
           $12, $13, candidate.filter_values, $14, $15, false
         )'
      else 'select candidate.projected_values from candidate' end;
  else
    -- Materialize each read once. The raw candidate count gates the reads, and
    -- every filter and aggregate uses only the fields this read returned.
    selected_sql := pg_catalog.format(
      'with readable as materialized (
         select vortex_record.read_record(%L::uuid, candidate.record_id) as result
         from candidate
         where (select value from candidate_count) <= %s
       )
       select (
         select coalesce(pg_catalog.jsonb_object_agg(field.id, readable.result -> ''values'' -> field.id), ''{}''::jsonb)
         from pg_catalog.unnest($17::text[]) as field(id)
         where readable.result -> ''values'' ? field.id
       ) as projected_values
       from readable
       where readable.result ->> ''outcome'' = ''allowed''
         and vortex_record.query_search_matches_internal(readable.result -> ''values'', $18::text[], $19::text)
         and not exists (
           select 1 from pg_catalog.unnest($16::text[]) as required(id)
           where not (readable.result -> ''values'' ? required.id)
         )
         and ($12::jsonb is null or vortex_access.evaluate_query_condition_internal(
           $12, $13,
           (select coalesce(pg_catalog.jsonb_object_agg(referenced.id,
             case $13 ->> referenced.id
               when ''organization_account_reference'' then pg_catalog.to_jsonb(
                 pg_catalog.lower(readable.result -> ''values'' -> referenced.id ->> ''organizationAccountId''))
               else readable.result -> ''values'' -> referenced.id
             end), ''{}''::jsonb)
            from pg_catalog.unnest($16::text[]) as referenced(id)),
           $14, $15, false
         ))',
      record_type_id_value::text, summary_candidate_limit
    );
  end if;

  -- Omitted grouping fields are withheld on that row, so they form no group;
  -- a readable JSON null remains a legitimate null group.
  if board_summary_mode then
    board_bucket_sql := pg_catalog.format(
      'case when pg_catalog.jsonb_typeof(candidate.projected_values -> %L) = ''string'' then case ',
      board_choice_field_id
    );
    board_option_position := 0;
    for board_option in
      select item.value from pg_catalog.jsonb_array_elements(board_options) as item(value)
    loop
      board_option_position := board_option_position + 1;
      board_bucket_sql := board_bucket_sql || pg_catalog.format(
        'when (candidate.projected_values ->> %L) collate "C" = %L collate "C" then %s ',
        board_choice_field_id, board_option ->> 'value', board_option_position
      );
    end loop;
    board_bucket_sql := board_bucket_sql || 'else 0 end else 0 end';
    -- Requested buckets are data, validated against the installed options. Only these buckets
    -- enter the existing capped aggregate path; unread columns retain navigation metadata only.
    for board_requested_column in
      select item.value from pg_catalog.jsonb_array_elements(board_requested_columns) as item(value)
    loop
      if board_requested_column ->> 'kind' = 'unassigned' then
        board_requested_positions := pg_catalog.array_append(board_requested_positions, 0);
      else
        board_option_position := pg_catalog.array_position(board_option_values, board_requested_column ->> 'value');
        if board_option_position is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
        end if;
        board_requested_positions := pg_catalog.array_append(board_requested_positions, board_option_position);
      end if;
    end loop;

    if aggregate_object_sql = '' then
      board_totals_sql := 'select ''{}''::jsonb as aggregate_values';
      board_empty_aggregates_sql := 'select ''{}''::jsonb as aggregates';
    else
      board_totals_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) as aggregate_values
         from normalized as candidate',
        aggregate_object_sql
      );
      board_empty_aggregates_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(%s) as aggregates
         from (select null::jsonb as projected_values) as candidate where false',
        aggregate_object_sql
      );
    end if;
    if fast_path then
      -- One grouping-set scan computes both each bucket and the grand total.
      -- The raw candidate count is retained separately for the existing limit.
      summary_sql := pg_catalog.format(
        'with candidate as materialized (%s),
         candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
         selected as (%s),
         normalized as (
           select bucket.projected_values, bucket.bucket_index
           from (select candidate.projected_values, %s as bucket_index
             from selected as candidate) as bucket
           where bucket.bucket_index = any (%L::integer[])
         ),
         aggregate_rows as materialized (
           select grouping(candidate.bucket_index) as is_total,
             candidate.bucket_index,
             pg_catalog.count(*)::integer as row_count,
             %s as aggregates
           from normalized as candidate
           group by rollup(candidate.bucket_index)
         ),
         totals as (select row_count, aggregates from aggregate_rows where is_total = 1),
         grouped as (select bucket_index, row_count, aggregates from aggregate_rows where is_total = 0),
         installed_options as (
           select choice_option.value, choice_option.position::integer as position
           from pg_catalog.jsonb_array_elements(%L::jsonb)
             with ordinality as choice_option(value, position)
         ),
         empty_aggregates as (%s),
         columns_result as (
           select coalesce(pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               ''value'', installed.value ->> ''value'',
               ''label'', installed.value ->> ''label'',
               ''rowCount'', case when installed.position = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
               ''aggregates'', case when installed.position = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
             ) order by installed.position
           ), ''[]''::jsonb) as value
           from installed_options as installed
           left join grouped on grouped.bucket_index = installed.position
           cross join empty_aggregates
         ),
         unassigned_result as (
           select pg_catalog.jsonb_build_object(
             ''rowCount'', case when 0 = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
             ''aggregates'', case when 0 = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
           ) as value
           from (select 0::integer as bucket_index) as unassigned
           left join grouped on grouped.bucket_index = unassigned.bucket_index
           cross join empty_aggregates
         )
         select case when candidate_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
           else pg_catalog.jsonb_build_object(
             ''outcome'', ''completed'',
             ''moduleRootId'', %L,
             ''moduleReleaseVersion'', %L,
             ''queryId'', %L,
             ''choiceFieldId'', %L,
             ''totalRowCount'', totals.row_count,
             ''columns'', columns_result.value,
             ''unassigned'', unassigned_result.value,
             ''aggregates'', totals.aggregates
           ) end
         from candidate_count cross join totals
           cross join columns_result cross join unassigned_result',
        candidate_sql,
        selected_sql,
        board_bucket_sql,
        board_requested_positions::text,
        case when aggregate_object_sql = '' then '''{}''::jsonb'
          else pg_catalog.format('pg_catalog.jsonb_build_object(%s)', aggregate_object_sql) end,
        board_options::text,
        board_empty_aggregates_sql,
        board_requested_positions::text, board_requested_positions::text,
        board_requested_positions::text, board_requested_positions::text,
        summary_candidate_limit,
        p_module_root_id::text,
        resolved ->> 'moduleReleaseVersion',
        p_query_id::text,
        board_choice_field_id
      );
    else
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       normalized as materialized (
         select bucket.projected_values, bucket.bucket_index
         from (select candidate.projected_values, %s as bucket_index
           from selected as candidate) as bucket
         where bucket.bucket_index = any (%L::integer[])
       ),
       selected_count as (select pg_catalog.count(*)::integer as value from normalized),
       installed_options as (
         select choice_option.value, choice_option.position::integer as position
         from pg_catalog.jsonb_array_elements(%L::jsonb)
           with ordinality as choice_option(value, position)
       ),
       totals as (%s),
       grouped as (
         select candidate.bucket_index,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from normalized as candidate
         group by candidate.bucket_index
       ),
       empty_aggregates as (%s),
       columns_result as (
         select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             ''value'', installed.value ->> ''value'',
             ''label'', installed.value ->> ''label'',
             ''rowCount'', case when installed.position = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
             ''aggregates'', case when installed.position = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
           ) order by installed.position
         ), ''[]''::jsonb) as value
         from installed_options as installed
         left join grouped on grouped.bucket_index = installed.position
         cross join empty_aggregates
       ),
       unassigned_result as (
         select pg_catalog.jsonb_build_object(
           ''rowCount'', case when 0 = any (%L::integer[]) then coalesce(grouped.row_count, 0) else null end,
           ''aggregates'', case when 0 = any (%L::integer[]) then coalesce(grouped.aggregates, empty_aggregates.aggregates) else ''{}''::jsonb end
         ) as value
         from (select 0::integer as bucket_index) as unassigned
         left join grouped on grouped.bucket_index = unassigned.bucket_index
         cross join empty_aggregates
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''choiceFieldId'', %L,
           ''totalRowCount'', selected_count.value,
           ''columns'', columns_result.value,
           ''unassigned'', unassigned_result.value,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals
         cross join columns_result cross join unassigned_result',
      candidate_sql,
      selected_sql,
      board_bucket_sql,
      board_requested_positions::text,
      board_options::text,
      board_totals_sql,
      aggregate_object_sql,
      board_empty_aggregates_sql,
      board_requested_positions::text, board_requested_positions::text,
      board_requested_positions::text, board_requested_positions::text,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      board_choice_field_id
    );
    end if;
  elsif pivot_mode then
    -- One grouping-sets statement yields every cell, each row total, each column total and the
    -- grand total over the full readable filtered set. Averages and extremes are computed for
    -- each set, never combined from cells. Rows are keyset-paged by their canonical value text.
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       raw_dimensions as materialized (
         select candidate.projected_values, coalesce(%s, ''null''::jsonb) as row_value, coalesce(%s, ''null''::jsonb) as column_value
         from selected as candidate
         where %s and (select value from candidate_count) <= %s
       ),
       row_values as materialized (
         select * from vortex_record.pivot_dimension_internal(
           (select pg_catalog.array_agg(distinct row_value) from raw_dimensions), %L::jsonb
         )
       ),
       column_values as materialized (
         select * from vortex_record.pivot_dimension_internal(
           (select pg_catalog.array_agg(distinct column_value) from raw_dimensions), %L::jsonb
         )
       ),
       dimensions as materialized (
         select source.projected_values, rows.normalized as row_value,
           columns.normalized as column_value
         from raw_dimensions as source
         join row_values as rows on rows.value = source.row_value
         join column_values as columns on columns.value = source.column_value
       ),
       crossed as materialized (
         select grouping(candidate.row_value, candidate.column_value) as level,
           candidate.row_value, candidate.column_value,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from dimensions as candidate
         group by grouping sets (
           (candidate.row_value, candidate.column_value), (candidate.row_value),
           (candidate.column_value), ()
         )
       ),
       column_axis as materialized (
         select * from crossed where level = 2
       ),
       column_count as (select pg_catalog.count(*)::integer as value from column_axis),
       row_axis as materialized (
         select * from crossed
         where level = 1
           and (%L::text is null or row_value::text collate "C" > %L::text collate "C")
         order by row_value::text collate "C" limit %s
       ),
       visible_rows as materialized (
         select * from row_axis order by row_value::text collate "C" limit %s
       ),
       grand as (select row_count, aggregates from crossed where level = 3)
       select case
         when candidate_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         when column_count.value > %s
           then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''pivot_columns_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', grand.row_count,
           ''groups'', ''[]''::jsonb,
           ''aggregates'', grand.aggregates,
           ''nextGroupKey'', case when (select pg_catalog.count(*) from row_axis) > %s
             then (select row_value::text from visible_rows order by row_value::text collate "C" desc limit 1)
             else null end,
           ''pivot'', pg_catalog.jsonb_build_object(
             ''rowFieldId'', %L,
             ''columnFieldId'', %L,
             ''rowGroupCount'', (select pg_catalog.count(*) from crossed where level = 1),
             ''columns'', (
               select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 ''value'', axis.column_value, ''rowCount'', axis.row_count, ''aggregates'', axis.aggregates
               ) order by axis.column_value::text collate "C"), ''[]''::jsonb)
               from column_axis as axis
             ),
             ''rows'', (
               select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 ''key'', visible.row_value::text, ''value'', visible.row_value, ''rowCount'', visible.row_count,
                 ''aggregates'', visible.aggregates,
                 ''cells'', (
                   select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     ''column'', cell.column_value, ''rowCount'', cell.row_count,
                     ''aggregates'', cell.aggregates
                   ) order by cell.column_value::text collate "C"), ''[]''::jsonb)
                   from crossed as cell
                   where cell.level = 0 and cell.row_value = visible.row_value
                 )
               ) order by visible.row_value::text collate "C"), ''[]''::jsonb)
               from visible_rows as visible
             )
           )
         ) end
       from candidate_count cross join column_count cross join grand',
      candidate_sql,
      selected_sql,
      group_by_terms[1],
      group_by_terms[2],
      group_presence_sql,
      summary_candidate_limit,
      (fields_by_id -> pivot_row_field_id)::text,
      (fields_by_id -> pivot_column_field_id)::text,
      aggregate_object_sql,
      group_after, group_after, group_page_limit + 1, group_page_limit,
      summary_candidate_limit,
      pivot_column_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text,
      group_page_limit,
      pivot_row_field_id,
      pivot_column_field_id
    );
  elsif pg_catalog.cardinality(group_ids) > 0 then
    groups_json_sql := pg_catalog.format(
      '(select coalesce(pg_catalog.jsonb_agg(
         pg_catalog.jsonb_build_object(
           ''groupKey'', grouped.group_values::text,
           ''groupValues'', grouped.group_values,
           ''rowCount'', grouped.row_count,
           ''aggregates'', grouped.aggregates
         ) order by grouped.group_values::text collate "C"
       ), ''[]''::jsonb) from visible_groups as grouped)'
    );
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       selected_count as (select pg_catalog.count(*)::integer as value from selected),
       totals as (%s),
       grouped as (
         select %s as group_values,
           pg_catalog.count(*)::integer as row_count,
           pg_catalog.jsonb_build_object(%s) as aggregates
         from selected as candidate
         where %s
         group by %s
       ),
       paged_groups as materialized (
         select * from grouped
         where %L::text is null or group_values::text collate "C" > %L::text collate "C"
         order by group_values::text collate "C" limit %s
       ),
       visible_groups as materialized (
         select * from paged_groups order by group_values::text collate "C" limit %s
       )
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', selected_count.value,
           ''groups'', %s,
           ''aggregates'', totals.aggregate_values,
           ''nextGroupKey'', case when (select pg_catalog.count(*) from paged_groups) > %s
             then (select group_values::text from visible_groups order by group_values::text collate "C" desc limit 1)
             else null end
         ) end
       from candidate_count cross join selected_count cross join totals',
      candidate_sql,
      selected_sql,
      summary_totals_sql,
      group_values_sql,
      aggregate_object_sql,
      group_presence_sql,
      group_by_sql,
      group_after, group_after, group_page_limit + 1, group_page_limit,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text,
      groups_json_sql,
      group_page_limit
    );
  else
    summary_sql := pg_catalog.format(
      'with candidate as materialized (%s),
       candidate_count as (select pg_catalog.count(*)::integer as value from candidate),
       selected as materialized (%s),
       selected_count as (select pg_catalog.count(*)::integer as value from selected),
       totals as (%s)
       select case when candidate_count.value > %s
         then pg_catalog.jsonb_build_object(''outcome'', ''refused'', ''reasonCode'', ''dataset_limit_exceeded'')
         else pg_catalog.jsonb_build_object(
           ''outcome'', ''completed'',
           ''moduleRootId'', %L,
           ''moduleReleaseVersion'', %L,
           ''queryId'', %L,
           ''groupByFieldIds'', %L::jsonb,
           ''totalRowCount'', selected_count.value,
           ''groups'', ''[]''::jsonb,
           ''aggregates'', totals.aggregate_values
         ) end
       from candidate_count cross join selected_count cross join totals',
      candidate_sql,
      selected_sql,
      summary_totals_sql,
      summary_candidate_limit,
      p_module_root_id::text,
      resolved ->> 'moduleReleaseVersion',
      p_query_id::text,
      pg_catalog.to_jsonb(group_ids)::text
    );
  end if;

  begin
    execute summary_sql into result_value
      using context_organization_id, context_application_root_id, null::text[], null::uuid,
        summary_candidate_limit + 1, access_owner_account_id, access_owner_group_ids,
        access_shared_record_ids, filter_parameters, access_parameters, null::jsonb,
        filter_condition, filter_types, parameter_types, parameter_values,
        filter_ids, summary_field_ids, search_field_ids, user_search;
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
  end;
  return result_value;
end
$function$;

alter function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_owner;

revoke all on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.run_module_query_summary_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb) is
  'Owner-only summary execution over the access plan prepared by the protected adapter entry point; explicit organisation and application scope and the exact read plan bound every aggregate scan, including a pivot crossed in one grouping-sets statement.';
