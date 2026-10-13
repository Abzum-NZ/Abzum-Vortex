CREATE FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
      loaded -> 'facts' -> 'recordTypes', p_record_type_id,
      bounds -> 'readableFieldIds'
    )
  );
  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
  loop
    if loaded -> 'columns' ? field_id and loaded -> 'fieldValues' ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, loaded -> 'fieldValues' -> field_id
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber',
    'values', values_value,
    'correlationId', loaded -> 'context' -> 'correlationId',
    'backgroundDelivery', 'pending', 'replayed', true
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$$;
alter function vortex_record.project_named_action_record_internal(text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) FROM PUBLIC;
