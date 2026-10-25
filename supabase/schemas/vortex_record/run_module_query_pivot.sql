-- Summarize two explicit dimensions and one measure with keyset paging over pivot rows.
create or replace function vortex_record.run_module_query_pivot(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_search text,
  p_searchable_field_ids uuid[],
  p_pivot jsonb,
  p_group_after text
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
  if p_group_after is not null and pg_catalog.length(p_group_after) not between 1 and 4096 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  opened := vortex_record.module_summary_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, p_search, p_searchable_field_ids
  );
  if opened ->> 'outcome' is distinct from 'prepared' then return opened; end if;
  query_item := opened -> 'query';
  query_item := vortex_record.pivot_query_internal(query_item, opened -> 'recordType', p_pivot);
  if query_item is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  planned := vortex_record.module_summary_plan_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values, p_filter,
    p_filterable_field_ids, p_search, p_searchable_field_ids, opened, query_item, null, false,
    (p_pivot ->> 'rowFieldId')::uuid, (p_pivot ->> 'columnFieldId')::uuid,
    (p_pivot #>> '{measure,fieldId}')::uuid,
    pg_catalog.jsonb_build_object(pg_catalog.lower(p_pivot ->> 'rowFieldId'), p_pivot -> 'rowDateBucket', pg_catalog.lower(p_pivot ->> 'columnFieldId'), p_pivot -> 'columnDateBucket'),
    ((p_pivot ->> 'rowLimit')::numeric)::integer, p_group_after, null, null
  );
  if planned ->> 'outcome' is distinct from 'planned' then return planned; end if;
  return vortex_record.module_summary_execute_internal(planned,
    vortex_record.module_summary_pivot_sql_internal(planned), false);
end
$function$;

alter function vortex_record.run_module_query_pivot(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,text) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_pivot(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_pivot(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[],jsonb,text) to vortex_request;
