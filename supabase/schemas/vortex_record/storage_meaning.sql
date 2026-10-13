CREATE FUNCTION vortex_record.storage_meaning(p_record_type jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type -> 'recordTypeId',
    'storageContractId', p_record_type -> 'storageContractId',
    'storageScope', p_record_type -> 'storageScope',
    'ownershipMode', p_record_type -> 'ownershipMode',
    'fields', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'fieldId', field.value -> 'fieldId',
        'type', field.value -> 'type',
        'required', field.value -> 'required',
        'unique', field.value -> 'unique',
        'filterable', field.value -> 'filterable',
        'sortable', field.value -> 'sortable',
        'settings', field.value -> 'settings'
      ) order by field.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(relationship.value order by relationship.value ->> 'relationshipId')
      from pg_catalog.jsonb_array_elements(p_record_type -> 'relationships') as relationship(value)
    ), '[]'::jsonb)
  )
$$;
alter function vortex_record.storage_meaning(jsonb) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.storage_meaning(p_record_type jsonb) FROM PUBLIC;
