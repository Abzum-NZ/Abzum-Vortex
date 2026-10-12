CREATE FUNCTION vortex_record.is_lifecycle_action_list(p_values text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(
    p_values is not null
    and pg_catalog.array_ndims(p_values) = 1
    and pg_catalog.cardinality(p_values) > 0
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or item.value <> all (array['delete', 'archive_workflow']::text[])
    )
    and pg_catalog.cardinality(p_values) = (
      select pg_catalog.count(distinct item.value)
      from pg_catalog.unnest(p_values) as item(value)
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION vortex_record.is_lifecycle_action_list(p_values text[]) FROM PUBLIC;
