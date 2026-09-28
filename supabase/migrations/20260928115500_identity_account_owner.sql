-- Run the account, invitation, runtime-settings, projection and disablement definers
-- under the least-privilege Identity owner. Bodies below are re-installed verbatim
-- from their current migration definitions; no stored definition is read.

begin;

grant usage on schema vortex_context to vortex_identity_owner;

grant execute on function vortex_context.current_context() to vortex_identity_owner;

grant execute on function vortex_identity.validated_human_account_context() to vortex_identity_owner;

grant execute on function vortex_identity.assert_organization_runtime_settings_values(text, text, text, text, text) to vortex_identity_owner;

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

revoke all on function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid) is
  'Atomically accepts one available invitation using request-local verified identity facts.';

alter function vortex_identity.accept_organization_invitation(text, uuid, text, text, uuid) owner to vortex_identity_owner;

create or replace function vortex_identity.accept_organization_invitation_with_transition(
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
  where invitation.token_fingerprint = p_token_fingerprint
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
    p_token_fingerprint,
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

revoke all on function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.accept_organization_invitation_with_transition(
  text, uuid, text, text, uuid
) is 'Owner-only Identity invitation transition with explicit Access change classification.';

alter function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid) to postgres;

create or replace function vortex_identity.begin_organization_account_closing(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
  closing_at timestamptz,
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
begin
  checked := vortex_identity.validated_human_account_context();

  return query
  update vortex_identity.organization_accounts as account
  set state = 'closing',
      closing_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      activated_at = account.activated_at,
      changed_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      state_changed_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = p_expected_revision
    and account.state in ('active', 'suspended', 'closed')
  returning account.organization_account_id, account.organization_id, account.state,
    account.closing_at, account.state_change_correlation_id, account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account closing is stale or unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.begin_organization_account_closing(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.begin_organization_account_closing(uuid, bigint) is
  'Owner-only active/suspended/closed-to-closing transition; Access composes it with version invalidation and stewardship.';

alter function vortex_identity.begin_organization_account_closing(uuid, bigint) owner to vortex_identity_owner;
grant execute on function vortex_identity.begin_organization_account_closing(uuid, bigint) to postgres;

create or replace function vortex_identity.change_organization_account_state(
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

revoke all on function vortex_identity.change_organization_account_state(uuid, bigint, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.change_organization_account_state(uuid, bigint, text) is null;

alter function vortex_identity.change_organization_account_state(uuid, bigint, text) owner to vortex_identity_owner;
grant execute on function vortex_identity.change_organization_account_state(uuid, bigint, text) to postgres;

create or replace function vortex_identity.create_organization_invitation(
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

revoke all on function vortex_identity.create_organization_invitation(text, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.create_organization_invitation(text, text, timestamptz) is null;

alter function vortex_identity.create_organization_invitation(text, text, timestamptz) owner to vortex_identity_owner;
grant execute on function vortex_identity.create_organization_invitation(text, text, timestamptz) to postgres;

create or replace function vortex_identity.ensure_identity_projection(
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

revoke all on function vortex_identity.ensure_identity_projection(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.ensure_identity_projection(uuid, uuid) to vortex_runtime;

comment on function vortex_identity.ensure_identity_projection(uuid, uuid) is null;

alter function vortex_identity.ensure_identity_projection(uuid, uuid) owner to vortex_identity_owner;

create or replace function vortex_identity.finalize_organization_account_deletion(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_identity.validated_human_account_context();

  return query
  update vortex_identity.organization_accounts as account
  set state = 'deleted',
      deleted_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      activated_at = account.activated_at,
      changed_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      state_changed_at = greatest(
        pg_catalog.statement_timestamp(), account.changed_at, account.state_changed_at
      ),
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = p_expected_revision
    and account.state = 'closing'
  returning account.organization_account_id, account.organization_id, account.state,
    account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account deletion is stale or unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) to vortex_record_adapter;

comment on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) is
  'Private closing-to-deleted transition, reachable only through the Record deletion fence after its inventory proves nothing is owned.';

alter function vortex_identity.finalize_organization_account_deletion(uuid, bigint) owner to vortex_identity_owner;
grant execute on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) to postgres;

create or replace function vortex_identity.identity_is_disabled(p_identity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.identity_disablement_commands as command
    where command.subject_identity_id = p_identity_id
      and command.outcome = 'disabled'
  )
$function$;

revoke all on function vortex_identity.identity_is_disabled(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.identity_is_disabled(uuid) is
  'Private environment-wide disabled fact: true only after a completed identity disablement.';

alter function vortex_identity.identity_is_disabled(uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.identity_is_disabled(uuid) to postgres;

create or replace function vortex_identity.initialize_organization_runtime_settings(
  p_organization_id uuid,
  p_language text,
  p_time_zone text,
  p_currency text,
  p_date_format text,
  p_number_format text
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings initialization is invalid';
  end if;
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_language, p_time_zone, p_currency, p_date_format, p_number_format
  );

  -- Serialize setup through the organisation itself.  That makes two
  -- simultaneous identical setup calls behave as retries rather than leaving
  -- one with a unique-constraint error, and it refuses an unknown organisation
  -- before any settings row can be created.
  perform 1
  from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings initialization is unavailable';
  end if;

  -- The organisation lock makes this read and the following insert one
  -- serializable setup decision for an organisation.
  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;

  if found then
    if existing.language is distinct from p_language
      or existing.time_zone is distinct from p_time_zone
      or existing.currency is distinct from p_currency
      or existing.date_format is distinct from p_date_format
      or existing.number_format is distinct from p_number_format then
      raise exception using errcode = '40001',
        message = 'Organization runtime settings are already initialized differently';
    end if;
    return query select existing.organization_id, existing.language, existing.time_zone,
      existing.currency, existing.date_format, existing.number_format, existing.revision;
    return;
  end if;

  insert into vortex_identity.organization_runtime_settings (
    organization_id, language, time_zone, currency, date_format, number_format,
    initialized_at, changed_at, revision
  ) values (
    p_organization_id, p_language, p_time_zone, p_currency, p_date_format,
    p_number_format, operation_at, operation_at, 1
  ) returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format, existing.revision;
end
$function$;

revoke all on function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) to vortex_runtime;

comment on function vortex_identity.initialize_organization_runtime_settings(
  uuid, text, text, text, text, text
) is 'Trusted explicit Identity setup for one organisation runtime-settings row; identical retries return the current existing row and conflicting retries refuse.';

alter function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) owner to vortex_identity_owner;
grant execute on function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) to postgres;

create or replace function vortex_identity.is_active_organization_account_reference_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where tenant.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
  )
$function$;

revoke all on function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) to vortex_record_adapter;

comment on function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) is null;

alter function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) owner to vortex_identity_owner;

create or replace function vortex_identity.list_organization_account_choices_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_search text,
  p_page_size integer,
  p_after_sort_key text,
  p_after_organization_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  search_value text;
  result_value jsonb;
begin
  if p_tenant_id is null
    or p_organization_id is null
    or p_page_size is null
    or p_page_size not between 1 and 100
    or (p_search is not null and pg_catalog.char_length(p_search) not between 1 and 100)
    or (p_after_sort_key is null) <> (p_after_organization_account_id is null)
    or pg_catalog.char_length(p_after_sort_key) > 1000 then
    raise exception using errcode = '22023',
      message = 'Organisation account choice page input is invalid';
  end if;
  search_value := pg_catalog.lower(p_search);

  with candidates as (
    select account.organization_account_id,
      account.display_name,
      (coalesce(pg_catalog.lower(account.display_name), '') collate "C") as sort_key
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where tenant.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
      and (
        search_value is null
        or pg_catalog.strpos(pg_catalog.lower(account.display_name), search_value) > 0
      )
  ),
  page as (
    select candidate.organization_account_id, candidate.display_name, candidate.sort_key,
      pg_catalog.row_number() over (
        order by candidate.sort_key, candidate.organization_account_id
      ) as ordinal
    from candidates as candidate
    where p_after_sort_key is null
      or (candidate.sort_key, candidate.organization_account_id)
        > ((p_after_sort_key collate "C"), p_after_organization_account_id)
    order by candidate.sort_key, candidate.organization_account_id
    limit p_page_size + 1
  )
  select pg_catalog.jsonb_build_object(
    'accounts', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'organizationAccountId', entry.organization_account_id,
          'displayName', entry.display_name
        )) order by entry.ordinal
      ) filter (where entry.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    'next', case
      when pg_catalog.count(*) > p_page_size then
        (pg_catalog.array_agg(
          pg_catalog.jsonb_build_object(
            'sortKey', entry.sort_key,
            'organizationAccountId', entry.organization_account_id
          ) order by entry.ordinal
        ) filter (where entry.ordinal <= p_page_size))[p_page_size]
      else null
    end
  )
  into result_value
  from page as entry;

  return result_value;
