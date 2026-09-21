-- Remove the legacy Team spelling from current state (#549).
--
-- Group is the only ownership mode, principal kind and Access-version reason.
-- The retired spellings were `team` (record ownership mode) and
-- `team_membership_changed` (Access-version change reason). This migration:
--   1. rewrites the stored Access-version reason to `group_membership_changed`
--      and closes the reason constraint and writers over the current vocabulary;
--   2. replaces every current function that accepted or emitted the ownership
--      value `team`, so each now accepts and emits `group` only.
--
-- Everything is one transaction, in dependency order: the constraint is dropped
-- before its rows are rewritten and re-added only once every row conforms, and
-- functions are replaced last under their existing owners so signature,
-- volatility, security mode, search path, grants, ACLs and comments are
-- unchanged. Only the retired literals differ from each function's current
-- definition.
--
-- Not rewritten: already-published Definition releases and drafts and stored
-- record-storage catalogue rows. Those are append-only, fingerprint-bound
-- evidence; an already-published release whose record type carries ownership
-- `team` is not migrated and must be republished from a corrected definition.

begin;

-- 1. Access-version reason. The protect trigger permits only a full version
-- increment, so it is disabled for exactly this in-transaction rewrite of the
-- reason label; version, time, actor and correlation are left untouched.
alter table vortex_access.organization_access_versions
  drop constraint organization_access_versions_reason_valid;

alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;

update vortex_access.organization_access_versions
set change_reason = 'group_membership_changed'
where change_reason = 'team_membership_changed';

alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;

alter table vortex_access.organization_access_versions
  add constraint organization_access_versions_reason_valid check (
    change_reason in (
      'organization_initialized',
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_activation_changed',
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    )
  );

create or replace function vortex_access.increment_organization_access_version(
  p_organization_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid,
  p_change_reason text
)
returns table (
  organization_id uuid,
  current_version bigint,
  changed_at timestamptz,
  changed_by uuid,
  change_correlation_id uuid,
  change_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change_reason not in (
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_activation_changed',
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = greatest(version.changed_at, pg_catalog.clock_timestamp()),
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id,
      change_reason = p_change_reason
  where version.organization_id = p_organization_id
    and version.current_version < 9007199254740991
  returning version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason;

  if not found then
    if exists (
      select 1 from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
        and version.current_version = 9007199254740991
    ) then
      raise exception using errcode = '22003', message = 'Access version is exhausted';
    end if;
    raise exception using errcode = '40001', message = 'Access version is unavailable';
  end if;
end
$function$;

create or replace function vortex_access.coordinate_organization_group_change(
  p_operation text,
  p_organization_id uuid,
  p_group_id uuid,
  p_expected_group_revision bigint,
  p_group_key text,
  p_label text,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  group_id uuid,
  group_key text,
  label text,
  state text,
  revision bigint,
  created_by_actor_id uuid,
  created_at timestamptz,
  changed_by_actor_id uuid,
  changed_at timestamptz,
  change_correlation_id uuid,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  current_group vortex_access.organization_groups%rowtype;
  next_access_version bigint;
  operation_at timestamptz;
begin
  if p_operation is null
    or p_operation not in ('create_group', 'revise_group_label', 'retire_group')
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group change input is invalid';
  end if;

  if p_operation = 'create_group' then
    if p_expected_group_revision is not null
      or p_group_key is null
      or pg_catalog.char_length(p_group_key) not between 1 and 40
      or p_group_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
      or p_label is null
      or p_label <> pg_catalog.btrim(p_label)
      or pg_catalog.char_length(p_label) not between 1 and 60 then
      raise exception using errcode = '22023',
        message = 'Organization Group creation input is invalid';
    end if;
  elsif p_operation = 'revise_group_label' then
    if p_expected_group_revision is null
      or p_expected_group_revision not between 1 and 9007199254740991
      or p_group_key is not null
      or p_label is null
      or p_label <> pg_catalog.btrim(p_label)
      or pg_catalog.char_length(p_label) not between 1 and 60 then
      raise exception using errcode = '22023',
        message = 'Organization Group label revision input is invalid';
    end if;
  elsif p_expected_group_revision is null
    or p_expected_group_revision not between 1 and 9007199254740991
    or p_group_key is not null
    or p_label is not null then
    raise exception using errcode = '22023',
      message = 'Organization Group retirement input is invalid';
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
      message = 'Organization Group change scope is unavailable';
  end if;

  if p_operation = 'create_group' then
    if exists (
      select 1
      from vortex_access.organization_groups as organization_group
      where organization_group.organization_id = p_organization_id
        and organization_group.group_id = p_group_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization Group creation is stale or unavailable';
    end if;

    operation_at := pg_catalog.clock_timestamp();
    insert into vortex_access.organization_groups (
      organization_id, group_id, group_key, label, state, revision,
      created_by, created_at, changed_by, changed_at, change_correlation_id
    ) values (
      p_organization_id, p_group_id, p_group_key, p_label, 'active', 1,
      p_changed_by, operation_at, p_changed_by, operation_at, p_correlation_id
    );
  else
    select organization_group.*
    into current_group
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
    for update;

    if not found
      or current_group.revision <> p_expected_group_revision
      or current_group.state <> 'active' then
      raise exception using errcode = '40001',
        message = 'Organization Group change is stale or unavailable';
    end if;

    if p_operation = 'revise_group_label'
      and current_group.label is not distinct from p_label then
      raise exception using errcode = '40001',
        message = 'Organization Group label is unchanged';
    end if;

    if current_group.revision = 9007199254740991 then
      raise exception using errcode = '22003',
        message = 'Organization Group revision is exhausted';
    end if;

    operation_at := greatest(
      current_group.changed_at,
      pg_catalog.clock_timestamp()
    );
    update vortex_access.organization_groups as organization_group
    set label = case
        when p_operation = 'revise_group_label' then p_label
        else current_group.label
      end,
      state = case
        when p_operation = 'retire_group' then 'retired'
        else current_group.state
      end,
      revision = current_group.revision + 1,
      changed_by = p_changed_by,
      changed_at = operation_at,
      change_correlation_id = p_correlation_id
    where organization_group.organization_id = p_organization_id
      and organization_group.group_id = p_group_id
      and organization_group.revision = p_expected_group_revision
      and organization_group.state = 'active';
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization Group change is stale or unavailable';
    end if;
  end if;

  select version.current_version
  into next_access_version
  from vortex_access.increment_organization_access_version(
    p_organization_id,
    p_changed_by,
    p_correlation_id,
    'group_membership_changed'
  ) as version;

  return query
  select 'changed'::text, p_operation, organization_group.organization_id,
    organization_group.group_id, organization_group.group_key,
    organization_group.label, organization_group.state,
    organization_group.revision, organization_group.created_by,
    organization_group.created_at, organization_group.changed_by,
    organization_group.changed_at, organization_group.change_correlation_id,
    next_access_version, p_correlation_id
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = p_organization_id
    and organization_group.group_id = p_group_id;
end
$function$;

create or replace function vortex_access.coordinate_organization_group_membership_change(
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
    'group_membership_changed'
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

-- 2. Record ownership mode.

create or replace function vortex_access.evaluate_current_record_ownership_visibility(
  p_permission_record_scope jsonb,
  p_ownership_mode text,
  p_binding_organization_id uuid,
  p_binding_application_root_id uuid,
  p_binding_module_root_id uuid,
  p_binding_record_type_id uuid,
  p_binding_storage_contract_id uuid,
  p_binding_storage_scope text,
  p_record_scope jsonb,
  p_owner_organization_account_id uuid,
  p_owner_group_id uuid,
  p_current_organization_id uuid,
  p_current_application_root_id uuid,
  p_current_organization_account_id uuid,
  p_checked_at timestamptz
)
returns table (
  admitted boolean,
  valid_until timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_id constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  scope_key_count integer;
  has_all_records boolean;
  has_ownership boolean;
  record_storage_scope text;
  record_organization_id uuid;
  record_application_root_id uuid;
  record_module_root_id uuid;
  record_type_id uuid;
  record_storage_contract_id uuid;
  record_id uuid;
  membership_deadline timestamptz;
begin
  has_all_records := exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
    where route.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      p_permission_record_scope -> 'routes'
    ) as route(value)
    where route.value ->> 'kind' = 'ownership'
  );

  if p_binding_organization_id is null or p_binding_organization_id = nil_id
    or p_binding_application_root_id is null
    or p_binding_application_root_id = nil_id
    or p_binding_module_root_id is null or p_binding_module_root_id = nil_id
    or p_binding_record_type_id is null or p_binding_record_type_id = nil_id
    or p_binding_storage_contract_id is null
    or p_binding_storage_contract_id = nil_id
    or p_current_organization_id is null or p_current_organization_id = nil_id
    or p_current_application_root_id is null
    or p_current_application_root_id = nil_id
    or p_current_organization_account_id is null
    or p_current_organization_account_id = nil_id
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_binding_storage_scope is null
    or p_binding_storage_scope not in ('organization_shared', 'application_contained')
    or p_ownership_mode is null
    or p_ownership_mode not in ('none', 'organization_account', 'group', 'inherited') then
    raise exception using errcode = '22023',
      message = 'Record visibility context is invalid';
  end if;

  if (p_ownership_mode in ('none', 'inherited')
      and (p_owner_organization_account_id is not null or p_owner_group_id is not null))
    or (p_ownership_mode = 'organization_account'
      and (p_owner_organization_account_id is null
        or p_owner_organization_account_id = nil_id
        or p_owner_group_id is not null))
    or (p_ownership_mode = 'group'
      and (p_owner_group_id is null or p_owner_group_id = nil_id
        or p_owner_organization_account_id is not null)) then
    raise exception using errcode = '22023',
      message = 'Record ownership evidence is invalid';
  end if;

  if p_record_scope is null
    or pg_catalog.jsonb_typeof(p_record_scope) is distinct from 'object' then
    raise exception using errcode = '22023',
      message = 'Record identity is invalid';
  end if;
  record_storage_scope := p_record_scope ->> 'storageScope';
  select pg_catalog.count(*) into scope_key_count
  from pg_catalog.jsonb_object_keys(p_record_scope) as record_key;
  if record_storage_scope = 'organization_shared' then
    if scope_key_count <> 6 or p_record_scope ? 'applicationRootId' then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
    end if;
  elsif record_storage_scope = 'application_contained' then
    if scope_key_count <> 7 or not (p_record_scope ? 'applicationRootId') then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
    end if;
  else
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;

  if not (p_record_scope ?& array[
    'organizationId', 'moduleRootId', 'recordTypeId',
    'storageContractId', 'recordId'
  ]) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;
  if not vortex_context.is_non_nil_uuid(p_record_scope ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'storageContractId')
    or not vortex_context.is_non_nil_uuid(p_record_scope ->> 'recordId')
    or (record_storage_scope = 'application_contained'
      and not vortex_context.is_non_nil_uuid(
        p_record_scope ->> 'applicationRootId'
      )) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;
  begin
    record_organization_id := (p_record_scope ->> 'organizationId')::uuid;
    record_module_root_id := (p_record_scope ->> 'moduleRootId')::uuid;
    record_type_id := (p_record_scope ->> 'recordTypeId')::uuid;
    record_storage_contract_id := (p_record_scope ->> 'storageContractId')::uuid;
    record_id := (p_record_scope ->> 'recordId')::uuid;
    if record_storage_scope = 'application_contained' then
      record_application_root_id := (p_record_scope ->> 'applicationRootId')::uuid;
    end if;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Record identity is invalid';
  end;
  if record_organization_id is null or record_organization_id = nil_id
    or record_module_root_id is null or record_module_root_id = nil_id
    or record_type_id is null or record_type_id = nil_id
    or record_storage_contract_id is null or record_storage_contract_id = nil_id
    or record_id is null or record_id = nil_id
    or (record_storage_scope = 'application_contained'
      and (record_application_root_id is null or record_application_root_id = nil_id)) then
    raise exception using errcode = '22023', message = 'Record identity is invalid';
  end if;

  if p_binding_organization_id <> p_current_organization_id
    or p_binding_application_root_id <> p_current_application_root_id
    or record_organization_id <> p_current_organization_id
    or record_module_root_id <> p_binding_module_root_id
    or record_type_id <> p_binding_record_type_id
    or record_storage_contract_id <> p_binding_storage_contract_id
    or record_storage_scope <> p_binding_storage_scope
    or (record_storage_scope = 'application_contained'
      and record_application_root_id <> p_current_application_root_id) then
    return query select false, null::timestamptz;
    return;
  end if;

  if has_all_records then
    return query select true, null::timestamptz;
    return;
  end if;

  if has_ownership and p_ownership_mode = 'organization_account'
    and p_owner_organization_account_id = p_current_organization_account_id then
    return query select true, null::timestamptz;
    return;
  end if;

  if has_ownership and p_ownership_mode = 'group' then
    select membership.expires_at into membership_deadline
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = membership.organization_id
      and organization_group.group_id = membership.group_id
      and organization_group.state = 'active'
    where membership.organization_id = p_current_organization_id
      and membership.group_id = p_owner_group_id
      and membership.organization_account_id = p_current_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= p_checked_at
      and (membership.expires_at is null or membership.expires_at > p_checked_at);
    if found then
      return query select true, membership_deadline;
      return;
    end if;
  end if;

  return query select false, null::timestamptz;
end
$function$;

create or replace function vortex_access.evaluate_record_permission_row_scope_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_auth_deadline timestamptz,
  p_application_root_id uuid,
  p_action jsonb,
  p_candidate jsonb,
  p_record_id uuid,
  p_facts jsonb,
  p_path uuid[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_organization_id uuid := (p_context ->> 'organizationId')::uuid;
  context_account_id uuid := (p_context ->> 'organizationAccountId')::uuid;
  action_kind text := p_action ->> 'actionKind';
  candidate_permission jsonb := p_candidate -> 'permission';
  candidate_record_scope jsonb := p_candidate -> 'recordScope';
  candidate_valid_until timestamptz := (p_candidate ->> 'validUntil')::timestamptz;
  target_record jsonb;
  target_record_scope jsonb;
  target_type jsonb;
  has_all_records boolean;
  has_ownership boolean;
  has_direct_share boolean;
  route_list jsonb[] := array[]::jsonb[];
  deadline_list timestamptz[] := array[]::timestamptz[];
  ownership_admitted boolean;
  ownership_deadline timestamptz;
  chase_record jsonb;
  chase_scope jsonb;
  chase_type jsonb;
  chase_relationship jsonb;
  chase_edge jsonb;
  chase_edge_count integer;
  parent_record jsonb;
  parent_scope jsonb;
  parent_type jsonb;
  visited_ids uuid[];
  chase_admitted boolean;
  chase_deadline timestamptz;
  share_row record;
  route jsonb;
  relationship_decl jsonb;
  source_owner_kind text;
  source_owner_id uuid;
  source_eval record;
  source_permission_entry vortex_access.permission_catalogue_entries;
  source_path_valid_until timestamptz;
  source_valid_until timestamptz;
  source_candidate jsonb;
  source_record jsonb;
  source_record_scope jsonb;
  edge_item jsonb;
  sub_result jsonb;
  sub_min_valid_until timestamptz;
  contribution_deadline timestamptz;
  condition_id uuid;
  saved_condition jsonb;
  projected_values jsonb;
  declared_field jsonb;
  reduced_type jsonb;
  condition_ok boolean;
  result jsonb;
begin
  select value into target_record
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
  limit 1;

  if target_record is null or target_record ->> 'lifecycleState' <> 'active' then
    return '[]'::jsonb;
  end if;

  target_record_scope := target_record -> 'recordScope';

  select value into target_type
  from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  where (value ->> 'recordTypeId')::uuid = (target_record_scope ->> 'recordTypeId')::uuid
  limit 1;

  if target_type is null then
    return '[]'::jsonb;
  end if;

  has_all_records := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'all_records'
  );
  has_ownership := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'ownership'
  );
  has_direct_share := exists (
    select 1 from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where item.value ->> 'kind' = 'direct_share'
  );

  -- Step 2: base ownership/all-record routes, then inherited-ownership chase.
  if has_all_records or has_ownership then
    select outcome.admitted, outcome.valid_until into ownership_admitted, ownership_deadline
    from vortex_access.evaluate_current_record_ownership_visibility(
      candidate_record_scope,
      target_type ->> 'ownershipMode',
      context_organization_id,
      p_application_root_id,
      (target_type ->> 'moduleRootId')::uuid,
      (target_type ->> 'recordTypeId')::uuid,
      (target_type ->> 'storageContractId')::uuid,
      target_type ->> 'storageScope',
      target_record_scope,
      (target_record ->> 'ownerOrganizationAccountId')::uuid,
      (target_record ->> 'ownerGroupId')::uuid,
      context_organization_id,
      p_application_root_id,
      context_account_id,
      p_checked_at
    ) as outcome;

    if ownership_admitted then
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', case when has_all_records then 'all_records' else 'ownership' end
      ));
      deadline_list := pg_catalog.array_append(deadline_list, ownership_deadline);
    elsif has_ownership and target_type ->> 'ownershipMode' = 'inherited' then
      chase_record := target_record;
      chase_scope := target_record_scope;
      chase_type := target_type;
      visited_ids := array[(target_record_scope ->> 'recordId')::uuid];

      while chase_type ->> 'ownershipMode' = 'inherited' loop
        select value into chase_relationship
        from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_type ->> 'ownershipRelationshipId')::uuid
        limit 1;

        exit when chase_relationship is null;

        select pg_catalog.count(*) into chase_edge_count
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid;

        exit when chase_edge_count <> 1;

        select value into chase_edge
        from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
        where (value ->> 'relationshipId')::uuid = (chase_relationship ->> 'relationshipId')::uuid
          and (value ->> 'fromRecordId')::uuid = (chase_scope ->> 'recordId')::uuid
        limit 1;

        select value into parent_record
        from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
        where (value -> 'recordScope' ->> 'recordId')::uuid = (chase_edge ->> 'toRecordId')::uuid
        limit 1;

        exit when parent_record is null or parent_record ->> 'lifecycleState' <> 'active';

        parent_scope := parent_record -> 'recordScope';

        select value into parent_type
        from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
        where (value ->> 'recordTypeId')::uuid = (parent_scope ->> 'recordTypeId')::uuid
        limit 1;

        exit when parent_type is null;

        exit when not vortex_access.record_relationship_witness_matches(
          (chase_relationship ->> 'relationshipId')::uuid,
          (chase_relationship ->> 'fromModuleRootId')::uuid,
          (chase_relationship ->> 'fromRecordTypeId')::uuid,
          (chase_relationship ->> 'toModuleRootId')::uuid,
          (chase_relationship ->> 'toRecordTypeId')::uuid,
          (chase_edge ->> 'relationshipId')::uuid,
          (chase_edge ->> 'fromRecordId')::uuid,
          (chase_edge ->> 'toRecordId')::uuid,
          chase_scope,
          parent_scope,
          context_organization_id,
          p_application_root_id
        );

        exit when (parent_scope ->> 'recordId')::uuid = any(visited_ids);

        visited_ids := pg_catalog.array_append(visited_ids, (parent_scope ->> 'recordId')::uuid);
        chase_record := parent_record;
        chase_scope := parent_scope;
        chase_type := parent_type;
      end loop;

      if chase_type ->> 'ownershipMode' in ('organization_account', 'group') then
        select outcome.admitted, outcome.valid_until into chase_admitted, chase_deadline
        from vortex_access.evaluate_current_record_ownership_visibility(
          '{"routes":[{"kind":"ownership"}]}'::jsonb,
          chase_type ->> 'ownershipMode',
          context_organization_id,
          p_application_root_id,
          (chase_type ->> 'moduleRootId')::uuid,
          (chase_type ->> 'recordTypeId')::uuid,
          (chase_type ->> 'storageContractId')::uuid,
          chase_type ->> 'storageScope',
          chase_scope,
          (chase_record ->> 'ownerOrganizationAccountId')::uuid,
          (chase_record ->> 'ownerGroupId')::uuid,
          context_organization_id,
          p_application_root_id,
          context_account_id,
          p_checked_at
        ) as outcome;

        if chase_admitted then
          route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object('kind', 'ownership'));
          deadline_list := pg_catalog.array_append(deadline_list, chase_deadline);
        end if;
      end if;
    end if;
  end if;

  -- Step 3: direct share, read/update only, each recipient contributing
  -- independently with its own field bounds.
  if has_direct_share and action_kind in ('read', 'update') then
    for share_row in
      select *
      from vortex_access.read_current_direct_record_share_contributions(
        context_organization_id,
        p_application_root_id,
        (target_type ->> 'moduleRootId')::uuid,
        (target_type ->> 'recordTypeId')::uuid,
        (target_type ->> 'storageContractId')::uuid,
        target_type ->> 'storageScope',
        p_record_id,
        context_organization_id,
        p_application_root_id,
        context_account_id,
        p_checked_at
      )
    loop
      if action_kind = 'update' and pg_catalog.cardinality(share_row.changeable_field_ids) = 0 then
        continue;
      end if;
      route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
        'kind', 'direct_share',
        'directShareId', share_row.direct_share_id,
        'directShareRevision', share_row.direct_share_revision,
        'readableFieldIds', pg_catalog.to_jsonb(share_row.readable_field_ids),
        'changeableFieldIds', pg_catalog.to_jsonb(share_row.changeable_field_ids)
      ));
      deadline_list := pg_catalog.array_append(deadline_list, share_row.valid_until);
    end loop;
  end if;

  -- Step 4: relationship routes. The target record is always the relationship's
  -- `to` endpoint and the source record its `from` endpoint (see
  -- runtime/definition/src/validation.ts). Every recursive step re-evaluates
  -- the source permission's own eligibility and own complete scope; authority
  -- never crosses alternatives.
  for route in
    select value from pg_catalog.jsonb_array_elements(candidate_record_scope -> 'routes') as item(value)
    where value ->> 'kind' = 'relationship'
  loop
    select value into relationship_decl
    from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
    where (value ->> 'relationshipId')::uuid = (route ->> 'relationshipId')::uuid
    limit 1;

    if relationship_decl is null
      or pg_catalog.lower(relationship_decl ->> 'toModuleRootId') <> pg_catalog.lower(target_type ->> 'moduleRootId')
      or pg_catalog.lower(relationship_decl ->> 'toRecordTypeId') <> pg_catalog.lower(target_type ->> 'recordTypeId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if (route ->> 'sourcePermissionId')::uuid = any(p_path) then
      continue;
    end if;

    begin
      select entry.owner_kind, entry.owner_id
      into strict source_owner_kind, source_owner_id
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registrations as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
        and registration.state = 'active'
      where entry.organization_id = context_organization_id
        and entry.application_root_id = p_application_root_id
        and entry.permission_id = (route ->> 'sourcePermissionId')::uuid
        and entry.record_type_id = (relationship_decl ->> 'fromRecordTypeId')::uuid
        and entry.action_kind = 'read'
        and entry.named_action is null;
    exception
      when no_data_found or too_many_rows then
        continue;
    end;

    source_eval := null;
    select evaluated.permission_entry, evaluated.path_valid_until
    into source_eval
    from vortex_access.evaluate_permission_role_path_internal(
      p_context,
      p_checked_at,
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      pg_catalog.jsonb_build_object('actionKind', 'read'),
      (relationship_decl ->> 'fromRecordTypeId')::uuid
    ) as evaluated
    limit 1;

    if source_eval is null or (source_eval.permission_entry).record_scope is null
      or source_eval.path_valid_until is null or p_auth_deadline is null then
      continue;
    end if;
    source_permission_entry := source_eval.permission_entry;
    source_path_valid_until := source_eval.path_valid_until;
    source_valid_until := least(source_path_valid_until, p_auth_deadline);

    source_candidate := pg_catalog.jsonb_build_object(
      'permission', pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', source_owner_kind,
        'ownerId', source_owner_id,
        'permissionId', (route ->> 'sourcePermissionId')::uuid
      ),
      'recordScope', (source_permission_entry).record_scope,
      'source', pg_catalog.jsonb_build_object(
        'kind', (source_permission_entry).source_kind,
        'definitionKey', (source_permission_entry).source_definition_key,
        'rootId', (source_permission_entry).source_root_id,
        'releaseRevision', (source_permission_entry).source_revision,
        'releaseVersion', (source_permission_entry).source_version,
        'validationContractVersion', (source_permission_entry).source_validation_contract_version,
        'contentFingerprint', (source_permission_entry).source_content_fingerprint,
        'resolutionFingerprint', (source_permission_entry).source_resolution_fingerprint
      ),
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', source_valid_until), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );

    for edge_item in
      select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
      where (value ->> 'relationshipId')::uuid = (relationship_decl ->> 'relationshipId')::uuid
        and (value ->> 'toRecordId')::uuid = p_record_id
    loop
      select value into source_record
      from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
      where (value -> 'recordScope' ->> 'recordId')::uuid = (edge_item ->> 'fromRecordId')::uuid
      limit 1;

      if source_record is null or source_record ->> 'lifecycleState' <> 'active' then
        continue;
      end if;
      source_record_scope := source_record -> 'recordScope';

      if pg_catalog.lower(source_record_scope ->> 'recordTypeId')
        <> pg_catalog.lower(relationship_decl ->> 'fromRecordTypeId') then
        continue;
      end if;

      if not vortex_access.record_relationship_witness_matches(
        (relationship_decl ->> 'relationshipId')::uuid,
        (relationship_decl ->> 'fromModuleRootId')::uuid,
        (relationship_decl ->> 'fromRecordTypeId')::uuid,
        (relationship_decl ->> 'toModuleRootId')::uuid,
        (relationship_decl ->> 'toRecordTypeId')::uuid,
        (edge_item ->> 'relationshipId')::uuid,
        (edge_item ->> 'fromRecordId')::uuid,
        (edge_item ->> 'toRecordId')::uuid,
        source_record_scope,
        target_record_scope,
        context_organization_id,
        p_application_root_id
      ) then
        continue;
      end if;

      sub_result := vortex_access.evaluate_record_permission_row_scope_internal(
        p_context,
        p_checked_at,
        p_auth_deadline,
        p_application_root_id,
        pg_catalog.jsonb_build_object('actionKind', 'read'),
        source_candidate,
        (edge_item ->> 'fromRecordId')::uuid,
        p_facts,
        pg_catalog.array_append(p_path, (route ->> 'sourcePermissionId')::uuid)
      );

      if pg_catalog.jsonb_array_length(sub_result) > 0 then
        select pg_catalog.min((elem.value ->> 'validUntil')::timestamptz) into sub_min_valid_until
        from pg_catalog.jsonb_array_elements(sub_result) as elem(value);

        contribution_deadline := least(source_valid_until, sub_min_valid_until);

        route_list := pg_catalog.array_append(route_list, pg_catalog.jsonb_build_object(
          'kind', 'relationship',
          'relationshipId', (route ->> 'relationshipId')::uuid,
          'sourcePermissionId', (route ->> 'sourcePermissionId')::uuid,
          'sourceRecordId', (edge_item ->> 'fromRecordId')::uuid
        ));
        deadline_list := pg_catalog.array_append(deadline_list, contribution_deadline);
      end if;
    end loop;
  end loop;

  -- Step 5: a saved condition narrows every route, including all_records.
  if coalesce(pg_catalog.array_length(route_list, 1), 0) > 0
    and candidate_record_scope ? 'savedCondition' then
    condition_id := (candidate_record_scope -> 'savedCondition' ->> 'conditionId')::uuid;

    select value into saved_condition
    from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
    where (value ->> 'conditionId')::uuid = condition_id
    limit 1;

    if saved_condition is null then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    projected_values := '{}'::jsonb;
    for declared_field in
      select value from pg_catalog.jsonb_array_elements(saved_condition -> 'declaredFieldIds') as item(value)
    loop
      if not ((target_record -> 'fieldValues') ? (declared_field #>> '{}')) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      projected_values := projected_values || pg_catalog.jsonb_build_object(
        declared_field #>> '{}', (target_record -> 'fieldValues') -> (declared_field #>> '{}')
      );
    end loop;

    reduced_type := pg_catalog.jsonb_build_object(
      'recordTypeId', target_type -> 'recordTypeId',
      'fields', target_type -> 'fields'
    ) || case
      when target_type ? 'validationContractVersion' then
        pg_catalog.jsonb_build_object(
          'validationContractVersion', target_type -> 'validationContractVersion'
        )
      else '{}'::jsonb
    end;

    condition_ok := vortex_access.evaluate_permission_saved_condition(
      candidate_record_scope, saved_condition, reduced_type, projected_values, context_account_id
    );

    if condition_ok is not true then
      route_list := array[]::jsonb[];
      deadline_list := array[]::timestamptz[];
    end if;
  end if;

  -- Step 6: map to full matched contributions for this candidate.
  result := '[]'::jsonb;
  for route_index in 1 .. coalesce(pg_catalog.array_length(route_list, 1), 0) loop
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'permission', candidate_permission,
      'recordScope', candidate_record_scope,
      'source', p_candidate -> 'source',
      'route', route_list[route_index],
      'validUntil', pg_catalog.to_char(
        pg_catalog.timezone('UTC', least(candidate_valid_until, deadline_list[route_index])),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ));
  end loop;

  return result;
end
$function$;

create or replace function vortex_access.evaluate_organization_record_access_internal(
  p_declaration jsonb,
  p_target_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  declaration_binding jsonb := p_declaration -> 'recordBinding';
  facts_binding jsonb;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  record_item jsonb;
  record_scope_item jsonb;
  edge_item jsonb;
  scope_key_count integer;
  seen_type_ids text[] := array[]::text[];
  seen_field_ids text[];
  seen_relationship_ids text[] := array[]::text[];
  seen_condition_ids text[] := array[]::text[];
  seen_record_ids text[] := array[]::text[];
  ctx jsonb;
  checked_at timestamptz;
  auth_deadline timestamptz;
  eligibility jsonb;
  decision_evidence jsonb;
  target_application_root_id uuid;
  target_record_row jsonb;
  target_ok boolean;
  matched jsonb;
  decision_valid_until text;
begin
  -- Facts shape: a closed object with exactly the declared top-level keys.
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object'
    or not (p_facts ?& array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_facts) as supplied(key)
      where supplied.key <> all (array['binding', 'recordTypes', 'relationships', 'sharingConditions', 'records', 'edges'])
    )
    or pg_catalog.jsonb_typeof(p_facts -> 'binding') <> 'object'
    or pg_catalog.jsonb_typeof(p_facts -> 'recordTypes') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'relationships') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'sharingConditions') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'records') <> 'array'
    or pg_catalog.jsonb_typeof(p_facts -> 'edges') <> 'array' then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  facts_binding := p_facts -> 'binding';
  if not (facts_binding ?& array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(facts_binding) as supplied(key)
      where supplied.key <> all (array['moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope'])
    )
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'moduleRootId')
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'recordTypeId')
    or not vortex_context.is_non_nil_uuid(facts_binding ->> 'storageContractId')
    or facts_binding ->> 'storageScope' not in ('organization_shared', 'application_contained') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  if pg_catalog.lower(facts_binding ->> 'moduleRootId') <> pg_catalog.lower(declaration_binding ->> 'moduleRootId')
    or pg_catalog.lower(facts_binding ->> 'recordTypeId') <> pg_catalog.lower(declaration_binding ->> 'recordTypeId')
    or pg_catalog.lower(facts_binding ->> 'storageContractId') <> pg_catalog.lower(declaration_binding ->> 'storageContractId')
    or (facts_binding ->> 'storageScope') <> (declaration_binding ->> 'storageScope') then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Record types: unique identity, well-formed ownership/field shape.
  for record_type_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'recordTypes') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_type_item) <> 'object'
      or not (record_type_item ?& array[
        'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope', 'ownershipMode', 'fields'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_type_item) as supplied(key)
        where supplied.key <> all (array[
          'moduleRootId', 'recordTypeId', 'storageContractId', 'storageScope',
          'ownershipMode', 'ownershipRelationshipId', 'validationContractVersion', 'fields'
        ])
      )
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'moduleRootId')
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(record_type_item ->> 'storageContractId')
      or record_type_item ->> 'storageScope' not in ('organization_shared', 'application_contained')
      or record_type_item ->> 'ownershipMode' not in ('none', 'organization_account', 'group', 'inherited')
      or ((record_type_item ? 'ownershipRelationshipId') <> (record_type_item ->> 'ownershipMode' = 'inherited'))
      or (record_type_item ? 'ownershipRelationshipId'
        and not vortex_context.is_non_nil_uuid(record_type_item ->> 'ownershipRelationshipId'))
      or (record_type_item ? 'validationContractVersion' and (
        pg_catalog.jsonb_typeof(record_type_item -> 'validationContractVersion') <> 'string'
        or record_type_item ->> 'validationContractVersion' not in ('1.0.0', '2.0.0', '3.0.0')
      ))
      or pg_catalog.jsonb_typeof(record_type_item -> 'fields') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_type_item ->> 'recordTypeId') = any (seen_type_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_type_ids := pg_catalog.array_append(seen_type_ids, pg_catalog.lower(record_type_item ->> 'recordTypeId'));

    seen_field_ids := array[]::text[];
    for field_item in
      select value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      if pg_catalog.jsonb_typeof(field_item) <> 'object'
        or not (field_item ?& array['fieldId', 'type'])
        or exists (
          select 1 from pg_catalog.jsonb_object_keys(field_item) as supplied(key)
          where supplied.key <> all (array['fieldId', 'type', 'settings'])
        )
        or not vortex_context.is_non_nil_uuid(field_item ->> 'fieldId')
        or pg_catalog.jsonb_typeof(field_item -> 'type') <> 'string'
        or (field_item ? 'settings' and pg_catalog.jsonb_typeof(field_item -> 'settings') <> 'object') then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      if pg_catalog.lower(field_item ->> 'fieldId') = any (seen_field_ids) then
        raise exception using errcode = '22023', message = 'Record access facts are invalid';
      end if;
      seen_field_ids := pg_catalog.array_append(seen_field_ids, pg_catalog.lower(field_item ->> 'fieldId'));
    end loop;
  end loop;

  if not (pg_catalog.lower(facts_binding ->> 'recordTypeId') = any (seen_type_ids)) then
    raise exception using errcode = '22023', message = 'Record access facts are invalid';
  end if;

  -- Relationships: unique identity, well-formed endpoints.
  for relationship_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'relationships') as item(value)
  loop
    if pg_catalog.jsonb_typeof(relationship_item) <> 'object'
      or not (relationship_item ?& array[
        'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toModuleRootId', 'toRecordTypeId'
      ])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(relationship_item) as supplied(key)
        where supplied.key <> all (array[
          'relationshipId', 'fromModuleRootId', 'fromRecordTypeId', 'toModuleRootId', 'toRecordTypeId'
        ])
      )
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'fromRecordTypeId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'toModuleRootId')
      or not vortex_context.is_non_nil_uuid(relationship_item ->> 'toRecordTypeId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(relationship_item ->> 'relationshipId') = any (seen_relationship_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_relationship_ids := pg_catalog.array_append(
      seen_relationship_ids, pg_catalog.lower(relationship_item ->> 'relationshipId')
    );
  end loop;

  -- Sharing conditions: unique identity, the fields the row-scope composition
  -- and the saved-condition predicate actually consume. Extra compiled-release
  -- fields (key, publicationTests, ...) are passed through untouched.
  for condition_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'sharingConditions') as item(value)
  loop
    if pg_catalog.jsonb_typeof(condition_item) <> 'object'
      or not (condition_item ?& array[
        'conditionId', 'sourceRecordTypeId', 'publishedRevision', 'contractFingerprint',
        'parameters', 'condition', 'declaredFieldIds'
      ])
      or not vortex_context.is_non_nil_uuid(condition_item ->> 'conditionId')
      or not vortex_context.is_non_nil_uuid(condition_item ->> 'sourceRecordTypeId')
      or pg_catalog.jsonb_typeof(condition_item -> 'publishedRevision') <> 'number'
      or pg_catalog.jsonb_typeof(condition_item -> 'contractFingerprint') <> 'string'
      or pg_catalog.jsonb_typeof(condition_item -> 'parameters') <> 'array'
      or pg_catalog.jsonb_typeof(condition_item -> 'condition') <> 'object'
      or pg_catalog.jsonb_typeof(condition_item -> 'declaredFieldIds') <> 'array' then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(condition_item ->> 'conditionId') = any (seen_condition_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_condition_ids := pg_catalog.array_append(
      seen_condition_ids, pg_catalog.lower(condition_item ->> 'conditionId')
    );
  end loop;

  -- Records: unique identity, well-formed record-identity scope, known type.
  for record_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) <> 'object'
      or not (record_item ?& array['recordScope', 'lifecycleState', 'fieldValues'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(record_item) as supplied(key)
        where supplied.key <> all (array[
          'recordScope', 'ownerOrganizationAccountId', 'ownerGroupId', 'lifecycleState', 'fieldValues'
        ])
      )
      or pg_catalog.jsonb_typeof(record_item -> 'recordScope') <> 'object'
      or record_item ->> 'lifecycleState' not in ('active', 'soft_deleted', 'removal_pending')
      or pg_catalog.jsonb_typeof(record_item -> 'fieldValues') <> 'object'
      or (record_item ? 'ownerOrganizationAccountId'
        and not vortex_context.is_non_nil_uuid(record_item ->> 'ownerOrganizationAccountId'))
      or (record_item ? 'ownerGroupId'
        and not vortex_context.is_non_nil_uuid(record_item ->> 'ownerGroupId'))
      or (record_item ? 'ownerOrganizationAccountId' and record_item ? 'ownerGroupId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    record_scope_item := record_item -> 'recordScope';
    select pg_catalog.count(*) into scope_key_count
    from pg_catalog.jsonb_object_keys(record_scope_item) as supplied(key);

    if not (record_scope_item ?& array[
        'storageScope', 'organizationId', 'moduleRootId', 'recordTypeId', 'storageContractId', 'recordId'
      ])
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'organizationId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'moduleRootId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'recordTypeId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'storageContractId')
      or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'recordId')
      or (record_scope_item ->> 'storageScope') not in ('organization_shared', 'application_contained')
      or (
        (record_scope_item ->> 'storageScope') = 'organization_shared'
        and (scope_key_count <> 6 or record_scope_item ? 'applicationRootId')
      )
      or (
        (record_scope_item ->> 'storageScope') = 'application_contained'
        and (scope_key_count <> 7 or not vortex_context.is_non_nil_uuid(record_scope_item ->> 'applicationRootId'))
      ) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(record_scope_item ->> 'recordTypeId') = any (seen_type_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if pg_catalog.lower(record_scope_item ->> 'recordId') = any (seen_record_ids) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    seen_record_ids := pg_catalog.array_append(seen_record_ids, pg_catalog.lower(record_scope_item ->> 'recordId'));
  end loop;

  -- Edges: well-formed, no dangling relationship or missing endpoint record.
  -- Duplicate/ambiguous edges are a functional refusal inside the row-scope
  -- composition, not a facts-shape violation, so they are not rejected here.
  for edge_item in
    select value from pg_catalog.jsonb_array_elements(p_facts -> 'edges') as item(value)
  loop
    if pg_catalog.jsonb_typeof(edge_item) <> 'object'
      or not (edge_item ?& array['relationshipId', 'fromRecordId', 'toRecordId'])
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(edge_item) as supplied(key)
        where supplied.key <> all (array['relationshipId', 'fromRecordId', 'toRecordId'])
      )
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'relationshipId')
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'fromRecordId')
      or not vortex_context.is_non_nil_uuid(edge_item ->> 'toRecordId') then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;

    if not (pg_catalog.lower(edge_item ->> 'relationshipId') = any (seen_relationship_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
    if not (pg_catalog.lower(edge_item ->> 'fromRecordId') = any (seen_record_ids))
      or not (pg_catalog.lower(edge_item ->> 'toRecordId') = any (seen_record_ids)) then
      raise exception using errcode = '22023', message = 'Record access facts are invalid';
    end if;
  end loop;

  -- One Access-version observation, one time sample, shared by the eligibility
  -- call and every row-scope composition below.
  ctx := vortex_access.validated_human_request_context();
  checked_at := pg_catalog.clock_timestamp();

  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, ctx, checked_at
  );

  decision_evidence := (eligibility - 'outcome' - 'validUntil' - 'eligiblePermissions' - 'reasonCode')
    || pg_catalog.jsonb_build_object('recordId', p_target_record_id, 'action', p_declaration -> 'action');

  if eligibility ->> 'outcome' = 'refused' then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', eligibility ->> 'reasonCode'
    );
  end if;

  target_application_root_id := (p_declaration -> 'target' ->> 'applicationRootId')::uuid;

  -- Target row check: fail closed, never raise. This is the cross-organisation
  -- and cross-application isolation path.
  select value into target_record_row
  from pg_catalog.jsonb_array_elements(p_facts -> 'records') as item(value)
  where (value -> 'recordScope' ->> 'recordId')::uuid = p_target_record_id
  limit 1;

  target_ok := target_record_row is not null
    and (target_record_row -> 'recordScope' ->> 'organizationId')::uuid = (ctx ->> 'organizationId')::uuid
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'moduleRootId') = pg_catalog.lower(facts_binding ->> 'moduleRootId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'recordTypeId') = pg_catalog.lower(facts_binding ->> 'recordTypeId')
    and pg_catalog.lower(target_record_row -> 'recordScope' ->> 'storageContractId') = pg_catalog.lower(facts_binding ->> 'storageContractId')
    and (target_record_row -> 'recordScope' ->> 'storageScope') = (facts_binding ->> 'storageScope')
    and (
      (facts_binding ->> 'storageScope') = 'organization_shared'
      or (target_record_row -> 'recordScope' ->> 'applicationRootId')::uuid = target_application_root_id
    )
    and target_record_row ->> 'lifecycleState' = 'active';

  if not target_ok then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    ctx, checked_at, p_declaration -> 'recentAuthentication'
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      contribution.value
      order by
        alt.ordinality,
        case contribution.value -> 'route' ->> 'kind'
          when 'all_records' then 0
          when 'ownership' then 1
          when 'direct_share' then 2
          when 'relationship' then 3
        end,
        coalesce(
          contribution.value -> 'route' ->> 'directShareId',
          contribution.value -> 'route' ->> 'sourceRecordId',
          ''
        )
    ),
    '[]'::jsonb
  )
  into matched
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    with ordinality as alt(value, ordinality)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      ctx,
      checked_at,
      auth_deadline,
      target_application_root_id,
      p_declaration -> 'action',
      alt.value,
      p_target_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);

  if pg_catalog.jsonb_array_length(matched) = 0 then
    return decision_evidence || pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_scope_refused'
    );
  end if;

  select pg_catalog.to_char(
    pg_catalog.timezone('UTC', pg_catalog.min((elem.value ->> 'validUntil')::timestamptz)),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
  into decision_valid_until
  from pg_catalog.jsonb_array_elements(matched) as elem(value);

  return decision_evidence || pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'validUntil', decision_valid_until,
    'matchedContributions', matched
  );
