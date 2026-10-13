CREATE FUNCTION vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, delegations jsonb, next_after_delegation_authority_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  checked_at timestamptz;
  delegation_items jsonb;
  page_delegation_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization delegation authority page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select delegation.delegation_authority_id, delegation.holder_kind,
      delegation.organization_account_id, account.display_name,
      delegation.group_id, organization_group.group_key,
      organization_group.label as group_label,
      organization_group.state as group_state,
      delegation.scope_kind, delegation.bounded_permissions,
      delegation.revision, delegation.starts_at, delegation.expires_at,
      delegation.state,
      case
        when delegation.state = 'revoked' then 'revoked'
        when delegation.starts_at > checked_at then 'scheduled'
        when delegation.expires_at is not null
          and delegation.expires_at <= checked_at then 'expired'
        else 'active'
      end as temporal_state,
      pg_catalog.row_number() over (
        order by delegation.delegation_authority_id
      ) as ordinal
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
      and (
        p_after_delegation_authority_id is null
        or delegation.delegation_authority_id > p_after_delegation_authority_id
      )
    order by delegation.delegation_authority_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'delegationAuthorityId', candidate.delegation_authority_id,
          'holder', case candidate.holder_kind
            when 'organization_account' then pg_catalog.jsonb_build_object(
              'kind', 'organization_account',
              'organizationAccountId', candidate.organization_account_id,
              'displayName', candidate.display_name
            )
            else pg_catalog.jsonb_build_object(
              'kind', 'group',
              'groupId', candidate.group_id,
              'key', candidate.group_key,
              'label', candidate.group_label,
              'state', candidate.group_state
            )
          end,
          'scope', case candidate.scope_kind
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
                from pg_catalog.jsonb_array_elements(candidate.bounded_permissions)
                  with ordinality as permission(value, ordinality)
              )
            )
          end,
          'revision', candidate.revision,
          'startsAt', candidate.starts_at,
          'expiresAt', candidate.expires_at,
          'state', candidate.state,
          'temporalState', candidate.temporal_state
        )) order by candidate.delegation_authority_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.delegation_authority_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into delegation_items, page_delegation_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, delegation_items,
    case when candidate_count > p_page_size
      then page_delegation_ids[p_page_size] else null end,
    scope.access_version;
end
$$;

alter function vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) IS 'Returns one bounded delegation page with internal scope evidence removed.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) TO vortex_request;

grant execute on function vortex_access.list_organization_delegation_authorities_for_administration(p_after_delegation_authority_id uuid, p_page_size integer) to postgres;
