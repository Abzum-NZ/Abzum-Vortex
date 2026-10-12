CREATE FUNCTION vortex_record.field_storage_meaning(p_field jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field -> 'fieldId',
    'type', p_field -> 'type',
    'required', p_field -> 'required',
    'unique', p_field -> 'unique',
    'filterable', p_field -> 'filterable',
    'sortable', p_field -> 'sortable',
    'settings', p_field -> 'settings'
  )
$$;

REVOKE ALL ON FUNCTION vortex_record.field_storage_meaning(p_field jsonb) FROM PUBLIC;
