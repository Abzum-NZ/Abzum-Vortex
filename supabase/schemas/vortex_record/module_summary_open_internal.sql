-- Shared request bounds, release resolution and storage preparation for summary reads.
create or replace function vortex_record.module_summary_open_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_search text,
  p_searchable_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared_plan jsonb;
begin
  if p_module_root_id is null or p_query_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_query_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if pg_catalog.length(pg_catalog.btrim(p_search)) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_filterable_field_ids is not null and pg_catalog.cardinality(p_filterable_field_ids) > 0
    and pg_catalog.array_ndims(p_filterable_field_ids) is distinct from 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_searchable_field_ids is not null and pg_catalog.cardinality(p_searchable_field_ids) > 0
    and pg_catalog.array_ndims(p_searchable_field_ids) is distinct from 1 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_filter, coalesce(pg_catalog.to_jsonb(p_filterable_field_ids), '[]'::jsonb),
    'resolution', null
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  prepared_plan := vortex_record.prepare_module_query_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_filter, coalesce(pg_catalog.to_jsonb(p_filterable_field_ids), '[]'::jsonb),
    'storage', prepared_plan
  );
  if prepared_plan ->> 'outcome' is distinct from 'prepared' then
    return prepared_plan;
  end if;
  return prepared_plan;
end
$function$;

alter function vortex_record.module_summary_open_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.module_summary_open_internal(uuid,uuid,bigint,jsonb,jsonb,uuid[],text,uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
