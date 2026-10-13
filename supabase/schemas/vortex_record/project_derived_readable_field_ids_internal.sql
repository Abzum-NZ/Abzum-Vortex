CREATE FUNCTION vortex_record.project_derived_readable_field_ids_internal(p_loaded jsonb, p_record_type_id uuid, p_record_id uuid, p_readable_field_ids jsonb, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  field_value jsonb;
  candidate_readable_field_ids jsonb := p_readable_field_ids;
  required_field_ids text[] := array[]::text[];
  total_field_id text;
  derived_field_key text;
  inputs_readable boolean;
begin
  if p_record_type_id is null or p_record_id is null
    or pg_catalog.jsonb_typeof(p_loaded -> 'facts' -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_readable_field_ids) <> 'array'
    or pg_catalog.jsonb_typeof(p_required_field_ids) <> 'array'
    or pg_catalog.jsonb_typeof(p_seen_derived_field_keys) <> 'array' then
    return null;
  end if;
  -- Only totals named by the source aggregate/filter fields, or by a declared
  -- calculation dependency of those fields, are traversed.  This avoids an
  -- unrelated total turning a finite self relationship into a false cycle.
  select coalesce(pg_catalog.array_agg(distinct needed.field_id), array[]::text[])
  into required_field_ids
  from (
    with recursive needed(field_id) as (
      select pg_catalog.lower(item.value)
      from pg_catalog.jsonb_array_elements_text(p_required_field_ids) as item(value)
      union
      select pg_catalog.lower(dependency.value)
      from needed
      join pg_catalog.jsonb_array_elements(p_loaded -> 'facts' -> 'recordTypes') as record_type(value)
        on pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
      cross join lateral pg_catalog.jsonb_array_elements_text(
        coalesce(field.value -> 'settings' -> 'dependencyFieldIds', '[]'::jsonb)
      ) as dependency(value)
      where field.value ->> 'type' = 'calculation'
        and pg_catalog.lower(field.value ->> 'fieldId') = needed.field_id
    ) select field_id from needed
  ) as needed;
  for field_value in
    select field.value
    from pg_catalog.jsonb_array_elements(p_loaded -> 'facts' -> 'recordTypes') as record_type(value)
    cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
    where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
      and field.value ->> 'type' = 'total'
  loop
    total_field_id := pg_catalog.lower(field_value ->> 'fieldId');
    if total_field_id <> all(required_field_ids)
      or not exists (
        select 1 from pg_catalog.jsonb_array_elements_text(p_readable_field_ids) as item(value)
        where pg_catalog.lower(item.value) = total_field_id
      ) then
      continue;
    end if;
    derived_field_key := pg_catalog.lower(p_record_type_id::text) || ':'
      || pg_catalog.lower(p_record_id::text) || ':' || total_field_id;
    inputs_readable := not exists (
      select 1 from pg_catalog.jsonb_array_elements_text(p_seen_derived_field_keys) as key(value)
      where key.value = derived_field_key
    ) and vortex_record.total_inputs_readable_internal(
      p_loaded, p_record_type_id, p_record_id, field_value,
      p_seen_derived_field_keys || pg_catalog.jsonb_build_array(derived_field_key)
    );
    if not inputs_readable then
      candidate_readable_field_ids := coalesce((
        select pg_catalog.jsonb_agg(item.value order by item.ordinality)
        from pg_catalog.jsonb_array_elements(candidate_readable_field_ids)
          with ordinality as item(value, ordinality)
        where pg_catalog.lower(item.value #>> '{}') <> total_field_id
      ), '[]'::jsonb);
    end if;
  end loop;
  -- Existing calculation disclosure is the sole fixed-point evaluator.  A
  -- failed total is removed before it becomes one of that evaluator's seeds.
  return vortex_record.filter_calculated_readable_field_ids(
    p_loaded -> 'facts' -> 'recordTypes', p_record_type_id,
    candidate_readable_field_ids
  );
end
$$;
alter function vortex_record.project_derived_readable_field_ids_internal(jsonb,uuid,uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.project_derived_readable_field_ids_internal(p_loaded jsonb, p_record_type_id uuid, p_record_id uuid, p_readable_field_ids jsonb, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) FROM PUBLIC;
