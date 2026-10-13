CREATE FUNCTION vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) RETURNS TABLE(organization_id uuid, outcome text, membership_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  checked_at timestamptz;
  membership_value jsonb;
begin
  if p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_groups_administration_scope() as authorized;

  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'membershipId', membership.membership_id,
    'groupId', membership.group_id,
    'organizationAccountId', membership.organization_account_id,
    'accountDisplayName', account.display_name,
    'revision', membership.revision,
    'startsAt', membership.starts_at,
    'expiresAt', membership.expires_at,
    'state', membership.state,
    'temporalState', case
      when membership.state = 'revoked' then 'revoked'
      when membership.starts_at > checked_at then 'scheduled'
      when membership.expires_at is not null
        and membership.expires_at <= checked_at then 'expired'
      else 'active'
    end
  ))
  into membership_value
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = scope.organization_id
    and membership.membership_id = p_membership_id;

  return query select scope.organization_id,
    case when membership_value is null then 'unavailable' else 'available' end,
    membership_value, scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) IS 'Returns one safe exact membership detail after fixed teams-read authorization; temporal state is descriptive and grants no permission.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_group_membership_for_administration(p_membership_id uuid) TO vortex_request;