end
$function$;

revoke all on function vortex_identity.list_organization_account_choices_internal(uuid, uuid, text, integer, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_account_choices_internal(
  uuid, uuid, text, integer, text, uuid
) is 'Identity-owned bounded picker projection of active accounts in one active organisation: account id and display name only, keyset-paged, no counts.';

alter function vortex_identity.list_organization_account_choices_internal(uuid, uuid, text, integer, text, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.list_organization_account_choices_internal(uuid, uuid, text, integer, text, uuid) to postgres;

create or replace function vortex_identity.list_organization_accounts(p_identity_id uuid)
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

revoke all on function vortex_identity.list_organization_accounts(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_accounts(uuid) is null;

alter function vortex_identity.list_organization_accounts(uuid) owner to vortex_identity_owner;

create or replace function vortex_identity.list_organization_accounts_for_administration_internal(
  p_organization_id uuid,
  p_after_organization_account_id uuid,
  p_page_size integer
)
returns table (
  accounts jsonb,
  next_after_organization_account_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  account_items jsonb;
  page_account_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_organization_account_id =
      '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account administration page input is invalid';
  end if;

  with candidates as (
    select account.organization_account_id, account.display_name,
      account.state, account.language, account.time_zone, account.revision,
      pg_catalog.row_number() over (
        order by account.organization_account_id
      ) as ordinal
    from vortex_identity.organization_accounts as account
    where account.organization_id = p_organization_id
      and (
        p_after_organization_account_id is null
        or account.organization_account_id > p_after_organization_account_id
      )
    order by account.organization_account_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'organizationAccountId', candidate.organization_account_id,
          'displayName', candidate.display_name,
          'state', candidate.state,
          'language', candidate.language,
          'timeZone', candidate.time_zone,
          'revision', candidate.revision
        )) order by candidate.organization_account_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.organization_account_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into account_items, page_account_ids, candidate_count
  from candidates as candidate;

  return query select account_items,
    case when candidate_count > p_page_size
      then page_account_ids[p_page_size] else null end;
end
$function$;

revoke all on function vortex_identity.list_organization_accounts_for_administration_internal(uuid, uuid, integer) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_accounts_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe account administration projection.';

alter function vortex_identity.list_organization_accounts_for_administration_internal(uuid, uuid, integer) owner to vortex_identity_owner;
grant execute on function vortex_identity.list_organization_accounts_for_administration_internal(uuid, uuid, integer) to postgres;

create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid,
  p_active_members_only boolean
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  -- Two fixed visibility modes, chosen only by the Access-owned reader. The
  -- administration mode returns every account of the organisation. The member
  -- mode applies today's account-choice rule: only active accounts whose
  -- identity, organisation and tenant are active, and only the display name and
  -- state, exactly the facts any active member may already list.
  select account.organization_account_id, account.display_name, account.state,
    case when p_active_members_only then null else account.language end,
    case when p_active_members_only then null else account.time_zone end,
    account.revision
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection
    on projection.identity_id = account.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where account.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and p_active_members_only is not null
    and (
      not p_active_members_only
      or (
        account.state = 'active'
        and projection.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
      )
    )
  order by account.organization_account_id
$function$;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) is
  'Identity-owned set-returning safe organisation-account projection bounded to the given organisation: every account in administration mode, or only active accounts with their display name and state in member mode; identity, originating invitation and state-change evidence are never exposed, and the already-decided request scope is the only visibility.';

alter function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) owner to vortex_identity_owner;
grant execute on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) to postgres;

