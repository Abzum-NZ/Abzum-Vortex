create or replace function vortex_record.date_bucket_end_internal(
  p_start timestamptz,
  p_unit text,
  p_zone text
)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $function$
  -- The exclusive upper bound is the next local calendar boundary in the bucket's zone
  -- (date buckets use UTC), so a DST day can contain 23 or 25 hours.
  select pg_catalog.timezone(p_zone,
    pg_catalog.date_trunc(p_unit, pg_catalog.timezone(p_zone, p_start))
      + (case when p_unit = 'quarter' then '3 months' else '1 ' || p_unit end)::pg_catalog.interval)
$function$;

alter function vortex_record.date_bucket_end_internal(timestamptz,text,text) owner to vortex_owner;
revoke all on function vortex_record.date_bucket_end_internal(timestamptz,text,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.date_bucket_end_internal(timestamptz,text,text) to vortex_record_adapter;

comment on function vortex_record.date_bucket_end_internal(timestamptz,text,text) is
  'Exclusive upper bound of the date bucket that starts at one instant: the next calendar boundary of the unit in the bucket zone.';
