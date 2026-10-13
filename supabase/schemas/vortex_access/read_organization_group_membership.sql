CREATE FUNCTION vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) RETURNS TABLE(organization_id uuid, membership_id uuid, group_id uuid, organization_account_id uuid, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, effective_state text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select membership.organization_id, membership.membership_id,
    membership.group_id, membership.organization_account_id,
    membership.revision, membership.starts_at, membership.expires_at,
    membership.state, membership.granted_by, membership.granted_at,
    membership.grant_correlation_id, membership.changed_by,
    membership.changed_at, membership.change_correlation_id,
    membership.revoked_by, membership.revoked_at,
    membership.revocation_correlation_id,
    case
      when membership.state = 'revoked' then 'revoked'
      when membership.starts_at > clock.checked_at then 'scheduled'
      when membership.expires_at is not null
        and membership.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_group_memberships as membership
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where membership.organization_id = p_organization_id
    and membership.membership_id = p_membership_id
$$;

alter function vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) IS 'Owner-only exact membership fact read with database-time temporal status.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) FROM PUBLIC;

grant execute on function vortex_access.read_organization_group_membership(p_organization_id uuid, p_membership_id uuid) to postgres;