create or replace function vortex_identity.list_organization_invitations_for_administration_internal(
  p_organization_id uuid,
  p_after_invitation_id uuid,
  p_page_size integer
)
returns table (
  invitations jsonb,
  next_after_invitation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_items jsonb;
  page_invitation_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration page input is invalid';
  end if;

  with candidates as (
    select invitation.invitation_id, invitation.organization_id,
      invitation.invited_email, invitation.invited_by_organization_account_id,
      invitation.created_at, invitation.invited_at, invitation.expires_at,
      invitation.revoked_at, invitation.revoked_by_organization_account_id,
      invitation.accepted_at, invitation.accepted_organization_account_id,
      invitation.changed_at, invitation.revision,
      pg_catalog.row_number() over (order by invitation.invitation_id) as ordinal
    from vortex_identity.organization_invitations as invitation
    where invitation.organization_id = p_organization_id
      and (
        p_after_invitation_id is null
        or invitation.invitation_id > p_after_invitation_id
      )
    order by invitation.invitation_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'invitationId', candidate.invitation_id,
          'organizationId', candidate.organization_id,
          'invitedEmail', candidate.invited_email,
          'invitedBy', candidate.invited_by_organization_account_id,
          'createdAt', candidate.created_at,
          'invitedAt', candidate.invited_at,
          'expiresAt', candidate.expires_at,
          'revokedAt', candidate.revoked_at,
          'revokedBy', candidate.revoked_by_organization_account_id,
          'acceptedAt', candidate.accepted_at,
          'acceptedOrganizationAccountId', candidate.accepted_organization_account_id,
          'changedAt', candidate.changed_at,
          'revision', candidate.revision
        )) order by candidate.invitation_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.invitation_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into invitation_items, page_invitation_ids, candidate_count
  from candidates as candidate;

  return query select invitation_items,
    case when candidate_count > p_page_size
      then page_invitation_ids[p_page_size] else null end;
