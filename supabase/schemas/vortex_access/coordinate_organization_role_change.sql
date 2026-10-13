CREATE FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, role jsonb, created_activation_policy jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_role_change_without_stewardship_v1_internal(
      p_evidence, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.role ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation, changed.role,
    changed.created_activation_policy, changed.access_version,
    changed.correlation_id;
end
$$;

ALTER FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_role_change(p_evidence jsonb, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;
