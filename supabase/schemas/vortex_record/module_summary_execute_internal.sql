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
  access_shared_record_ids uuid[];
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
  select case when p_plan -> 'access_shared_record_ids' = '[]'::jsonb then array[]::uuid[]
    else pg_catalog.array_agg(item.value::uuid order by item.position) end into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(nullif(p_plan -> 'access_shared_record_ids', 'null'::jsonb))
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
        access_shared_record_ids, filter_parameters, access_parameters, null::jsonb,
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
