-- R3.3d part 1 (#2238): delegation scope no longer carries a fingerprint.
--
-- A bounded delegation scope was stored with a sha256 "scopeFingerprint" of its permission list that the database only
-- format-checked and that was "preparation provenance only": authority is the stored exact permission tuples. The race
-- protection of a delegation change (a person previews a change, then applies it) is the expected delegation revision,
-- which the change functions already compare under a row lock. The fingerprint is deleted with its column, constraint,
-- parameter, prepared-scope field and read projection.
-- Removed: column organization_delegation_authorities.scope_fingerprint; function
-- coordinate_private_organization_delegation_authority_change (no caller; execute was revoked from every role).
-- Rewritten without the fingerprint: coordinate_delegation_change_without_stewardship_v1_internal and
-- coordinate_organization_delegation_authority_change (argument p_scope_fingerprint removed),
-- protect_organization_delegation_authority, read_organization_delegation_authority,
-- appoint_organization_steward_for_administration, coordinate_organization_stewardship_adoption,
-- revoke_organization_delegation_authority_for_administration (one fewer positional argument).

drop function vortex_access.coordinate_private_organization_delegation_authority_change(text, uuid, bigint, text, uuid, uuid, jsonb, timestamptz, timestamptz, uuid);
drop function vortex_access.coordinate_organization_delegation_authority_change(text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text, timestamptz, timestamptz, uuid, uuid);
drop function vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(text, uuid, uuid, bigint, text, uuid, uuid, text, jsonb, text, timestamptz, timestamptz, uuid, uuid);

alter table vortex_access.organization_delegation_authorities
  drop constraint organization_delegation_authorities_scope_shape;
alter table vortex_access.organization_delegation_authorities
  drop column scope_fingerprint;
alter table vortex_access.organization_delegation_authorities
  add constraint organization_delegation_authorities_scope_shape check (
    (scope_kind = 'organization_catalogue' and bounded_permissions is null)
    or (
      scope_kind = 'bounded' and bounded_permissions is not null
      and case when jsonb_typeof(bounded_permissions) = 'array'
        then jsonb_array_length(bounded_permissions) > 0 else false end
    )
  );

CREATE FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, delegation jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
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
      and p_bounded_permissions is not null
    )
    or (
      p_scope_kind = 'bounded'
      and p_bounded_permissions is null
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
      revision, starts_at, expires_at, state, granted_by,
      granted_at, grant_correlation_id, changed_by, changed_at,
      change_correlation_id, revoked_by, revoked_at,
      revocation_correlation_id
    ) values (
      p_organization_id, p_delegation_authority_id, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, 1, p_starts_at,
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
          'permissions', delegation_fact.bounded_permissions
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
$_$;

ALTER FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) IS 'Owner-only atomic delegation grant, whole-scope replacement or terminal revocation. It changes Access once but grants no caller authority.';

REVOKE ALL ON FUNCTION vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

