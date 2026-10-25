create or replace function vortex_record.date_bucket_checked_key_internal(
  p_value jsonb,
  p_field_type text,
  p_bucket jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  bucket_start timestamptz;
  local_start timestamp;
  zone text := case when p_field_type = 'date' then 'UTC' else p_bucket ->> 'timeZone' end;
begin
  -- The single date bucket domain check. It mirrors the canonical instant/date domain the
  -- TypeScript contract uses: the bucket starts in common-era UTC year 0001 or later (a BC
  -- start would print as a misleading common-era key) and its exclusive end is before UTC
  -- year 10000. Date buckets are evaluated as UTC midnights in the zone UTC.
  if p_field_type = 'date' then
    local_start := pg_catalog.date_trunc(p_bucket ->> 'unit', (p_value #>> '{}')::pg_catalog.date::pg_catalog.timestamp);
    bucket_start := pg_catalog.timezone('UTC', local_start);
  else
    bucket_start := pg_catalog.date_trunc(p_bucket ->> 'unit', (p_value #>> '{}')::pg_catalog.timestamptz, zone);
  end if;
  if bucket_start < '0001-01-01 00:00:00+00'::pg_catalog.timestamptz
    or vortex_record.date_bucket_end_internal(bucket_start, p_bucket ->> 'unit', zone)
      >= '10000-01-01 00:00:00+00'::pg_catalog.timestamptz then
    -- Callers translate this SQLSTATE into the typed value_out_of_range refusal.
    raise exception using errcode = 'V3187', message = 'Date bucket is outside the supported year range';
  end if;
  return case when p_field_type = 'date'
    then pg_catalog.to_jsonb(pg_catalog.to_char(local_start, 'YYYY-MM-DD'))
    else pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(bucket_start)) end;
end
$function$;

alter function vortex_record.date_bucket_checked_key_internal(jsonb,text,jsonb) owner to vortex_owner;
revoke all on function vortex_record.date_bucket_checked_key_internal(jsonb,text,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.date_bucket_checked_key_internal(jsonb,text,jsonb) to vortex_record_adapter;

comment on function vortex_record.date_bucket_checked_key_internal(jsonb,text,jsonb) is
  'The canonical date bucket key after the exact year-domain check: raises SQLSTATE V3187 when the bucket starts before common-era UTC year 0001 or ends after UTC year 9999. grouping_value_internal calls it only for values near a domain edge.';
