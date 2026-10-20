create or replace function vortex_record.run_module_query_summary(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_inputs jsonb
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
  prepared_plan jsonb;
  board_summary_mode boolean := false;
  board_summary jsonb;
begin
  if p_module_root_id is null or p_query_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_query_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_user_inputs is null then
    p_user_inputs := '{}'::jsonb;
  end if;
  board_summary_mode := p_user_inputs ? 'boardSummary';
  if pg_catalog.jsonb_typeof(p_user_inputs) <> 'object'
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_user_inputs) as supplied(key)
      where supplied.key not in ('filter', 'filterableFieldIds', 'boardSummary', 'groupingFieldId', 'search', 'searchableFieldIds')
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if (p_user_inputs ? 'groupingFieldId' and board_summary_mode)
    or (p_user_inputs ? 'search' and pg_catalog.jsonb_typeof(p_user_inputs -> 'search') not in ('string', 'null'))
    or pg_catalog.length(pg_catalog.btrim(p_user_inputs ->> 'search')) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if board_summary_mode then
    board_summary := p_user_inputs -> 'boardSummary';
    if pg_catalog.jsonb_typeof(board_summary) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if board_summary - array['choiceFieldId']::text[] <> '{}'::jsonb
      or not (board_summary ? 'choiceFieldId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    if pg_catalog.jsonb_typeof(board_summary -> 'choiceFieldId') is distinct from 'string'
      or pg_catalog.lower(board_summary ->> 'choiceFieldId') !~ uuid_pattern then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
  end if;

  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_user_inputs -> 'filter', coalesce(p_user_inputs -> 'filterableFieldIds', '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  return vortex_record.run_module_query_summary_internal(
    p_module_root_id, p_query_id, p_expected_release_revision,
    p_input_values, p_user_inputs, prepared_plan
  );
end
$function$;

alter function vortex_record.run_module_query_summary(uuid,uuid,bigint,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.run_module_query_summary(uuid, uuid, bigint, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.run_module_query_summary(uuid, uuid, bigint, jsonb, jsonb)
  to vortex_request;

comment on function vortex_record.run_module_query_summary(uuid, uuid, bigint, jsonb, jsonb) is
  'Runs one bounded database-backed installed Module query summary or protected board summary. It validates the request, prepares one protected read-scan access plan, and delegates the summary to the owner-only aggregate function, normalizes unreadable board choices to one unassigned bucket, summarises the own records of a preview for a preview request, and refuses neutrally above 100000 candidate rows.';
