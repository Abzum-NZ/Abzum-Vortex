CREATE FUNCTION vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, group_id uuid, memberships jsonb, next_after_membership_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  checked_at timestamptz;
  membership_items jsonb;
  page_membership_ids uuid[];
  candidate_count integer;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or (
      p_after_membership_id is not null
      and p_after_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    ) then
    raise exception using errcode = '22023',
      message = 'Organization Group membership page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_groups_administration_scope() as authorized;

  if not exists (
    select 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = scope.organization_id
      and organization_group.group_id = p_group_id
  ) then
    raise exception using errcode = '42501',
      message = 'Organization Group membership administration is unavailable';
  end if;

  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select membership.membership_id, membership.group_id,
      membership.organization_account_id, account.display_name,
      membership.revision, membership.starts_at, membership.expires_at,
      membership.state,
      case
        when membership.state = 'revoked' then 'revoked'
        when membership.starts_at > checked_at then 'scheduled'
        when membership.expires_at is not null
          and membership.expires_at <= checked_at then 'expired'
        else 'active'
      end as temporal_state,
      pg_catalog.row_number() over (order by membership.membership_id) as ordinal
    from vortex_access.organization_group_memberships as membership
    join vortex_identity.organization_accounts as account
      on account.organization_id = membership.organization_id
      and account.organization_account_id = membership.organization_account_id
    where membership.organization_id = scope.organization_id
      and membership.group_id = p_group_id
      and (
        p_after_membership_id is null
        or membership.membership_id > p_after_membership_id
      )
    order by membership.membership_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'membershipId', candidate.membership_id,
          'groupId', candidate.group_id,
          'organizationAccountId', candidate.organization_account_id,
          'accountDisplayName', candidate.display_name,
          'revision', candidate.revision,
          'startsAt', candidate.starts_at,
          'expiresAt', candidate.expires_at,
          'state', candidate.state,
          'temporalState', candidate.temporal_state
        )) order by candidate.membership_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.membership_id order by candidate.membership_id)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into membership_items, page_membership_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, p_group_id, membership_items,
    case when candidate_count > p_page_size
      then page_membership_ids[p_page_size]
      else null
    end,
    scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) IS 'Returns one bounded selected-Group membership page after fixed teams-read authorization; temporal state is descriptive and grants no permission.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_group_memberships_for_administration(p_group_id uuid, p_after_membership_id uuid, p_page_size integer) TO vortex_request;
