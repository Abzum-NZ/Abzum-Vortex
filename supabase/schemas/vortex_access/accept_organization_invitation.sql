CREATE OR REPLACE FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) RETURNS TABLE(outcome text, organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  target_organization_id uuid;
  invitation vortex_identity.organization_invitations%rowtype;
  accepted record;
  resulting_version bigint;
  role_intent record;
  role_fact record;
  checked_at timestamptz;
  prior_account_state text;
  access_transition text := 'unchanged';
begin
  if p_invitation_id is null
    or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
    or p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_display_name is not null and (
      p_display_name is distinct from pg_catalog.btrim(p_display_name)
      or pg_catalog.char_length(p_display_name) not between 1 and 120
    )) then
    raise exception using errcode = '22023',
      message = 'Invitation acceptance input is invalid';
  end if;

  select candidate.organization_id into target_organization_id
  from vortex_identity.organization_invitations as candidate
  where candidate.invitation_id = p_invitation_id;

  if not found then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = target_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    if exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = target_organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;


  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id', target_organization_id::text, true
  );

  select candidate.* into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.organization_id = target_organization_id
    and candidate.invitation_id = p_invitation_id
  for update;

  if not found or invitation.revoked_at is not null or invitation.accepted_at is not null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  if invitation.invited_email <> p_verified_email then
    return query select 'wrong_address'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;
  checked_at := pg_catalog.clock_timestamp();
  if invitation.expires_at <= checked_at then
    return query select 'expired'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;
  for role_intent in
    select intent."roleId" as role_id, intent."roleRevision" as role_revision
    from pg_catalog.jsonb_to_recordset(invitation.role_intents)
      as intent("roleId" uuid, "roleRevision" bigint)
    order by intent."roleId"
  loop
    select role.live_revision, revision.lifecycle, revision.assignment_policy into role_fact
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = target_organization_id and role.role_id = role_intent.role_id
    for update of role;
    if not found or role_fact.live_revision <> role_intent.role_revision
      or role_fact.lifecycle <> 'active'
      or role_fact.assignment_policy not in ('standing', 'activation_required') then
    return query select 'role_changed'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
    end if;
    if not vortex_access.check_organization_invitation_role_authority_internal(
      target_organization_id, invitation.invited_by_organization_account_id, role_intent.role_id, checked_at
    ) then
    return query select 'inviter_not_allowed'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(invitation.role_intents) = 0 then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  select account.state into prior_account_state
  from vortex_identity.organization_accounts as account
  where account.organization_id = target_organization_id and account.identity_id = p_identity_id
  for update;
  if not found then
    access_transition := 'activated';
  elsif prior_account_state <> 'active' then
    access_transition := 'reactivated';
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation(
    p_invitation_id,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome = 'accepted' and access_transition <> 'unchanged' then
    select incremented.current_version into resulting_version
    from vortex_access.increment_organization_access_version(
      accepted.organization_id,
      accepted.organization_account_id,
      p_correlation_id,
      case access_transition
        when 'activated' then 'organization_account_activated'
        when 'reactivated' then 'organization_account_reactivated'
      end
    ) as incremented;

  elsif accepted.outcome = 'accepted' then
    select version.current_version into resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = accepted.organization_id;

    if not found then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
  end if;

  if accepted.outcome = 'accepted' then
    for role_intent in
      select intent."roleId" as role_id, intent."roleRevision" as role_revision
      from pg_catalog.jsonb_to_recordset(invitation.role_intents)
        as intent("roleId" uuid, "roleRevision" bigint)
      order by intent."roleId"
    loop
      select revision.assignment_policy into strict role_fact
      from vortex_access.organization_role_revisions as revision
      where revision.organization_id = target_organization_id
        and revision.role_id = role_intent.role_id and revision.revision = role_intent.role_revision;
      if not exists (
        select 1 from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = target_organization_id
          and assignment.role_id = role_intent.role_id
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = accepted.organization_account_id
          and assignment.assignment_kind = case role_fact.assignment_policy
            when 'standing' then 'standing' else 'eligible' end
          and assignment.state = 'live' and assignment.starts_at <= checked_at
          and (assignment.expires_at is null or assignment.expires_at > checked_at)
      ) then
        select changed.access_version into resulting_version
        from vortex_access.coordinate_organization_role_assignment_change(
          'grant', target_organization_id, pg_catalog.gen_random_uuid(), null,
          role_intent.role_id, role_intent.role_revision, 'organization_account',
          accepted.organization_account_id, null,
          case role_fact.assignment_policy when 'standing' then 'standing' else 'eligible' end,
          checked_at, null, invitation.invited_by_organization_account_id, p_correlation_id
        ) as changed;
      end if;
    end loop;
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id,
    accepted.organization_id, accepted.identity_id, accepted.display_name,
    accepted.state, accepted.language, accepted.time_zone,
    accepted.invitation_id, accepted.activated_at, accepted.suspended_at,
    accepted.closed_at, accepted.changed_at, accepted.state_changed_at,
    accepted.state_changed_by, accepted.state_change_correlation_id,
    accepted.revision, resulting_version;
end
$_$;

alter function vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) IS 'Runtime acceptance of an invitation by the signed-in person whose verified email it names, under the organization access-version lock.';

REVOKE ALL ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) TO vortex_runtime;

grant execute on function vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) to postgres;
