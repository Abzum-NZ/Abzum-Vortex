-- Invitation expiry remains a fresh post-lock decision. Only the audit time
-- shared by the accepted invitation and any account activation is clamped to
-- the locked facts so an exact next revision cannot move audit time backwards.
create or replace function vortex_identity.accept_organization_invitation(
  p_token_fingerprint text,
  p_identity_id uuid,
  p_verified_email text,
  p_display_name text,
  p_correlation_id uuid
)
returns table (
  outcome text,
  organization_account_id uuid,
  organization_id uuid,
  identity_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  invitation_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  invitation vortex_identity.organization_invitations%rowtype;
  account vortex_identity.organization_accounts%rowtype;
  projection_state text;
  checked_at timestamptz;
  operation_at timestamptz;
  new_account_id uuid;
  result_outcome text := 'accepted';
begin
  if p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
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

  select candidate.*
  into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.token_fingerprint = p_token_fingerprint
  for update;

  if not found
    or invitation.invited_email <> p_verified_email
    or invitation.revoked_at is not null then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
      null::text, null::text, null::text, null::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  if invitation.accepted_at is not null then
    select existing.* into account
    from vortex_identity.organization_accounts as existing
    where existing.organization_account_id = invitation.accepted_organization_account_id
      and existing.organization_id = invitation.organization_id
      and existing.identity_id = p_identity_id;

    if not found then
      return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    select projection.state into projection_state
    from vortex_identity.identity_projections as projection
    where projection.identity_id = p_identity_id
    for update;

    if projection_state is distinct from 'active' then
      return query select 'identity_inactive'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    if account.state <> 'active' or not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = account.organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    result_outcome := 'already_accepted';
  else
    checked_at := pg_catalog.clock_timestamp();
    if invitation.expires_at <= checked_at or not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      where organization.organization_id = invitation.organization_id
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    operation_at := greatest(invitation.changed_at, checked_at);

    insert into vortex_identity.identity_projections (
      identity_id, state, created_at, state_changed_at, state_changed_by,
      state_change_correlation_id, revision
    ) values (
      p_identity_id, 'active', operation_at, operation_at, p_identity_id,
      p_correlation_id, 1
    ) on conflict on constraint identity_projections_pk do nothing;

    select projection.state into projection_state
    from vortex_identity.identity_projections as projection
    where projection.identity_id = p_identity_id
    for update;

    if projection_state <> 'active' then
      return query select 'identity_inactive'::text, null::uuid, null::uuid, null::uuid,
        null::text, null::text, null::text, null::text, null::uuid,
        null::timestamptz, null::timestamptz, null::timestamptz,
        null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
      return;
    end if;

    select existing.* into account
    from vortex_identity.organization_accounts as existing
    where existing.organization_id = invitation.organization_id
      and existing.identity_id = p_identity_id
    for update;

    if found then
      if account.state <> 'active'
        and invitation.invited_at <= account.state_changed_at then
        return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
          null::text, null::text, null::text, null::text, null::uuid,
          null::timestamptz, null::timestamptz, null::timestamptz,
          null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
        return;
      end if;

      operation_at := greatest(
        operation_at,
        account.changed_at,
        account.state_changed_at
      );
      if account.state <> 'active' then
        update vortex_identity.organization_accounts as existing
        set state = 'active',
            display_name = coalesce(existing.display_name, p_display_name),
            originating_invitation_id = invitation.invitation_id,
            activated_at = existing.activated_at,
            changed_at = operation_at,
            state_changed_at = operation_at,
            state_changed_by = p_identity_id,
            state_change_correlation_id = p_correlation_id,
            revision = existing.revision + 1
        where existing.organization_account_id = account.organization_account_id
        returning existing.* into account;
      end if;
    else
      loop
        new_account_id := pg_catalog.gen_random_uuid();
        exit when new_account_id <>
          '00000000-0000-0000-0000-000000000000'::uuid;
      end loop;

      insert into vortex_identity.organization_accounts (
        organization_account_id, organization_id, identity_id, display_name,
        state, originating_invitation_id, activated_at, changed_at,
        state_changed_at, state_changed_by, state_change_correlation_id,
        revision
      ) values (
        new_account_id, invitation.organization_id, p_identity_id,
        p_display_name, 'active', invitation.invitation_id, operation_at,
        operation_at, operation_at, p_identity_id, p_correlation_id, 1
      ) returning * into account;
    end if;

    update vortex_identity.organization_invitations as accepted
    set accepted_at = operation_at,
        accepted_organization_account_id = account.organization_account_id,
        changed_at = operation_at,
        revision = accepted.revision + 1
    where accepted.invitation_id = invitation.invitation_id
      and accepted.accepted_at is null
      and accepted.revoked_at is null;
  end if;

  return query
  select result_outcome, account.organization_account_id,
    account.organization_id, account.identity_id, account.display_name,
    account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at,
    account.suspended_at, account.closed_at, account.changed_at,
    account.state_changed_at, account.state_changed_by,
    account.state_change_correlation_id, account.revision;
end
$function$;
