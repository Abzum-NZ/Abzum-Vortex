-- Cluster-local identity eligibility, organisation accounts, and invitation
-- lifecycle. Supabase Auth remains the environment Identity Authority; this
-- schema stores no provider credential, token, email profile, or MFA state.

create table vortex_identity.identity_projections (
  identity_id uuid not null,
  state text not null,
  created_at timestamptz not null,
  state_changed_at timestamptz not null,
  state_changed_by uuid not null,
  state_change_correlation_id uuid not null,
  revision bigint not null,
  constraint identity_projections_pk primary key (identity_id),
  constraint identity_projections_id_non_nil check (
    identity_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint identity_projections_state_valid check (
    state in ('active', 'suspended', 'closed')
  ),
  constraint identity_projections_state_changed_by_non_nil check (
    state_changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint identity_projections_correlation_non_nil check (
    state_change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint identity_projections_time_order check (state_changed_at >= created_at),
  constraint identity_projections_revision_range check (
    revision between 1 and 9007199254740991
  )
);

create table vortex_identity.organization_accounts (
  organization_account_id uuid not null,
  organization_id uuid not null,
  identity_id uuid not null,
  display_name text,
  state text not null,
  language text,
  time_zone text,
  originating_invitation_id uuid,
  activated_at timestamptz not null,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz not null,
  state_changed_at timestamptz not null,
  state_changed_by uuid not null,
  state_change_correlation_id uuid not null,
  revision bigint not null,
  constraint organization_accounts_pk primary key (organization_account_id),
  constraint organization_accounts_id_non_nil check (
    organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_accounts_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_accounts_identity_non_nil check (
    identity_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_accounts_display_name_valid check (
    display_name is null
    or (
      display_name = pg_catalog.btrim(display_name)
      and pg_catalog.char_length(display_name) between 1 and 120
    )
  ),
  constraint organization_accounts_state_valid check (
    state in ('active', 'suspended', 'closed')
  ),
  constraint organization_accounts_language_valid check (
    language is null
    or (
      language = pg_catalog.btrim(language)
      and pg_catalog.char_length(language) between 2 and 35
    )
  ),
  constraint organization_accounts_time_zone_valid check (
    time_zone is null
    or (
      time_zone = pg_catalog.btrim(time_zone)
      and pg_catalog.char_length(time_zone) between 1 and 100
    )
  ),
  constraint organization_accounts_state_evidence check (
    (state <> 'suspended' or suspended_at is not null)
    and (state <> 'closed' or closed_at is not null)
  ),
  constraint organization_accounts_time_order check (
    changed_at >= activated_at
    and state_changed_at >= activated_at
    and (suspended_at is null or suspended_at >= activated_at)
    and (closed_at is null or closed_at >= activated_at)
  ),
  constraint organization_accounts_state_changed_by_non_nil check (
    state_changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_accounts_correlation_non_nil check (
    state_change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_accounts_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_accounts_organization_identity_unique unique (
    organization_id,
    identity_id
  ),
  constraint organization_accounts_organization_account_unique unique (
    organization_id,
    organization_account_id
  ),
  constraint organization_accounts_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id),
  constraint organization_accounts_identity_fk foreign key (identity_id)
    references vortex_identity.identity_projections (identity_id)
);

create index organization_accounts_identity_lookup_idx
  on vortex_identity.organization_accounts (identity_id, organization_id);

create index organization_accounts_originating_invitation_idx
  on vortex_identity.organization_accounts (organization_id, originating_invitation_id)
  where originating_invitation_id is not null;

create table vortex_identity.organization_invitations (
  invitation_id uuid not null,
  organization_id uuid not null,
  invited_email text not null,
  token_fingerprint text not null,
  invited_by_organization_account_id uuid not null,
  created_at timestamptz not null,
  invited_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_organization_account_id uuid,
  accepted_at timestamptz,
  accepted_organization_account_id uuid,
  changed_at timestamptz not null,
  revision bigint not null,
  constraint organization_invitations_pk primary key (invitation_id),
  constraint organization_invitations_id_non_nil check (
    invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_invitations_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_invitations_email_normalized check (
    invited_email = pg_catalog.lower(pg_catalog.btrim(invited_email))
    and pg_catalog.char_length(invited_email) between 3 and 320
    and invited_email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  constraint organization_invitations_token_fingerprint_format check (
    token_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint organization_invitations_token_fingerprint_unique unique (token_fingerprint),
  constraint organization_invitations_inviter_non_nil check (
    invited_by_organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_invitations_revoker_non_nil check (
    revoked_by_organization_account_id is null
    or revoked_by_organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_invitations_accepted_account_non_nil check (
    accepted_organization_account_id is null
    or accepted_organization_account_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint organization_invitations_time_order check (
    invited_at >= created_at
    and expires_at > invited_at
    and changed_at >= created_at
    and (revoked_at is null or revoked_at >= invited_at)
    and (accepted_at is null or accepted_at >= invited_at)
  ),
  constraint organization_invitations_revocation_complete check (
    (revoked_at is null) = (revoked_by_organization_account_id is null)
  ),
  constraint organization_invitations_acceptance_complete check (
    (accepted_at is null) = (accepted_organization_account_id is null)
  ),
  constraint organization_invitations_one_terminal_outcome check (
    revoked_at is null or accepted_at is null
  ),
  constraint organization_invitations_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint organization_invitations_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id),
  constraint organization_invitations_inviter_same_organization_fk foreign key (
    organization_id,
    invited_by_organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id,
    organization_account_id
  ),
  constraint organization_invitations_revoker_same_organization_fk foreign key (
    organization_id,
    revoked_by_organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id,
    organization_account_id
  ),
  constraint organization_invitations_accepted_same_organization_fk foreign key (
    organization_id,
    accepted_organization_account_id
  ) references vortex_identity.organization_accounts (
    organization_id,
    organization_account_id
  )
);

alter table vortex_identity.organization_invitations
  add constraint organization_invitations_organization_invitation_unique unique (
    organization_id,
    invitation_id
  );

alter table vortex_identity.organization_accounts
  add constraint organization_accounts_originating_invitation_fk foreign key (
    organization_id,
    originating_invitation_id
  ) references vortex_identity.organization_invitations (organization_id, invitation_id);

create index organization_invitations_organization_email_idx
  on vortex_identity.organization_invitations (organization_id, invited_email, expires_at desc)
  where accepted_at is null and revoked_at is null;

create index organization_invitations_inviter_idx
  on vortex_identity.organization_invitations (
    organization_id,
    invited_by_organization_account_id
  );

create index organization_invitations_revoker_idx
  on vortex_identity.organization_invitations (
    organization_id,
    revoked_by_organization_account_id
  ) where revoked_by_organization_account_id is not null;

create index organization_invitations_accepted_account_idx
  on vortex_identity.organization_invitations (
    organization_id,
    accepted_organization_account_id
  ) where accepted_organization_account_id is not null;

alter table vortex_identity.identity_projections enable row level security;
alter table vortex_identity.identity_projections force row level security;
alter table vortex_identity.organization_accounts enable row level security;
alter table vortex_identity.organization_accounts force row level security;
alter table vortex_identity.organization_invitations enable row level security;
alter table vortex_identity.organization_invitations force row level security;

create function vortex_identity.protect_identity_projection()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.identity_id is distinct from old.identity_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'Identity projection identity is permanent';
  end if;

  if old.state = 'closed' and new.state <> 'closed' then
    raise exception using errcode = '23514', message = 'A closed identity projection cannot be reactivated';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Identity projection revision is stale or invalid';
  end if;

  return new;
end
$function$;

create function vortex_identity.protect_organization_account()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.organization_account_id is distinct from old.organization_account_id
    or new.organization_id is distinct from old.organization_id
    or new.identity_id is distinct from old.identity_id
    or new.activated_at < old.activated_at then
    raise exception using errcode = '23514', message = 'Organisation-account identity and scope are permanent';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Organisation-account revision is stale or invalid';
  end if;

  return new;
end
$function$;

create function vortex_identity.protect_organization_invitation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.invitation_id is distinct from old.invitation_id
    or new.organization_id is distinct from old.organization_id
    or new.invited_email is distinct from old.invited_email
    or new.token_fingerprint is distinct from old.token_fingerprint
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
$function$;

create trigger identity_projections_protect
before update on vortex_identity.identity_projections
for each row execute function vortex_identity.protect_identity_projection();

create trigger organization_accounts_protect
before update on vortex_identity.organization_accounts
for each row execute function vortex_identity.protect_organization_account();

create trigger organization_invitations_protect
before update on vortex_identity.organization_invitations
for each row execute function vortex_identity.protect_organization_invitation();

create function vortex_identity.validated_human_account_context()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'human'
    or not checked ?& array['identityId', 'organizationAccountId'] then
    raise exception using errcode = '42501', message = 'Organisation-account operation requires human context';
  end if;

  if not exists (
    select 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
    where account.organization_account_id = (checked ->> 'organizationAccountId')::uuid
      and account.organization_id = (checked ->> 'organizationId')::uuid
      and account.identity_id = (checked ->> 'identityId')::uuid
      and organization.tenant_id = (checked ->> 'tenantId')::uuid
      and account.state = 'active'
      and identity.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Organisation-account context is inactive or unavailable';
  end if;

  return checked;
end
$function$;

create function vortex_identity.ensure_identity_projection(
  p_identity_id uuid,
  p_correlation_id uuid
)
returns table (
  identity_id uuid,
  state text,
  created_at timestamptz,
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
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Identity projection input is invalid';
  end if;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_identity_id, 'active', operation_at, operation_at, p_identity_id,
    p_correlation_id, 1
  ) on conflict on constraint identity_projections_pk do nothing;

  return query
  select projection.identity_id, projection.state, projection.created_at,
    projection.state_changed_at, projection.state_changed_by,
    projection.state_change_correlation_id, projection.revision
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id;
end
$function$;

create function vortex_identity.list_organization_accounts(p_identity_id uuid)
returns table (
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
language sql
stable
security definer
set search_path = ''
as $function$
  select account.organization_account_id, account.organization_id, account.identity_id,
    account.display_name, account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at, account.suspended_at,
    account.closed_at, account.changed_at, account.state_changed_at,
    account.state_changed_by, account.state_change_correlation_id, account.revision
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection
    on projection.identity_id = account.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where account.identity_id = p_identity_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  order by account.organization_id, account.organization_account_id
$function$;

create function vortex_identity.create_organization_invitation(
  p_invited_email text,
  p_token_fingerprint text,
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
    or p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Invitation input is invalid';
  end if;

  loop
    new_invitation_id := pg_catalog.gen_random_uuid();
    exit when new_invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, token_fingerprint,
    invited_by_organization_account_id, created_at, invited_at, expires_at,
    changed_at, revision
  ) values (
    new_invitation_id, (checked ->> 'organizationId')::uuid, p_invited_email,
    p_token_fingerprint, (checked ->> 'organizationAccountId')::uuid,
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

create function vortex_identity.revoke_organization_invitation(
  p_invitation_id uuid,
  p_expected_revision bigint
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
begin
  checked := vortex_identity.validated_human_account_context();

  return query
  update vortex_identity.organization_invitations as invitation
  set revoked_at = operation_at,
      revoked_by_organization_account_id = (checked ->> 'organizationAccountId')::uuid,
      changed_at = operation_at,
      revision = invitation.revision + 1
  where invitation.invitation_id = p_invitation_id
    and invitation.organization_id = (checked ->> 'organizationId')::uuid
    and invitation.revision = p_expected_revision
    and invitation.accepted_at is null
    and invitation.revoked_at is null
  returning invitation.invitation_id, invitation.organization_id, invitation.invited_email,
    invitation.invited_by_organization_account_id, invitation.created_at,
    invitation.invited_at, invitation.expires_at, invitation.revoked_at,
    invitation.revoked_by_organization_account_id, invitation.accepted_at,
    invitation.accepted_organization_account_id, invitation.changed_at,
    invitation.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Invitation is stale or unavailable';
  end if;
end
$function$;

create function vortex_identity.change_organization_account_state(
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_state text
)
returns table (
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
  checked jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  checked := vortex_identity.validated_human_account_context();
  if p_state not in ('active', 'suspended', 'closed') then
    raise exception using errcode = '22023', message = 'Organisation-account state is invalid';
  end if;

  return query
  update vortex_identity.organization_accounts as account
  set state = p_state,
      activated_at = account.activated_at,
      suspended_at = case when p_state = 'suspended' then operation_at else account.suspended_at end,
      closed_at = case when p_state = 'closed' then operation_at else account.closed_at end,
      changed_at = operation_at,
      state_changed_at = operation_at,
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = p_expected_revision
    and account.state is distinct from p_state
  returning account.organization_account_id, account.organization_id, account.identity_id,
    account.display_name, account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at, account.suspended_at,
    account.closed_at, account.changed_at, account.state_changed_at,
    account.state_changed_by, account.state_change_correlation_id, account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account is stale or unavailable';
  end if;
end
$function$;

create function vortex_identity.accept_organization_invitation(
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
  operation_at timestamptz := pg_catalog.statement_timestamp();
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
    raise exception using errcode = '22023', message = 'Invitation acceptance input is invalid';
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
      join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
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
    if invitation.expires_at <= operation_at or not exists (
      select 1
      from vortex_identity.organizations as organization
      join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
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
      if account.state <> 'active' and invitation.invited_at <= account.state_changed_at then
        return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid,
          null::text, null::text, null::text, null::text, null::uuid,
          null::timestamptz, null::timestamptz, null::timestamptz,
          null::timestamptz, null::timestamptz, null::uuid, null::uuid, null::bigint;
        return;
      end if;

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
        exit when new_account_id <> '00000000-0000-0000-0000-000000000000'::uuid;
      end loop;

      insert into vortex_identity.organization_accounts (
        organization_account_id, organization_id, identity_id, display_name, state,
        originating_invitation_id, activated_at, changed_at, state_changed_at,
        state_changed_by, state_change_correlation_id, revision
      ) values (
        new_account_id, invitation.organization_id, p_identity_id, p_display_name, 'active',
        invitation.invitation_id, operation_at, operation_at, operation_at,
        p_identity_id, p_correlation_id, 1
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
  select result_outcome, account.organization_account_id, account.organization_id,
    account.identity_id, account.display_name, account.state, account.language,
    account.time_zone, account.originating_invitation_id, account.activated_at,
    account.suspended_at, account.closed_at, account.changed_at,
    account.state_changed_at, account.state_changed_by,
    account.state_change_correlation_id, account.revision;
end
$function$;

revoke all on all tables in schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on all sequences in schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke execute on all functions in schema vortex_identity
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant usage on schema vortex_identity to vortex_runtime;
grant execute on function vortex_identity.ensure_identity_projection(uuid, uuid)
  to vortex_runtime;
grant execute on function vortex_identity.list_organization_accounts(uuid)
  to vortex_runtime;
grant execute on function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid)
  to vortex_runtime;

comment on table vortex_identity.identity_projections is
  'Cluster-local identity eligibility keyed by the environment Identity Authority identity ID.';
comment on table vortex_identity.organization_accounts is
  'One separate organisation-local account per identity and organisation.';
comment on table vortex_identity.organization_invitations is
  'Organisation invitations containing only one-way acceptance-token fingerprints.';
comment on function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid) is
  'Atomically accepts one available invitation using request-local verified identity facts.';
