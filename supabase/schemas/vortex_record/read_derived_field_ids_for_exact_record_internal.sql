CREATE FUNCTION vortex_record.read_derived_field_ids_for_exact_record_internal(p_record_type_id uuid, p_record_id uuid, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or pg_catalog.jsonb_typeof(p_required_field_ids) <> 'array'
    or pg_catalog.jsonb_typeof(p_seen_derived_field_keys) <> 'array' then
    return null;
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null, null::jsonb);
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return null;
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return null;
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  return vortex_record.project_derived_readable_field_ids_internal(
    loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds',
    p_required_field_ids, p_seen_derived_field_keys
  );
end
$$;
alter function vortex_record.read_derived_field_ids_for_exact_record_internal(uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.read_derived_field_ids_for_exact_record_internal(p_record_type_id uuid, p_record_id uuid, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) FROM PUBLIC;
