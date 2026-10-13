CREATE FUNCTION vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) RETURNS TABLE(organization_id uuid, outcome text, delegation_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  checked_at timestamptz;
  delegation_value jsonb;
begin
  if p_delegation_authority_id is null
    or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization delegation authority detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'delegationAuthorityId', delegation.delegation_authority_id,
    'holder', case delegation.holder_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', delegation.organization_account_id,
        'displayName', account.display_name
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'groupId', delegation.group_id,
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      )
    end,
    'scope', case delegation.scope_kind
      when 'organization_catalogue' then pg_catalog.jsonb_build_object(
        'kind', 'organization_catalogue'
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'bounded',
        'permissions', (
          select coalesce(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                'applicationRootId', permission.value -> 'applicationRootId',
                'ownerKind', permission.value -> 'ownerKind',
                'ownerId', permission.value -> 'ownerId',
                'permissionId', permission.value -> 'permissionId'
              )) order by permission.ordinality
            ),
            '[]'::jsonb
          )
          from pg_catalog.jsonb_array_elements(delegation.bounded_permissions)
            with ordinality as permission(value, ordinality)
        )
      )
    end,
    'revision', delegation.revision,
    'startsAt', delegation.starts_at,
    'expiresAt', delegation.expires_at,
    'state', delegation.state,
    'temporalState', case
      when delegation.state = 'revoked' then 'revoked'
      when delegation.starts_at > checked_at then 'scheduled'
      when delegation.expires_at is not null
        and delegation.expires_at <= checked_at then 'expired'
      else 'active'
    end
  ))
  into delegation_value
  from vortex_access.organization_delegation_authorities as delegation
  left join vortex_identity.organization_accounts as account
    on delegation.holder_kind = 'organization_account'
    and account.organization_id = delegation.organization_id
    and account.organization_account_id = delegation.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on delegation.holder_kind = 'group'
    and organization_group.organization_id = delegation.organization_id
    and organization_group.group_id = delegation.group_id
  where delegation.organization_id = scope.organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id;

  return query select scope.organization_id,
    case when delegation_value is null then 'unavailable' else 'available' end,
    delegation_value, scope.access_version;
end
$$;

alter function vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) IS 'Returns one safe exact delegation detail without inferring holder authority.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) TO vortex_request;

grant execute on function vortex_access.read_organization_delegation_authority_for_administration(p_delegation_authority_id uuid) to postgres;
