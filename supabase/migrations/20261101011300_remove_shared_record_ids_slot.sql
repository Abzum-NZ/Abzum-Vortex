-- DT-4 follow-up: the record read scan carried a shared-record slot that only the removed
-- direct-share route kind could fill, so it was always null. The route resolver and the scan
-- planner stop returning it, the prepared access plan and the summary plan stop carrying it, and
-- every generated scan statement loses its positional parameter: the parameters after it move
-- down by one ($9..$19 become $8..$18), with the filter and access compilers, the projection
-- source, the board-column and tree predicates and the search pre-predicate renumbered to match.

set role vortex_owner;

drop function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text);

create or replace function vortex_access.resolve_record_read_scan_routes_internal(
  p_declaration jsonb,
  p_ownership_mode text
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  alternatives jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb;
  checked_at timestamptz;
  routes jsonb;
  eligibility jsonb;
  candidate jsonb;
  route jsonb;
  route_kind text;
  account_id uuid;
  member_group_ids uuid[];
  wants_owner boolean := false;
  -- Every route of every eligible alternative has an exact stored predicate, so
  -- a condition-free scan examines only rows the exact decision admits. When
  -- any route does not, that route's term is left true in the scan plan and no
  -- field is taken as readable for every scanned row.
  pushable boolean := true;
  alternatives jsonb := '[]'::jsonb;
begin
  if p_declaration is null
    or pg_catalog.jsonb_typeof(p_declaration) <> 'object'
    or p_declaration -> 'action' ->> 'actionKind' is distinct from 'read'
    or (p_declaration -> 'action') ? 'namedAction'
    or p_ownership_mode is null
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record read scan declaration is invalid';
  end if;

  -- The same one context and time sample the exact-record decision uses, and
  -- the same eligibility core: the eligible alternatives here are exactly the
  -- ones that decision would union for any single record.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();
  account_id := (ctx ->> 'organizationAccountId')::uuid;

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  -- An ineligible caller is refused for every record by that decision. The
  -- empty alternative list narrows the scan to nothing; the exact decision
  -- would refuse every row anyway.
  if eligibility ->> 'outcome' <> 'eligible' then
    return query select true, null::uuid, array[]::uuid[], '[]'::jsonb;
    return;
  end if;

  -- One alternative per eligible permission, reduced to the two facts the scan
  -- plan consumes: its exact route list and its saved-condition envelope. A
  -- route list that is not an array is never reasoned about; returning a null
  -- alternative list leaves the scan unrestricted.
  for candidate in
    select item.value
    from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as item(value)
  loop
    routes := candidate -> 'recordScope' -> 'routes';
    if pg_catalog.jsonb_typeof(routes) is distinct from 'array' then
      return query select false, null::uuid, array[]::uuid[], null::jsonb;
      return;
    end if;
    alternatives := alternatives || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'routes', routes,
      'savedCondition', case
        when candidate -> 'recordScope' ? 'savedCondition'
          then candidate -> 'recordScope' -> 'savedCondition'
        else null::jsonb
      end
    ));
    for route in
      select item.value from pg_catalog.jsonb_array_elements(routes) as item(value)
    loop
      route_kind := route ->> 'kind';
      if route_kind = 'ownership' then
        wants_owner := true;
        if p_ownership_mode not in ('organization_account', 'group') then
          -- An inherited owner is reached only by a current-edge chase, and an
          -- ownership route over a record type that stores no owner admits no
          -- record: neither is a fixed stored predicate.
          pushable := false;
        end if;
      else
        -- all_records admits every record; a relationship route is a
        -- relationship chase. Neither is a fixed stored predicate, so the scan
        -- is left unrestricted and the exact decision alone narrows it.
        pushable := false;
      end if;
    end loop;
  end loop;

  -- The groups the caller belongs to now: an active group and a live,
  -- started, unexpired membership, as the ownership test requires.
  select coalesce(pg_catalog.array_agg(distinct membership.group_id), array[]::uuid[])
  into member_group_ids
  from vortex_access.organization_group_memberships as membership
  join vortex_access.organization_groups as organization_group
    on organization_group.organization_id = membership.organization_id
    and organization_group.group_id = membership.group_id
    and organization_group.state = 'active'
  where membership.organization_id = (ctx ->> 'organizationId')::uuid
    and membership.organization_account_id = account_id
    and membership.state = 'live'
    and membership.starts_at <= checked_at
    and (membership.expires_at is null or membership.expires_at > checked_at);

  return query select
    pushable,
    case when wants_owner and p_ownership_mode = 'organization_account'
      then account_id else null::uuid end,
    case when wants_owner and p_ownership_mode = 'group'
      then member_group_ids else array[]::uuid[] end,
    alternatives;
end
$function$;

revoke all on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  to vortex_record_adapter;

comment on function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text) is
  'Private read-scan narrowing for the fixed record adapter: from the caller''s own current eligible read alternatives it returns the owner account and owner groups, the eligible alternatives reduced to their route lists and saved-condition envelopes, and whether every route has an exact stored predicate; it only narrows candidates and never replaces the exact-record decision.';

alter function vortex_access.resolve_record_read_scan_routes_internal(jsonb, text)
  owner to vortex_owner;

-- One protected summary plan: field policy, filter pushdown, aggregate expressions and candidate scan.
create or replace function vortex_record.module_summary_plan_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_search text,
  p_searchable_field_ids uuid[],
  p_prepared_plan jsonb,
  p_query jsonb,
  p_grouping_field_id uuid,
  p_field_counts boolean,
  p_pivot_row_field_id uuid,
  p_pivot_column_field_id uuid,
  p_pivot_measure_field_id uuid,
  p_buckets jsonb,
  p_group_limit integer,
  p_group_after text,
  p_choice_field_id uuid,
  p_columns jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  summary_candidate_limit constant integer := 100000;
  group_page_default constant integer := 40;
  group_page_maximum constant integer := 200;
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  prepared_plan jsonb := p_prepared_plan;
  user_search text := nullif(pg_catalog.btrim(p_search), '');
  search_field_ids text[] := array[]::text[];
  declared_searchable_ids jsonb := coalesce(pg_catalog.to_jsonb(p_searchable_field_ids), '[]'::jsonb);
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
  readable_field_ids text[] := array[]::text[];
  bound_field_ids text[] := array[]::text[];
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
  expression_pairs text[] := array[]::text[];
  group_value_pairs text[] := array[]::text[];
  group_by_terms text[] := array[]::text[];
  group_presence_terms text[] := array[]::text[];
  group_values_sql text;
  group_value_sql text;
  group_page_limit integer;
  group_after text := p_group_after;
  pivot_mode boolean := false;
  group_cursor jsonb;
  pivot_row_field_id text;
  pivot_column_field_id text;
  pivot_measure_field_id text;
  pivot_buckets jsonb := '{}'::jsonb;
  group_bucket jsonb;
  pivot_column_limit constant integer := 50;
  group_presence_sql text;
  group_dimension_sql text;
  group_axis_ctes_sql text;
  group_axis_joins_sql text := '';
  group_axis_index integer := 0;
  group_field_type text;
  group_axis_normalized text;
  group_axis_rank text;
  group_axis_title text;
  group_first_rank_sql text;
  group_axis_normalized_pairs text[] := array[]::text[];
  group_axis_title_terms text[] := array[]::text[];
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
  board_summary_mode boolean := false;
  board_choice_field_id text;
  board_options jsonb;
  board_option jsonb;
  board_option_values text[] := array[]::text[];
  board_requested_columns jsonb := p_columns;
  board_requested_positions integer[] := array[]::integer[];
  board_requested_column jsonb;
  board_option_position integer;
