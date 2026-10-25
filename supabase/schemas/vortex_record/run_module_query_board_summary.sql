-- Summarize explicitly requested board buckets; unread buckets keep navigation metadata only.
create or replace function vortex_record.run_module_query_board_summary(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
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
  opened jsonb;
  query_item jsonb;
  planned jsonb;
begin
  if p_choice_field_id is null or vortex_record.board_column_selector_internal(
    pg_catalog.jsonb_build_object('choiceFieldId', p_choice_field_id, 'columns', p_columns), true) is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  opened := vortex_record.module_summary_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, null::text, null::uuid[]
  );
  if opened ->> 'outcome' is distinct from 'prepared' then return opened; end if;
  query_item := opened -> 'query';
  planned := vortex_record.module_summary_plan_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, null::text, null::uuid[], opened, query_item, null, false, null, null, null,
    '{}'::jsonb, null, null, p_choice_field_id, p_columns
  );
  if planned ->> 'outcome' is distinct from 'planned' then return planned; end if;
  return vortex_record.module_summary_execute_internal(planned,
    vortex_record.module_summary_board_sql_internal(planned), false);
end
$function$;

alter function vortex_record.run_module_query_board_summary(uuid,uuid,bigint,jsonb,jsonb,uuid[],uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_board_summary(uuid,uuid,bigint,jsonb,jsonb,uuid[],uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_board_summary(uuid,uuid,bigint,jsonb,jsonb,uuid[],uuid,jsonb) to vortex_request;
