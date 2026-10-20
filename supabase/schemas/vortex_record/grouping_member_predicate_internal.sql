create or replace function vortex_record.grouping_member_predicate_internal(
  p_column text,
  p_storage_type text,
  p_field_type text,
  p_grouping jsonb,
  p_value jsonb
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  bucket jsonb := p_grouping -> 'dateBucket';
  start_date date;
  end_date date;
  start_instant timestamptz;
  end_instant timestamptz;
begin
  if not (case p_field_type
    when 'choice' then p_storage_type = 'text'
    when 'date' then p_storage_type = 'date'
    when 'date_time' then p_storage_type = 'timestamp_with_time_zone'
    else false end) then return null; end if;
  if p_value = 'null'::jsonb then
    return pg_catalog.format('stored.%I is null', p_column);
  end if;
  -- Only canonical bucket starts may select members. The upper bound is the next
  -- local calendar boundary, so a DST day can contain 23 or 25 hours.
  if vortex_record.grouping_value_internal(p_value, p_field_type, bucket) is distinct from p_value then
    return null;
  end if;
  if p_field_type = 'choice' then
    return pg_catalog.format('stored.%I collate "C" = %L collate "C"', p_column, p_value #>> '{}');
  end if;
  if p_field_type = 'date' then
    start_date := (p_value #>> '{}')::date;
    end_date := (start_date::timestamp + (case when bucket ->> 'unit' = 'quarter' then '3 months' else '1 ' || (bucket ->> 'unit') end)::interval)::date;
    return pg_catalog.format('stored.%I >= %L::date and stored.%I < %L::date',
      p_column, start_date, p_column, end_date);
  end if;
  start_instant := (p_value #>> '{}')::timestamptz;
  end_instant := (pg_catalog.date_trunc(bucket ->> 'unit', start_instant at time zone (bucket ->> 'timeZone'))
    + (case when bucket ->> 'unit' = 'quarter' then '3 months' else '1 ' || (bucket ->> 'unit') end)::interval) at time zone (bucket ->> 'timeZone');
  -- A repeated local midnight resolves to its later instant. Keep the indexable
  -- range broad enough for both occurrences, then match the exact bucket before
  -- the candidate page budget is applied. The readable projection is rechecked.
  return pg_catalog.format(
    'stored.%I >= %L::timestamptz and stored.%I < %L::timestamptz and pg_catalog.date_trunc(%L, stored.%I, %L) = %L::timestamptz',
    p_column, start_instant - interval '24 hours',
    p_column, end_instant + interval '24 hours',
    bucket ->> 'unit', p_column, bucket ->> 'timeZone', start_instant);
end
$function$;

alter function vortex_record.grouping_member_predicate_internal(text,text,text,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.grouping_member_predicate_internal(text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.grouping_member_predicate_internal(text,text,text,jsonb,jsonb) to vortex_record_adapter;

comment on function vortex_record.grouping_member_predicate_internal(text,text,text,jsonb,jsonb) is
  'Protected group member scan predicate over a validated stored field and selector. Date buckets use typed half-open calendar ranges suitable for storage indexes, with local DST-aware upper boundaries and an exact projection recheck by the reader.';