begin
  board_summary_mode := p_choice_field_id is not null;
  board_choice_field_id := p_choice_field_id::text;
  pivot_mode := p_pivot_row_field_id is not null;
  pivot_row_field_id := p_pivot_row_field_id::text;
  pivot_column_field_id := p_pivot_column_field_id::text;
  pivot_measure_field_id := p_pivot_measure_field_id::text;
  pivot_buckets := coalesce(p_buckets, '{}'::jsonb);
  resolved := prepared_plan -> 'resolved';
  query_item := p_query;
  record_type_item := prepared_plan -> 'recordType';
  if record_type_item ? 'systemProjection' then
    -- A protected reader supplies bounded pages, not an unbounded relation
    -- for aggregate scans.
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  record_type_id_value := (prepared_plan ->> 'recordTypeId')::uuid;
  context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
  context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;

  -- A group continuation is the jsonb text [rank, title, canonical group value] of the last group
  -- a page returned, for pivot rows and grouped tables alike; anything else is forged.
  if group_after is not null then
    begin
      group_cursor := group_after::jsonb;
      if pg_catalog.jsonb_typeof(group_cursor) <> 'array'
        or pg_catalog.jsonb_array_length(group_cursor) <> 3
        or (group_cursor ->> 0) not in ('0', '1', '2')
        or pg_catalog.jsonb_typeof(group_cursor -> 0) <> 'number'
        or pg_catalog.jsonb_typeof(group_cursor -> 1) <> 'string'
        or pg_catalog.jsonb_typeof(group_cursor -> 2) <> 'string' then
        raise exception using errcode = '22023', message = 'Group cursor is not a group key';
      end if;
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end;
  end if;
  -- Every grouped read pages its groups: the requested page size, or the default, held to the maximum.
  -- The candidate ceiling bounds the rows a read may scan, never the groups it returns.
  group_page_limit := least(group_page_maximum, greatest(1, coalesce(p_group_limit, group_page_default)));
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
        'link'
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
      if board_option - array['value', 'label', 'tone', 'requiredPermissionId']::text[] <> '{}'::jsonb
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
      or (aggregate_operation = 'count' and aggregate_field_id is not null and not p_field_counts) then
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
        if coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,expression,op}', '') not in ('add', 'subtract', 'multiply', 'divide', 'round')
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
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
  into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);

  -- The fields the reader is guaranteed to see on every record it may read: the bound a grouped
  -- table offers its filter, search and sort controls by, as a plain page read reports it.
  select coalesce(pg_catalog.array_agg(item.value order by item.value), array[]::text[])
  into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'fieldBoundIds') as item(value)
  where fields_by_id ? item.value;
  if p_grouping_field_id is not null and not (
    p_grouping_field_id::text = any (readable_field_ids)
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
    p_filter, coalesce(pg_catalog.to_jsonb(p_filterable_field_ids), '[]'::jsonb),
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

  -- A search narrows the candidate scan, and so the ceiling, through the one shared
  -- stored-value pre-predicate; read_record stays the decision for each counted match.
  search_prefilter_sql := vortex_record.query_search_prefilter_internal(
    v_storage_contract_id, fields_by_id, search_field_ids, readable_field_ids, user_search, 17, 18
  );

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
        if coalesce((fields_by_id -> aggregate_field_id) #>> '{settings,expression,op}', '') not in ('add', 'subtract', 'multiply', 'divide', 'round')
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
  group_presence_sql := pg_catalog.array_to_string(group_presence_terms, ' and ');
  -- A grouped table orders its groups by the tuple of (rank, title) per group field, in
  -- groupByFieldIds order, then the canonical value. A link dimension takes its rank and title from
  -- one protected title batch per link field (the batch pivot axes use), so unreadable targets fold
  -- into one Not available value per field. A choice dimension follows the field's option order: a
  -- stored value the field no longer offers follows every option, and no value comes last (rank 1,
  -- as for a link). Every other dimension keeps its canonical value order. The first field's rank is
  -- the group's rank; every field's title (terminated, the later ones led by their rank) is the
  -- group's title, so the keyset cursor stays [rank, title, canonical value].
  group_axis_ctes_sql := '';
  foreach field_key in array group_ids loop
    group_axis_index := group_axis_index + 1;
    group_field_type := fields_by_id -> field_key ->> 'type';
    if group_field_type = 'link' then
      group_axis_ctes_sql := group_axis_ctes_sql || pg_catalog.format(
        'link_axis_%1$s as materialized (
           select * from vortex_record.dimension_value_internal(
             (select pg_catalog.array_agg(distinct raw.group_values -> %2$L) from raw_dimensions as raw), %3$L::jsonb
           )
         ), ',
        group_axis_index, field_key, (fields_by_id -> field_key)::text
      );
      group_axis_joins_sql := group_axis_joins_sql || pg_catalog.format(
        ' left join link_axis_%1$s on link_axis_%1$s.value = raw.group_values -> %2$L',
        group_axis_index, field_key
      );
      group_axis_normalized := pg_catalog.format('link_axis_%s.normalized', group_axis_index);
      group_axis_rank := pg_catalog.format('coalesce(link_axis_%s.sort_rank, 0)', group_axis_index);
      group_axis_title := pg_catalog.format('coalesce(link_axis_%s.sort_title, '''')', group_axis_index);
    elsif group_field_type = 'choice' then
      group_axis_normalized := pg_catalog.format('raw.group_values -> %L', field_key);
      group_axis_rank := pg_catalog.format(
        'case when coalesce(raw.group_values -> %L, ''null''::jsonb) = ''null''::jsonb then 1 else 0 end', field_key
      );
      group_axis_title := pg_catalog.format(
        'case when coalesce(raw.group_values -> %1$L, ''null''::jsonb) = ''null''::jsonb then ''''::text
           else coalesce((
             select pg_catalog.lpad(choice_option.ordinal::text, 4, ''0'')
             from pg_catalog.jsonb_array_elements(%2$L::jsonb) with ordinality as choice_option(item, ordinal)
             where choice_option.item ->> ''value'' = raw.group_values ->> %1$L
             order by choice_option.ordinal limit 1
           ), ''9999'') end',
        field_key, coalesce(fields_by_id #> array[field_key, 'settings', 'options'], '[]'::jsonb)::text
      );
    else
      group_axis_normalized := pg_catalog.format('raw.group_values -> %L', field_key);
      group_axis_rank := '0';
      group_axis_title := '''''::text';
    end if;
    group_axis_normalized_pairs := pg_catalog.array_append(
      group_axis_normalized_pairs, pg_catalog.format('%L, %s', field_key, group_axis_normalized)
    );
    group_axis_title_terms := pg_catalog.array_append(
      group_axis_title_terms,
      case when group_axis_index = 1 then '' else '(' || group_axis_rank || ')::text || ' end
        || pg_catalog.format('pg_catalog.translate(pg_catalog.left(%s, 256), pg_catalog.chr(1), '''') || pg_catalog.chr(1)', group_axis_title)
    );
    if group_axis_index = 1 then group_first_rank_sql := group_axis_rank; end if;
  end loop;
  group_dimension_sql := pg_catalog.format(
    'select raw.group_values as value, pg_catalog.jsonb_build_object(%s) as normalized,
       %s as sort_rank, %s as sort_title
     from (select distinct group_values from raw_dimensions) as raw%s',
    pg_catalog.array_to_string(group_axis_normalized_pairs, ', '),
    group_first_rank_sql,
    pg_catalog.array_to_string(group_axis_title_terms, ' || '),
    group_axis_joins_sql
  );

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
           $11, $12, candidate.filter_values, $13, $14, false
         )'
      else 'select candidate.projected_values from candidate' end;
  else
    -- Decide the candidates together, one set pass per batch, and materialize each read once.
    -- The raw candidate count gates the reads, and every filter and aggregate uses only the
    -- fields this read returned.
    selected_sql := pg_catalog.format(
      'with readable as materialized (
         select batch.result
         from vortex_record.read_record_batch_internal(
           %L::uuid,
           (select pg_catalog.array_agg(candidate.record_id) from candidate
             where (select value from candidate_count) <= %s),
           %L::boolean, %L::uuid, %L::jsonb
         ) as batch
       )
       select (
         select coalesce(pg_catalog.jsonb_object_agg(field.id, readable.result -> ''values'' -> field.id), ''{}''::jsonb)
         from pg_catalog.unnest($16::text[]) as field(id)
         where readable.result -> ''values'' ? field.id
       ) as projected_values
       from readable
       where readable.result ->> ''outcome'' = ''allowed''
         and vortex_record.query_search_matches_internal(readable.result -> ''values'', $17::text[], $18::text)
         and not exists (
           select 1 from pg_catalog.unnest($15::text[]) as required(id)
           where not (readable.result -> ''values'' ? required.id)
         )
         and ($11::jsonb is null or vortex_access.evaluate_query_condition_internal(
           $11, $12,
           (select coalesce(pg_catalog.jsonb_object_agg(referenced.id,
             case $12 ->> referenced.id
               when ''organization_account_reference'' then pg_catalog.to_jsonb(
                 pg_catalog.lower(readable.result -> ''values'' -> referenced.id ->> ''organizationAccountId''))
               else readable.result -> ''values'' -> referenced.id
             end), ''{}''::jsonb)
            from pg_catalog.unnest($15::text[]) as referenced(id)),
           $13, $14, false
         ))',
      record_type_id_value::text, summary_candidate_limit,
      prepared_plan ? 'preview', v_storage_contract_id::text,
      case when prepared_plan ? 'preview' then record_type_item::text end
    );
  end if;

  -- Omitted grouping fields are withheld on that row, so they form no group;
  -- a readable JSON null remains a legitimate null group.
  if board_summary_mode then
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

  end if;
  return pg_catalog.jsonb_build_object('outcome', 'planned')
    || pg_catalog.jsonb_build_object('summary_candidate_limit', pg_catalog.to_jsonb(summary_candidate_limit),
      'resolved', pg_catalog.to_jsonb(resolved),
      'fast_path', pg_catalog.to_jsonb(fast_path),
      'candidate_sql', pg_catalog.to_jsonb(candidate_sql),
      'selected_sql', pg_catalog.to_jsonb(selected_sql),
      'aggregate_object_sql', pg_catalog.to_jsonb(aggregate_object_sql),
      'board_choice_field_id', pg_catalog.to_jsonb(board_choice_field_id),
      'board_options', pg_catalog.to_jsonb(board_options),
      'board_requested_positions', pg_catalog.to_jsonb(board_requested_positions),
      'p_module_root_id', pg_catalog.to_jsonb(p_module_root_id),
      'p_query_id', pg_catalog.to_jsonb(p_query_id),
      'group_ids', pg_catalog.to_jsonb(group_ids),
      'fields_by_id', pg_catalog.to_jsonb(fields_by_id),
      'group_by_terms', pg_catalog.to_jsonb(group_by_terms),
      'group_page_limit', pg_catalog.to_jsonb(group_page_limit),
      'group_after', pg_catalog.to_jsonb(group_after),
      'group_cursor', pg_catalog.to_jsonb(group_cursor),
      'pivot_row_field_id', pg_catalog.to_jsonb(pivot_row_field_id),
      'pivot_column_field_id', pg_catalog.to_jsonb(pivot_column_field_id),
      'pivot_column_limit', pg_catalog.to_jsonb(pivot_column_limit),
      'group_presence_sql', pg_catalog.to_jsonb(group_presence_sql),
      'group_values_sql', pg_catalog.to_jsonb(group_values_sql),
      'group_dimension_sql', pg_catalog.to_jsonb(group_dimension_sql),
      'group_axis_ctes_sql', pg_catalog.to_jsonb(group_axis_ctes_sql),
      'summary_totals_sql', pg_catalog.to_jsonb(summary_totals_sql),
      'user_search', pg_catalog.to_jsonb(user_search),
      'search_field_ids', pg_catalog.to_jsonb(search_field_ids),
      'context_organization_id', pg_catalog.to_jsonb(context_organization_id),
      'context_application_root_id', pg_catalog.to_jsonb(context_application_root_id),
      'access_parameters', pg_catalog.to_jsonb(access_parameters),
      'access_owner_account_id', pg_catalog.to_jsonb(access_owner_account_id),
      'access_owner_group_ids', pg_catalog.to_jsonb(access_owner_group_ids),
      'bound_field_ids', pg_catalog.to_jsonb(bound_field_ids),
      'filter_condition', pg_catalog.to_jsonb(filter_condition))
    || pg_catalog.jsonb_build_object('filter_types', pg_catalog.to_jsonb(filter_types),
      'parameter_types', pg_catalog.to_jsonb(parameter_types),
      'parameter_values', pg_catalog.to_jsonb(parameter_values),
      'filter_ids', pg_catalog.to_jsonb(filter_ids),
      'filter_parameters', pg_catalog.to_jsonb(filter_parameters),
      'summary_field_ids', pg_catalog.to_jsonb(summary_field_ids))
  ;
