CREATE OR REPLACE FUNCTION vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid) RETURNS TABLE(organization_id uuid, delegation_authority_id uuid, holder_kind text, organization_account_id uuid, group_id uuid, scope jsonb, revision bigint, starts_at timestamp with time zone, expires_at timestamp with time zone, state text, granted_by_actor_id uuid, granted_at timestamp with time zone, grant_correlation_id uuid, changed_by_actor_id uuid, changed_at timestamp with time zone, change_correlation_id uuid, revoked_by_actor_id uuid, revoked_at timestamp with time zone, revocation_correlation_id uuid, effective_state text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select delegation.organization_id, delegation.delegation_authority_id,
    delegation.holder_kind, delegation.organization_account_id,
    delegation.group_id,
    case delegation.scope_kind
      when 'organization_catalogue' then
        pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      when 'bounded' then pg_catalog.jsonb_build_object(
        'kind', 'bounded',
        'permissions', delegation.bounded_permissions
      )
    end,
    delegation.revision, delegation.starts_at, delegation.expires_at,
    delegation.state, delegation.granted_by, delegation.granted_at,
    delegation.grant_correlation_id, delegation.changed_by,
    delegation.changed_at, delegation.change_correlation_id,
    delegation.revoked_by, delegation.revoked_at,
    delegation.revocation_correlation_id,
    case
      when delegation.state = 'revoked' then 'revoked'
      when delegation.starts_at > clock.checked_at then 'scheduled'
      when delegation.expires_at is not null
        and delegation.expires_at <= clock.checked_at then 'expired'
      else 'active'
    end
  from vortex_access.organization_delegation_authorities as delegation
  cross join (
    select pg_catalog.statement_timestamp() as checked_at
  ) as clock
  where delegation.organization_id = p_organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id
$$;

ALTER FUNCTION vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid) IS 'Owner-only exact delegation fact read with database-time temporal status, not an access decision.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_delegation_authority(p_organization_id uuid, p_delegation_authority_id uuid) FROM PUBLIC;
