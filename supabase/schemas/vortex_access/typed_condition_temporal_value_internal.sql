create or replace function vortex_access.typed_condition_temporal_value_internal(
  p_value text,
  p_kind text
)
returns bigint
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  parts text[];
  year_value integer;
  month_value integer;
  day_value integer;
  hour_value integer := 0;
  minute_value integer := 0;
  second_value integer := 0;
  fraction_value bigint := 0;
  offset_minutes integer := 0;
  leap_year boolean;
  maximum_day integer;
  month_offsets integer[] := array[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  day_ordinal bigint;
begin
  if p_kind = 'date' then
    parts := pg_catalog.regexp_match(p_value, '^([0-9]{4})-([0-9]{2})-([0-9]{2})$');
  elsif p_kind = 'date_time' then
    parts := pg_catalog.regexp_match(
      p_value,
      '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})([.]([0-9]{1,6}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$'
    );
  else
    return null;
  end if;

  if parts is null then
    return null;
  end if;

  year_value := parts[1]::integer;
  month_value := parts[2]::integer;
  day_value := parts[3]::integer;
  leap_year := year_value % 4 = 0 and (year_value % 100 <> 0 or year_value % 400 = 0);

  if month_value not between 1 and 12 then
    return null;
  end if;
  maximum_day := case month_value
    when 2 then case when leap_year then 29 else 28 end
    when 4 then 30
    when 6 then 30
    when 9 then 30
    when 11 then 30
    else 31
  end;
  if day_value not between 1 and maximum_day then
    return null;
  end if;

  day_ordinal := year_value::bigint * 365
    + (year_value + 3) / 4
    - (year_value + 99) / 100
    + (year_value + 399) / 400
    + month_offsets[month_value]
    + case when leap_year and month_value > 2 then 1 else 0 end
    + day_value - 1;

  if p_kind = 'date' then
    return day_ordinal;
  end if;

  hour_value := parts[4]::integer;
  minute_value := parts[5]::integer;
  second_value := parts[6]::integer;
  if hour_value > 23 or minute_value > 59 or second_value > 59 then
    return null;
  end if;
  if parts[8] is not null then
    fraction_value := pg_catalog.rpad(parts[8], 6, '0')::bigint;
  end if;
  if parts[9] <> 'Z' then
    if parts[11]::integer > 23 or parts[12]::integer > 59 then
      return null;
    end if;
    offset_minutes := (parts[11]::integer * 60 + parts[12]::integer)
      * case parts[10] when '+' then 1 else -1 end;
  end if;

  return day_ordinal * 86400000000::bigint
    + hour_value::bigint * 3600000000::bigint
    + minute_value::bigint * 60000000::bigint
    + second_value::bigint * 1000000::bigint
    + fraction_value
    - offset_minutes::bigint * 60000000::bigint;
end
$function$;

comment on function vortex_access.typed_condition_temporal_value_internal(text,text) is null;

alter function vortex_access.typed_condition_temporal_value_internal(text,text) owner to postgres;

revoke execute on function vortex_access.typed_condition_temporal_value_internal(text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.typed_condition_temporal_value_internal(text,text) to vortex_access_owner;
