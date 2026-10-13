CREATE FUNCTION vortex_access.change_account_state_without_stewardship_v1_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) RETURNS TABLE(organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  changed record;
  checked jsonb;
  resulting_version bigint;
begin
  checked := vortex_identity.validated_human_account_context();

  select * into changed
  from vortex_identity.change_organization_account_state(
    p_organization_account_id,
    p_expected_revision,
    p_state
  );

  select incremented.current_version into resulting_version
  from vortex_access.increment_organization_access_version(
    changed.organization_id,
    (checked ->> 'organizationAccountId')::uuid,
    (checked ->> 'correlationId')::uuid,
    case changed.state
      when 'active' then 'organization_account_reactivated'
      when 'suspended' then 'organization_account_suspended'
      when 'closed' then 'organization_account_closed'
    end
  ) as incremented;

  return query
  select changed.organization_account_id, changed.organization_id, changed.identity_id,
    changed.display_name, changed.state, changed.language, changed.time_zone,
    changed.invitation_id, changed.activated_at, changed.suspended_at,
    changed.closed_at, changed.changed_at, changed.state_changed_at,
    changed.state_changed_by, changed.state_change_correlation_id,
    changed.revision, resulting_version;
end
$$;

ALTER FUNCTION vortex_access.change_account_state_without_stewardship_v1_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.change_account_state_without_stewardship_v1_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) IS 'Owner-only account lifecycle and Access-version composition reserved for permission-checked administration.';

REVOKE ALL ON FUNCTION vortex_access.change_account_state_without_stewardship_v1_internal(p_organization_account_id uuid, p_expected_revision bigint, p_state text) FROM PUBLIC;
