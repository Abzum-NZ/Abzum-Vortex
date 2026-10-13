CREATE OR REPLACE FUNCTION vortex_platform.read_file_application(p_file_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  located_application_root_id uuid;
begin
  if p_file_id is null
    or p_file_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  select stored.application_root_id into located_application_root_id
  from vortex_platform.file_records as stored
  where stored.file_id = p_file_id
    and stored.lifecycle_state = 'active'
    and stored.owner_record_id is not null;
  if not found or located_application_root_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'located',
    'applicationRootId', located_application_root_id
  );
end
$$;

ALTER FUNCTION vortex_platform.read_file_application(p_file_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_platform.read_file_application(p_file_id uuid) IS 'Locates the application of an active attached file of the request organisation.';

REVOKE ALL ON FUNCTION vortex_platform.read_file_application(p_file_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_platform.read_file_application(p_file_id uuid) TO vortex_request;
