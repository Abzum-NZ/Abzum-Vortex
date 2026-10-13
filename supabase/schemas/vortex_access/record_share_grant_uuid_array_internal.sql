CREATE FUNCTION vortex_access.record_share_grant_uuid_array_internal(p_value jsonb, p_minimum integer, p_maximum integer) RETURNS uuid[]
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  parsed uuid[];
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into parsed
  from pg_catalog.jsonb_array_elements_text(p_value) with ordinality as item(value, ordinality);
  if pg_catalog.cardinality(parsed) not between p_minimum and p_maximum
    or (select pg_catalog.count(distinct element) from pg_catalog.unnest(parsed) as element)
      <> pg_catalog.cardinality(parsed)
    or '00000000-0000-0000-0000-000000000000'::uuid = any (parsed) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;
  return parsed;
end
$$;

ALTER FUNCTION vortex_access.record_share_grant_uuid_array_internal(p_value jsonb, p_minimum integer, p_maximum integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.record_share_grant_uuid_array_internal(p_value jsonb, p_minimum integer, p_maximum integer) FROM PUBLIC;
