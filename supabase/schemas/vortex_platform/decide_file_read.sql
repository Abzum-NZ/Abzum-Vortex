CREATE OR REPLACE FUNCTION vortex_platform.decide_file_read(p_file_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  stored_organization_id uuid;
  stored_application_root_id uuid;
  stored_record_type_id uuid;
  stored_record_id uuid;
  stored_field_id uuid;
  stored_lifecycle_state text;
  stored_scanner_result text;
  projection jsonb;
  attached jsonb;
begin
  if p_file_id is null
    or p_file_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  select stored.organization_id, stored.application_root_id,
    stored.owner_record_type_id, stored.owner_record_id, stored.owner_field_id,
    stored.lifecycle_state, stored.scanner_result
  into stored_organization_id, stored_application_root_id,
    stored_record_type_id, stored_record_id, stored_field_id,
    stored_lifecycle_state, stored_scanner_result
  from vortex_platform.file_records as stored
  where stored.file_id = p_file_id;
  if not found
    or stored_record_id is null
    or stored_lifecycle_state <> 'active'
    or stored_scanner_result <> 'clean' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  projection := vortex_record.read_record(stored_record_type_id, stored_record_id);
  if projection ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  attached := projection -> 'values' -> (stored_field_id::text);
  if pg_catalog.jsonb_typeof(attached) is distinct from 'array'
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(attached) as member(value)
      where pg_catalog.jsonb_typeof(member.value) = 'string'
        and pg_catalog.lower(member.value #>> '{}') = p_file_id::text
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'organizationId', stored_organization_id,
    'applicationRootId', stored_application_root_id,
    'recordTypeId', stored_record_type_id,
    'recordId', stored_record_id,
    'fieldId', stored_field_id
  ));
end
$$;

alter function vortex_platform.decide_file_read(p_file_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_platform.decide_file_read(p_file_id uuid) IS 'Decides current read authority for a file through the protected record read and the attachment value that names it.';

REVOKE ALL ON FUNCTION vortex_platform.decide_file_read(p_file_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_platform.decide_file_read(p_file_id uuid) TO vortex_request;

grant execute on function vortex_platform.decide_file_read(p_file_id uuid) to postgres;