end
$function$;

revoke all on function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_invitations_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe invitation projection without secret or fingerprint.';

alter function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) owner to vortex_identity_owner;
grant execute on function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) to postgres;

create or replace function vortex_identity.list_organization_invitations_projection_internal(
  p_organization_id uuid
)
returns table (
  invitation_id uuid,
  invited_email text,
  invitation_state text,
  invited_at timestamptz,
  expires_at timestamptz,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select invitation.invitation_id, invitation.invited_email,
    case
      when invitation.accepted_at is not null then 'accepted'
      when invitation.revoked_at is not null then 'revoked'
      when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired'
      else 'pending'
    end,
    invitation.invited_at, invitation.expires_at, invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  order by invitation.invitation_id
$function$;

revoke all on function vortex_identity.list_organization_invitations_projection_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_invitations_projection_internal(uuid) is
  'Identity-owned set-returning safe organisation-invitation projection bounded to the given organisation: the raw invitation secret and its stored fingerprint are never exposed, and the already-decided request scope is the only visibility.';

alter function vortex_identity.list_organization_invitations_projection_internal(uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.list_organization_invitations_projection_internal(uuid) to postgres;

create or replace function vortex_identity.lock_organization_account_for_deletion_internal(
  p_organization_account_id uuid
)
returns table (
  state text,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_identity.validated_human_account_context();

  return query
  select account.state, account.revision
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
  for update of account;
end
$function$;

revoke all on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) to vortex_record_adapter;

comment on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) is
  'Private exclusive lock and state read that opens the account-deletion fence.';

alter function vortex_identity.lock_organization_account_for_deletion_internal(uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) to postgres;

create or replace function vortex_identity.publish_identity_disablement(
  p_subject_identity_id uuid,
  p_actor_identity_id uuid,
  p_correlation_id uuid,
  p_published_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_identity.projection:' || p_subject_identity_id::text, 0
    )
  );

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_subject_identity_id
  for update;

  update vortex_identity.identity_projections as projection
  set state = 'suspended',
    state_changed_at = greatest(p_published_at, projection.state_changed_at),
    state_changed_by = p_actor_identity_id,
    state_change_correlation_id = p_correlation_id,
    revision = projection.revision + 1
  where projection.identity_id = p_subject_identity_id
    and projection.state = 'active';
end
$function$;

revoke all on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) is
  'Private step of complete_identity_disablement: suspends the subject''s existing cluster-local identity projection.';

alter function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) owner to vortex_identity_owner;
grant execute on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) to postgres;

