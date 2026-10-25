-- An invited person accepts an invitation after signing in with the verified email it names, from
-- the organisation chooser (UI-43). The invitation is identified by its id; the secret token and
-- its fingerprint are gone. Inviting an email that already has a pending invitation is refused
-- (UI-44).
set role vortex_owner;

drop function vortex_access.accept_organization_invitation(text, uuid, text, text, uuid);
drop function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid);
drop function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid);
drop function vortex_access.create_organization_invitation_for_administration(uuid, text, text, timestamptz);
drop function vortex_identity.create_organization_invitation(text, text, timestamptz);

CREATE OR REPLACE FUNCTION vortex_identity.protect_organization_invitation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.invitation_id is distinct from old.invitation_id
    or new.organization_id is distinct from old.organization_id
    or new.invited_email is distinct from old.invited_email
    or new.invited_by_organization_account_id is distinct from old.invited_by_organization_account_id
    or new.created_at is distinct from old.created_at
    or new.invited_at is distinct from old.invited_at
    or new.expires_at is distinct from old.expires_at then
    raise exception using errcode = '23514', message = 'Invitation identity and scope are permanent';
  end if;

  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception using errcode = '23514', message = 'A completed invitation cannot change';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at then
    raise exception using errcode = '40001', message = 'Invitation revision is stale or invalid';
  end if;

  return new;
end
$$;

alter function vortex_identity.protect_organization_invitation() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.protect_organization_invitation() FROM PUBLIC;

grant execute on function vortex_identity.protect_organization_invitation() to postgres;

alter table vortex_identity.organization_invitations
  drop constraint organization_invitations_token_fingerprint_unique;
alter table vortex_identity.organization_invitations drop column token_fingerprint;
create index organization_invitations_pending_email_idx
  on vortex_identity.organization_invitations (invited_email, expires_at)
  where accepted_at is null and revoked_at is null;

