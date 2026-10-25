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
  -- A board reads members of its query's sole grouping key.
  if pg_catalog.jsonb_typeof(opened #> '{query,groupByFieldIds}') = 'array'
    and pg_catalog.jsonb_array_length(opened #> '{query,groupByFieldIds}') <> 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
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
