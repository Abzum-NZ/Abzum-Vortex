CREATE FUNCTION vortex_record.append_declared_named_action_occurrences_internal(p_storage_contract_id uuid, p_record_id uuid, p_event_descriptors jsonb, p_occurrence_ids jsonb, p_field_values jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  occurrence_values jsonb := '[]'::jsonb;
  descriptor_value jsonb;
  carried_values jsonb;
  occurrence_id_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_event_descriptors) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_occurrence_ids) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_field_values) is distinct from 'object'
    or pg_catalog.jsonb_array_length(p_event_descriptors) <>
      pg_catalog.jsonb_array_length(p_occurrence_ids)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_occurrence_ids) item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
        or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
        or (item.value #>> '{}')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
    ) then
    raise exception using errcode = '22023',
      message = 'Named action Event occurrence input is invalid';
  end if;
  for descriptor_value, occurrence_id_value in
    select descriptor.value, occurrence.value
    from pg_catalog.jsonb_array_elements(p_event_descriptors)
      with ordinality descriptor(value, ordinal)
    join pg_catalog.jsonb_array_elements(p_occurrence_ids)
      with ordinality occurrence(value, ordinal) using (ordinal)
    order by descriptor.ordinal
  loop
    select coalesce(pg_catalog.jsonb_object_agg(
      pg_catalog.lower(field.value #>> '{}'),
      p_field_values -> pg_catalog.lower(field.value #>> '{}')
    ), '{}'::jsonb)
    into carried_values
    from pg_catalog.jsonb_array_elements(descriptor_value -> 'carriedFieldIds') field(value)
    where p_field_values ? pg_catalog.lower(field.value #>> '{}');
    occurrence_values := occurrence_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'occurrenceId', occurrence_id_value,
        'descriptor', descriptor_value,
        'payload', pg_catalog.jsonb_build_object(
          'kind', 'declared', 'carriedValues', carried_values
        )
      )
    );
  end loop;
  return vortex_event.append_record_occurrences(
    p_storage_contract_id, p_record_id, occurrence_values
  );
end
$$;

REVOKE ALL ON FUNCTION vortex_record.append_declared_named_action_occurrences_internal(p_storage_contract_id uuid, p_record_id uuid, p_event_descriptors jsonb, p_occurrence_ids jsonb, p_field_values jsonb) FROM PUBLIC;
