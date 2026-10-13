CREATE FUNCTION vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, application_root_id uuid, registration_state text, registration_revision bigint, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_application_access_without_stewardship_v1_internal(
      p_operation, p_expected_revision, p_prepared_templates,
      p_organization_id, p_application_root_id, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.application_root_id,
    changed.registration_state, changed.registration_revision,
    changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only atomic application-access composition guarded by the adopted organisation stewardship invariant.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_application_access_change(p_operation text, p_expected_revision bigint, p_prepared_templates jsonb, p_organization_id uuid, p_application_root_id uuid, p_changed_by uuid, p_correlation_id uuid) to postgres;