CREATE FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, delegation jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(
      p_operation, p_organization_id, p_delegation_authority_id,
      p_expected_delegation_revision, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, p_starts_at,
      p_expires_at, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.delegation ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation,
    changed.delegation, changed.access_version, changed.correlation_id;
end
$$;

ALTER FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION vortex_access.protect_organization_delegation_authority() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  permissions_changed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Organization delegation authorities cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Organization delegation authority revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.organization_id is distinct from old.organization_id
    or new.delegation_authority_id is distinct from
      old.delegation_authority_id
    or new.holder_kind is distinct from old.holder_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at
    or (new.changed_by, new.changed_at, new.change_correlation_id)
      is not distinct from
      (old.changed_by, old.changed_at, old.change_correlation_id) then
    raise exception using errcode = '23514',
      message = 'Organization delegation authority identity or evidence is immutable';
  end if;

  permissions_changed := new.bounded_permissions is distinct from
    old.bounded_permissions;

  if new.state = 'revoked' then
    if new.revoked_at is null
      or new.revoked_at < old.changed_at
      or new.scope_kind is distinct from old.scope_kind
      or permissions_changed then
      raise exception using errcode = '23514',
        message = 'Delegation revocation cannot alter scope or predate current evidence';
    end if;
    return new;
  end if;

  if new.state <> 'live'
    or (
      new.scope_kind is not distinct from old.scope_kind
      and not permissions_changed
    ) then
    raise exception using errcode = '23514',
      message = 'Delegation scope replacement must replace one exact whole scope';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.protect_organization_delegation_authority() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_delegation_authority() FROM PUBLIC;

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

create or replace function vortex_access.appoint_organization_steward_for_administration(
  p_organization_account_id uuid,
  p_expected_account_revision bigint
)
returns table (
  outcome text,
  organization_id uuid,
  appointment_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_channel text;
  locked_access_version bigint;
  stewardship_requirement vortex_access.organization_stewardship_requirements%rowtype;
  target_account vortex_identity.organization_accounts%rowtype;
  steward_role vortex_access.organization_roles%rowtype;
  steward_role_revision vortex_access.organization_role_revisions%rowtype;
  assignment_fact vortex_access.organization_role_assignments%rowtype;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  decision record;
  role_decision record;
  version_change record;
  affected_permissions jsonb;
  guarded_minimum jsonb;
  current_guarded_minimum jsonb;
  catalogue_declaration jsonb;
  existing_steward_role_id uuid;
  existing_role_assignment_id uuid;
  existing_delegation_authority_id uuid;
  steward_role_is_qualified boolean;
  generated_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  generated_delegation_authority_id uuid := pg_catalog.gen_random_uuid();
  activity_id uuid;
  activity_result text;
  appointment_starts_at timestamptz;
  authorization_checked_at timestamptz;
  result_summary jsonb;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_account_revision is null
    or p_expected_account_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization steward appointment input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_channel := vortex_platform.channel();

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select requirement.* into stewardship_requirement
  from vortex_access.organization_stewardship_requirements as requirement
  where requirement.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  catalogue_declaration := pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.delegations.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    );
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.grant'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, decision.checked_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null
    or decision.valid_until is null
    or decision.checked_at > pg_catalog.clock_timestamp()
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or decision.valid_until <= decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  select account.* into target_account
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
  where account.organization_id = context_organization_id
    and account.organization_account_id = p_organization_account_id
    and account.state = 'active'
    and identity.state = 'active'
  for update of account, identity;
  if not found or p_organization_account_id = context_account_id then
    activity_id := pg_catalog.gen_random_uuid();
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, activity_id, appointment_starts_at,
      'organization_account', context_account_id, 'grant_role_assignment',
      array[context_organization_id]::uuid[], array[]::uuid[],
      context_channel, context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization steward appointment refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;
  -- Match the target against the same live minimum used by the permanent-steward
  -- safeguard. The original adoption role may have changed or another role may
  -- already qualify the target.
  with required_declaration as materialized (
    select declaration.permission_id, declaration.meaning_fingerprint
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint,
      registration.revision as registration_revision
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = registration.organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
      and required.meaning_fingerprint = entry.meaning_fingerprint
    where registration.organization_id = context_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        context_organization_id, registration.revision
      )
      and entry.application_root_id is null
      and entry.owner_kind = 'platform'
      -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
      and entry.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ), qualifying_role as (
    select role.role_id
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = context_organization_id
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
      and (select pg_catalog.count(*) from required_declaration) > 0
      and (select pg_catalog.count(distinct permission_id) from required_declaration)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(distinct permission_id) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and (select pg_catalog.count(*) from required_permission)
        = (select pg_catalog.count(*) from required_declaration)
      and not exists (
        select 1 from required_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_root_id is not distinct from permission.application_root_id
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.meaning_fingerprint = permission.meaning_fingerprint
            and continuity.last_processed_registration_revision = required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
            and permission.meaning_fingerprint = required.meaning_fingerprint
        )
      )
  ), current_steward as (
    select assignment.role_assignment_id,
      delegation.delegation_authority_id, role.role_id
    from vortex_access.organization_role_assignments as assignment
    join qualifying_role as role on role.role_id = assignment.role_id
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = assignment.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = p_organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= appointment_starts_at
      and delegation.expires_at is null
    where assignment.organization_id = context_organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = p_organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= appointment_starts_at
      and assignment.expires_at is null
    order by assignment.role_assignment_id, delegation.delegation_authority_id
    limit 1
  )
  select exists (
      select 1 from qualifying_role as role
      where role.role_id = stewardship_requirement.original_role_id
    ), current_steward_result.role_assignment_id,
    current_steward_result.delegation_authority_id,
    current_steward_result.role_id,
    (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'permissionId', declaration.permission_id,
      'meaningFingerprint', declaration.meaning_fingerprint
    ) order by declaration.permission_id) from required_declaration as declaration)
  into steward_role_is_qualified, existing_role_assignment_id,
    existing_delegation_authority_id, existing_steward_role_id, guarded_minimum
  from (select 1) as anchor
  left join current_steward as current_steward_result on true;
  if existing_role_assignment_id is null and steward_role_is_qualified is not true then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select role.* into steward_role
  from vortex_access.organization_roles as role
  where role.organization_id = context_organization_id
    and role.role_id = coalesce(
      existing_steward_role_id, stewardship_requirement.original_role_id
    )
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select revision.* into steward_role_revision
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = context_organization_id
    and revision.role_id = steward_role.role_id
    and revision.revision = steward_role.live_revision
  for share;
  if not found
    or steward_role_revision.lifecycle is distinct from 'active'
    or steward_role_revision.assignment_policy is distinct from 'standing' then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Bind the complete role grant, including every permission beyond the minimum.
  select pg_catalog.jsonb_agg(reference.permission order by
    reference.application_root_id nulls first, reference.owner_kind,
    reference.owner_id, reference.permission_id)
  into affected_permissions
  from (
    select distinct permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.application_root_id,
        'ownerKind', permission.owner_kind, 'ownerId', permission.owner_id,
        'permissionId', permission.permission_id
      )) as permission
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = context_organization_id
      and permission.role_id = steward_role.role_id
      and permission.role_revision = steward_role.live_revision
  ) as reference;
  if affected_permissions is null then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  -- Refresh catalogue authority under all initial locks, without changing context.
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    catalogue_declaration
  ) as evaluated;
  select evaluated.* into strict role_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.role_assignments.grant',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        )
      )
    )
  ) as evaluated;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.grant'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id
    or decision.reason_code is not null
    or decision.checked_at is null or decision.valid_until is null
    or decision.checked_at > authorization_checked_at
    or decision.valid_until <= authorization_checked_at
    or decision.valid_until <= decision.checked_at
    or role_decision.outcome is distinct from 'eligible'
    or role_decision.operation_key is distinct from 'platform.organization.role_assignments.grant'
    or role_decision.target_kind is distinct from 'organization'
    or role_decision.target_application_root_id is not null
    or role_decision.organization_id is distinct from context_organization_id
    or role_decision.organization_account_id is distinct from context_account_id
    or role_decision.access_version is distinct from context_access_version
    or role_decision.correlation_id is distinct from context_correlation_id
    or role_decision.reason_code is not null
    or role_decision.checked_at is null or role_decision.valid_until is null
    or role_decision.checked_at > authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= role_decision.checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id,
    'meaningFingerprint', declaration.meaning_fingerprint
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= pg_catalog.clock_timestamp()
    or role_decision.valid_until <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  if target_account.revision is distinct from p_expected_account_revision then
    return query select 'conflict'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;
  if existing_role_assignment_id is not null then
    perform vortex_access.assert_organization_has_permanent_steward(
      context_organization_id
    );
    if vortex_access.validated_human_request_context() is distinct from context_value
      or decision.valid_until <= pg_catalog.clock_timestamp()
      or role_decision.valid_until <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501',
        message = 'Organization steward appointment is unavailable';
    end if;
    result_summary := pg_catalog.jsonb_build_object(
      'organizationAccountId', p_organization_account_id,
      'roleAssignmentId', existing_role_assignment_id,
      'delegationAuthorityId', existing_delegation_authority_id
    );
    return query select 'unchanged'::text, context_organization_id,
      result_summary, context_access_version;
    return;
  end if;

  appointment_starts_at := pg_catalog.clock_timestamp();
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    context_organization_id, generated_role_assignment_id, steward_role.role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    appointment_starts_at, null, 'live', context_account_id, appointment_starts_at,
    context_correlation_id, context_account_id, appointment_starts_at,
    context_correlation_id, null, null, null
  ) returning * into assignment_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward role grant is stale or unavailable';
  end if;
  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at, revocation_correlation_id
  ) values (
    context_organization_id, generated_delegation_authority_id,
    'organization_account', p_organization_account_id, null,
    'organization_catalogue', null, 1, appointment_starts_at, null, 'live',
    context_account_id, appointment_starts_at, context_correlation_id,
    context_account_id, appointment_starts_at, context_correlation_id, null, null, null
  ) returning * into delegation_fact;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation grant is stale or unavailable';
  end if;

  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, assignment_fact.changed_at,
    'organization_account', context_account_id, 'grant_role_assignment',
    array[assignment_fact.role_assignment_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward role Activity is stale';
  end if;
  activity_id := pg_catalog.gen_random_uuid();
  activity_result := vortex_record.append_organization_activity_entry(
    context_organization_id, activity_id, delegation_fact.changed_at,
    'organization_account', context_account_id, 'grant_delegation',
    array[delegation_fact.delegation_authority_id]::uuid[], array[]::uuid[],
    context_channel, context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization steward delegation Activity is stale';
  end if;

  if not exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      join vortex_access.organization_roles as role
        on role.organization_id = assignment.organization_id
        and role.role_id = assignment.role_id
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      join vortex_access.organization_delegation_authorities as delegation
        on delegation.organization_id = assignment.organization_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = assignment.organization_id
        and account.organization_account_id = assignment.organization_account_id
      join vortex_identity.identity_projections as identity
        on identity.identity_id = account.identity_id
      where assignment.organization_id = context_organization_id
        and assignment.role_assignment_id = generated_role_assignment_id
        and assignment.role_id = stewardship_requirement.original_role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.group_id is null
        and assignment.assignment_kind = 'standing'
        and assignment.revision = 1
        and assignment.state = 'live'
        and assignment.starts_at = appointment_starts_at
        and assignment.expires_at is null
        and assignment.granted_by = context_account_id
        and assignment.granted_at = appointment_starts_at
        and assignment.grant_correlation_id = context_correlation_id
        and assignment.changed_by = context_account_id
        and assignment.changed_at = appointment_starts_at
        and assignment.change_correlation_id = context_correlation_id
        and assignment.revoked_by is null and assignment.revoked_at is null
        and assignment.revocation_correlation_id is null
        and role.live_revision = steward_role.live_revision
        and revision.lifecycle = 'active'
        and revision.assignment_policy = 'standing'
        and delegation.delegation_authority_id = generated_delegation_authority_id
        and delegation.holder_kind = 'organization_account'
        and delegation.organization_account_id = p_organization_account_id
        and delegation.group_id is null
        and delegation.scope_kind = 'organization_catalogue'
        and delegation.bounded_permissions is null
        and delegation.revision = 1
        and delegation.state = 'live'
        and delegation.starts_at = appointment_starts_at
        and delegation.expires_at is null
        and delegation.granted_by = context_account_id
        and delegation.granted_at = appointment_starts_at
        and delegation.grant_correlation_id = context_correlation_id
        and delegation.changed_by = context_account_id
        and delegation.changed_at = appointment_starts_at
        and delegation.change_correlation_id = context_correlation_id
        and delegation.revoked_by is null and delegation.revoked_at is null
        and delegation.revocation_correlation_id is null
        and account.state = 'active'
        and identity.state = 'active'
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(guarded_minimum) as required(value)
          where not exists (
            select 1
            from vortex_access.organization_role_permission_entries as permission
            join vortex_access.permission_continuities as continuity
              on continuity.organization_id = permission.organization_id
              and continuity.application_root_id is not distinct from permission.application_root_id
              and continuity.owner_kind = permission.owner_kind
              and continuity.owner_id = permission.owner_id
              and continuity.permission_id = permission.permission_id
              and continuity.state = 'available'
              and continuity.continuity_revision = permission.continuity_revision
              and continuity.meaning_fingerprint = permission.meaning_fingerprint
            join vortex_access.permission_registrations as registration
              on registration.organization_id = permission.organization_id
              and registration.registration_kind = 'platform'
              and registration.registration_owner_id =
                -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
                'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
              and registration.state = 'active'
              and continuity.last_processed_registration_revision = registration.revision
            join vortex_access.permission_catalogue_entries as entry
              on entry.organization_id = registration.organization_id
              and entry.registration_kind = registration.registration_kind
              and entry.registration_owner_id = registration.registration_owner_id
              and entry.registration_revision = registration.revision
              and entry.application_root_id is null
              and entry.owner_kind = 'platform'
              -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
              and entry.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
              and entry.permission_id = permission.permission_id
              and entry.meaning_fingerprint = permission.meaning_fingerprint
            where permission.organization_id = role.organization_id
              and permission.role_id = role.role_id
              and permission.role_revision = role.live_revision
              and permission.application_root_id is null
              and permission.owner_kind = 'platform'
              -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
              and permission.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
              and permission.permission_id = (required.value ->> 'permissionId')::uuid
              and permission.meaning_fingerprint = required.value ->> 'meaningFingerprint'
          )
        )
    ) then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment result is stale or unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(
    context_organization_id
  );
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'permissionId', declaration.permission_id,
    'meaningFingerprint', declaration.meaning_fingerprint
  ) order by declaration.permission_id)
  into current_guarded_minimum
  from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration;
  authorization_checked_at := pg_catalog.clock_timestamp();
  if current_guarded_minimum is distinct from guarded_minimum
    or vortex_access.validated_human_request_context() is distinct from context_value
    or decision.valid_until <= authorization_checked_at
    or role_decision.valid_until <= authorization_checked_at then
    raise exception using errcode = '42501',
      message = 'Organization steward appointment is unavailable';
  end if;
  select changed.* into strict version_change
  from vortex_access.increment_organization_access_version(
    context_organization_id, context_account_id, context_correlation_id,
    'stewardship_changed'
  ) as changed;
  if version_change.organization_id is distinct from context_organization_id
    or version_change.current_version is distinct from context_access_version + 1
    or version_change.changed_by is distinct from context_account_id
    or version_change.change_correlation_id is distinct from context_correlation_id
    or version_change.change_reason is distinct from 'stewardship_changed' then
    raise exception using errcode = '40001',
      message = 'Organization steward appointment version is stale or unavailable';
  end if;
  result_summary := pg_catalog.jsonb_build_object(
    'organizationAccountId', p_organization_account_id,
    'roleAssignmentId', generated_role_assignment_id,
    'delegationAuthorityId', generated_delegation_authority_id
  );
  return query select 'changed'::text, context_organization_id,
    result_summary, version_change.current_version;