end
$function$;

set local role vortex_record_owner;

create or replace function vortex_record.provision_exact_module_storage(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  content_fingerprint text,
  resolution_fingerprint text,
  generator_contract_version text,
  storage_contract_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  field_value jsonb;
  relationship_value jsonb;
  target_value jsonb;
  target_ids uuid[];
  storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  relationship_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_check text;
  owner_check text;
  scope_index_columns text;
  result_storage_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Record storage release selector is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  -- Module V3 reuses the Module V2 record-type content, so both validation
  -- contracts allocate identical storage. The source contract must agree with
  -- the validation contract, and the embedded identity is compared with
  -- IS DISTINCT FROM so an absent JSON member cannot evade the gate.
  if release_row.validation_contract_version not in ('2.0.0', '3.0.0')
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;

  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array'
    or pg_catalog.jsonb_array_length(record_types) < 1 then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;

  perform 1 from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision
  for update;
  if found then
    select provision.storage_contract_ids into result_storage_ids
    from vortex_record.release_provisions as provision
    where provision.module_root_id = p_module_root_id
      and provision.release_revision = p_module_release_revision
      and provision.content_fingerprint = release_row.content_fingerprint
      and provision.resolution_fingerprint = release_row.resolution_fingerprint
      and provision.generator_contract_version = '1.0.0';
    if result_storage_ids is null then
      raise exception using errcode = '55000', message = 'Stored release provision evidence is incompatible';
    end if;
    if result_storage_ids is distinct from (
      select pg_catalog.array_agg((item.value ->> 'storageContractId')::uuid order by item.value ->> 'storageContractId')
      from pg_catalog.jsonb_array_elements(record_types) as item(value)
    ) then
      raise exception using errcode = '55000', message = 'Stored release provision identities are incompatible';
    end if;
    result_storage_ids := array[]::uuid[];
  end if;

  if (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    where (
      select pg_catalog.count(*) <> pg_catalog.count(distinct field_item.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(record_item.value -> 'fields') as field_item(value)
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct relationship_item.value ->> 'relationshipId')
    from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'relationships'
    ) as relationship_item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module field or relationship identities are duplicated';
  end if;

  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_context.is_non_nil_uuid(storage_id::text)
      or not vortex_context.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;
    -- The record-type loop is ordered by storage identity, so overlapping
    -- provisions acquire absent and existing lineage locks deterministically.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(storage_id::text), '-', '');
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(record_type);
    result_storage_ids := result_storage_ids || storage_id;
    scope_index_columns := case storage_scope_value
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;

    select catalogue.* into stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
    for update;

    if not found then
      scope_check := case storage_scope_value
        when 'organization_shared' then 'application_root_id is null'
        else 'application_root_id is not null'
      end;
      owner_check := case ownership_mode_value
        when 'organization_account' then
          'owner_organisation_account_id is not null and owner_group_id is null'
        when 'group' then
          'owner_organisation_account_id is null and owner_group_id is not null'
        else 'owner_organisation_account_id is null and owner_group_id is null'
      end;
      execute pg_catalog.format(
        'create table record_data.%I (
          organisation_id uuid not null references vortex_identity.organizations (organization_id),
          module_root_id uuid not null check (module_root_id = %L::uuid),
          record_type_id uuid not null check (record_type_id = %L::uuid),
          storage_contract_id uuid not null check (storage_contract_id = %L::uuid),
          record_id uuid not null,
          application_root_id uuid,
          definition_revision bigint not null check (definition_revision between 1 and 9007199254740991),
          owner_organisation_account_id uuid,
          owner_group_id uuid,
          lifecycle_state text not null check (lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')),
          concurrency_number bigint not null check (concurrency_number between 1 and 9007199254740991),
          created_at timestamptz not null,
          created_by uuid not null,
          updated_at timestamptz not null,
          updated_by uuid not null,
          deleted_at timestamptz,
          deleted_by uuid,
          removal_due_at timestamptz,
          primary key (%s, record_id),
          foreign key (organisation_id, owner_organisation_account_id)
            references vortex_identity.organization_accounts (organization_id, organization_account_id),
          foreign key (organisation_id, owner_group_id)
            references vortex_access.organization_groups (organization_id, group_id),
          check (%s), check (%s),
          check ((deleted_at is null) = (deleted_by is null)),
          check ((lifecycle_state = ''active'') = (deleted_at is null and deleted_by is null)),
          check (updated_at >= created_at)
        )', table_token, p_module_root_id, record_type_id_value, storage_id,
        scope_index_columns, scope_check, owner_check
      );
      execute pg_catalog.format('alter table record_data.%I enable row level security', table_token);
      execute pg_catalog.format('alter table record_data.%I force row level security', table_token);
      execute pg_catalog.format(
        'create policy record_select on record_data.%I for select to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_insert on record_data.%I for insert to vortex_record_adapter with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_update on record_data.%I for update to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        ) with check (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'create policy record_delete on record_data.%I for delete to vortex_record_adapter using (
          organisation_id = vortex_context.organization_id()
          and case when application_root_id is null then true
            else application_root_id = vortex_context.application_root_id(true) end
        )', table_token
      );
      execute pg_catalog.format(
        'grant select, insert, update, delete on record_data.%I to vortex_record_adapter',
        table_token
      );

      insert into vortex_record.storage_catalogue (
        storage_contract_id, physical_schema_token, physical_table_token,
        module_root_id, record_type_id, storage_scope,
        first_compatible_release_revision, last_compatible_release_revision,
        state, generator_contract_version, content_fingerprint, record_type_definition
      ) values (
        storage_id, 'record_data', table_token, p_module_root_id,
        record_type_id_value, storage_scope_value, p_module_release_revision,
        p_module_release_revision, 'active', '1.0.0', shape_fingerprint, record_type
      );
      any_change := true;
    else
      if stored_catalogue.module_root_id <> p_module_root_id
        or stored_catalogue.record_type_id <> record_type_id_value
        or stored_catalogue.storage_scope <> storage_scope_value
        or stored_catalogue.state <> 'active'
        or stored_catalogue.generator_contract_version <> '1.0.0'
        or stored_catalogue.physical_schema_token <> 'record_data'
        or stored_catalogue.physical_table_token <> table_token
        or pg_catalog.to_regclass(pg_catalog.format('%I.%I', 'record_data', table_token)) is null then
        raise exception using errcode = '55000', message = 'Record storage lineage is incompatible';
      end if;
    end if;

    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_context.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);

      select mapping.* into stored_field
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.field_id = field_id_value
      for update;
      if found then
        if stored_field.physical_column_token <> column_token
          or stored_field.database_value_type <> database_type
          or stored_field.state <> 'active'
          or vortex_record.field_storage_meaning(stored_field.field_definition)
            is distinct from vortex_record.field_storage_meaning(field_value)
          or not exists (
            select 1
            from pg_catalog.pg_attribute as attribute
            where attribute.attrelid = pg_catalog.to_regclass(
                pg_catalog.format('%I.%I', 'record_data', table_token)
              )
              and attribute.attname = column_token
              and attribute.attnum > 0
              and not attribute.attisdropped
          ) then
          raise exception using errcode = '55000', message = 'Existing record field storage is incompatible';
        end if;
      else
        if stored_catalogue.storage_contract_id is not null
          and (field_value ->> 'required')::boolean then
          raise exception using errcode = '55000', message = 'Compatible storage upgrades may add only nullable fields';
        end if;
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s%s',
          table_token, column_token, sql_type,
          case when (field_value ->> 'required')::boolean then ' not null' else '' end
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          storage_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
        if (field_value ->> 'unique')::boolean then
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            'ux_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          execute pg_catalog.format(
            'create index %I on record_data.%I (%s, %I)',
            'ix_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        end if;
        any_change := true;
      end if;
    end loop;

    if exists (
      select 1 from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = storage_id and mapping.state = 'active'
        and mapping.introduced_at_release_revision <= p_module_release_revision
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
          where item.value ->> 'fieldId' = mapping.field_id::text
        )
    ) then
      raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove fields';
    end if;

    if stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision < p_module_release_revision then
      update vortex_record.storage_catalogue
      set last_compatible_release_revision = greatest(
            last_compatible_release_revision, p_module_release_revision
          ),
          content_fingerprint = shape_fingerprint,
          record_type_definition = record_type,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
      any_change := true;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.first_compatible_release_revision > p_module_release_revision then
      -- A newer release may have created the shared table first. The loops above
      -- prove the older release is a compatible subset; retain the newer shape.
      update vortex_record.storage_catalogue
      set first_compatible_release_revision = p_module_release_revision,
          changed_at = pg_catalog.statement_timestamp()
      where storage_contract_id = storage_id;
    elsif stored_catalogue.storage_contract_id is not null
      and stored_catalogue.last_compatible_release_revision = p_module_release_revision
      and stored_catalogue.content_fingerprint <> shape_fingerprint then
      raise exception using errcode = '55000', message = 'Stored record storage meaning is incompatible';
    end if;
  end loop;

  if exists (
    select 1
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.module_root_id = p_module_root_id
      and mapping.release_revision <= p_module_release_revision
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_types) as record_item(value)
        cross join lateral pg_catalog.jsonb_array_elements(
          record_item.value -> 'relationships'
        ) as relationship_item(value)
        where relationship_item.value ->> 'relationshipId' = mapping.relationship_id::text
      )
  ) then
    raise exception using errcode = '55000', message = 'Compatible storage upgrades cannot remove relationships';
  end if;

  for record_type in select item.value from pg_catalog.jsonb_array_elements(record_types) as item(value)
  loop
    storage_id := (record_type ->> 'storageContractId')::uuid;
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type -> 'relationships') as item(value)
    loop
      relationship_id_value := (relationship_value ->> 'relationshipId')::uuid;
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      target_ids := array[]::uuid[];
      if relationship_value ? 'toRecordType' then
        target_ids := array[(relationship_value #>> '{toRecordType,recordTypeId}')::uuid];
      else
        for target_value in select item.value
          from pg_catalog.jsonb_array_elements(relationship_value -> 'toRecordTypes') as item(value)
        loop
          target_ids := target_ids || (target_value ->> 'recordTypeId')::uuid;
        end loop;
      end if;
      if pg_catalog.cardinality(target_ids) < 1 or array_position(target_ids, null) is not null then
        raise exception using errcode = '42501', message = 'Relationship target evidence is unresolved';
      end if;
      insert into vortex_record.relationship_storage_mappings (
        relationship_id, module_root_id, release_revision, source_storage_contract_id,
        source_field_id, target_record_type_ids, cardinality, on_parent_delete, definition
      ) values (
        relationship_id_value, p_module_root_id, p_module_release_revision, storage_id,
        field_id_value, target_ids, relationship_value ->> 'cardinality',
        relationship_value ->> 'onParentDelete', relationship_value
      )
      on conflict (relationship_id) do update
      set release_revision = greatest(
            vortex_record.relationship_storage_mappings.release_revision,
            excluded.release_revision
          )
      where vortex_record.relationship_storage_mappings.module_root_id = excluded.module_root_id
        and vortex_record.relationship_storage_mappings.source_storage_contract_id = excluded.source_storage_contract_id
        and vortex_record.relationship_storage_mappings.source_field_id = excluded.source_field_id
        and vortex_record.relationship_storage_mappings.target_record_type_ids = excluded.target_record_type_ids
        and vortex_record.relationship_storage_mappings.cardinality = excluded.cardinality
        and vortex_record.relationship_storage_mappings.on_parent_delete = excluded.on_parent_delete
        and vortex_record.relationship_storage_mappings.definition = excluded.definition;
      if not found then
        raise exception using errcode = '55000', message = 'Existing relationship storage is incompatible';
      end if;
    end loop;
  end loop;

  select pg_catalog.array_agg(value order by value) into result_storage_ids
  from pg_catalog.unnest(result_storage_ids) as item(value);
  insert into vortex_record.release_provisions (
    module_root_id, release_revision, content_fingerprint, resolution_fingerprint,
    generator_contract_version, storage_contract_ids
  ) values (
    p_module_root_id, p_module_release_revision, release_row.content_fingerprint,
    release_row.resolution_fingerprint, '1.0.0', result_storage_ids
  ) on conflict on constraint release_provisions_pkey do nothing;

  return query select p_module_root_id, p_module_release_revision,
    release_row.content_fingerprint, release_row.resolution_fingerprint,
    '1.0.0'::text, result_storage_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module storage evidence is ambiguous';
end
$function$;

reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  submitted_id uuid;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    if pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;

    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(vortex_record.allocate_reference_number_internal(
          (context_value ->> 'organizationId')::uuid,
          (meta ->> 'storageContractId')::uuid,
          field_id_value, app_scope, field_item -> 'settings'
        ));
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      column_names := pg_catalog.array_append(
        column_names, pg_catalog.format('%I', column_value ->> 'token')
      );
      column_values := pg_catalog.array_append(column_values,
        case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
          when 'timestamp_with_time_zone' then
            pg_catalog.format('%L::timestamptz', input_value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
          else pg_catalog.format('%L::text', input_value #>> '{}')
        end end
      );
    end loop;

    insert_sql := pg_catalog.format(
      'insert into record_data.%I (
         organisation_id, module_root_id, record_type_id, storage_contract_id,
         record_id, application_root_id, definition_revision,
         owner_organisation_account_id, owner_group_id, lifecycle_state,
         concurrency_number, created_at, created_by, updated_at, updated_by%s
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
         pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)',
      meta ->> 'table',
      case when pg_catalog.cardinality(column_names) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
      case when pg_catalog.cardinality(column_values) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_values, ', ') end
    );
    execute insert_sql using
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'moduleRootId')::uuid, p_record_type_id,
      (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
      (meta ->> 'moduleReleaseRevision')::bigint,
      owner_account_id, owner_group_id,
      (context_value ->> 'organizationAccountId')::uuid;

    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, record_id_value,
          (relationship_value ->> 'relationshipId')::uuid,
          final_values -> pg_catalog.lower(field_id_value::text), false
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'create', record_id_value, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'access_refused';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    foreach submitted_id in array p_submitted_field_ids loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', 1, 'values', final_values
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

create or replace function vortex_record.transfer_record_ownership(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  command_fingerprint_value text;
  receipt vortex_record.save_command_receipts%rowtype;
  inserted_command_id uuid;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  projection jsonb;
  event_result jsonb;
  updated_concurrency_number bigint;
  changed_rows integer;
begin
  if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind not in ('organization_account', 'group')
    or p_target_id is null or p_target_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  command_fingerprint_value := vortex_record.ownership_transfer_command_fingerprint_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_target_kind, p_target_id, 'public', null
  );

  insert into vortex_record.save_command_receipts (
    organization_id, application_root_id, actor_organization_account_id, command_id,
    command_fingerprint, record_type_id, operation, state
  ) values (
    organization_id_value, application_root_id_value, actor_id_value, p_command_id,
    command_fingerprint_value, p_record_type_id, 'transfer_ownership', 'pending'
  ) on conflict do nothing returning command_id into inserted_command_id;

  if inserted_command_id is null then
    select stored.* into strict receipt from vortex_record.save_command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_id = p_command_id for update;
    if receipt.command_fingerprint is distinct from command_fingerprint_value
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.operation is distinct from 'transfer_ownership' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt.state <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- A replay reprojects from current access and intentionally never returns
    -- owner metadata (including the prior target).
    projection := vortex_record.read_record(p_record_type_id, receipt.record_id);
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId', 'replayed', true
    );
  end if;

  -- The closed transfer authority is its own exact record permission decision;
  -- it is evaluated under the record lock, while owner columns remain
  -- unavailable to the ordinary update writer.
  -- Public transfer is active-installation-only.  It deliberately never calls
  -- the retained/detached reader, so a detached record cannot leak its current
  -- revision through the ordinary conflict response.
  begin
    installation := vortex_module.read_current_active_installation();
  exception
    when no_data_found then
      delete from vortex_record.save_command_receipts where organization_id = organization_id_value
        and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
        and command_id = p_command_id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
  end;
  loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number, installation
  );
  if loaded ->> 'outcome' = 'conflict' then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into record_type_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if record_fact is null or record_type_fact is null
    or record_fact ->> 'lifecycleState' <> 'active' then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  ownership_mode := record_type_fact ->> 'ownershipMode';
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_ownership_transfer_activity_internal(
      p_activity_id, organization_id_value, 'refused'
    );
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  elsif decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
  end if;
  if ownership_mode = 'organization_account' then
    previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
  elsif ownership_mode = 'group' then
    previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
  else
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if (ownership_mode = 'organization_account' and p_target_kind <> 'organization_account')
    or (ownership_mode = 'group' and p_target_kind <> 'group')
    or previous_owner_id is null or previous_owner_id = p_target_id
    or not vortex_access.lock_active_record_ownership_target_internal(p_target_kind, p_target_id) then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'owner_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id = $3,
       owner_group_id = $4, concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $6 returning stored.concurrency_number',
    loaded ->> 'table'
  ) into updated_concurrency_number using organization_id_value, p_record_id,
    case when p_target_kind = 'organization_account' then p_target_id else null end,
    case when p_target_kind = 'group' then p_target_id else null end,
    actor_id_value, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
  end if;
  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (record_type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
  event_result := vortex_event.append_record_occurrences(
    (record_type_fact ->> 'storageContractId')::uuid,
    p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
      ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
  end if;
  update vortex_record.save_command_receipts as stored set state = 'completed',
    record_id = p_record_id, concurrency_number = updated_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = organization_id_value
    and stored.application_root_id = application_root_id_value
    and stored.actor_organization_account_id = actor_id_value
    and stored.command_id = p_command_id and stored.state = 'pending';
  if not found then raise exception using errcode = '40001', message = 'Record ownership transfer receipt is stale'; end if;
  -- This is deliberately an undisclosed result: an authorised transfer may
  -- remove the operator's read path.  A post-write projection would turn that
  -- valid committed mutation into a rollback.  Exact replay still applies
  -- current disclosure separately above.
  return pg_catalog.jsonb_build_object(
    'outcome', 'transferred', 'recordId', p_record_id,
    'concurrencyNumber', updated_concurrency_number,
    'correlationId', context_value -> 'correlationId', 'replayed', false
  );
end
$function$;

create or replace function vortex_record.named_action_creation_plan_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  effect_value jsonb;
  effect_ordinal integer;
  target_type_id uuid;
  target_meta jsonb;
  target_type jsonb;
  ownership_mode text;
  field_key text;
  field_value jsonb;
  relationship_value jsonb;
  create_targets jsonb := '[]'::jsonb;
  supplied jsonb;
  expected_plan jsonb := '[]'::jsonb;
  supplied_plan jsonb := '[]'::jsonb;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );

  -- Refusal 5, and the one place this slice narrows what an action may
  -- express. `save_named_action_set_fields_internal:591` writes the subject's
  -- own relationship edge inside the same call that claims the command
  -- receipt, so it necessarily takes the relationship advisory key (L6) before
  -- any creation can allocate a reference-number counter (L4). Ordinary create
  -- takes those in the opposite order (`20260913030000:787-806` before
  -- `:868-877`), which is a hard cycle: this command would hold
  -- `A(relS, X)` and wait for `C(storage(S), refField)` while a concurrent
  -- ordinary create of `S` linked to `X` holds that counter and waits for
  -- `A(relS, X)`. Lifting this needs an explicit named-action subject writer
  -- that allocates the creations' reference numbers between claiming the
  -- receipt and writing the subject's edges; that is deliberately not done
  -- here rather than hidden.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'create_record'
  ) and exists (
    select 1
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects') effect(value)
    join pg_catalog.jsonb_array_elements(
      action_context -> 'recordType' -> 'fields'
    ) field(value)
      on pg_catalog.lower(field.value ->> 'fieldId') =
        pg_catalog.lower(effect.value ->> 'fieldId')
    where effect.value ->> 'kind' = 'set_field'
      and field.value ->> 'type' in ('link', 'link_to_one_of_several')
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', 'create_with_subject_link_unsupported'
    );
  end if;

  for effect_value, effect_ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects')
      with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if effect_value ->> 'kind' <> 'create_record' then continue; end if;
    if effect_value #>> '{recordType,state}' is distinct from 'resolved'
      or not pg_catalog.pg_input_is_valid(
        effect_value #>> '{recordType,recordTypeId}', 'uuid'
      )
      or pg_catalog.jsonb_typeof(effect_value -> 'values') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    target_type_id := (effect_value #>> '{recordType,recordTypeId}')::uuid;
    target_meta := vortex_record.resolve_record_action_context_internal(
      target_type_id, 'create'
    );
    target_type := target_meta -> 'recordType';
    if pg_catalog.jsonb_typeof(target_type) <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
      );
    end if;
    ownership_mode := target_type ->> 'ownershipMode';

    -- Refusal 1: #50 forbids a caller-supplied final owner, so
    -- `p_selected_group_id` is permanently null and a `group` target could only
    -- fail with `owner_unavailable` after its insert.
    if ownership_mode = 'group' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_owner_unsupported'
      );
    end if;
    -- Refusal 2: an `inherited` target derives its owner from one declared
    -- relationship, which the authored field map must name.
    if ownership_mode = 'inherited'
      and not (effect_value -> 'values') ? pg_catalog.lower(
        target_type ->> 'ownershipRelationshipId'
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', 'create_target_owner_relationship_missing'
      );
    end if;

    for field_key in
      select pg_catalog.lower(item.value)
      from pg_catalog.jsonb_object_keys(effect_value -> 'values') item(value)
    loop
      select item.value into field_value
      from pg_catalog.jsonb_array_elements(target_type -> 'fields') item(value)
      where pg_catalog.lower(item.value ->> 'fieldId') = field_key;
      if field_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_field_unknown'
        );
      end if;
      if field_value ->> 'type' = 'reference_number' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', 'create_target_generated_field'
        );
      end if;
      -- Refusal 3: only the delivered #402 single-target to-one link semantics
      -- are implemented. Polymorphic targets remain #49 and must refuse, never
      -- be silently skipped.
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into relationship_value
        from pg_catalog.jsonb_array_elements(target_type -> 'relationships') item(value)
        where pg_catalog.lower(item.value ->> 'fromFieldId') = field_key;
        if field_value ->> 'type' <> 'link'
          or relationship_value is null
          or not (relationship_value ? 'toRecordType')
          or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
          return pg_catalog.jsonb_build_object(
            'outcome', 'unsupported', 'reasonCode', 'create_target_relationship_unsupported'
          );
        end if;
      end if;
    end loop;

    create_targets := create_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', effect_ordinal,
        'recordTypeId', target_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_meta ->> 'storageScope',
        'ownershipMode', ownership_mode,
        'recordType', target_type
      )
    );
    expected_plan := expected_plan || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'ordinal', effect_ordinal,
        'recordTypeId', pg_catalog.lower(target_type_id::text),
        'valueFieldIds', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
          from pg_catalog.jsonb_object_keys(effect_value -> 'values') item(value)
        ), '[]'::jsonb)
      )
    );
  end loop;

  if p_creations is not null then
    if pg_catalog.jsonb_typeof(p_creations) <> 'array' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    for supplied in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(supplied) <> 'object'
        or not (supplied ?& array['ordinal', 'recordTypeId', 'values', 'finalValues'])
        or pg_catalog.jsonb_typeof(supplied -> 'values') <> 'object'
        or pg_catalog.jsonb_typeof(supplied -> 'finalValues') <> 'object'
        or not pg_catalog.pg_input_is_valid(supplied ->> 'recordTypeId', 'uuid') then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      supplied_plan := supplied_plan || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'ordinal', (supplied ->> 'ordinal')::integer,
          'recordTypeId', pg_catalog.lower((supplied ->> 'recordTypeId')::uuid::text),
          'valueFieldIds', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.lower(item.value) order by pg_catalog.lower(item.value) collate "C")
            from pg_catalog.jsonb_object_keys(supplied -> 'values') item(value)
          ), '[]'::jsonb)
        )
      );
    end loop;
    if supplied_plan is distinct from expected_plan then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'creation_plan_mismatch'
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'planned', 'createTargets', create_targets
  );
