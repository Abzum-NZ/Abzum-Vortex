CREATE FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, organization_id uuid, role_assignment_id uuid, role_id uuid, assignee_kind text, organization_account_id uuid, group_id uuid, assignment_kind text, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(
      p_operation, p_organization_id, p_role_assignment_id,
      p_expected_assignment_revision, p_role_id, p_expected_role_revision,
      p_assignee_kind, p_organization_account_id, p_group_id,
      p_assignment_kind, p_starts_at, p_expires_at, p_changed_by,
      p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    changed.organization_id
  );

  return query select changed.outcome, changed.operation,
    changed.organization_id, changed.role_assignment_id, changed.role_id,
    changed.assignee_kind, changed.organization_account_id, changed.group_id,
    changed.assignment_kind, changed.revision, changed.starts_at,
    changed.expires_at, changed.state, changed.granted_by_actor_id,
    changed.granted_at, changed.grant_correlation_id,
    changed.changed_by_actor_id, changed.changed_at,
    changed.change_correlation_id, changed.revoked_by_actor_id,
    changed.revoked_at, changed.revocation_correlation_id,
    changed.access_version, changed.correlation_id;
end
$$;


ALTER FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_role_assignment_change(p_operation text, p_organization_id uuid, p_role_assignment_id uuid, p_expected_assignment_revision bigint, p_role_id uuid, p_expected_role_revision bigint, p_assignee_kind text, p_organization_account_id uuid, p_group_id uuid, p_assignment_kind text, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;
