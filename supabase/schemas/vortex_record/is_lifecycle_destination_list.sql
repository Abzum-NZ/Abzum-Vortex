CREATE FUNCTION vortex_record.is_lifecycle_destination_list(p_values text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(
    p_values is not null
    and (
      pg_catalog.cardinality(p_values) = 0
      or pg_catalog.array_ndims(p_values) = 1
    )
    and not exists (
      select 1
      from pg_catalog.unnest(p_values) as item(value)
      where item.value is null
        or not vortex_record.is_lifecycle_destination(item.value)
    ),
    false
  );
$$;
alter function vortex_record.is_lifecycle_destination_list(text[]) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.is_lifecycle_destination_list(p_values text[]) FROM PUBLIC;
