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
