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
  -- A value written with a year from 0003 to 9996 sits more than a year from both limits of
  -- the supported year domain, which no unit or zone offset can bridge, so it takes the
  -- plain key. Every other value (canonical values and selectors carry a four-digit year)
  -- goes through the one exact domain check, which raises V3187 for an out-of-range bucket.
  -- A flat expression keeps the per-candidate path as cheap as before the domain existed.
  select case
    when p_bucket is null or p_value is null or p_value = 'null'::jsonb then p_value
    when p_field_type not in ('date', 'date_time') then p_value
    when pg_catalog.substr(p_value #>> '{}', 1, 4) collate "C" not between '0003' and '9996'
      then vortex_record.date_bucket_checked_key_internal(p_value, p_field_type, p_bucket)
    when p_field_type = 'date' then pg_catalog.to_jsonb(pg_catalog.to_char(
      pg_catalog.date_trunc(p_bucket ->> 'unit', (p_value #>> '{}')::pg_catalog.date::pg_catalog.timestamp),
      'YYYY-MM-DD'
    ))
    else pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(
      pg_catalog.date_trunc(p_bucket ->> 'unit', (p_value #>> '{}')::pg_catalog.timestamptz, p_bucket ->> 'timeZone')
    ))
  end
$function$;

alter function vortex_record.grouping_value_internal(jsonb,text,jsonb) owner to vortex_owner;
revoke all on function vortex_record.grouping_value_internal(jsonb,text,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.grouping_value_internal(jsonb,text,jsonb) to vortex_record_adapter;

comment on function vortex_record.grouping_value_internal(jsonb,text,jsonb) is
  'One canonical date bucket value shared by protected summaries and member checks. Date-only values retain calendar dates; instants truncate in the explicitly validated authored zone and return canonical UTC. A bucket outside the supported year domain raises SQLSTATE V3187 (never null, never a clamped key); callers return the value_out_of_range refusal.';
