CREATE FUNCTION vortex_access.read_current_organization_runtime_settings_for_application() RETURNS TABLE(organization_id uuid, language text, time_zone text, currency text, date_format text, number_format text, revision bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return query
  select * from vortex_identity.read_current_organization_runtime_settings_internal(
    (context_value ->> 'organizationId')::uuid
  );
end
$$;


ALTER FUNCTION vortex_access.read_current_organization_runtime_settings_for_application() OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_current_organization_runtime_settings_for_application() IS 'Narrow request-role reader for an already-authorised application transaction; it reads only its established organisation and returns absence when setup is incomplete.';

REVOKE ALL ON FUNCTION vortex_access.read_current_organization_runtime_settings_for_application() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_current_organization_runtime_settings_for_application() TO vortex_request;