create or replace function vortex_identity.read_current_organization_runtime_settings_internal(
  p_organization_id uuid
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings read is invalid';
  end if;
  return query
  select settings.organization_id, settings.language, settings.time_zone,
    settings.currency, settings.date_format, settings.number_format,
    settings.revision
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id;
end
$function$;

revoke all on function vortex_identity.read_current_organization_runtime_settings_internal(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_current_organization_runtime_settings_internal(uuid) is null;

alter function vortex_identity.read_current_organization_runtime_settings_internal(uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.read_current_organization_runtime_settings_internal(uuid) to postgres;

create or replace function vortex_identity.read_identity_projection(p_identity_id uuid)
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
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Identity projection identifier is invalid';
  end if;

  return query
  select projection.identity_id, projection.state, projection.created_at,
    projection.state_changed_at, projection.state_changed_by,
    projection.state_change_correlation_id, projection.revision
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id;
end
$function$;

revoke all on function vortex_identity.read_identity_projection(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.read_identity_projection(uuid) to vortex_runtime;

comment on function vortex_identity.read_identity_projection(uuid) is
  'Returns one existing cluster-local identity projection without creating or changing it.';

alter function vortex_identity.read_identity_projection(uuid) owner to vortex_identity_owner;

create or replace function vortex_identity.read_organization_account_for_administration_internal(
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns table (
  outcome text,
  account_summary jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  account_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'organizationAccountId', account.organization_account_id,
    'displayName', account.display_name,
    'state', account.state,
    'language', account.language,
    'timeZone', account.time_zone,
    'revision', account.revision
  ))
  into account_value
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id;

  return query select
    case when account_value is null then 'unavailable' else 'available' end,
    account_value;
end
$function$;

revoke all on function vortex_identity.read_organization_account_for_administration_internal(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_organization_account_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe account administration projection.';

alter function vortex_identity.read_organization_account_for_administration_internal(uuid, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.read_organization_account_for_administration_internal(uuid, uuid) to postgres;

create or replace function vortex_identity.read_organization_invitation_for_administration_internal(
  p_organization_id uuid,
  p_invitation_id uuid
)
returns table (
  outcome text,
  invitation jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_invitation_id is null
    or p_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'invitationId', invitation.invitation_id,
    'organizationId', invitation.organization_id,
    'invitedEmail', invitation.invited_email,
    'invitedBy', invitation.invited_by_organization_account_id,
    'createdAt', invitation.created_at,
    'invitedAt', invitation.invited_at,
    'expiresAt', invitation.expires_at,
    'revokedAt', invitation.revoked_at,
    'revokedBy', invitation.revoked_by_organization_account_id,
    'acceptedAt', invitation.accepted_at,
    'acceptedOrganizationAccountId', invitation.accepted_organization_account_id,
    'changedAt', invitation.changed_at,
    'revision', invitation.revision
  ))
  into invitation_value
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and invitation.invitation_id = p_invitation_id;

  return query select
    case when invitation_value is null then 'unavailable' else 'available' end,
    invitation_value;
end
$function$;

revoke all on function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_organization_invitation_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe invitation projection without secret or fingerprint.';

alter function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) to postgres;

create or replace function vortex_identity.read_organization_time_zone_internal(
  p_organization_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  zone_value text;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization time zone read is invalid';
  end if;
  select settings.time_zone
  into zone_value
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id;
  return zone_value;
end
$function$;

revoke all on function vortex_identity.read_organization_time_zone_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;

grant execute on function vortex_identity.read_organization_time_zone_internal(uuid)
  to vortex_record_adapter;

comment on function vortex_identity.read_organization_time_zone_internal(uuid) is
  'Private reader of one organisation''s configured time zone, or null when its runtime settings are not set up; callable only by the record adapter with the organisation of its own validated request context.';

alter function vortex_identity.read_organization_time_zone_internal(uuid) owner to vortex_identity_owner;

create or replace function vortex_identity.read_staged_organization_runtime_settings_update()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  staged jsonb;
begin
  select row_value.settings into staged
  from vortex_identity.organization_runtime_settings_update_staging as row_value
  where row_value.backend_pid = pg_catalog.pg_backend_pid()
    and row_value.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  if staged is null then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;
  return staged;
end
$function$;

revoke all on function vortex_identity.read_staged_organization_runtime_settings_update() from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_staged_organization_runtime_settings_update() is null;

alter function vortex_identity.read_staged_organization_runtime_settings_update() owner to vortex_identity_owner;

create or replace function vortex_identity.revoke_organization_invitation(
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

revoke all on function vortex_identity.revoke_organization_invitation(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.revoke_organization_invitation(uuid, bigint) is null;

alter function vortex_identity.revoke_organization_invitation(uuid, bigint) owner to vortex_identity_owner;
grant execute on function vortex_identity.revoke_organization_invitation(uuid, bigint) to postgres;

create or replace function vortex_identity.stage_organization_runtime_settings_update(
  p_settings jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_settings is null or pg_catalog.jsonb_typeof(p_settings) <> 'object'
    or not p_settings ?& array[
      'organizationId', 'language', 'timeZone', 'currency', 'dateFormat',
      'numberFormat', 'revision'
    ]
    or p_settings - array[
      'organizationId', 'language', 'timeZone', 'currency', 'dateFormat',
      'numberFormat', 'revision'
    ] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings staging is invalid';
  end if;

  insert into vortex_identity.organization_runtime_settings_update_staging as staged (
    backend_pid, transaction_id, settings
  ) values (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_settings
  ) on conflict on constraint organization_runtime_settings_update_staging_pk do update
    set transaction_id = excluded.transaction_id, settings = excluded.settings
    where staged.transaction_id <> excluded.transaction_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Organization runtime settings update is already staged';
  end if;
end
$function$;

revoke all on function vortex_identity.stage_organization_runtime_settings_update(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.stage_organization_runtime_settings_update(jsonb) to vortex_runtime;

comment on function vortex_identity.stage_organization_runtime_settings_update(jsonb) is null;

alter function vortex_identity.stage_organization_runtime_settings_update(jsonb) owner to vortex_identity_owner;

create or replace function vortex_identity.update_organization_account_profile_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_language text,
  p_time_zone text
)
returns table (
  organization_id uuid,
  organization_account_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_accounts%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120
    or (p_language is not null
      and (p_language <> pg_catalog.btrim(p_language)
        or pg_catalog.char_length(p_language) not between 2 and 35))
    or (p_time_zone is not null
      and (p_time_zone <> pg_catalog.btrim(p_time_zone)
        or pg_catalog.char_length(p_time_zone) not between 1 and 100)) then
    raise exception using errcode = '22023',
      message = 'Organization account profile update is invalid';
  end if;

  select account.* into existing
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found
    or existing.state <> 'active'
    or existing.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001',
      message = 'Organization account profile update is stale or unavailable';
  end if;
  if existing.display_name is not distinct from p_display_name
    and existing.language is not distinct from p_language
    and existing.time_zone is not distinct from p_time_zone then
    raise exception using errcode = '40001',
      message = 'Organization account profile is unchanged';
  end if;

  update vortex_identity.organization_accounts as account
  set display_name = p_display_name,
      language = p_language,
      time_zone = p_time_zone,
      changed_at = pg_catalog.statement_timestamp(),
      revision = account.revision + 1
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id
  returning * into existing;

  return query select existing.organization_id, existing.organization_account_id,
    existing.display_name, existing.state, existing.language, existing.time_zone,
    existing.changed_at, existing.revision;
end
$function$;

revoke all on function vortex_identity.update_organization_account_profile_internal(
  uuid, uuid, bigint, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

comment on function vortex_identity.update_organization_account_profile_internal(
  uuid, uuid, bigint, text, text, text
) is
  'Owner-only Identity writer for one active organisation account profile under an exact current revision; changes display name, language and time zone only and advances the account revision.';

alter function vortex_identity.update_organization_account_profile_internal(uuid, uuid, bigint, text, text, text) owner to vortex_identity_owner;
grant execute on function vortex_identity.update_organization_account_profile_internal(uuid, uuid, bigint, text, text, text) to postgres;

create or replace function vortex_identity.update_organization_default_application_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_default_application_root_id uuid
)
returns table (
  organization_id uuid,
  previous_default_application_root_id uuid,
  default_application_root_id uuid,
  revision bigint,
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  previous_id uuid;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or (p_default_application_root_id is not null
      and p_default_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Organization default application update is invalid';
  end if;

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization default application is stale or unavailable';
  end if;

  previous_id := existing.default_application_root_id;

  -- Re-submitting the current value is not a change: report it unchanged so no
  -- Activity is written and the revision is not advanced.
  if previous_id is not distinct from p_default_application_root_id then
    return query select existing.organization_id, previous_id, previous_id,
      existing.revision, false;
    return;
  end if;

  update vortex_identity.organization_runtime_settings as settings
  set default_application_root_id = p_default_application_root_id,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, previous_id,
    existing.default_application_root_id, existing.revision, true;
end
$function$;

revoke all on function vortex_identity.update_organization_default_application_internal(uuid, bigint, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.update_organization_default_application_internal(
  uuid, bigint, uuid
) is
  'Private Identity writer for the exact organisation default application reference; requires the current settings revision and reports an unchanged value without advancing it.';

alter function vortex_identity.update_organization_default_application_internal(uuid, bigint, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.update_organization_default_application_internal(uuid, bigint, uuid) to postgres;

create or replace function vortex_identity.update_organization_runtime_settings_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_language text,
  p_time_zone text,
  p_currency text,
  p_date_format text,
  p_number_format text
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings update is invalid';
  end if;
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_language, p_time_zone, p_currency, p_date_format, p_number_format
  );

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization runtime settings are stale or unavailable';
  end if;

  update vortex_identity.organization_runtime_settings as settings
  set language = p_language,
      time_zone = p_time_zone,
      currency = p_currency,
      date_format = p_date_format,
      number_format = p_number_format,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format, existing.revision;
end
$function$;

revoke all on function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) is null;

alter function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) owner to vortex_identity_owner;
grant execute on function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) to postgres;

create or replace function vortex_identity.save_organization_runtime_settings_record_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  default_application_root_id uuid,
  extension_values jsonb,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  language_value text;
  time_zone_value text;
  currency_value text;
  date_format_value text;
  number_format_value text;
  default_application_root_id_value uuid;
  extension_values_value jsonb;
  extension_item record;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or p_core_values - array[
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object'
    or p_extension_values ?| array[
      'organization_id', 'revision', 'language', 'time_zone', 'currency',
      'date_format', 'number_format', 'default_application_root_id'
    ] then
    raise exception using errcode = '22023',
      message = 'Organization settings record update is invalid';
  end if;

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization settings record is stale or unavailable';
  end if;

  language_value := existing.language;
  time_zone_value := existing.time_zone;
  currency_value := existing.currency;
  date_format_value := existing.date_format;
  number_format_value := existing.number_format;
  default_application_root_id_value := existing.default_application_root_id;

  if p_core_values ? 'language' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'language') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    language_value := p_core_values ->> 'language';
  end if;
  if p_core_values ? 'time_zone' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'time_zone') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    time_zone_value := p_core_values ->> 'time_zone';
  end if;
  if p_core_values ? 'currency' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'currency') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    currency_value := p_core_values ->> 'currency';
  end if;
  if p_core_values ? 'date_format' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'date_format') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    date_format_value := p_core_values ->> 'date_format';
  end if;
  if p_core_values ? 'number_format' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'number_format') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    number_format_value := p_core_values ->> 'number_format';
  end if;
  if p_core_values ? 'default_application_root_id' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') = 'null' then
      default_application_root_id_value := null;
    elsif pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') = 'string'
      and pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      default_application_root_id_value :=
        (p_core_values ->> 'default_application_root_id')::uuid;
    else
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    language_value, time_zone_value, currency_value, date_format_value, number_format_value
  );

  extension_values_value := existing.extension_values;
  for extension_item in
    select item.key, item.value
    from pg_catalog.jsonb_each(p_extension_values) as item(key, value)
    order by item.key collate "C"
  loop
    if pg_catalog.jsonb_typeof(extension_item.value) = 'null' then
      extension_values_value := extension_values_value - extension_item.key;
    else
      extension_values_value := extension_values_value || pg_catalog.jsonb_build_object(
        extension_item.key, extension_item.value
      );
    end if;
  end loop;

  update vortex_identity.organization_runtime_settings as settings
  set language = language_value,
      time_zone = time_zone_value,
      currency = currency_value,
      date_format = date_format_value,
      number_format = number_format_value,
      default_application_root_id = default_application_root_id_value,
      extension_values = extension_values_value,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format,
    existing.default_application_root_id, existing.extension_values, existing.revision;
end
$function$;

revoke all on function vortex_identity.save_organization_runtime_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.save_organization_runtime_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) is
  'Private revision-checked Identity writer for one organisation settings record, merging invariant field patches and declared extension values in the same settings row.';

alter function vortex_identity.save_organization_runtime_settings_record_internal(uuid, bigint, jsonb, jsonb) owner to vortex_identity_owner;
grant execute on function vortex_identity.save_organization_runtime_settings_record_internal(uuid, bigint, jsonb, jsonb) to postgres;

grant select on table vortex_identity.organization_accounts to vortex_identity_owner;
grant insert (activated_at, changed_at, display_name, identity_id, organization_account_id, organization_id, originating_invitation_id, revision, state, state_change_correlation_id, state_changed_at, state_changed_by) on table vortex_identity.organization_accounts to vortex_identity_owner;
grant update (activated_at, changed_at, closed_at, closing_at, deleted_at, display_name, language, originating_invitation_id, revision, state, state_change_correlation_id, state_changed_at, state_changed_by, suspended_at, time_zone) on table vortex_identity.organization_accounts to vortex_identity_owner;

grant select (created_at, identity_id, revision, state, state_change_correlation_id, state_changed_at, state_changed_by) on table vortex_identity.identity_projections to vortex_identity_owner;
grant insert (created_at, identity_id, revision, state, state_change_correlation_id, state_changed_at, state_changed_by) on table vortex_identity.identity_projections to vortex_identity_owner;
grant update (revision, state, state_change_correlation_id, state_changed_at, state_changed_by) on table vortex_identity.identity_projections to vortex_identity_owner;

grant select on table vortex_identity.organization_invitations to vortex_identity_owner;
grant insert (changed_at, created_at, expires_at, invitation_id, invited_at, invited_by_organization_account_id, invited_email, organization_id, revision, token_fingerprint) on table vortex_identity.organization_invitations to vortex_identity_owner;
grant update (accepted_at, accepted_organization_account_id, changed_at, revision, revoked_at, revoked_by_organization_account_id) on table vortex_identity.organization_invitations to vortex_identity_owner;

grant select (display_name, organization_id, short_name, state, tenant_id) on table vortex_identity.organizations to vortex_identity_owner;
grant update (organization_id) on table vortex_identity.organizations to vortex_identity_owner;
grant select (display_name, short_name, state, tenant_id) on table vortex_identity.tenants to vortex_identity_owner;

grant select on table vortex_identity.organization_runtime_settings to vortex_identity_owner;
grant insert (changed_at, currency, date_format, initialized_at, language, number_format, organization_id, revision, time_zone) on table vortex_identity.organization_runtime_settings to vortex_identity_owner;
grant update (changed_at, currency, date_format, default_application_root_id, extension_values, language, number_format, revision, time_zone) on table vortex_identity.organization_runtime_settings to vortex_identity_owner;

grant select (backend_pid, settings, transaction_id) on table vortex_identity.organization_runtime_settings_update_staging to vortex_identity_owner;
grant insert (backend_pid, settings, transaction_id) on table vortex_identity.organization_runtime_settings_update_staging to vortex_identity_owner;
grant update (settings, transaction_id) on table vortex_identity.organization_runtime_settings_update_staging to vortex_identity_owner;

grant select (outcome, subject_identity_id) on table vortex_identity.identity_disablement_commands to vortex_identity_owner;

create policy identity_owner_accounts_select on vortex_identity.organization_accounts for select to vortex_identity_owner using (true);
create policy identity_owner_accounts_insert on vortex_identity.organization_accounts for insert to vortex_identity_owner with check (true);
create policy identity_owner_accounts_update on vortex_identity.organization_accounts for update to vortex_identity_owner using (true) with check (true);
create policy identity_owner_projections_select on vortex_identity.identity_projections for select to vortex_identity_owner using (true);
create policy identity_owner_projections_insert on vortex_identity.identity_projections for insert to vortex_identity_owner with check (true);
create policy identity_owner_projections_update on vortex_identity.identity_projections for update to vortex_identity_owner using (true) with check (true);
create policy identity_owner_invitations_select on vortex_identity.organization_invitations for select to vortex_identity_owner using (true);
create policy identity_owner_invitations_insert on vortex_identity.organization_invitations for insert to vortex_identity_owner with check (true);
create policy identity_owner_invitations_update on vortex_identity.organization_invitations for update to vortex_identity_owner using (true) with check (true);
create policy identity_owner_organizations_select on vortex_identity.organizations for select to vortex_identity_owner using (true);
create policy identity_owner_organizations_update on vortex_identity.organizations for update to vortex_identity_owner using (true) with check (true);
create policy identity_owner_tenants_select on vortex_identity.tenants for select to vortex_identity_owner using (true);
create policy identity_owner_runtime_settings_select on vortex_identity.organization_runtime_settings for select to vortex_identity_owner using (true);
create policy identity_owner_runtime_settings_insert on vortex_identity.organization_runtime_settings for insert to vortex_identity_owner with check (true);
create policy identity_owner_runtime_settings_update on vortex_identity.organization_runtime_settings for update to vortex_identity_owner using (true) with check (true);
create policy identity_owner_runtime_staging_select on vortex_identity.organization_runtime_settings_update_staging for select to vortex_identity_owner using (true);
create policy identity_owner_runtime_staging_insert on vortex_identity.organization_runtime_settings_update_staging for insert to vortex_identity_owner with check (true);
create policy identity_owner_runtime_staging_update on vortex_identity.organization_runtime_settings_update_staging for update to vortex_identity_owner using (true) with check (true);
create policy identity_owner_disablement_commands_select on vortex_identity.identity_disablement_commands for select to vortex_identity_owner using (true);

commit;
