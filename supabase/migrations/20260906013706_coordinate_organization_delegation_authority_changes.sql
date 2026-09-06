create function vortex_access.coordinate_organization_delegation_authority_change(
  p_operation text,
  p_organization_id uuid,
  p_delegation_authority_id uuid,
  p_expected_delegation_revision bigint,
  p_holder_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_scope_kind text,
  p_bounded_permissions jsonb,
  p_scope_fingerprint text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  delegation jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  checked_at timestamptz;
  operation_at timestamptz;
  next_access_version bigint;
begin
  if p_operation is null
    or p_operation not in (
      'grant_delegation', 'replace_delegation_scope', 'revoke_delegation'
    )
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_delegation_authority_id is null
    or p_delegation_authority_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization delegation change input is invalid';
  end if;

  if p_operation = 'grant_delegation' then
    if p_expected_delegation_revision is not null
      or p_holder_kind is null
      or p_holder_kind not in ('organization_account', 'group')
      or (
        p_holder_kind = 'organization_account'
        and (
          p_organization_account_id is null
          or p_organization_account_id =
            '00000000-0000-0000-0000-000000000000'::uuid
          or p_group_id is not null
        )
      )
      or (
        p_holder_kind = 'group'
        and (
          p_group_id is null
          or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
          or p_organization_account_id is not null
        )
      )
      or p_starts_at is null
      or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
      or (p_expires_at is not null and p_expires_at <= p_starts_at) then
      raise exception using errcode = '22023',
        message = 'Organization delegation grant input is invalid';
    end if;
  elsif p_operation = 'replace_delegation_scope' then
    if p_expected_delegation_revision is null
      or p_expected_delegation_revision not between 1 and 9007199254740991
      or p_holder_kind is not null
      or p_organization_account_id is not null
      or p_group_id is not null
      or p_starts_at is not null
      or p_expires_at is not null then
      raise exception using errcode = '22023',
        message = 'Organization delegation scope replacement input is invalid';
    end if;
  elsif p_expected_delegation_revision is null
    or p_expected_delegation_revision not between 1 and 9007199254740991
    or p_holder_kind is not null
    or p_organization_account_id is not null
    or p_group_id is not null
    or p_scope_kind is not null
    or p_bounded_permissions is not null
    or p_scope_fingerprint is not null
    or p_starts_at is not null
    or p_expires_at is not null then
    raise exception using errcode = '22023',
      message = 'Organization delegation revocation input is invalid';
  end if;

  if p_operation <> 'revoke_delegation' and (
    p_scope_kind is null
    or p_scope_kind not in ('organization_catalogue', 'bounded')
    or (
      p_scope_kind = 'organization_catalogue'
      and (
        p_bounded_permissions is not null
        or p_scope_fingerprint is not null
      )
    )
    or (
      p_scope_kind = 'bounded'
      and (
        p_bounded_permissions is null
        or p_scope_fingerprint is null
        or p_scope_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      )
    )
  ) then
    raise exception using errcode = '22023',
      message = 'Organization delegation scope input is invalid';
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
      message = 'Organization delegation change scope is unavailable';
  end if;

  if p_operation = 'grant_delegation' then
    if exists (
      select 1
      from vortex_access.organization_delegation_authorities as stored_delegation
      where stored_delegation.organization_id = p_organization_id
        and stored_delegation.delegation_authority_id =
          p_delegation_authority_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization delegation grant is stale or unavailable';
    end if;

    if p_holder_kind = 'organization_account' then
      perform 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = p_organization_id
        and account.organization_account_id = p_organization_account_id
        and account.state = 'active'
      for update;
    else
      perform 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
        and organization_group.state = 'active'
      for update;
    end if;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization delegation holder is stale or unavailable';
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if p_expires_at is not null and p_expires_at <= checked_at then
      raise exception using errcode = '40001',
        message = 'Organization delegation window is no longer current';
    end if;

    insert into vortex_access.organization_delegation_authorities (
      organization_id, delegation_authority_id, holder_kind,
      organization_account_id, group_id, scope_kind, bounded_permissions,
      scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
      granted_at, grant_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_delegation_authority_id, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, p_scope_fingerprint, 1, p_starts_at,
      p_expires_at, 'live', p_changed_by, checked_at, p_correlation_id,
      p_changed_by, checked_at, p_correlation_id, null, null, null
    ) returning * into delegation_fact;
  else
    select stored_delegation.*
    into delegation_fact
    from vortex_access.organization_delegation_authorities as stored_delegation
    where stored_delegation.organization_id = p_organization_id
      and stored_delegation.delegation_authority_id =
        p_delegation_authority_id
    for update;

    if not found
      or delegation_fact.revision <> p_expected_delegation_revision
      or delegation_fact.state <> 'live' then
      raise exception using errcode = '40001',
        message = 'Organization delegation change is stale or unavailable';
    end if;
    if delegation_fact.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization delegation authority revision is exhausted';
    end if;

    if p_operation = 'replace_delegation_scope' then
      if delegation_fact.holder_kind = 'organization_account' then
        perform 1
        from vortex_identity.organization_accounts as account
        where account.organization_id = p_organization_id
          and account.organization_account_id =
            delegation_fact.organization_account_id
          and account.state = 'active'
        for update;
      else
        perform 1
        from vortex_access.organization_groups as organization_group
        where organization_group.organization_id = p_organization_id
          and organization_group.group_id = delegation_fact.group_id
          and organization_group.state = 'active'
        for update;
      end if;
      if not found then
        raise exception using errcode = '40001',
          message = 'Organization delegation holder is stale or unavailable';
      end if;
    end if;

    checked_at := pg_catalog.clock_timestamp();
    if p_operation = 'replace_delegation_scope' then
      if delegation_fact.expires_at is not null
        and delegation_fact.expires_at <= checked_at then
        raise exception using errcode = '40001',
          message = 'Organization delegation window is no longer current';
      end if;
      if delegation_fact.scope_kind is not distinct from p_scope_kind
        and delegation_fact.bounded_permissions is not distinct from
          p_bounded_permissions then
        raise exception using errcode = '40001',
          message = 'Organization delegation scope is unchanged';
      end if;
    end if;

    operation_at := greatest(delegation_fact.changed_at, checked_at);
    update vortex_access.organization_delegation_authorities as stored_delegation
    set scope_kind = case when p_operation = 'replace_delegation_scope'
        then p_scope_kind else delegation_fact.scope_kind end,
      bounded_permissions = case when p_operation = 'replace_delegation_scope'
        then p_bounded_permissions else delegation_fact.bounded_permissions end,
      scope_fingerprint = case when p_operation = 'replace_delegation_scope'
        then p_scope_fingerprint else delegation_fact.scope_fingerprint end,
      revision = delegation_fact.revision + 1,
      state = case when p_operation = 'revoke_delegation'
        then 'revoked' else delegation_fact.state end,
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id,
      revoked_by = case when p_operation = 'revoke_delegation'
        then p_changed_by else null end,
      revoked_at = case when p_operation = 'revoke_delegation'
        then operation_at else null end,
      revocation_correlation_id = case when p_operation = 'revoke_delegation'
        then p_correlation_id else null end
    where stored_delegation.organization_id = p_organization_id
      and stored_delegation.delegation_authority_id =
        p_delegation_authority_id
      and stored_delegation.revision = p_expected_delegation_revision
      and stored_delegation.state = 'live'
    returning stored_delegation.* into delegation_fact;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization delegation change is stale or unavailable';
    end if;
  end if;

  select version.current_version
  into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'delegation_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'delegationAuthorityId', delegation_fact.delegation_authority_id,
      'organizationId', delegation_fact.organization_id,
      'holder', case delegation_fact.holder_kind
        when 'organization_account' then pg_catalog.jsonb_build_object(
          'kind', 'organization_account',
          'organizationAccountId', delegation_fact.organization_account_id
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'group', 'groupId', delegation_fact.group_id
        )
      end,
      'scope', case delegation_fact.scope_kind
        when 'organization_catalogue' then pg_catalog.jsonb_build_object(
          'kind', 'organization_catalogue'
        )
        else pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', delegation_fact.bounded_permissions,
          'scopeFingerprint', delegation_fact.scope_fingerprint
        )
      end,
      'revision', delegation_fact.revision,
      'startsAt', delegation_fact.starts_at,
      'expiresAt', delegation_fact.expires_at,
      'state', delegation_fact.state,
      'grantedByActorId', delegation_fact.granted_by,
      'grantedAt', delegation_fact.granted_at,
      'grantCorrelationId', delegation_fact.grant_correlation_id,
      'changedByActorId', delegation_fact.changed_by,
      'changedAt', delegation_fact.changed_at,
      'changeCorrelationId', delegation_fact.change_correlation_id,
      'revokedByActorId', delegation_fact.revoked_by,
      'revokedAt', delegation_fact.revoked_at,
      'revocationCorrelationId', delegation_fact.revocation_correlation_id
    )),
    next_access_version, p_correlation_id;
end
$function$;

revoke execute on function
  vortex_access.coordinate_organization_delegation_authority_change(
    text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text,
    timestamptz, timestamptz, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function
  vortex_access.coordinate_organization_delegation_authority_change(
    text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text,
    timestamptz, timestamptz, uuid, uuid
  ) is
  'Owner-only atomic delegation grant, whole-scope replacement or terminal revocation. It changes Access once but grants no caller authority.';
