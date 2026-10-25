create or replace function vortex_record.module_query_grouped_internal(
  p_query jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  -- Whether a resolved query groups or totals its records; a malformed shape is left to the bind
  -- step, which refuses it.
  select (pg_catalog.jsonb_typeof(p_query -> 'groupByFieldIds') = 'array'
      and pg_catalog.jsonb_array_length(p_query -> 'groupByFieldIds') > 0)
    or (pg_catalog.jsonb_typeof(p_query -> 'aggregates') = 'array'
      and pg_catalog.jsonb_array_length(p_query -> 'aggregates') > 0)
$function$;

alter function vortex_record.module_query_grouped_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_grouped_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_grouped_internal(jsonb) is
  'Adapter-only test whether a resolved Module query groups or totals its records, so a plain row, exact or tree read refuses it before any storage or access is bound.';
