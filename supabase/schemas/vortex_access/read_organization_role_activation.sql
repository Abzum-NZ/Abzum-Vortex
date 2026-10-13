CREATE FUNCTION vortex_access.read_organization_role_activation(p_organization_id uuid, p_role_activation_id uuid) RETURNS TABLE(organization_id uuid, role_activation_id uuid, organization_account_id uuid, role_id uuid, revision bigint, historical_role_revision bigint, authority_continuity_revision bigint, policy_continuity_revision bigint, activation_policy_id uuid, activation_policy_revision bigint, activation_policy_fingerprint text, eligibility_source_kind text, role_assignment_id uuid, role_assignment_revision bigint, membership_id uuid, membership_revision bigint, state text, activated_by_actor_id uuid, activated_at timestamp with time zone, expires_at timestamp with time zone, activation_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, temporal_state text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select activation.organization_id, activation.role_activation_id,
    activation.organization_account_id, activation.role_id,
    activation.revision, activation.historical_role_revision,
    activation.authority_continuity_revision,
    activation.policy_continuity_revision, activation.activation_policy_id,
    activation.activation_policy_revision,
    activation.activation_policy_fingerprint,
    activation.eligibility_source_kind, activation.role_assignment_id,
    activation.role_assignment_revision, activation.membership_id,
    activation.membership_revision, activation.state,
    activation.activated_by, activation.activated_at, activation.expires_at,
    activation.activation_correlation_id, activation.changed_by,
    activation.changed_at, activation.change_correlation_id,
    activation.revoked_by, activation.revoked_at,
    activation.revocation_correlation_id,
    case
      when activation.state = 'revoked' then 'revoked'
      when activation.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_role_activations as activation
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where activation.organization_id = p_organization_id
    and activation.role_activation_id = p_role_activation_id
$$;

ALTER FUNCTION vortex_access.read_organization_role_activation(p_organization_id uuid, p_role_activation_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_role_activation(p_organization_id uuid, p_role_activation_id uuid) IS 'Owner-only exact activation fact read with database-time temporal status, not an access decision.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_role_activation(p_organization_id uuid, p_role_activation_id uuid) FROM PUBLIC;
