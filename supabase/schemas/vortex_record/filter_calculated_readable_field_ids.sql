CREATE FUNCTION vortex_record.filter_calculated_readable_field_ids(p_record_types jsonb, p_record_type_id uuid, p_readable_field_ids jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  record_type_value jsonb;
  field_value jsonb;
  field_id text;
  dependency_id text;
  readable_ids text[] := array[]::text[];
  allowed_ids text[] := array[]::text[];
  changed boolean := true;
  dependencies_allowed boolean;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_record_types) <> 'array'
    or pg_catalog.jsonb_typeof(p_readable_field_ids) <> 'array' then
    return '[]'::jsonb;
  end if;

  select item.value into record_type_value
  from pg_catalog.jsonb_array_elements(p_record_types) as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if record_type_value is null
    or pg_catalog.jsonb_typeof(record_type_value -> 'fields') <> 'array' then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.array_agg(pg_catalog.lower(item.value #>> '{}')),
    array[]::text[])
  into readable_ids
  from pg_catalog.jsonb_array_elements(p_readable_field_ids) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'string';

  -- Ordinary fields keep their already-authorized visibility. Calculated fields
  -- are added only after every declared source is already visible.
  for field_value in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
  loop
    field_id := pg_catalog.lower(field_value ->> 'fieldId');
    if field_value ->> 'type' <> 'calculation'
      and field_id = any (readable_ids) then
      allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
    end if;
  end loop;

  while changed loop
    changed := false;
    for field_value in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      where item.value ->> 'type' = 'calculation'
    loop
      field_id := pg_catalog.lower(field_value ->> 'fieldId');
      if field_id <> all (readable_ids) or field_id = any (allowed_ids) then
        continue;
      end if;
      dependencies_allowed := true;
      for dependency_id in
        select pg_catalog.lower(item.value #>> '{}')
        from pg_catalog.jsonb_array_elements(
          coalesce(field_value -> 'settings' -> 'dependencyFieldIds', '[]'::jsonb)
        ) as item(value)
      loop
        if dependency_id <> all (allowed_ids) then
          dependencies_allowed := false;
          exit;
        end if;
      end loop;
      if dependencies_allowed then
        allowed_ids := pg_catalog.array_append(allowed_ids, field_id);
        changed := true;
      end if;
    end loop;
  end loop;

  return coalesce((
    select pg_catalog.jsonb_agg(item.value order by item.ordinality)
    from pg_catalog.jsonb_array_elements(p_readable_field_ids)
      with ordinality as item(value, ordinality)
    where pg_catalog.jsonb_typeof(item.value) = 'string'
      and pg_catalog.lower(item.value #>> '{}') = any (allowed_ids)
  ), '[]'::jsonb);
end
$$;
alter function vortex_record.filter_calculated_readable_field_ids(jsonb,uuid,jsonb) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.filter_calculated_readable_field_ids(p_record_types jsonb, p_record_type_id uuid, p_readable_field_ids jsonb) FROM PUBLIC;