end
$function$;

revoke execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint)
to vortex_request;

comment on function vortex_access.appoint_organization_steward_for_administration(uuid, bigint) is
  'Verified human request entry: atomically appoints another active same-organisation account to the current steward role and catalogue delegation under the original context with one Access increment, safe target-revision conflict and no public operation binding.';

create or replace function vortex_access.coordinate_organization_stewardship_adoption(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_role_key text,
  p_role_label text,
  p_role_description text,
  p_role_assignment_id uuid,
  p_delegation_authority_id uuid,
  p_changed_by uuid,
  p_correlation_id uuid
)
returns table (
  outcome text,
  operation text,
  requirement jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
  platform_owner_id constant uuid := 'cabe121e-0baf-4084-9471-cce915d460a8';
  stewardship vortex_access.organization_stewardship_requirements%rowtype;
  platform_registration vortex_access.permission_registrations%rowtype;
  is_replay boolean;
  expected_count bigint;
  declared_current_revision bigint;
  expected_metadata_exact boolean;
  continuity_count bigint;
  distinct_continuity_count bigint;
  granted_count bigint;
  checked_at timestamptz;
  next_access_version bigint;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_id is null
    or p_role_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_assignment_id is null
    or p_role_assignment_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_delegation_authority_id is null
    or p_delegation_authority_id =
      '00000000-0000-0000-0000-000000000000'::uuid
    or p_role_key is null
    or pg_catalog.char_length(p_role_key) not between 1 and 40
    or p_role_key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_role_label is null
    or p_role_label is distinct from pg_catalog.btrim(p_role_label)
    or pg_catalog.char_length(p_role_label) not between 1 and 60
    or p_role_description is null
    or p_role_description is distinct from pg_catalog.btrim(p_role_description)
    or pg_catalog.char_length(p_role_description) not between 1 and 1000
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization stewardship adoption input is invalid';
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
      message = 'Organization stewardship adoption scope is unavailable';
  end if;

  select stored.* into stewardship
  from vortex_access.organization_stewardship_requirements as stored
  where stored.organization_id = p_organization_id
  for update;

  is_replay := found;
  if is_replay then
    if stewardship.original_organization_account_id <>
        p_organization_account_id
      or stewardship.original_role_id <> p_role_id
      or stewardship.original_role_assignment_id <> p_role_assignment_id
      or stewardship.original_delegation_authority_id <>
        p_delegation_authority_id
      or stewardship.adopted_by <> p_changed_by
      or stewardship.adoption_correlation_id <> p_correlation_id then
      raise exception using errcode = '40001',
        message = 'Organization stewardship adoption conflicts with existing evidence';
    end if;
  end if;

  if not is_replay then
    perform 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    where account.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and account.state = 'active'
    for update of account;
    if not found then
      raise exception using errcode = '40001',
        message = 'Organization stewardship account is stale or unavailable';
    end if;

    if exists (
      select 1 from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
        and (role.role_id = p_role_id or role.role_key = p_role_key)
    ) or exists (
      select 1 from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = p_organization_id
        and assignment.role_assignment_id = p_role_assignment_id
    ) or exists (
      select 1
      from vortex_access.organization_delegation_authorities as delegation
      where delegation.organization_id = p_organization_id
        and delegation.delegation_authority_id = p_delegation_authority_id
    ) then
      raise exception using errcode = '40001',
        message = 'Organization stewardship grant identity is unavailable';
    end if;
  end if;

  select registration.* into platform_registration
  from vortex_access.permission_registrations as registration
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'platform'
    and registration.registration_owner_id = platform_owner_id
    and registration.state = 'active'
  for update;
  if not found
    or not vortex_access.platform_permission_catalogue_revision_is_exact(
      p_organization_id, platform_registration.revision
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- The private producer supplies the whole selected catalogue and its target.
  with expected as materialized (
    select declaration.*
    from vortex_access.read_platform_permission_declaration_catalogue_internal(
      platform_registration.revision
    ) as declaration
  )
  select pg_catalog.count(*),
    pg_catalog.min(expected.declared_current_revision),
    coalesce(
      pg_catalog.count(*) > 0
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_id)
      and pg_catalog.count(*) = pg_catalog.count(distinct expected.permission_key)
      and pg_catalog.count(distinct expected.declared_current_revision) = 1
      and pg_catalog.count(distinct expected.registration_revision) = 1
      and pg_catalog.count(distinct expected.source_version) = 1
      and pg_catalog.count(distinct expected.catalogue_fingerprint) = 1
      and pg_catalog.bool_and(
        expected.registration_revision = platform_registration.revision
        and expected.declared_current_revision >= platform_registration.revision
        and expected.source_version = platform_registration.source_version
        and expected.catalogue_fingerprint =
          platform_registration.permission_catalogue_fingerprint
        and expected.catalogue_fingerprint =
          platform_registration.candidate_fingerprint
      ),
      false
    )
  into expected_count, declared_current_revision, expected_metadata_exact
  from expected;
  if not expected_metadata_exact then
    raise exception using errcode = '55000',
      message = 'Platform permission catalogue evidence is invalid';
  end if;

  -- Lock the complete fixed registration-owner set, including invalid roots.
  perform 1
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
  order by continuity.owner_kind collate "C", continuity.owner_id,
    continuity.permission_id
  for update;

  select pg_catalog.count(*) into continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;

  if continuity_count = 0 then
    -- Only an untouched historical pre-adoption phase may seed availability.
    if is_replay or platform_registration.revision not between 1 and 3
      or exists (
        select 1 from vortex_access.organization_roles as role
        where role.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_role_revisions as role_revision
        where role_revision.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_role_permission_entries as grant_entry
        where grant_entry.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = p_organization_id
      ) or exists (
        select 1 from vortex_access.organization_delegation_authorities as delegation
        where delegation.organization_id = p_organization_id
      ) then
      raise exception using errcode = '55000',
        message = 'Platform permission continuity evidence is incomplete';
    end if;

    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id, state,
      continuity_revision, meaning_fingerprint,
      last_processed_registration_revision, changed_at
    )
    select entry.organization_id, null, entry.owner_kind, entry.owner_id,
      entry.permission_id, 'platform', entry.registration_owner_id,
      'available', 1, entry.meaning_fingerprint, entry.registration_revision,
      pg_catalog.clock_timestamp()
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = p_organization_id
      and entry.application_root_id is null
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = platform_owner_id
      and entry.registration_revision = platform_registration.revision
      and entry.owner_kind = 'platform'
      and entry.owner_id = platform_owner_id
    order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;
  end if;

  select pg_catalog.count(*), pg_catalog.count(distinct continuity.permission_id)
  into continuity_count, distinct_continuity_count
  from vortex_access.permission_continuities as continuity
  where continuity.organization_id = p_organization_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id;

  if continuity_count <> expected_count
    or distinct_continuity_count <> expected_count
    or exists (
      select 1
      from vortex_access.permission_continuities as continuity
      where continuity.organization_id = p_organization_id
        and continuity.registration_kind = 'platform'
        and continuity.registration_owner_id = platform_owner_id
        and not exists (
          select 1
          from vortex_access.permission_catalogue_entries as entry
          where entry.organization_id = continuity.organization_id
            and entry.registration_kind = continuity.registration_kind
            and entry.registration_owner_id = platform_owner_id
            and entry.registration_revision = platform_registration.revision
            and entry.application_root_id is null
            and entry.owner_kind = 'platform'
            and entry.owner_id = platform_owner_id
            and entry.owner_kind = continuity.owner_kind
            and entry.owner_id = continuity.owner_id
            and entry.permission_id = continuity.permission_id
            and entry.meaning_fingerprint = continuity.meaning_fingerprint
            and continuity.application_root_id is null
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) or exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = p_organization_id
        and entry.registration_kind = 'platform'
        and entry.registration_owner_id = platform_owner_id
        and entry.registration_revision = platform_registration.revision
        and not exists (
          select 1
          from vortex_access.permission_continuities as continuity
          where continuity.organization_id = entry.organization_id
            and continuity.application_root_id is null
            and continuity.registration_kind = 'platform'
            and continuity.registration_owner_id = platform_owner_id
            and continuity.owner_kind = 'platform'
            and continuity.owner_id = platform_owner_id
            and continuity.owner_kind = entry.owner_kind
            and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision > 0
            and continuity.meaning_fingerprint = entry.meaning_fingerprint
            and continuity.last_processed_registration_revision =
              platform_registration.revision
        )
    ) then
    raise exception using errcode = '55000',
      message = 'Platform permission continuity evidence is incomplete';
  end if;

  if is_replay then
    perform vortex_access.assert_organization_has_permanent_steward(
      p_organization_id
    );
    if platform_registration.revision >= 7
      and declared_current_revision = platform_registration.revision then
      -- Availability is already current; use the version under our held lock.
      select version.current_version into next_access_version
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id;
    else
      -- Historical progression or a newer trusted target must use its writer.
      select published.access_version into next_access_version
      from vortex_access.initialize_platform_permission_catalogue(
        p_organization_id, p_changed_by, p_correlation_id
      ) as published;
    end if;

    return query select 'unchanged'::text,
      'adopt_organization_stewardship'::text,
      pg_catalog.jsonb_build_object(
        'organizationId', stewardship.organization_id,
        'originalOrganizationAccountId',
          stewardship.original_organization_account_id,
        'originalRoleId', stewardship.original_role_id,
        'originalRoleAssignmentId', stewardship.original_role_assignment_id,
        'originalDelegationAuthorityId',
          stewardship.original_delegation_authority_id,
        'revision', stewardship.revision,
        'adoptedByActorId', stewardship.adopted_by,
        'adoptedAt', stewardship.adopted_at,
        'adoptionCorrelationId', stewardship.adoption_correlation_id,
        'changedByActorId', stewardship.changed_by,
        'changedAt', stewardship.changed_at,
        'changeCorrelationId', stewardship.change_correlation_id
      ), next_access_version, p_correlation_id;
    return;
  end if;

  checked_at := pg_catalog.clock_timestamp();

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, derived_application_root_id, derived_source_role_id,
    derived_source_definition_key, derived_source_release_revision,
    derived_source_release_version,
    derived_source_validation_contract_version,
    derived_source_content_fingerprint,
    derived_source_resolution_fingerprint,
    derived_source_template_fingerprint, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_role_id, 'custom', p_role_key, null, null,
    null, null, null, null, null, null, null, null, null, 1,
    p_changed_by, checked_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select p_organization_id, p_role_id, 1,
    pg_catalog.row_number() over (
      order by entry.owner_kind collate "C", entry.owner_id,
        entry.permission_id
    ),
    'custom', null, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    entry.registration_revision,
    platform_registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is null
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.registration_kind = 'platform'
    and continuity.registration_owner_id = platform_owner_id
    and continuity.registration_owner_id = entry.registration_owner_id
    and continuity.state = 'available'
    and continuity.continuity_revision > 0
    and continuity.last_processed_registration_revision =
      platform_registration.revision
    and continuity.meaning_fingerprint = entry.meaning_fingerprint
  where entry.organization_id = p_organization_id
    and entry.application_root_id is null
    and entry.registration_kind = 'platform'
    and entry.registration_owner_id = platform_owner_id
    and entry.registration_revision = platform_registration.revision
    and entry.owner_kind = 'platform'
    and entry.owner_id = platform_owner_id
  order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id;

  get diagnostics granted_count = row_count;
  if granted_count <> expected_count or (
    select pg_catalog.count(distinct grant_entry.permission_id)
    from vortex_access.organization_role_permission_entries as grant_entry
    where grant_entry.organization_id = p_organization_id
      and grant_entry.role_id = p_role_id
      and grant_entry.role_revision = 1
  ) <> expected_count then
    raise exception using errcode = '55000',
      message = 'Platform permission stewardship grant evidence is incomplete';
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', null, 'active', 'privileged',
    'standing', 1, 1, null, null, null, p_role_key, p_role_label,
    p_role_description, null, null, null, null, null, null, null, null,
    null, null, null, p_changed_by, checked_at, p_correlation_id
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id,
    changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_role_assignment_id, p_role_id,
    'organization_account', p_organization_account_id, null, 'standing', 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_delegation_authorities (
    organization_id, delegation_authority_id, holder_kind,
    organization_account_id, group_id, scope_kind, bounded_permissions,
    revision, starts_at, expires_at, state, granted_by,
    granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id, revoked_by, revoked_at,
    revocation_correlation_id
  ) values (
    p_organization_id, p_delegation_authority_id, 'organization_account',
    p_organization_account_id, null, 'organization_catalogue', null, 1,
    checked_at, null, 'live', p_changed_by, checked_at, p_correlation_id,
    p_changed_by, checked_at, p_correlation_id, null, null, null
  );

  insert into vortex_access.organization_stewardship_requirements (
    organization_id, original_organization_account_id, original_role_id,
    original_role_assignment_id, original_delegation_authority_id, revision,
    adopted_by, adopted_at, adoption_correlation_id, changed_by, changed_at,
    change_correlation_id
  ) values (
    p_organization_id, p_organization_account_id, p_role_id,
    p_role_assignment_id, p_delegation_authority_id, 1, p_changed_by,
    checked_at, p_correlation_id, p_changed_by, checked_at, p_correlation_id
  ) returning * into stewardship;

  perform vortex_access.assert_organization_has_permanent_steward(
    p_organization_id
  );

  perform 1
  from vortex_access.increment_organization_access_version(
    p_organization_id, p_changed_by, p_correlation_id,
    'stewardship_changed'
  ) as version;

  if platform_registration.revision >= 7
    and declared_current_revision = platform_registration.revision then
    -- Availability is already current; use the version under our held lock.
    select version.current_version into next_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
  else
    -- Historical progression or a newer trusted target must use its writer.
    select published.access_version into next_access_version
    from vortex_access.initialize_platform_permission_catalogue(
      p_organization_id, p_changed_by, p_correlation_id
    ) as published;
  end if;

  return query select 'changed'::text,
    'adopt_organization_stewardship'::text,
    pg_catalog.jsonb_build_object(
      'organizationId', stewardship.organization_id,
      'originalOrganizationAccountId',
        stewardship.original_organization_account_id,
      'originalRoleId', stewardship.original_role_id,
      'originalRoleAssignmentId', stewardship.original_role_assignment_id,
      'originalDelegationAuthorityId',
        stewardship.original_delegation_authority_id,
      'revision', stewardship.revision,
      'adoptedByActorId', stewardship.adopted_by,
      'adoptedAt', stewardship.adopted_at,
      'adoptionCorrelationId', stewardship.adoption_correlation_id,
      'changedByActorId', stewardship.changed_by,
      'changedAt', stewardship.changed_at,
      'changeCorrelationId', stewardship.change_correlation_id
    ), next_access_version, p_correlation_id;
