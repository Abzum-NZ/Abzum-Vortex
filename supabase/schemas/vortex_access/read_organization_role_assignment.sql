CREATE FUNCTION vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid) RETURNS TABLE(organization_id uuid, role_assignment_id uuid, role_id uuid, assignee_kind text, organization_account_id uuid, group_id uuid, assignment_kind text, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, effective_state text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select assignment.organization_id, assignment.role_assignment_id,
    assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state, assignment.granted_by,
    assignment.granted_at, assignment.grant_correlation_id,
    assignment.changed_by, assignment.changed_at,
    assignment.change_correlation_id, assignment.revoked_by,
    assignment.revoked_at, assignment.revocation_correlation_id,
    case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > clock.checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_role_assignments as assignment
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where assignment.organization_id = p_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
$$;

ALTER FUNCTION vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid) IS 'Owner-only exact assignment fact read with database-time temporal status, not an access decision.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_role_assignment(p_organization_id uuid, p_role_assignment_id uuid) FROM PUBLIC;
