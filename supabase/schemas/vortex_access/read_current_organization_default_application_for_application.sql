CREATE FUNCTION vortex_access.read_current_organization_default_application_for_application() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  selected_application_root_id uuid;
begin
  context_value := vortex_access.validated_human_request_context();
  select settings.default_application_root_id into selected_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = (context_value ->> 'organizationId')::uuid;
  return selected_application_root_id;
end
$$;

alter function vortex_access.read_current_organization_default_application_for_application() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.read_current_organization_default_application_for_application() IS 'Reads only the exact default application root of the validated human organisation context; absence is null and does not grant application access.';

REVOKE ALL ON FUNCTION vortex_access.read_current_organization_default_application_for_application() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_current_organization_default_application_for_application() TO vortex_request;

grant execute on function vortex_access.read_current_organization_default_application_for_application() to postgres;