exception
  when no_data_found or too_many_rows then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', 'create_target_unresolved'
    );
end
$function$;

create or replace function vortex_record.insert_named_action_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  app_scope uuid;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <> (
      select pg_catalog.count(distinct value)
      from pg_catalog.unnest(p_submitted_field_ids) as item(value)
    ) then
    raise exception using errcode = '22023', message = 'Named action creation is invalid';
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
  if pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = '55000', message = 'Named action creation target is unavailable';
  end if;
  context_value := meta -> 'context';
  record_type_value := meta -> 'recordType';
  ownership_mode := record_type_value ->> 'ownershipMode';
  app_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;

  if ownership_mode = 'organization_account' then
    owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
  elsif ownership_mode = 'group' then
    -- Refused by the creation plan; #50 forbids a caller-supplied final owner.
    raise exception using errcode = '42501',
      message = 'Named action creation owner is unavailable';
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
    where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
  ) then
    raise exception using errcode = '23514', message = 'Named action creation field is unknown';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id_value := (field_item ->> 'fieldId')::uuid;
    column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
    if field_item ->> 'type' = 'reference_number' then
      if final_values ? pg_catalog.lower(field_id_value::text)
        or field_id_value = any (p_submitted_field_ids) then
        raise exception using errcode = '23514',
          message = 'Named action creation cannot submit a generated field';
      end if;
      input_value := pg_catalog.to_jsonb(vortex_record.allocate_reference_number_internal(
        (context_value ->> 'organizationId')::uuid,
        (meta ->> 'storageContractId')::uuid,
        field_id_value, app_scope, field_item -> 'settings'
      ));
      final_values := final_values || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_id_value::text), input_value
      );
    elsif final_values ? pg_catalog.lower(field_id_value::text) then
      input_value := final_values -> pg_catalog.lower(field_id_value::text);
      if (field_item ->> 'required')::boolean
        and pg_catalog.jsonb_typeof(input_value) = 'null' then
        raise exception using errcode = '23514',
          message = 'Named action creation is missing a required value';
      end if;
      if not vortex_record.canonical_record_value_matches(
        input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
      ) then
        raise exception using errcode = '23514',
          message = 'Named action creation value is invalid';
      end if;
    else
      if (field_item ->> 'required')::boolean then
        raise exception using errcode = '23514',
          message = 'Named action creation is missing a required value';
      end if;
      continue;
    end if;

    column_names := pg_catalog.array_append(
      column_names, pg_catalog.format('%I', column_value ->> 'token')
    );
    column_values := pg_catalog.array_append(column_values,
      case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
      else case column_value ->> 'databaseValueType'
        when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
        when 'timestamp_with_time_zone' then
          pg_catalog.format('%L::timestamptz', input_value #>> '{}')
        when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
        when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
        when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
        when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
        else pg_catalog.format('%L::text', input_value #>> '{}')
      end end
    );
  end loop;

  insert_sql := pg_catalog.format(
    'insert into record_data.%I (
       organisation_id, module_root_id, record_type_id, storage_contract_id,
       record_id, application_root_id, definition_revision,
       owner_organisation_account_id, owner_group_id, lifecycle_state,
       concurrency_number, created_at, created_by, updated_at, updated_by%s
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, null, ''active'', 1,
       pg_catalog.statement_timestamp(), $9, pg_catalog.statement_timestamp(), $9%s)',
    meta ->> 'table',
    case when pg_catalog.cardinality(column_names) = 0 then ''
      else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
    case when pg_catalog.cardinality(column_values) = 0 then ''
      else ', ' || pg_catalog.array_to_string(column_values, ', ') end
  );
  execute insert_sql using
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'moduleRootId')::uuid, p_record_type_id,
    (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
    (meta ->> 'moduleReleaseRevision')::bigint,
    owner_account_id,
    (context_value ->> 'organizationAccountId')::uuid;

  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'storageContractId')::uuid, app_scope
  );
  return pg_catalog.jsonb_build_object(
    'recordId', record_id_value,
    'storageContractId', (meta ->> 'storageContractId')::uuid,
    'values', final_values
  );
end
$function$;

reset role;

commit;
