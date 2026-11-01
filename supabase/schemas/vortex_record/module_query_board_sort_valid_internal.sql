create or replace function vortex_record.module_query_board_sort_valid_internal(
  p_bound jsonb,
  p_sort jsonb
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select case when pg_catalog.jsonb_typeof(p_sort) is distinct from 'array' then false
    else pg_catalog.jsonb_array_length(p_sort) <= 1 and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_sort) as item(value)
      where coalesce((p_bound -> 'fieldsById' -> pg_catalog.lower(item.value ->> 'fieldId')
        ->> 'sortable')::boolean, false) is not true
    ) end
$function$;

alter function vortex_record.module_query_board_sort_valid_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_board_sort_valid_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_board_sort_valid_internal(jsonb,jsonb) is
  'Adapter-only validation that a board sort names at most one field declared sortable by the resolved record type.';
