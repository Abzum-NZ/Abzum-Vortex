-- Bounded Group membership administration uses the already-protected fixed
-- teams-read scope. This index supports stable keyset pages including retained
-- revoked memberships.
create index organization_group_memberships_group_page_idx
  on vortex_access.organization_group_memberships (
    organization_id, group_id, membership_id
  );

create function vortex_access.list_organization_group_memberships_for_administration(
  p_group_id uuid,
  p_after_membership_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  group_id uuid,
  memberships jsonb,
  next_after_membership_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
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
$function$;

create function vortex_access.read_organization_group_membership_for_administration(
  p_membership_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  membership_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
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
$function$;

revoke execute on function
  vortex_access.list_organization_group_memberships_for_administration(uuid, uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on function
  vortex_access.read_organization_group_membership_for_administration(uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_group_memberships_for_administration(uuid, uuid, integer)
to vortex_request;
grant execute on function
  vortex_access.read_organization_group_membership_for_administration(uuid)
to vortex_request;

comment on function
  vortex_access.list_organization_group_memberships_for_administration(uuid, uuid, integer) is
  'Returns one bounded selected-Group membership page after fixed teams-read authorization; temporal state is descriptive and grants no permission.';
comment on function
  vortex_access.read_organization_group_membership_for_administration(uuid) is
  'Returns one safe exact membership detail after fixed teams-read authorization; temporal state is descriptive and grants no permission.';
