CREATE FUNCTION vortex_access.project_organization_delegation_summary(p_organization_id uuid, p_delegation_authority_id uuid) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'delegationAuthorityId', delegation.delegation_authority_id,
    'holder', case delegation.holder_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', delegation.organization_account_id,
        'displayName', account.display_name)
      else pg_catalog.jsonb_build_object('kind', 'group',
        'groupId', delegation.group_id, 'key', organization_group.group_key,
        'label', organization_group.label, 'state', organization_group.state) end,
    'scope', case delegation.scope_kind
      when 'organization_catalogue' then pg_catalog.jsonb_build_object(
        'kind', 'organization_catalogue')
      else pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions',
        (select pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'applicationRootId', permission.value -> 'applicationRootId',
            'ownerKind', permission.value -> 'ownerKind',
            'ownerId', permission.value -> 'ownerId',
            'permissionId', permission.value -> 'permissionId'))
          order by permission.ordinality)
         from pg_catalog.jsonb_array_elements(delegation.bounded_permissions)
           with ordinality as permission(value, ordinality))) end,
    'revision', delegation.revision, 'startsAt', delegation.starts_at,
    'expiresAt', delegation.expires_at, 'state', delegation.state,
    'temporalState', case when delegation.state = 'revoked' then 'revoked'
      when delegation.starts_at > pg_catalog.clock_timestamp() then 'scheduled'
      when delegation.expires_at is not null
        and delegation.expires_at <= pg_catalog.clock_timestamp() then 'expired'
      else 'active' end))
  from vortex_access.organization_delegation_authorities as delegation
  left join vortex_identity.organization_accounts as account
    on delegation.holder_kind = 'organization_account'
    and account.organization_id = delegation.organization_id
    and account.organization_account_id = delegation.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on delegation.holder_kind = 'group'
    and organization_group.organization_id = delegation.organization_id
    and organization_group.group_id = delegation.group_id
  where delegation.organization_id = p_organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id
$$;

ALTER FUNCTION vortex_access.project_organization_delegation_summary(p_organization_id uuid, p_delegation_authority_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.project_organization_delegation_summary(p_organization_id uuid, p_delegation_authority_id uuid) FROM PUBLIC;