end
$function$;

comment on function vortex_access.coordinate_organization_stewardship_adoption(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
) is
  'Owner-only atomic whole-current-catalogue first-steward adoption or exact unchanged replay. It preserves original grants, validates complete availability, and progresses only through the existing catalogue writer.';

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

revoke execute on function
  vortex_access.coordinate_organization_stewardship_adoption(
    uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, uuid
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create or replace function vortex_access.revoke_organization_delegation_authority_for_administration(
  p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_activity_id uuid
)
returns table (outcome text, organization_id uuid, delegation_summary jsonb, access_version bigint)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  context_value jsonb; context_organization_id uuid; context_account_id uuid;
  context_access_version bigint; context_correlation_id uuid; locked_access_version bigint;
  delegation_fact vortex_access.organization_delegation_authorities%rowtype;
  authority_before jsonb; decision record; changed record; summary jsonb; activity_result text;
begin
  if p_delegation_authority_id is null or p_delegation_authority_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_delegation_revision is null or p_expected_delegation_revision not between 1 and 9007199254740991
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Delegation revocation input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  select version.current_version into locked_access_version from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id and organization.state = 'active'
    and tenant.state = 'active' for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501', message = 'Delegation revocation is unavailable'; end if;
  select delegation.* into delegation_fact from vortex_access.organization_delegation_authorities as delegation
  where delegation.organization_id = context_organization_id
    and delegation.delegation_authority_id = p_delegation_authority_id for update;
  if not found or delegation_fact.revision <> p_expected_delegation_revision or delegation_fact.state <> 'live' then
    raise exception using errcode = '40001', message = 'Delegation revocation is stale or unavailable'; end if;
  if delegation_fact.scope_kind = 'organization_catalogue' then
    authority_before := pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  else
    select pg_catalog.jsonb_build_object('kind', 'bounded', 'permissions',
      pg_catalog.jsonb_agg(pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'applicationRootId', permission.value -> 'applicationRootId',
          'ownerKind', permission.value -> 'ownerKind',
          'ownerId', permission.value -> 'ownerId',
          'permissionId', permission.value -> 'permissionId'))))
    into authority_before
    from pg_catalog.jsonb_array_elements(delegation_fact.bounded_permissions)
      as permission(value);
  end if;
  select evaluated.* into strict decision from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object('operationKey', 'platform.organization.delegations.revoke',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object('ownerKind', 'platform',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        -- guard-allow: function-uuid fixed platform permission identity without declaration-table read access
        'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'delegated_management',
        'before', authority_before, 'after', pg_catalog.jsonb_build_object('kind', 'none')))) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.delegations.revoke'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_record.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'revoke_delegation',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Delegation revocation refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.delegations.revoke'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Delegation revocation is unavailable';
  end if;
  select result.* into strict changed from vortex_access.coordinate_organization_delegation_authority_change(
    'revoke_delegation', context_organization_id, p_delegation_authority_id,
    p_expected_delegation_revision, null, null, null, null, null, null, null,
    context_account_id, context_correlation_id) as result;
  summary := vortex_access.project_organization_delegation_summary(context_organization_id, p_delegation_authority_id);
  if summary is null then raise exception using errcode = '40001', message = 'Changed delegation projection is unavailable'; end if;
  activity_result := vortex_record.append_organization_activity_entry(context_organization_id,
    p_activity_id, (changed.delegation ->> 'changedAt')::timestamptz, 'organization_account', context_account_id,
    'revoke_delegation', array[p_delegation_authority_id]::uuid[], array[]::uuid[], vortex_platform.channel(),
    context_correlation_id, 'completed');
  if activity_result is distinct from 'inserted' then raise exception using errcode = '40001', message = 'Delegation Activity is stale'; end if;
  return query select 'completed'::text, context_organization_id, summary, changed.access_version;
end $function$;

revoke execute on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.revoke_organization_delegation_authority_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_delegation after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';
