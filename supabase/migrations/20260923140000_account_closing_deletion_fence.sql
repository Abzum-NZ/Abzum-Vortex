-- Issue #565: the final account-deletion fence.
--
-- 'closing' is a protected, one-way state between an ordinary lifecycle state
-- and deletion. Entering it is an accounts.manage administration change that,
-- like suspend/close, invalidates the organisation's Access version and keeps
-- the permanent-steward invariant. It then fences new ownership three ways:
--   * every ownership-target check (the fixed transfer writers' target lock
--     and the creator's own request context) already requires 'active';
--   * a row trigger on every Record table refuses any write that assigns an
--     account owner unless that account is 'active', under a share lock on
--     the account row, so no stale precheck, direct SQL entry point or batch
--     can straddle the transition;
--   * a closing account can only become 'deleted', so neither administration
--     nor invitation acceptance can quietly lift the fence.
-- Final deletion locks the account row, then runs a private all-scope
-- inventory over every physical Record table in the organisation (every
-- application, installed or not, and organisation-shared storage; active,
-- soft-deleted and removal-pending rows alike, blind to the caller's record
-- visibility) and deletes only when it proves nothing is owned. The account
-- row and its historical attribution are retained.

begin;

alter table vortex_identity.organization_accounts
  add column closing_at timestamptz,
  add column deleted_at timestamptz;

alter table vortex_identity.organization_accounts
  drop constraint organization_accounts_state_valid;
alter table vortex_identity.organization_accounts
  add constraint organization_accounts_state_valid check (
    state in ('active', 'suspended', 'closed', 'closing', 'deleted')
  );

alter table vortex_identity.organization_accounts
  drop constraint organization_accounts_state_evidence;
alter table vortex_identity.organization_accounts
  add constraint organization_accounts_state_evidence check (
    (state <> 'suspended' or suspended_at is not null)
    and (state <> 'closed' or closed_at is not null)
    and (state <> 'closing' or (closing_at is not null and deleted_at is null))
    and (state <> 'deleted' or (closing_at is not null and deleted_at is not null))
    and (state in ('closing', 'deleted') or (closing_at is null and deleted_at is null))
  );

alter table vortex_identity.organization_accounts
  drop constraint organization_accounts_time_order;
alter table vortex_identity.organization_accounts
  add constraint organization_accounts_time_order check (
    changed_at >= activated_at
    and state_changed_at >= activated_at
    and (suspended_at is null or suspended_at >= activated_at)
    and (closed_at is null or closed_at >= activated_at)
    and (closing_at is null or closing_at >= activated_at)
    and (deleted_at is null or (closing_at is not null and deleted_at >= closing_at))
  );

-- Closing only ever leads to deletion, and a deleted account row is permanent
-- historical attribution. Every account writer passes through this trigger.
create or replace function vortex_identity.protect_organization_account()
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

  if old.state = 'deleted' then
    raise exception using errcode = '23514', message = 'A deleted organisation account is permanent';
  end if;

  if old.state = 'closing' and new.state not in ('closing', 'deleted') then
    raise exception using errcode = '23514', message = 'A closing organisation account can only be deleted';
  end if;

  if (old.closing_at is not null and new.closing_at is distinct from old.closing_at)
    or (old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at) then
    raise exception using errcode = '23514', message = 'Organisation-account closing evidence is permanent';
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

-- Identity-owned transitions. Neither is reachable by any request or runtime
-- role directly: Access composes closing, and the Record deletion fence
-- composes the lock and the deletion around its own inventory.
create function vortex_identity.begin_organization_account_closing(
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

-- The deletion fence's first step. FOR UPDATE conflicts with the share lock
-- every owner-assigning write takes on the account row (and with the key-share
-- lock of its foreign key), so an in-flight write finishes before the
-- inventory runs and a later one observes the deletion and refuses.
create function vortex_identity.lock_organization_account_for_deletion_internal(
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

create function vortex_identity.finalize_organization_account_deletion(
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

revoke all on function vortex_identity.begin_organization_account_closing(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.lock_organization_account_for_deletion_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke all on function vortex_identity.finalize_organization_account_deletion(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.lock_organization_account_for_deletion_internal(uuid)
  to vortex_record_adapter;
grant execute on function vortex_identity.finalize_organization_account_deletion(uuid, bigint)
  to vortex_record_adapter;

comment on function vortex_identity.begin_organization_account_closing(uuid, bigint) is
  'Owner-only active/suspended/closed-to-closing transition; Access composes it with version invalidation and stewardship.';
comment on function vortex_identity.lock_organization_account_for_deletion_internal(uuid) is
  'Private exclusive lock and state read that opens the account-deletion fence.';
comment on function vortex_identity.finalize_organization_account_deletion(uuid, bigint) is
  'Private closing-to-deleted transition, reachable only through the Record deletion fence after its inventory proves nothing is owned.';

-- Closing is a fixed accounts.manage administration change composed exactly
-- like account closure: the same scope, the same target-then-version lock
-- order, one Access-version invalidation and the stewardship invariant. The
-- account stops acting immediately, as for closure, so the existing
-- 'organization_account_closed' change reason is used.
create function vortex_access.begin_organization_account_closing_for_administration(
  p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  state text,
  closing_at timestamptz,
  revision bigint,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  target record;
  changed record;
  resulting_version bigint;
begin
  if p_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closing command is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;

  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;

  if not found or target.state not in ('active', 'suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closing is stale or unavailable';
  end if;

  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;

  select result.* into strict changed
  from vortex_identity.begin_organization_account_closing(
    p_organization_account_id, p_expected_revision
  ) as result;

  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closing' or changed.revision <> p_expected_revision + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  select incremented.current_version into strict resulting_version
  from vortex_access.increment_organization_access_version(
    scope.organization_id,
    scope.organization_account_id,
    changed.state_change_correlation_id,
    'organization_account_closed'
  ) as incremented;

  if resulting_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  perform vortex_access.assert_organization_has_permanent_steward(scope.organization_id);

  return query select changed.organization_account_id, changed.organization_id,
    changed.state, changed.closing_at, changed.revision, resulting_version;
end
$function$;

revoke all on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint)
  to vortex_request;
comment on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) is
  'Protected one-way active/suspended/closed-to-closing account command under accounts.manage; deletion is a separate, later fence.';

-- Invitation acceptance may reactivate a non-active account, but never a
-- closing or deleted one: both are 'unavailable', exactly like a re-invitation
-- that predates the account's last state change. This is the current
-- definition with only that condition extended.
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


-- The authoritative ownership fence. Every Record table carries it, so every
-- insert and every owner change (creates, named-action creates, single and
-- batched transfers and any future writer) assigns an account owner only while
-- that account is 'active' in the row's organisation. The share lock serialises
-- with closing and with the deletion fence's exclusive lock; an unchanged owner
-- on update is not a new assignment, so retained rows of inactive accounts stay
-- maintainable.
create function vortex_access.fence_record_owner_account_target_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if new.owner_organisation_account_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.owner_organisation_account_id is not distinct from old.owner_organisation_account_id
      and new.organisation_id is not distinct from old.organisation_id then
      return new;
    end if;
  end if;

  perform 1
  from vortex_identity.organization_accounts as account
  where account.organization_id = new.organisation_id
    and account.organization_account_id = new.owner_organisation_account_id
    and account.state = 'active'
  for share of account;

  if not found then
    raise exception using errcode = '40001', message = 'Record owner account is not active';
  end if;

  return new;
end
$function$;

alter function vortex_access.fence_record_owner_account_target_internal()
  owner to postgres;
revoke all on function vortex_access.fence_record_owner_account_target_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
-- The Record table owner attaches the trigger; nothing can call it directly.
grant execute on function vortex_access.fence_record_owner_account_target_internal()
  to vortex_record_owner;
comment on function vortex_access.fence_record_owner_account_target_internal() is
  'Row trigger on every Record table: an assigned account owner must be active in the row organisation, under a share lock on the account.';

-- The inventory needs to see every application's rows, which the adapter's
-- application-scoped policies deliberately never allow. This dedicated role
-- owns only the private inventory below, cannot log in or bypass row
-- security, and reads Record tables solely through its own organisation-scoped
-- SELECT policy.
do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'vortex_record_inventory') then
    create role vortex_record_inventory nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  else
    alter role vortex_record_inventory nologin noinherit nosuperuser nocreatedb
      nocreaterole noreplication nobypassrls;
  end if;
end
$roles$;

revoke vortex_record_inventory
  from anon, authenticated, service_role, vortex_runtime, vortex_request;
grant vortex_record_inventory to postgres with inherit false, set true;

grant usage on schema vortex_context to vortex_record_inventory;
grant execute on function vortex_context.current_context(),
  vortex_context.organization_id() to vortex_record_inventory;

set local role vortex_record_owner;

grant usage on schema record_data to vortex_record_inventory;

-- One idempotent per-table step: the account-owner index (so the inventory
-- probe is indexed on every table), the inventory role's read policy and grant,
-- and the ownership fence trigger.
create function vortex_record.ensure_account_deletion_fence_internal(
  p_physical_table_token text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  relation_id oid;
begin
  if p_physical_table_token is null
    or p_physical_table_token !~ '^rt_[a-f0-9]{32}$' then
    raise exception using errcode = '55000',
      message = 'Account-deletion fence storage is unavailable';
  end if;
  relation_id := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_physical_table_token)
  );
  if relation_id is null then
    raise exception using errcode = '55000',
      message = 'Account-deletion fence storage is unavailable';
  end if;

  perform vortex_record.ensure_offboarding_owner_index_internal(p_physical_table_token);

  execute pg_catalog.format(
    'grant select on record_data.%I to vortex_record_inventory', p_physical_table_token
  );
  if not exists (
    select 1 from pg_catalog.pg_policy as policy
    where policy.polrelid = relation_id
      and policy.polname = 'record_account_deletion_inventory'
  ) then
    execute pg_catalog.format(
      'create policy record_account_deletion_inventory on record_data.%I
         for select to vortex_record_inventory
         using (organisation_id = vortex_context.organization_id())',
      p_physical_table_token
    );
  end if;

  execute pg_catalog.format(
    'drop trigger if exists record_owner_account_fence on record_data.%I',
    p_physical_table_token
  );
  execute pg_catalog.format(
    'create trigger record_owner_account_fence
       before insert or update of owner_organisation_account_id, organisation_id
       on record_data.%I
       for each row execute function vortex_access.fence_record_owner_account_target_internal()',
    p_physical_table_token
  );
end
$function$;

revoke all on function vortex_record.ensure_account_deletion_fence_internal(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
comment on function vortex_record.ensure_account_deletion_fence_internal(text) is
  'Private provisioner for one Record table: owner index, inventory read policy and the ownership fence trigger.';

create function vortex_record.provision_account_deletion_fence_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if new.physical_schema_token = 'record_data' then
    perform vortex_record.ensure_account_deletion_fence_internal(new.physical_table_token);
  end if;
  return new;
end
$function$;

revoke all on function vortex_record.provision_account_deletion_fence_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

-- The catalogue insert is the successful end of live provisioning, after the
-- physical table exists, so every future Record table is fenced as it appears.
create trigger storage_catalogue_account_deletion_fence
after insert on vortex_record.storage_catalogue
for each row execute function vortex_record.provision_account_deletion_fence_internal();

comment on trigger storage_catalogue_account_deletion_fence on vortex_record.storage_catalogue is
  'Fences each new Record table for account deletion as it enters the live catalogue.';

-- Backfill exactly the physical tables the inventory walks.
do $block$
declare physical record;
begin
  for physical in
    select relation.relname
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'record_data'
      and relation.relkind = 'r'
      and relation.relname ~ '^rt_[a-f0-9]{32}$'
    order by relation.relname
  loop
    perform vortex_record.ensure_account_deletion_fence_internal(physical.relname);
  end loop;
end
$block$;

-- USAGE lets the inventory role resolve the schema-qualified name when it sets the
-- privileges on the function it creates; it is lent only for this transaction.
grant usage, create on schema vortex_record to vortex_record_inventory;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_inventory;

-- The private, undisclosed completeness check. It walks every physical Record
-- table rather than an installation's bound contracts, so other applications,
-- detached or uninstalled applications and organisation-shared storage are all
-- included, with every lifecycle state. It proves completeness or fails: a
-- Record table without this role's policy would read as empty, so it refuses;
-- a missing grant or column is an error. Only a boolean crosses the boundary.
create function vortex_record.account_retains_owned_records_internal(
  p_organization_account_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  organization_id_value uuid;
  physical record;
  found_any boolean;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Account deletion inventory selector is invalid';
  end if;

  organization_id_value := vortex_context.organization_id();
  if organization_id_value is null then
    raise exception using errcode = '55000',
      message = 'Account deletion inventory completeness cannot be proved';
  end if;

  for physical in
    select relation.oid as relation_id, relation.relname, relation.relkind,
      relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'record_data'
      and relation.relname ~ '^rt_[a-f0-9]{32}$'
    order by relation.relname
  loop
    if physical.relkind <> 'r'
      or (physical.relrowsecurity and not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = physical.relation_id
          and policy.polname = 'record_account_deletion_inventory'
      )) then
      raise exception using errcode = '55000',
        message = 'Account deletion inventory completeness cannot be proved';
    end if;

    execute pg_catalog.format(
      'select exists (
         select 1 from record_data.%I as stored
         where stored.organisation_id = $1
           and stored.owner_organisation_account_id = $2
       )',
      physical.relname
    ) into found_any using organization_id_value, p_organization_account_id;

    if found_any then
      return true;
    end if;
  end loop;

  return false;
end
$function$;

revoke all on function vortex_record.account_retains_owned_records_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.account_retains_owned_records_internal(uuid)
  to vortex_record_adapter;
comment on function vortex_record.account_retains_owned_records_internal(uuid) is
  'Private all-scope account-deletion inventory over every physical Record table in the organisation; returns only whether any owned row remains.';

reset role;
set local role vortex_record_adapter;

-- The protected flow: accounts.manage, the account lock, the undisclosed
-- inventory and the deletion, in one transaction. Only a closing account is
-- inventoried, and a refusal never says which record or scope remains. A
-- retry after deletion reports the same 'deleted' outcome.
create function vortex_record.finalize_account_deletion_fence(
  p_organization_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  target record;
  changed record;
  resulting_revision bigint;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Account deletion command is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  -- After the lock wait, each later statement must read the rows committed
  -- by the writers it waited for; an older transaction snapshot cannot.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '55000',
      message = 'Account deletion inventory completeness cannot be proved';
  end if;

  select locked.state, locked.revision into target
  from vortex_identity.lock_organization_account_for_deletion_internal(
    p_organization_account_id
  ) as locked;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'not_closing',
      'accessVersion', scope.access_version
    );
  end if;

  if target.state not in ('closing', 'deleted') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'not_closing',
      'organizationAccountId', p_organization_account_id,
      'state', target.state,
      'revision', target.revision,
      'accessVersion', scope.access_version
    );
  end if;

  resulting_revision := target.revision;
  if target.state = 'closing' then
    if vortex_record.account_retains_owned_records_internal(p_organization_account_id) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'records_remain',
        'accessVersion', scope.access_version
      );
    end if;

    select result.* into strict changed
    from vortex_identity.finalize_organization_account_deletion(
      p_organization_account_id, target.revision
    ) as result;

    if changed.organization_id <> scope.organization_id
      or changed.organization_account_id <> p_organization_account_id
      or changed.state <> 'deleted'
      or changed.revision <> target.revision + 1 then
      raise exception using errcode = '42501', message = 'Account deletion result is unavailable';
    end if;
    resulting_revision := changed.revision;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'deleted',
    'organizationAccountId', p_organization_account_id,
    'state', 'deleted',
    'revision', resulting_revision,
    'accessVersion', scope.access_version
  );
end
$function$;

revoke all on function vortex_record.finalize_account_deletion_fence(uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.finalize_account_deletion_fence(uuid) to vortex_request;
comment on function vortex_record.finalize_account_deletion_fence(uuid) is
  'Protected final account-deletion fence: accounts.manage, exclusive account lock, private all-scope inventory, then closing-to-deleted only when nothing is owned.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
revoke usage, create on schema vortex_record from vortex_record_inventory;
reset role;

commit;
