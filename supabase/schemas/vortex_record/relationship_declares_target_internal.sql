CREATE FUNCTION vortex_record.relationship_declares_target_internal(p_relationship jsonb, p_record_type_id uuid) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select p_record_type_id is not null and exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(p_relationship -> 'toRecordType') = 'object'
          then pg_catalog.jsonb_build_array(p_relationship -> 'toRecordType')
        when pg_catalog.jsonb_typeof(p_relationship -> 'toRecordTypes') = 'array'
          then p_relationship -> 'toRecordTypes'
        else '[]'::jsonb
      end
    ) as target(value)
    where pg_catalog.lower(target.value ->> 'recordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  )
$$;
alter function vortex_record.relationship_declares_target_internal(jsonb,uuid) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.relationship_declares_target_internal(p_relationship jsonb, p_record_type_id uuid) IS 'True only when a concrete record type is one of a relationship''s declared targets: its single toRecordType or a member of its toRecordTypes list.';

REVOKE ALL ON FUNCTION vortex_record.relationship_declares_target_internal(p_relationship jsonb, p_record_type_id uuid) FROM PUBLIC;