end
$function$;

alter function vortex_record.module_summary_plan_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,uuid,boolean,uuid,uuid,uuid,jsonb,integer,text,uuid,jsonb) owner to vortex_owner;
revoke all on function vortex_record.module_summary_plan_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,uuid,boolean,uuid,uuid,uuid,jsonb,integer,text,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.module_summary_plan_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,jsonb,uuid,boolean,uuid,uuid,uuid,jsonb,integer,text,uuid,jsonb) to vortex_record_adapter;

-- The only aggregate SQL execution path; it preserves the protected scan parameters and safe refusals.
create or replace function vortex_record.module_summary_execute_internal(
  p_plan jsonb,
  summary_sql text,
  p_include_field_bounds boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  summary_candidate_limit integer;
  user_search text;
  search_field_ids text[];
  context_organization_id uuid;
  context_application_root_id uuid;
  access_parameters jsonb;
  access_owner_account_id uuid;
  access_owner_group_ids uuid[];
  bound_field_ids text[];
  filter_condition jsonb;
  filter_types jsonb;
  parameter_types jsonb;
  parameter_values jsonb;
  filter_ids text[];
  filter_parameters jsonb;
  summary_field_ids text[];
  result_value jsonb;
  error_message text;
begin
  summary_candidate_limit := (p_plan ->> 'summary_candidate_limit')::integer;
  user_search := (p_plan ->> 'user_search')::text;
  select case when p_plan -> 'search_field_ids' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into search_field_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'search_field_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  context_organization_id := (p_plan ->> 'context_organization_id')::uuid;
  context_application_root_id := (p_plan ->> 'context_application_root_id')::uuid;
  access_parameters := nullif(p_plan -> 'access_parameters', 'null'::jsonb);
  access_owner_account_id := (p_plan ->> 'access_owner_account_id')::uuid;
  select case when p_plan -> 'access_owner_group_ids' = '[]'::jsonb then array[]::uuid[]
    else pg_catalog.array_agg(item.value::uuid order by item.position) end into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'access_owner_group_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  select case when p_plan -> 'bound_field_ids' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into bound_field_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'bound_field_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  filter_condition := nullif(p_plan -> 'filter_condition', 'null'::jsonb);
  filter_types := nullif(p_plan -> 'filter_types', 'null'::jsonb);
  parameter_types := nullif(p_plan -> 'parameter_types', 'null'::jsonb);
  parameter_values := nullif(p_plan -> 'parameter_values', 'null'::jsonb);
  select case when p_plan -> 'filter_ids' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into filter_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'filter_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  filter_parameters := nullif(p_plan -> 'filter_parameters', 'null'::jsonb);
  select case when p_plan -> 'summary_field_ids' = '[]'::jsonb then array[]::text[]
    else pg_catalog.array_agg(item.value::text order by item.position) end into summary_field_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'summary_field_ids', 'null'::jsonb))
    with ordinality as item(value, position);
  begin
    execute summary_sql into result_value
      using context_organization_id, context_application_root_id, null::text[], null::uuid,
        summary_candidate_limit + 1, access_owner_account_id, access_owner_group_ids,
        filter_parameters, access_parameters, null::jsonb,
        filter_condition, filter_types, parameter_types, parameter_values,
        filter_ids, summary_field_ids, search_field_ids, user_search;
  exception
    when invalid_parameter_value then
      -- Only the query condition evaluator's refusal is a filter the reader got wrong; any other
      -- invalid parameter is a platform fault and propagates to the adapter, which logs it.
      get stacked diagnostics error_message = message_text;
      if error_message is distinct from 'Query condition is invalid' then
        raise;
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    when sqlstate 'V3187' then
      -- A readable date bucket left the supported year domain (grouping_value_internal).
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'value_out_of_range');
  end;
  -- A grid's grouped read carries the reader's field bound, as its plain page read does, so the
  -- collapsed table offers the same controls without reading a member page.
  if p_include_field_bounds and result_value ->> 'outcome' = 'completed' then
    result_value := result_value || pg_catalog.jsonb_build_object(
      'fieldBounds', pg_catalog.jsonb_build_object(
        'readableFieldIds', pg_catalog.to_jsonb(bound_field_ids),
        'searchable', search_field_ids && bound_field_ids
      )
    );
  end if;
  return result_value;
