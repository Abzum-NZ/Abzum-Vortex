-- Every member can open the organisation's default application (UI-46): accepting an invitation
-- gives the new or reactivated account that application's default member role.
set role vortex_owner;

CREATE OR REPLACE FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) RETURNS TABLE(outcome text, organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  target_organization_id uuid;
  invitation vortex_identity.organization_invitations%rowtype;
  accepted record;
  resulting_version bigint;
  member_role record;
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
  where candidate.invitation_id = p_invitation_id
    and candidate.invited_email = p_verified_email;

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

  if not found
    or invitation.invited_email <> p_verified_email
    or invitation.revoked_at is not null
    or (
      invitation.accepted_at is null
      and invitation.expires_at <= pg_catalog.clock_timestamp()
    ) then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid,
      null::bigint, null::bigint;
    return;
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation_with_transition(
    p_invitation_id,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome = 'accepted' and accepted.access_transition <> 'unchanged' then
    select incremented.current_version into resulting_version
    from vortex_access.increment_organization_access_version(
      accepted.organization_id,
      accepted.organization_account_id,
      p_correlation_id,
      case accepted.access_transition
        when 'activated' then 'organization_account_activated'
        when 'reactivated' then 'organization_account_reactivated'
      end
    ) as incremented;

    -- Every member can open the organisation's default application: an account that becomes
    -- active through an invitation is given that application's default member role, under the
    -- invitation of the person who invited them.
    select role.role_id, role.live_revision into member_role
    from vortex_identity.organization_runtime_settings as settings
    join vortex_access.organization_roles as role
      on role.organization_id = settings.organization_id
      and role.application_root_id = settings.default_application_root_id
      and role.role_kind = 'application'
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where settings.organization_id = accepted.organization_id
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
      and exists (
        select 1
        from vortex_definition.installation_bindings as binding
        join vortex_definition.releases as release
          on release.root_id = binding.application_root_id
          and release.release_revision = binding.application_release_revision
        cross join lateral pg_catalog.jsonb_array_elements(
          release.compilation_output -> 'canonical' -> 'content' -> 'roles'
        ) as release_role
        where binding.organization_id = settings.organization_id
          and binding.application_root_id = settings.default_application_root_id
          and binding.state = 'active'
          and release_role ->> 'defaultMember' = 'true'
          and release_role ->> 'roleId' = role.source_role_id::text
      )
      and not exists (
        select 1
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = role.organization_id
          and assignment.role_id = role.role_id
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = accepted.organization_account_id
          and assignment.state = 'live'
      )
    for update of role;

    if found then
      select changed.access_version into resulting_version
      from vortex_access.coordinate_organization_role_assignment_change(
        'grant', accepted.organization_id, pg_catalog.gen_random_uuid(), null,
        member_role.role_id, member_role.live_revision, 'organization_account',
        accepted.organization_account_id, null, 'standing',
        pg_catalog.clock_timestamp(), null,
        invitation.invited_by_organization_account_id, p_correlation_id
      ) as changed;
    end if;
  elsif accepted.outcome in ('accepted', 'already_accepted') then
    select version.current_version into resulting_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = accepted.organization_id;

    if not found then
      raise exception using errcode = '40001',
        message = 'Access version is unavailable';
    end if;
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

reset role;
