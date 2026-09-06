create function vortex_access.coordinate_organization_group_membership_change(
  p_operation text,
  p_organization_id uuid,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_group_id uuid,
  p_organization_account_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_replacement_membership_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  membership jsonb,
  closed_predecessor jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  current_membership vortex_access.organization_group_memberships%rowtype;
  resulting_membership vortex_access.organization_group_memberships%rowtype;
  closed_membership vortex_access.organization_group_memberships%rowtype;
  next_access_version bigint;
  checked_at timestamptz;
  operation_at timestamptz;
begin
  if p_operation is null
    or p_operation not in (
      'add_membership', 'remove_membership',
      'restore_membership', 'renew_membership'
    )
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership change input is invalid';
  end if;

  if p_operation = 'add_membership' then
    if p_expected_membership_revision is not null
      or p_group_id is null
      or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_organization_account_id is null
      or p_organization_account_id =
        '00000000-0000-0000-0000-000000000000'::uuid
      or p_starts_at is null
      or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (p_expires_at is not null and p_expires_at <= p_starts_at)
      or p_replacement_membership_id is not null then
      raise exception using errcode = '22023',
        message = 'Organization Group membership addition input is invalid';
    end if;
  elsif p_operation in ('remove_membership', 'restore_membership') then
    if p_expected_membership_revision is null
      or p_expected_membership_revision not between 1 and 9007199254740991
      or p_group_id is not null
      or p_organization_account_id is not null
      or p_starts_at is not null
      or p_expires_at is not null
      or p_replacement_membership_id is not null then
      raise exception using errcode = '22023',
        message = 'Organization Group membership transition input is invalid';
    end if;
  elsif p_expected_membership_revision is null
    or p_expected_membership_revision not between 1 and 9007199254740991
    or p_group_id is not null
    or p_organization_account_id is not null
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_replacement_membership_id is null
    or p_replacement_membership_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_replacement_membership_id = p_membership_id then
    raise exception using errcode = '22023',
      message = 'Organization Group membership renewal input is invalid';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization Group membership change scope is unavailable';
  end if;

  if p_operation = 'add_membership' then
    if exists (
      select 1
      from vortex_access.organization_group_memberships as stored_membership
      where stored_membership.organization_id = p_organization_id
        and stored_membership.membership_id = p_membership_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization Group membership addition is stale or unavailable';
    end if;

    perform 1
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization Group membership sources are stale or unavailable';
    end if;

    perform 1
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization Group membership sources are stale or unavailable';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    if p_expires_at is not null and p_expires_at <= operation_at then
      raise exception using errcode = '40001',
        message = 'Organization Group membership window is no longer current';
    end if;

    insert into vortex_access.organization_group_memberships (
      organization_id, membership_id, group_id, organization_account_id,
      revision, starts_at, expires_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id,
      revoked_by, revoked_at, revocation_correlation_id
    ) values (
      p_organization_id, p_membership_id, p_group_id,
      p_organization_account_id, 1, p_starts_at, p_expires_at, 'live',
      p_changed_by, operation_at, p_correlation_id, p_changed_by,
      operation_at, p_correlation_id, null, null, null
    ) returning * into resulting_membership;
  else
    select stored_membership.*
    into current_membership
    from vortex_access.organization_group_memberships as stored_membership
    where stored_membership.organization_id = p_organization_id
      and stored_membership.membership_id = p_membership_id
    for update;

    if not found
      or current_membership.revision <> p_expected_membership_revision
      or (
        p_operation in ('remove_membership', 'renew_membership')
        and current_membership.state <> 'live'
      )
      or (
        p_operation = 'restore_membership'
        and current_membership.state <> 'revoked'
      ) then
      raise exception using errcode = '40001',
        message = 'Organization Group membership change is stale or unavailable';
    end if;

    if current_membership.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization Group membership revision is exhausted';
    end if;

    if p_operation in ('restore_membership', 'renew_membership') then
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = current_membership.group_id
        and organization_group.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization Group membership sources are stale or unavailable';
      end if;

      perform 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id =
          current_membership.organization_account_id
        and account.state = 'active'
      for update;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization Group membership sources are stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    operation_at := greatest(
      current_membership.changed_at,
      checked_at
    );

    if p_operation = 'remove_membership' then
      update vortex_access.organization_group_memberships as stored_membership
      set revision = current_membership.revision + 1,
        state = 'revoked',
        changed_by = p_changed_by,
        changed_at = operation_at,
        change_correlation_id = p_correlation_id,
        revoked_by = p_changed_by,
        revoked_at = operation_at,
        revocation_correlation_id = p_correlation_id
      where stored_membership.organization_id = p_organization_id
        and stored_membership.membership_id = p_membership_id
        and stored_membership.revision = p_expected_membership_revision
        and stored_membership.state = 'live'
      returning stored_membership.* into resulting_membership;
    elsif p_operation = 'restore_membership' then
      if current_membership.expires_at is not null
        and current_membership.expires_at <= checked_at then
        raise exception using errcode = '40001',
          message = 'An expired Group membership requires renewal';
      end if;

      update vortex_access.organization_group_memberships as stored_membership
      set revision = current_membership.revision + 1,
        state = 'live',
        changed_by = p_changed_by,
        changed_at = operation_at,
        change_correlation_id = p_correlation_id,
        revoked_by = null,
        revoked_at = null,
        revocation_correlation_id = null
      where stored_membership.organization_id = p_organization_id
        and stored_membership.membership_id = p_membership_id
        and stored_membership.revision = p_expected_membership_revision
        and stored_membership.state = 'revoked'
      returning stored_membership.* into resulting_membership;
    else
      if current_membership.expires_at is null
        or current_membership.expires_at > checked_at then
        raise exception using errcode = '40001',
          message = 'Only a naturally expired live Group membership can be renewed';
      end if;
      if p_expires_at is not null and p_expires_at <= checked_at then
        raise exception using errcode = '40001',
          message = 'Organization Group membership window is no longer current';
      end if;
      if exists (
        select 1
        from vortex_access.organization_group_memberships as stored_membership
        where stored_membership.organization_id = p_organization_id
          and stored_membership.membership_id = p_replacement_membership_id
      ) then
        raise exception using errcode = '40001',
          message = 'Organization Group membership renewal is stale or unavailable';
      end if;

      update vortex_access.organization_group_memberships as stored_membership
      set revision = current_membership.revision + 1,
        state = 'revoked',
        changed_by = p_changed_by,
        changed_at = operation_at,
        change_correlation_id = p_correlation_id,
        revoked_by = p_changed_by,
        revoked_at = operation_at,
        revocation_correlation_id = p_correlation_id
      where stored_membership.organization_id = p_organization_id
        and stored_membership.membership_id = p_membership_id
        and stored_membership.revision = p_expected_membership_revision
        and stored_membership.state = 'live'
      returning stored_membership.* into closed_membership;

      insert into vortex_access.organization_group_memberships (
        organization_id, membership_id, group_id, organization_account_id,
        revision, starts_at, expires_at, state, granted_by, granted_at,
        grant_correlation_id, changed_by, changed_at, change_correlation_id,
        revoked_by, revoked_at, revocation_correlation_id
      ) values (
        p_organization_id, p_replacement_membership_id,
        current_membership.group_id, current_membership.organization_account_id,
        1, p_starts_at, p_expires_at, 'live', p_changed_by, checked_at,
        p_correlation_id, p_changed_by, checked_at, p_correlation_id,
        null, null, null
      ) returning * into resulting_membership;
    end if;

    if resulting_membership.membership_id is null then
      raise exception using errcode = '40001',
        message = 'Organization Group membership change is stale or unavailable';
    end if;
  end if;

  select version.current_version
  into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'team_membership_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'membershipId', resulting_membership.membership_id,
      'organizationId', resulting_membership.organization_id,
      'groupId', resulting_membership.group_id,
      'organizationAccountId', resulting_membership.organization_account_id,
      'revision', resulting_membership.revision,
      'startsAt', resulting_membership.starts_at,
      'expiresAt', resulting_membership.expires_at,
      'state', resulting_membership.state,
      'grantedByActorId', resulting_membership.granted_by,
      'grantedAt', resulting_membership.granted_at,
      'grantCorrelationId', resulting_membership.grant_correlation_id,
      'changedByActorId', resulting_membership.changed_by,
      'changeCorrelationId', resulting_membership.change_correlation_id,
      'revokedByActorId', resulting_membership.revoked_by,
      'revokedAt', resulting_membership.revoked_at,
      'revocationCorrelationId', resulting_membership.revocation_correlation_id,
      'changedAt', resulting_membership.changed_at
    )),
    case when p_operation = 'renew_membership' then
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'membershipId', closed_membership.membership_id,
        'organizationId', closed_membership.organization_id,
        'groupId', closed_membership.group_id,
        'organizationAccountId', closed_membership.organization_account_id,
        'revision', closed_membership.revision,
        'startsAt', closed_membership.starts_at,
        'expiresAt', closed_membership.expires_at,
        'state', closed_membership.state,
        'grantedByActorId', closed_membership.granted_by,
        'grantedAt', closed_membership.granted_at,
        'grantCorrelationId', closed_membership.grant_correlation_id,
        'changedByActorId', closed_membership.changed_by,
        'changeCorrelationId', closed_membership.change_correlation_id,
        'revokedByActorId', closed_membership.revoked_by,
        'revokedAt', closed_membership.revoked_at,
        'revocationCorrelationId', closed_membership.revocation_correlation_id,
        'changedAt', closed_membership.changed_at
      ))
    else null::jsonb end,
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_group_membership_change(
    text, uuid, uuid, bigint, uuid, uuid, timestamptz, timestamptz,
    uuid, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_organization_group_membership_change(
  text, uuid, uuid, bigint, uuid, uuid, timestamptz, timestamptz,
  uuid, uuid, uuid
) is
  'Owner-only atomic Group membership add, remove, restore or renewal. It changes Access once but grants no caller authority.';