end
$function$;

alter function vortex_record.module_summary_execute_internal(jsonb,text,boolean) owner to vortex_owner;
revoke all on function vortex_record.module_summary_execute_internal(jsonb,text,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.module_summary_execute_internal(jsonb,text,boolean) to vortex_record_adapter;


set role vortex_record_adapter;

drop function vortex_record.plan_record_read_scan_internal(uuid);

create or replace function vortex_record.plan_record_read_scan_internal(
  p_record_type_id uuid
)
returns table (
  restricted boolean,
  owner_account_id uuid,
  owner_group_ids uuid[],
  readable_field_ids text[],
  access_predicate text,
  access_parameters jsonb,
  bound_field_ids text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_account_id uuid;
  plan jsonb;
  target_meta jsonb;
  declaration jsonb;
  field_bounds jsonb;
  ownership_mode text;
  access_routes record;
  alternative jsonb;
  route jsonb;
  route_terms text[];
  route_sql text;
  alternative_terms text[] := array[]::text[];
  condition_sql text;
  condition_entry jsonb;
  condition_params jsonb;
  condition_field_types jsonb;
  condition_field_columns jsonb;
  condition_field_database_types jsonb;
  condition_field_definitions jsonb;
  condition_parameter_types jsonb;
  condition_parameter_values jsonb;
  condition_referenced_ids text[];
  declared_condition_ids text[];
  field_item jsonb;
  declaration_item jsonb;
  binding_item jsonb;
  field_id text;
  field_kind text;
  semantic_type text;
  column_entry jsonb;
  database_value_type text;
  parameter_offset integer;
  supported boolean;
  compiled jsonb;
  readable_field_ids_value text[];
  access_parameters_accum jsonb := '[]'::jsonb;
  access_predicate_value text := 'true';
  access_parameters_value jsonb := '[]'::jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  -- Narrowing only. A refusal or unsupported condition named below leaves the
  -- scan less selective, so the exact per-row decision is still what decides
  -- what a caller reads. Any other failure propagates with its cause: it is
  -- never turned into an unrestricted scan.
  if p_record_type_id is null or p_record_type_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not (context_value ? 'applicationRootId') then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;

  plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_current_active_installation()
  );
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  target_meta := plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  ownership_mode := target_meta ->> 'ownershipMode';

  -- The declaration the record loader builds for a read.
  declaration := vortex_record.record_type_read_declaration_internal(
    plan, p_record_type_id, context_application_root_id
  );
  if declaration is null then
    return query select false, null::uuid, array[]::uuid[],
      array[]::text[], 'false'::text, '[]'::jsonb, array[]::text[];
    return;
  end if;

  -- The owner and owner-group routes the scan can narrow, and the
  -- eligible alternatives reduced to their route lists and saved-condition
  -- envelopes. A null alternative list means no narrowing is possible.
  select routes.* into access_routes
  from vortex_access.resolve_record_read_scan_routes_internal(
    declaration, ownership_mode
  ) as routes;

  -- The fields this reader is guaranteed to see on every record the read
  -- decision admits, after the field-read decision for produced fields. A
  -- refused access context yields no fields, so the scan pushes neither an
  -- order nor a filter on a value it cannot prove is visible; any other
  -- failure propagates.
  field_bounds := vortex_record.decide_record_type_read_bounds_internal(
    plan, p_record_type_id, '[]'::jsonb
  );

  -- Those fields may drive the scan only when every row the scan examines is a
  -- row the exact decision admits: an unconditioned all-records alternative
  -- admits every active record, and a restricted plan examines only owned
  -- records, which its routes admit unless a saved condition narrows them. Otherwise the scan also examines rows the reader cannot read,
  -- whose every value is hidden, so no field is readable for the scan.
  readable_field_ids_value := case
    when (field_bounds -> 'coversAllRecords') = 'true'::jsonb
      or (access_routes.restricted and (field_bounds -> 'conditionFree') = 'true'::jsonb)
    then coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    )
    else array[]::text[]
  end;

  -- Access routes with an exact table form narrow the candidate rows here so a
  -- reader limited to some records still gets full pages from a large table.
  -- Every eligible alternative contributes one term: its route's exact stored
  -- predicate (or true when the route has no exact form) AND its saved
  -- condition compiled into the same scan. The terms are OR-ed deliberately:
  -- the exact decision admits a record through any one alternative, so the
  -- scan must keep every row any of them admits. The result only removes rows
  -- the exact per-row decision below would refuse; every row the scan returns
  -- still goes through read_record, so it cannot widen a result.
  if access_routes.alternatives is null
    or pg_catalog.jsonb_typeof(access_routes.alternatives) is distinct from 'array' then
    access_predicate_value := 'true';
  elsif pg_catalog.jsonb_array_length(access_routes.alternatives) = 0 then
    -- No eligible alternative admits any record.
    access_predicate_value := 'false';
  else
    for alternative in
      select item.value
      from pg_catalog.jsonb_array_elements(access_routes.alternatives) as item(value)
    loop
      route_terms := array[]::text[];
      for route in
        select item.value
        from pg_catalog.jsonb_array_elements(alternative -> 'routes') as item(value)
      loop
        case route ->> 'kind'
          when 'ownership' then
            if ownership_mode = 'organization_account' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_organisation_account_id = $6');
            elsif ownership_mode = 'group' then
              route_terms := pg_catalog.array_append(
                route_terms, 'stored.owner_group_id = any ($7)');
            else
              -- Inherited ownership is reached only by a current-edge chase.
              route_terms := pg_catalog.array_append(route_terms, 'true');
            end if;
          else
            -- all_records admits every record; a relationship route is a
            -- current-edge chase. Neither has an exact stored predicate.
            route_terms := pg_catalog.array_append(route_terms, 'true');
        end case;
      end loop;

      if pg_catalog.cardinality(route_terms) = 0 then
        route_sql := 'false';
      elsif 'true' = any (route_terms) then
        route_sql := 'true';
      else
        route_sql := '(' || pg_catalog.array_to_string(route_terms, ' or ') || ')';
      end if;

      -- A saved condition narrows every route of its alternative, including an
      -- all-records route. It is compiled with the exact-semantics type map and
      -- the alternative's own bound parameters; anything the compiler cannot
      -- express exactly is left as true, so the per-row decision still decides.
      condition_sql := null;
      condition_params := '[]'::jsonb;
      if alternative ? 'savedCondition'
        and pg_catalog.jsonb_typeof(alternative -> 'savedCondition') = 'object' then
        condition_entry := null;
        select entry.value into condition_entry
        from pg_catalog.jsonb_array_elements(plan -> 'sharingConditions') as entry(value)
        where (entry.value ->> 'conditionId')
            = (alternative -> 'savedCondition' ->> 'conditionId')
          and (entry.value ->> 'publishedRevision')::numeric
            = (alternative -> 'savedCondition' ->> 'publishedRevision')::numeric
          and (entry.value ->> 'contractFingerprint')
            = (alternative -> 'savedCondition' ->> 'contractFingerprint')
          and pg_catalog.lower(entry.value ->> 'sourceRecordTypeId')
            = pg_catalog.lower(p_record_type_id::text)
        limit 1;

        if condition_entry is not null then
          condition_field_types := '{}'::jsonb;
          condition_field_columns := '{}'::jsonb;
          condition_field_database_types := '{}'::jsonb;
          condition_field_definitions := '{}'::jsonb;
          for field_item in
            select item.value
            from pg_catalog.jsonb_array_elements(target_meta -> 'fields') as item(value)
          loop
            field_id := pg_catalog.lower(field_item ->> 'fieldId');
            column_entry := target_meta -> 'columns' -> field_id;
            if column_entry is not null then
              field_kind := field_item ->> 'type';
              -- Calculation and total fields have no fixed stored value here and stay
              -- out of the map, as do kinds the mapping does not know.
              semantic_type := case when field_kind in ('calculation', 'total') then null
                else vortex_access.condition_field_type_internal(field_item) end;
              if semantic_type is not null then
                condition_field_types := condition_field_types
                  || pg_catalog.jsonb_build_object(field_id, semantic_type);
                condition_field_columns := condition_field_columns
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'token');
                condition_field_database_types := condition_field_database_types
                  || pg_catalog.jsonb_build_object(field_id, column_entry ->> 'databaseValueType');
                condition_field_definitions := condition_field_definitions
                  || pg_catalog.jsonb_build_object(
                    field_id, pg_catalog.jsonb_build_object('filterable', true, 'type', field_kind));
              end if;
            end if;
          end loop;

          select coalesce(
            pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
          into condition_referenced_ids
          from pg_catalog.jsonb_path_query(
            condition_entry -> 'condition', 'lax $.**?(@.source == "field").fieldId'
          ) as referenced(value);
          select coalesce(
            pg_catalog.array_agg(pg_catalog.lower(declared.value #>> '{}')), array[]::text[])
          into declared_condition_ids
          from pg_catalog.jsonb_array_elements(
            condition_entry -> 'declaredFieldIds'
          ) as declared(value);

          supported := true;
          foreach field_id in array condition_referenced_ids loop
            field_id := pg_catalog.lower(field_id);
            if not (condition_field_types ? field_id)
              or not (condition_field_columns ? field_id)
              or not (condition_field_database_types ? field_id)
              or not (field_id = any (declared_condition_ids)) then
              supported := false;
              exit;
            end if;
            semantic_type := condition_field_types ->> field_id;
            database_value_type := condition_field_database_types ->> field_id;
            if not (
              (semantic_type = 'yes_no' and database_value_type = 'boolean')
              or (semantic_type = 'text' and database_value_type in ('text', 'json'))
              or (semantic_type = 'text_collection' and database_value_type = 'json')
              or (semantic_type = 'opaque_json' and database_value_type = 'json')
              or (semantic_type = 'money' and database_value_type = 'json')
              or (semantic_type = 'decimal_number' and database_value_type = 'decimal')
              or (semantic_type = 'whole_number' and database_value_type = 'integer')
              or (semantic_type = 'date' and database_value_type = 'date')
              or (semantic_type = 'date_time' and database_value_type = 'timestamp_with_time_zone')
            ) then
              supported := false;
              exit;
            end if;
          end loop;

          if supported then
            condition_parameter_types := '{}'::jsonb;
            condition_parameter_values := '{}'::jsonb;
            for declaration_item in
              select item.value
              from pg_catalog.jsonb_array_elements(condition_entry -> 'parameters') as item(value)
            loop
              condition_parameter_types := condition_parameter_types
                || pg_catalog.jsonb_build_object(
                  declaration_item ->> 'key', declaration_item ->> 'type');
            end loop;
            for binding_item in
              select item.value
              from pg_catalog.jsonb_array_elements(
                alternative -> 'savedCondition' -> 'parameterBindings'
              ) as item(value)
            loop
              if binding_item ->> 'source' = 'current_organization_account_id' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', context_account_id::text);
              elsif binding_item ->> 'source' = 'literal' then
                condition_parameter_values := condition_parameter_values
                  || pg_catalog.jsonb_build_object(
                    binding_item ->> 'key', binding_item -> 'value');
              else
                supported := false;
                exit;
              end if;
            end loop;
          end if;

          if supported then
            parameter_offset := pg_catalog.jsonb_array_length(access_parameters_accum);
            begin
              compiled := vortex_record.compile_query_filter_internal(
                condition_entry -> 'condition',
                condition_field_types,
                condition_field_columns,
                condition_field_database_types,
                condition_field_definitions,
                '{}'::jsonb,
                condition_parameter_types,
                condition_parameter_values,
                9,
                parameter_offset
              );
              condition_sql := compiled ->> 'predicate';
              condition_params := coalesce(compiled -> 'parameters', '[]'::jsonb);
            exception
              -- 22023 is the compiler's refusal of a condition it cannot express
              -- exactly; the condition is then left as true. Any other failure
              -- propagates.
              when sqlstate '22023' then
                get stacked diagnostics failure_sqlstate = returned_sqlstate,
                  failure_message = message_text;
                raise warning 'Record read scan condition was not pushed: SQLSTATE %, %',
                  failure_sqlstate, failure_message;
                condition_sql := null;
                condition_params := '[]'::jsonb;
            end;
          end if;

          -- Keep every compiled parameter even when nothing was pushed, so the
          -- next alternative's offsets stay aligned with the JSON array passed
          -- to the scan.
          access_parameters_accum := access_parameters_accum || condition_params;
        end if;
      end if;

      if condition_sql is null then
        alternative_terms := pg_catalog.array_append(alternative_terms, route_sql);
      elsif route_sql = 'true' then
        alternative_terms := pg_catalog.array_append(alternative_terms, condition_sql);
      else
        alternative_terms := pg_catalog.array_append(
          alternative_terms, '(' || route_sql || ' and ' || condition_sql || ')');
      end if;
    end loop;

    if 'true' = any (alternative_terms) then
      access_predicate_value := 'true';
      access_parameters_value := '[]'::jsonb;
    else
      access_predicate_value := '('
        || pg_catalog.array_to_string(alternative_terms, ' or ') || ')';
      access_parameters_value := access_parameters_accum;
    end if;
  end if;

  return query select
    access_routes.restricted,
    access_routes.owner_account_id,
    access_routes.owner_group_ids,
    readable_field_ids_value,
    access_predicate_value,
    access_parameters_value,
    coalesce(
      (
        select pg_catalog.array_agg(field.value order by field.value)
        from pg_catalog.jsonb_array_elements_text(
          field_bounds -> 'readableFieldIds'
        ) as field(value)
      ),
      array[]::text[]
    );
  return;
end
$function$;

alter function vortex_record.plan_record_read_scan_internal(uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.plan_record_read_scan_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.plan_record_read_scan_internal(uuid) to vortex_owner;

comment on function vortex_record.plan_record_read_scan_internal(uuid) is
  'Private read-scan narrowing for the record query: builds the read declaration for one record type of the exact active installation and returns the owner account and owner groups a caller can be admitted through, the fields every eligible read alternative is guaranteed to expose, kept only when every row the scan examines is one the exact decision admits, the same guaranteed fields unconditionally as the reader''s current field bound (what a list may offer to filter, search or sort by), and one scan predicate that OR-s every eligible alternative''s exact route test with its saved condition compiled into the same scan; any route without an exact stored predicate or any condition the compiler cannot express as a superset is left unrestricted or true, so the per-row decision remains the only thing that decides access.';

create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  semantic_type text;
  filter_condition jsonb;
  filter_exact boolean := false;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
  failure_sqlstate text;
  failure_message text;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview installation): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_platform.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    -- A plan for a system projection is a live plan, in a preview too: see below.
    if preview_mode and not (prepared_plan ? 'preview')
      and prepared_plan -> 'recordType' ? 'systemProjection' then
      preview_mode := false;
    end if;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception
        -- A refused access context or a stale preview is the expected refusal; any
        -- other failure is logged with its cause before the same safe refusal.
        when sqlstate '42501' or sqlstate '40001' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        when others then
          get stacked diagnostics failure_sqlstate = returned_sqlstate,
            failure_message = message_text;
          raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
            failure_sqlstate, failure_message;
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') or resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'fieldBoundIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      -- A system projection has no preview copy: it is the platform's live read model, which a
      -- preview reads on the live path, under the reader's own live access and never under the
      -- preview's roles.
      if resolved is null then
        resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
        if resolved -> 'recordType' ? 'systemProjection' then
          preview_mode := false;
        else
          resolved := null;
        end if;
      end if;
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview query): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  -- A query of a Module this Application only uses is read only when that Module exposes it,
  -- the same rule the Studio picker, the draft compile and publication apply; a release that
  -- names a private or older query of another Application's Module reads nothing. A record
  -- type's own listing carries its record type's identity and follows record access instead.
  if pg_catalog.lower(resolved #>> '{query,queryId}')
      is distinct from pg_catalog.lower(resolved #>> '{query,recordType,recordTypeId}')
    and resolved #>> '{query,exposure}' is distinct from 'exposed'
    and not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_module_root_id
        and root.kind = 'module'
        and root.owner_application_root_id = context_application_root_id
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  -- A preview reads its copy of the records with their stored totals and calculations; a system
  -- projection is read only through its protected reader, never from a preview.
  if preview_mode and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      -- A record type of a Module the previewed Application only uses is shared data: the preview
      -- takes the same read plan decision as the installed path, in the preview's registration,
      -- where that Module's own permissions follow the builder's live access. No eligible read
      -- alternative is the same refusal, never an empty preview table. A row the RLS policy does
      -- not show counts as used, so the decision is never skipped.
      if not exists (
        select 1
        from vortex_definition.roots as root
        where root.root_id = (resolved ->> 'recordTypeModuleRootId')::uuid
          and root.kind = 'module'
          and root.owner_application_root_id = context_application_root_id
      ) then
        begin
          select plan.* into access_plan
          from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
        exception
          -- A refused access context or a stale preview is the expected refusal; any
          -- other failure is logged with its cause before the same safe refusal.
          when sqlstate '42501' or sqlstate '40001' then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
          when others then
            get stacked diagnostics failure_sqlstate = returned_sqlstate,
              failure_message = message_text;
            raise warning 'Query preview preparation failed (read plan): SQLSTATE %, %',
              failure_sqlstate, failure_message;
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end;
        if access_plan.access_predicate is null then
          raise warning 'Query preview preparation failed (read plan): no access predicate';
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        if access_plan.access_predicate = 'false' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
        end if;
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        -- The builder's preview field bounds are also the bound a list offers its controls by.
        'fieldBoundIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A planning failure propagates; it never widens the scan.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
      -- No eligible read alternative admits any record. Report a refusal before
      -- an empty scan can be mistaken for an empty query result.
      if access_plan.access_predicate = 'false' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'read_forbidden');
      end if;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        -- The fields the reader is guaranteed to see on every record it may read, whatever the
        -- scan examines: the current field bound a list offers its filter, search and sort by.
        'fieldBoundIds', pg_catalog.to_jsonb(coalesce(access_plan.bound_field_ids, array[]::text[])),
        'access', pg_catalog.jsonb_build_object(
          'predicate', access_plan.access_predicate,
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      semantic_type := vortex_access.condition_field_type_internal(fields_by_id -> field_key);
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,op}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- Keep the canonical typed link object, including its target record type.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs retain their canonical values. The bridge validates declared types.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and coalesce((input_item ->> 'required')::boolean, true) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  filter_condition := vortex_record.omit_unbound_query_conditions_internal(filter_condition, parameter_values);
  select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
  into filter_ids
  from pg_catalog.jsonb_path_query(filter_condition, 'lax $.**?(@.source == "field").fieldId') as referenced(value);

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        8,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
      -- An incomplete compiled predicate remains a candidate narrowing step.
      filter_exact := filter_plan ->> 'predicate' is not null
        and (filter_plan ->> 'exact')::boolean is true;
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedExact', filter_exact,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  to vortex_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, refuses a preview of a used Module''s record type with read_forbidden when the same read plan decision admits no read alternative, refuses an authored query of a Module the Application does not own unless that query is exposed, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

create or replace function vortex_record.prepare_system_projection_scan_internal(
  p_plan jsonb,
  p_search jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  filter_condition jsonb := nullif(p_plan #> '{filter,residualCondition}', 'null'::jsonb);
  filter_types jsonb := coalesce(p_plan #> '{filter,residualFieldTypes}', '{}'::jsonb);
  parameter_types jsonb := coalesce(p_plan #> '{filter,residualInputTypes}', '{}'::jsonb);
  parameter_values jsonb := coalesce(p_plan #> '{filter,residualInputs}', '{}'::jsonb);
  record_type_item jsonb := p_plan -> 'recordType';
  resolved jsonb := p_plan -> 'resolved';
  v_storage_contract_id uuid := (p_plan #>> '{storage,storageContractId}')::uuid;
  query_module_root_id uuid := (p_plan ->> 'queryModuleRootId')::uuid;
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  user_search text := p_search ->> 'search';
  fields_by_id jsonb;
  filter_ids text[];
  readable_field_ids text[];
  search_field_ids text[];
  projection_field_keys jsonb;
  projection_database_types jsonb;
  projection_search_keys text[];
  projection_predicate jsonb;
  scan_source_sql text;
begin
  -- This plan is local to the query invocation, never caller-writable session state.
  select pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value)
  into fields_by_id
  from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into readable_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'readableFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_search -> 'fieldIds') as item(value);
  -- The prepared filter and search are handed to the bounded reader, which
  -- applies them inside its own indexed keyset scan before the limit. A
  -- field the reader is not guaranteed to see on every row may not decide
  -- which rows a page holds, so it is refused rather than filtered per row.
  if filter_condition is not null then
    if exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select coalesce(pg_catalog.jsonb_object_agg(referenced.id, fields_by_id -> referenced.id ->> 'key'),
      '{}'::jsonb)
    into projection_field_keys
    from pg_catalog.unnest(filter_ids) as referenced(id);
    select coalesce(pg_catalog.jsonb_object_agg(mapping.field_id::text, mapping.database_value_type),
      '{}'::jsonb)
    into projection_database_types
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = v_storage_contract_id
      and mapping.state = 'active'
      and mapping.field_id::text = any (filter_ids);
    projection_predicate := pg_catalog.jsonb_build_object('filter', pg_catalog.jsonb_build_object(
      'condition', filter_condition,
      'fieldKeys', projection_field_keys,
      'fieldTypes', filter_types,
      'fieldDatabaseTypes', projection_database_types,
      'inputTypes', parameter_types,
      'inputValues', parameter_values));
  end if;
  if user_search is not null then
    if exists (
      select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
      where searched.id <> all (readable_field_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'field_unbounded');
    end if;
    select coalesce(pg_catalog.array_agg(fields_by_id -> searched.id ->> 'key' order by searched.position),
      array[]::text[])
    into projection_search_keys
    from pg_catalog.unnest(search_field_ids) with ordinality as searched(id, position);
    projection_predicate := coalesce(projection_predicate, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'search', pg_catalog.jsonb_build_object(
        'term', user_search, 'keys', pg_catalog.to_jsonb(projection_search_keys)));
  end if;
  -- Explicit definition-derived columns shape the bounded reader values.
  -- No record_data relation is created or read for a system projection.
  scan_source_sql := pg_catalog.format($source$
    pg_catalog.jsonb_to_recordset($10) as projection(
      organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
    )
    cross join lateral pg_catalog.jsonb_to_record(
      pg_catalog.jsonb_build_object(
        'organisation_id', projection.organization_id,
        'module_root_id', %L::uuid,
        'record_type_id', %L::uuid,
        'storage_contract_id', %L::uuid,
        'record_id', projection.record_id,
        'definition_revision', %L::bigint,
        'lifecycle_state', 'active',
        'concurrency_number', projection.revision
      ) || coalesce((
        select pg_catalog.jsonb_object_agg(
          'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
          case
            when field.value ->> 'fieldId' = %L
              then pg_catalog.to_jsonb(projection.organization_id::text)
            when field.value ->> 'fieldId' = %L
              then pg_catalog.to_jsonb(projection.revision)
            else projection.attribute_values -> (field.value ->> 'key')
          end
        )
        from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
      ), '{}'::jsonb)
    ) as stored(%s)$source$,
    query_module_root_id, record_type_id_value,
    v_storage_contract_id, (resolved ->> 'moduleReleaseRevision')::bigint,
    record_type_item #>> '{systemProjection,organizationFieldId}',
    record_type_item #>> '{systemProjection,revisionFieldId}',
    record_type_item, vortex_record.system_projection_columns_internal(record_type_item)
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'predicate', projection_predicate, 'sourceSql', scan_source_sql);
end
$function$;

alter function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb)
  to vortex_owner, vortex_record_adapter, postgres;
comment on function vortex_record.prepare_system_projection_scan_internal(jsonb, jsonb) is
  'Prepares one bounded system-projection scan from the query invocation''s current private plan: refuses filters or searches over fields not guaranteed readable, builds the typed predicate for the registered reader, and maps its rows into explicit definition-derived columns; performs no row read or predicate evaluation.';

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
  scan_source_sql := pg_catalog.format('record_data.%I as stored', storage_plan #>> '{storage,physicalTableToken}');
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
      readable_field_ids, p_bound #>> '{searchPlan,search}', 16, 17);
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
  access_owner_account_id uuid := nullif(p_plan #>> '{storagePlan,access,ownerAccountId}', '')::uuid;
  access_owner_group_ids uuid[];
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
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{storagePlan,access,ownerGroupIds}') as item(value);
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
        exact_record_ids, projection_sort_key, projection_direction, projection_after,
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
       and ($11::uuid[] is null or stored.record_id = any ($11))
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
    case when p_plan #>> '{storagePlan,storage,storageScope}' = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    p_plan #>> '{storagePlan,access,predicate}',
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
      access_owner_group_ids,
      p_plan -> 'filterParameters', coalesce(p_plan #> '{storagePlan,access,parameters}', '[]'::jsonb),
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
        page_access_loaded := (vortex_record.load_record_access_facts_with_plan_internal(
          'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordTypeId', record_type_id_value,
            'recordId', scan_record.record_id,
            'projectionRow', scan_record.projection_row
          )),
          page_shared -> 'installation', page_shared -> 'plan'
        ) -> 0);
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
    exact_record_ids, projection_sort_key, projection_direction, projection_after,
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
      'stored.%I collate "C" = $12 collate "C"', p_member ->> 'choiceColumn')
    else pg_catalog.format(
      '(stored.%1$I is null or not (stored.%1$I collate "C" = any ($13::text[])))',
      p_member ->> 'choiceColumn')
  end
$function$;

alter function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_column_predicate_internal(jsonb,jsonb) is
  'Adapter-only stored-value predicate of one board column: the stored choice equals the bound column value, or names no option for the unassigned column; null when the choice field is not guaranteed readable and membership is decided from each readable projection only.';

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
  -- Grouped and totalled shapes are not plain rows.
  if vortex_record.module_query_grouped_internal(opened -> 'query') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
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
      || ' and tree_edge.to_record_id = $15)',
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

create or replace function vortex_record.read_query_tree_relatives_internal(
  p_parents boolean, p_record_ids uuid[], p_relationship_id uuid,
  p_organization_id uuid, p_application_root_id uuid, p_storage_plan jsonb,
  p_record_type_id uuid, p_first_loaded jsonb, p_declaration jsonb,
  p_eligibility jsonb, p_shared jsonb, p_narrowed boolean, p_validated_types jsonb,
  p_filter jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  pending uuid[] := p_record_ids;
  pending_after uuid[] := pg_catalog.array_fill(null::uuid, array[pg_catalog.cardinality(p_record_ids)]);
  batch_owners uuid[];
  batch_after uuid[];
  rest_owners uuid[];
  rest_after uuid[];
  round_room integer;
  candidate_values jsonb[];
  candidate_matches boolean[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  readable_values jsonb;
  filter_condition jsonb := nullif(p_filter -> 'condition', 'null'::jsonb);
  filter_ids text[];
  search_field_ids text[];
  search_text text := p_filter ->> 'search';
  matches boolean;
  found_ids uuid[] := array[]::uuid[];
  readable_parent_ids uuid[] := array[]::uuid[];
  candidates uuid[];
  owners uuid[];
  decided_ids uuid[];
  outcomes text[];
  candidate_index integer;
  examined integer := 0;
  outcome text;
  access_sql text := p_storage_plan #>> '{access,predicate}';
  owner_groups uuid[];
  storage_contract_id uuid := (p_storage_plan #>> '{storage,storageContractId}')::uuid;
  filter_exact boolean := (p_filter ->> 'exact')::boolean is true;
  owner_column text := case when p_parents then 'from_record_id' else 'to_record_id' end;
  candidate_column text := case when p_parents then 'to_record_id' else 'from_record_id' end;
begin
  -- Private invocation-local facts come from the query's validated page, never caller state.
  if p_parents is null or pg_catalog.cardinality(p_record_ids) > 201
    or p_organization_id is null or storage_contract_id is null or access_sql is null
    or pg_catalog.jsonb_typeof(p_filter) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_filter -> 'predicate') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'Tree relative read is invalid';
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into owner_groups
  from pg_catalog.jsonb_array_elements_text(p_storage_plan #> '{access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_filter -> 'fieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_filter -> 'searchFieldIds') as item(value);
  -- Keep the protected scan's parameter slots; slots 1,2,6,7,8,10 occur in access predicates and
  -- slot 9 in the query's pushed filter predicate.
  -- Each round reads the next matching child per owner, or its sole parent regardless of filters.
  -- Parent readability and filtered tree membership reuse the same exact batched decision.
  -- Work is bounded by candidates examined; owners beyond the budget stay undecided.
  while examined < 500 and pg_catalog.cardinality(pending) > 0 loop
    round_room := 500 - examined;
    batch_owners := pending[1 : round_room];
    batch_after := pending_after[1 : round_room];
    rest_owners := pending[round_room + 1 :];
    rest_after := pending_after[round_room + 1 :];
    execute pg_catalog.format(
      'select pg_catalog.array_agg(candidate.record_id order by pending_item.owner_id),
         pg_catalog.array_agg(pending_item.owner_id order by pending_item.owner_id),
         pg_catalog.array_agg(candidate.filter_values order by pending_item.owner_id),
         pg_catalog.array_agg(candidate.matches_filter order by pending_item.owner_id)
       from rows from (pg_catalog.unnest($10::uuid[]), pg_catalog.unnest($11::uuid[]))
         as pending_item(owner_id, after_id)
       cross join lateral (
         select stored.record_id, pg_catalog.jsonb_build_object(%8$s) as filter_values,
           (case when not %10$L::boolean then true when (%9$s) then true else false end) as matches_filter
         from vortex_record.relationship_edges as edge
         join record_data.%2$I as stored on stored.organisation_id = edge.from_organisation_id
           and stored.record_id = edge.%3$I
         where edge.relationship_id = %4$L::uuid and edge.from_organisation_id = $1
           and edge.to_organisation_id = $1
           and edge.from_storage_contract_id = %5$L::uuid and edge.to_storage_contract_id = %5$L::uuid
           and edge.%1$I = pending_item.owner_id
           and (pending_item.after_id is null or stored.record_id > pending_item.after_id)
           and stored.lifecycle_state = ''active''
           and %6$s and (%7$s)
           and (%10$L::boolean or (case when (%9$s) then true else false end))
         order by stored.record_id
         limit 1
       ) as candidate',
      owner_column, p_storage_plan #>> '{storage,physicalTableToken}', candidate_column,
      p_relationship_id, storage_contract_id,
      case when p_storage_plan #>> '{storage,storageScope}' = 'application_contained'
        then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
      access_sql, coalesce(p_filter ->> 'valuesSql', ''), p_filter ->> 'predicate', p_parents)
    into candidates, owners, candidate_values, candidate_matches
    using p_organization_id, p_application_root_id, null::text[], null::uuid, 501,
      (p_storage_plan #>> '{access,ownerAccountId}')::uuid, owner_groups,
      p_filter -> 'parameters', p_storage_plan #> '{access,parameters}', batch_owners, batch_after;
    if candidates is null then
      -- No owner of this batch has a matching candidate left; only owners beyond the budget remain.
      pending := coalesce(rest_owners, array[]::uuid[]);
      pending_after := coalesce(rest_after, array[]::uuid[]);
      continue;
    end if;
    examined := examined + pg_catalog.cardinality(candidates);
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.decision ->> 'outcome'), array[]::text[]),
      pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
      pg_catalog.array_agg(decided.bounds)
    into decided_ids, outcomes, decided_loaded, decided_decisions, decided_bounds
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, p_first_loaded, p_declaration, p_eligibility,
      candidates, p_shared -> 'envelope', p_narrowed
    ) as decided;
    for candidate_index in 1 .. pg_catalog.cardinality(candidates) loop
      decided_index := pg_catalog.array_position(decided_ids, candidates[candidate_index]);
      readable_values := null;
      if decided_index is not null and pg_catalog.cardinality(filter_ids) = 0
        and search_text is null and (filter_condition is null or filter_exact) then
        outcome := outcomes[decided_index];
      else
        -- The filter's referenced values must be readable, and its residual condition and the viewer's
        -- search must hold on the readable projection, exactly as the level scan decides a row.
        select row_read.projection ->> 'outcome', row_read.projection -> 'values'
        into outcome, readable_values
        from vortex_record.read_record_projection_with_validated_types_internal(
          p_record_type_id, candidates[candidate_index], p_declaration, p_eligibility,
          p_validated_types, null, decided_loaded[decided_index],
          decided_decisions[decided_index], decided_bounds[decided_index], p_shared
        ) as row_read;
      end if;
      if p_parents and outcome = 'allowed' then
        readable_parent_ids := pg_catalog.array_append(readable_parent_ids, owners[candidate_index]);
      end if;
      if outcome = 'allowed' then
        matches := candidate_matches[candidate_index];
        if matches and readable_values is not null then
          matches := not exists (
            select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
            where not (readable_values ? referenced.id));
          if matches and filter_condition is not null and not filter_exact then
            begin
              matches := vortex_access.evaluate_query_condition_internal(
                filter_condition, p_filter -> 'fieldTypes', candidate_values[candidate_index],
                p_filter -> 'inputTypes', p_filter -> 'inputs', false);
            exception when invalid_parameter_value then
              return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
            end;
          end if;
          if matches and search_text is not null then
            matches := vortex_record.query_search_matches_internal(
              readable_values, search_field_ids, search_text);
          end if;
        end if;
        if not matches then outcome := 'filtered'; end if;
      end if;
      if outcome = 'allowed' then
        found_ids := pg_catalog.array_append(found_ids, owners[candidate_index]);
      end if;
    end loop;
    exit when p_parents;
    -- An owner with an allowed candidate is decided; one whose candidates ran out drops out; one the
    -- budget did not reach stays undecided with the owners that continue.
    select coalesce(pg_catalog.array_agg(item.owner_id order by item.owner_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(item.record_id order by item.owner_id), array[]::uuid[])
    into pending, pending_after
    from rows from (pg_catalog.unnest(owners), pg_catalog.unnest(candidates))
      as item(owner_id, record_id)
    where item.owner_id <> all (found_ids);
    pending := pending || coalesce(rest_owners, array[]::uuid[]);
    pending_after := pending_after || coalesce(rest_after, array[]::uuid[]);
  end loop;
  -- Owners still pending when the budget ran out are undecided: the page is returned, not refused.
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'recordIds', pg_catalog.to_jsonb(found_ids),
    'readableParentRecordIds', pg_catalog.to_jsonb(readable_parent_ids),
    'undecidedIds', case when p_parents then '[]'::jsonb else pg_catalog.to_jsonb(pending) end);
end
$function$;

alter function vortex_record.read_query_tree_relatives_internal(boolean,uuid[],uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_query_tree_relatives_internal(boolean,uuid[],uuid,uuid,uuid,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,boolean,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;


reset role;
