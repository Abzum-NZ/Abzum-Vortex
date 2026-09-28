create or replace function vortex_context.format_timestamp_utc(p_value timestamptz)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.to_char(
    pg_catalog.timezone('UTC', p_value), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
$function$;

revoke execute on function vortex_context.format_timestamp_utc(timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_context.format_timestamp_utc(timestamptz)
  to vortex_record_owner, vortex_record_adapter, vortex_module_owner,
    vortex_event_owner;

comment on function vortex_context.format_timestamp_utc(timestamptz) is
  'Formats one timestamp as a UTC ISO-8601 text value with six fractional digits.';