create or replace function vortex_identity.accept_organization_invitation(
  p_invitation_id uuid,
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

  select candidate.*
  into invitation
  from vortex_identity.organization_invitations as candidate
  where candidate.invitation_id = p_invitation_id
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
      if account.state in ('closing', 'deleted')
        or (account.state <> 'active'
          and invitation.invited_at <= account.state_changed_at) then
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

revoke all on function vortex_identity.accept_organization_invitation(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.accept_organization_invitation(uuid, uuid, text, text, uuid) is
  'Atomically accepts one available invitation using request-local verified identity facts.';

alter function vortex_identity.accept_organization_invitation(uuid, uuid, text, text, uuid) owner to vortex_owner;

create or replace function vortex_identity.accept_organization_invitation_with_transition(
  p_invitation_id uuid,
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
  revision bigint,
  access_transition text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  candidate_organization_id uuid;
  prior_account_state text;
  classified_transition text := 'unchanged';
  accepted record;
begin
  select invitation.organization_id into candidate_organization_id
  from vortex_identity.organization_invitations as invitation
  where invitation.invitation_id = p_invitation_id
    and invitation.invited_email = p_verified_email
  for update;

  if found then
    select account.state into prior_account_state
    from vortex_identity.organization_accounts as account
    where account.organization_id = candidate_organization_id
      and account.identity_id = p_identity_id
    for update;

    if not found then
      classified_transition := 'activated';
    elsif prior_account_state <> 'active' then
      classified_transition := 'reactivated';
    end if;
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation(
    p_invitation_id,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome <> 'accepted' then
    classified_transition := 'unchanged';
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id, accepted.organization_id,
    accepted.identity_id, accepted.display_name, accepted.state, accepted.language,
    accepted.time_zone, accepted.invitation_id, accepted.activated_at,
    accepted.suspended_at, accepted.closed_at, accepted.changed_at,
    accepted.state_changed_at, accepted.state_changed_by,
    accepted.state_change_correlation_id, accepted.revision, classified_transition;
end
$function$;

revoke all on function vortex_identity.accept_organization_invitation_with_transition(uuid, uuid, text, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.accept_organization_invitation_with_transition(
  uuid, uuid, text, text, uuid
) is 'Owner-only Identity invitation transition with explicit Access change classification.';

alter function vortex_identity.accept_organization_invitation_with_transition(uuid, uuid, text, text, uuid) owner to vortex_owner;
grant execute on function vortex_identity.accept_organization_invitation_with_transition(uuid, uuid, text, text, uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.accept_organization_invitation(p_invitation_id uuid, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) RETURNS TABLE(outcome text, organization_account_id uuid, organization_id uuid, identity_id uuid, display_name text, state text, language text, time_zone text, invitation_id uuid, activated_at timestamp with time zone, suspended_at timestamp with time zone, closed_at timestamp with time zone, changed_at timestamp with time zone, state_changed_at timestamp with time zone, state_changed_by uuid, state_change_correlation_id uuid, revision bigint, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  target_organization_id uuid;
  invitation vortex_identity.organization_invitations%rowtype;
  accepted record;
  resulting_version bigint;
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

create or replace function vortex_identity.create_organization_invitation(
  p_invited_email text,
  p_expires_at timestamptz
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  invited_email text,
  invited_by uuid,
  created_at timestamptz,
  invited_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  accepted_at timestamptz,
  accepted_organization_account_id uuid,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  new_invitation_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();
  if p_invited_email is null
    or p_invited_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Invitation input is invalid';
  end if;

  -- One pending invitation per email and organisation: inviting again while one waits is refused.
  if exists (
    select 1
    from vortex_identity.organization_invitations as pending
    where pending.organization_id = (checked ->> 'organizationId')::uuid
      and pending.invited_email = p_invited_email
      and pending.accepted_at is null
      and pending.revoked_at is null
      and pending.expires_at > operation_at
  ) then
    raise exception using errcode = '23505', message = 'Invitation is already pending';
  end if;

  loop
    new_invitation_id := pg_catalog.gen_random_uuid();
    exit when new_invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, invited_by_organization_account_id,
    created_at, invited_at, expires_at, changed_at, revision
  ) values (
    new_invitation_id, (checked ->> 'organizationId')::uuid, p_invited_email,
    (checked ->> 'organizationAccountId')::uuid,
    operation_at, operation_at, p_expires_at, operation_at, 1
  );

  return query
  select invitation.invitation_id, invitation.organization_id, invitation.invited_email,
    invitation.invited_by_organization_account_id, invitation.created_at,
    invitation.invited_at, invitation.expires_at, invitation.revoked_at,
    invitation.revoked_by_organization_account_id, invitation.accepted_at,
    invitation.accepted_organization_account_id, invitation.changed_at,
    invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.invitation_id = new_invitation_id;
end
$function$;

revoke all on function vortex_identity.create_organization_invitation(text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.create_organization_invitation(text, timestamptz) is null;

alter function vortex_identity.create_organization_invitation(text, timestamptz) owner to vortex_owner;
grant execute on function vortex_identity.create_organization_invitation(text, timestamptz) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; command_fingerprint text; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'create_organization_invitation',
      scope.organization_id::text, p_invited_email, p_expires_at::text), 'UTF8'),
      'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_expires_at
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

alter function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) IS 'Protected no-intent invitation creation; replay returns receipt evidence. The invited person accepts it after signing in with that verified email.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) TO vortex_request;

grant execute on function vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_expires_at timestamp with time zone) to postgres;

create or replace function vortex_access.list_pending_invitations_for_identity(
  p_identity_id uuid,
  p_verified_email text
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  organization_display_name text,
  tenant_display_name text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email)) then
    raise exception using errcode = '22023', message = 'Pending invitation lookup is invalid';
  end if;
  -- The invitations a signed-in person may accept: sent to their verified email, still pending,
  -- in an active organisation where they hold no active account. At most 20, soonest expiry first.
  return query
  select invitation.invitation_id, invitation.organization_id, organization.display_name,
    tenant.display_name, invitation.expires_at
  from vortex_identity.organization_invitations as invitation
  join vortex_identity.organizations as organization
    on organization.organization_id = invitation.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where invitation.invited_email = p_verified_email
    and invitation.accepted_at is null
    and invitation.revoked_at is null
    and invitation.expires_at > pg_catalog.statement_timestamp()
    and organization.state = 'active'
    and tenant.state = 'active'
    and not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = invitation.organization_id
        and account.identity_id = p_identity_id
        and account.state = 'active'
    )
  order by invitation.expires_at, invitation.invitation_id
  limit 20;
end
$function$;

revoke all on function vortex_access.list_pending_invitations_for_identity(uuid, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
-- The server reads it for the verified identity of the signed-in session, outside any
-- organisation request (the person has no organisation account yet).
grant execute on function vortex_access.list_pending_invitations_for_identity(uuid, text)
  to vortex_runtime, postgres;
alter function vortex_access.list_pending_invitations_for_identity(uuid, text) owner to vortex_owner;

reset role;
