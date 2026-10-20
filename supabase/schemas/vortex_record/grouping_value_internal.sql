create or replace function vortex_record.grouping_value_internal(
  p_value jsonb,
  p_field_type text,
  p_bucket jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when p_bucket is null or p_value is null or p_value = 'null'::jsonb then p_value
    when p_field_type = 'date' then pg_catalog.to_jsonb(pg_catalog.to_char(
      pg_catalog.date_trunc(p_bucket ->> 'unit', (p_value #>> '{}')::date::timestamp),
      'YYYY-MM-DD'
    ))
    when p_field_type = 'date_time' then pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(
      pg_catalog.date_trunc(p_bucket ->> 'unit', (p_value #>> '{}')::timestamptz, p_bucket ->> 'timeZone')
    ))
    else p_value
  end
$function$;

alter function vortex_record.grouping_value_internal(jsonb,text,jsonb) owner to vortex_owner;
revoke all on function vortex_record.grouping_value_internal(jsonb,text,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.grouping_value_internal(jsonb,text,jsonb) to vortex_record_adapter;

comment on function vortex_record.grouping_value_internal(jsonb,text,jsonb) is
  'One canonical date bucket value shared by protected summaries and member checks. Date-only values retain calendar dates; instants truncate in the explicitly validated authored zone and return canonical UTC.';
