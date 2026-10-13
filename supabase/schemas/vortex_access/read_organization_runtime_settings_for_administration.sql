CREATE FUNCTION vortex_access.read_organization_runtime_settings_for_administration() RETURNS TABLE(organization_id uuid, outcome text, settings jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  projected record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  select result.* into projected
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope.organization_id
  ) as result;

  return query select scope.organization_id,
    case when projected.organization_id is null then 'unavailable' else 'available' end,
    case when projected.organization_id is null then null else
      pg_catalog.jsonb_build_object(
        'organizationId', projected.organization_id,
        'language', projected.language,
        'timeZone', projected.time_zone,
        'currency', projected.currency,
        'dateFormat', projected.date_format,
        'numberFormat', projected.number_format,
        'revision', projected.revision
      )
    end,
    scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.read_organization_runtime_settings_for_administration() OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_runtime_settings_for_administration() IS 'Protected explicit-presence runtime-settings read under the fixed runtime_settings.read decision.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_runtime_settings_for_administration() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_runtime_settings_for_administration() TO vortex_request;
