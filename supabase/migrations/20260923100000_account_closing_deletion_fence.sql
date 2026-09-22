-- Issue #565: the final account-deletion fence. Closing an account is a new
-- protected intermediate state between an ordinary lifecycle state and actual
-- deletion. Ownership-target validation and the fixed transfer writers already
-- refuse any account whose state is not 'active' (see
-- vortex_access.lock_active_record_ownership_target_internal and
-- vortex_identity.validated_human_account_context), so entering 'closing'
-- fences new ownership without touching those call sites. Deletion itself
-- only proceeds once a private, undisclosed inventory reusing #563/#564's
-- exact installation and storage-contract resolution proves every owned
-- record is gone, blind to lifecycle state and to the caller's own record
-- visibility.

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
    and (state <> 'closing' or closing_at is not null)
    and (state <> 'deleted' or (closing_at is not null and deleted_at is not null))
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

-- A deleted account is terminal, exactly like a closed identity projection.
-- Closing is not terminal: an administrator can still resolve it back to an
-- ordinary state without deleting, which is why only 'deleted' is fenced here.
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

  if old.state = 'deleted' and new.state <> 'deleted' then
    raise exception using errcode = '23514', message = 'A deleted organisation account cannot be reactivated';
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

-- Entering 'closing' is available from every non-terminal state. A 'closed'
-- account already refuses new ownership (its state is not 'active' either),
-- but only 'closing' carries the deletion fence's own evidence and precedes
-- the final inventory.
create function vortex_identity.begin_organization_account_closing(
  p_organization_account_id uuid,
  p_expected_revision bigint
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
  closing_at timestamptz,
  deleted_at timestamptz,
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

  -- The plain UPDATE below takes the same row lock a concurrent ownership
  -- target check takes with `for share of account`: whichever started first
  -- is finished before the other proceeds, so an in-flight transfer either
  -- completes against the still-active account or observes 'closing' and
  -- refuses; no transfer can straddle the transition.
  return query
  update vortex_identity.organization_accounts as account
  set state = 'closing',
      closing_at = operation_at,
      activated_at = account.activated_at,
      changed_at = operation_at,
      state_changed_at = operation_at,
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = p_expected_revision
    and account.state in ('active', 'suspended', 'closed')
  returning account.organization_account_id, account.organization_id, account.identity_id,
    account.display_name, account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at, account.suspended_at,
    account.closed_at, account.closing_at, account.deleted_at, account.changed_at,
    account.state_changed_at, account.state_changed_by, account.state_change_correlation_id,
    account.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account closing is stale or unavailable';
  end if;
end
$function$;

comment on function vortex_identity.begin_organization_account_closing(uuid, bigint) is
  'Protected active/suspended/closed-to-closing account transition that fences new ownership assignment ahead of final deletion.';

-- Deletion never receives an expected revision from outside this flow: it
-- always follows the same-transaction undisclosed inventory check, and the
-- row is already exclusively locked here before that check is trusted.
create function vortex_identity.finalize_organization_account_deletion(
  p_organization_account_id uuid
)
returns table (
  outcome text,
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
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_row vortex_identity.organization_accounts%rowtype;
  changed vortex_identity.organization_accounts%rowtype;
begin
  checked := vortex_identity.validated_human_account_context();

  select account.* into current_row
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
  for update;

  if not found or current_row.state <> 'closing' then
    return query select 'not_closing'::text, p_organization_account_id,
      (checked ->> 'organizationId')::uuid, current_row.state, current_row.revision;
    return;
  end if;

  update vortex_identity.organization_accounts as account
  set state = 'deleted',
      deleted_at = operation_at,
      activated_at = account.activated_at,
      changed_at = operation_at,
      state_changed_at = operation_at,
      state_changed_by = (checked ->> 'organizationAccountId')::uuid,
      state_change_correlation_id = (checked ->> 'correlationId')::uuid,
      revision = account.revision + 1
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = (checked ->> 'organizationId')::uuid
    and account.revision = current_row.revision
    and account.state = 'closing'
  returning account.* into changed;

  if not found then
    raise exception using errcode = '40001', message = 'Organisation account deletion is stale or unavailable';
  end if;

  return query select 'deleted'::text, changed.organization_account_id,
    changed.organization_id, changed.state, changed.revision;
end
$function$;

comment on function vortex_identity.finalize_organization_account_deletion(uuid) is
  'Protected closing-to-deleted transition. The caller must already have proved the account owns nothing in this same protected flow; this function itself only re-admits the closing precondition.';

revoke execute on function vortex_identity.begin_organization_account_closing(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke execute on function vortex_identity.finalize_organization_account_deletion(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- Only the record-adapter-owned deletion fence composes the identity write
-- with its own undisclosed completeness check; Identity keeps ownership of
-- the row and its transitions.
grant execute on function vortex_identity.finalize_organization_account_deletion(uuid)
  to vortex_record_adapter;

-- The closing transition is a plain accounts.manage administration change,
-- exactly like suspend/reactivate/close, so it is exposed the same way: a
-- fixed Access wrapper under the existing accounts.manage scope check.
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
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
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

  select result.* into strict changed
  from vortex_identity.begin_organization_account_closing(
    p_organization_account_id, p_expected_revision
  ) as result;

  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closing' or changed.revision <> p_expected_revision + 1 then
    raise exception using errcode = '42501', message = 'Account closing result is unavailable';
  end if;

  return query select changed.organization_account_id, changed.organization_id,
    changed.state, changed.closing_at, changed.revision, scope.access_version;
end
$function$;

revoke execute on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint)
  to vortex_request;
comment on function vortex_access.begin_organization_account_closing_for_administration(uuid, bigint) is
  'Protected active/suspended/closed-to-closing account command under the existing accounts.manage authority; deletion is a separate, later step.';

-- The undisclosed completeness check. It reuses the exact #563/#564
-- installation and storage-contract resolution (active-or-detached
-- installation, contracts pinned to it) so it walks precisely what the
-- disclosed preview walks, but every storage contract in one pass, blind to
-- lifecycle state (active, soft-deleted and removal-pending all count as
-- owned) and to the caller's own per-record transfer visibility. It returns
-- only a boolean: no record identity, type or count crosses this boundary.
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.account_owns_any_record_in_current_scope_internal(
  p_organization_account_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  installation jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  candidate_sql text;
  found_any boolean;
begin
  if p_organization_account_id is null or p_organization_account_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Account deletion inventory selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '22023',
      message = 'Account deletion inventory requires an application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  installation := vortex_module.read_current_offboarding_inventory_installation_internal();

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id in (
        select (value #>> '{}')::uuid
        from pg_catalog.jsonb_array_elements(installation -> 'storageContractIds') as item(value)
      )
      and catalogue.state = 'active'
      and catalogue.record_type_definition ->> 'ownershipMode' = 'organization_account'
  loop
    if catalogue_row.storage_scope = 'organization_shared' then
      candidate_sql := pg_catalog.format(
        'select exists (
           select 1 from record_data.%I as stored
           where stored.organisation_id = $1
             and stored.application_root_id is null
             and stored.owner_organisation_account_id = $2
         )',
        catalogue_row.physical_table_token
      );
      execute candidate_sql into found_any using organization_id_value, p_organization_account_id;
    else
      candidate_sql := pg_catalog.format(
        'select exists (
           select 1 from record_data.%I as stored
           where stored.organisation_id = $1
             and stored.application_root_id = $2
             and stored.owner_organisation_account_id = $3
         )',
        catalogue_row.physical_table_token
      );
      execute candidate_sql into found_any
        using organization_id_value, application_root_id_value, p_organization_account_id;
    end if;
    if found_any then
      return true;
    end if;
  end loop;

  return false;
end
$function$;

revoke all on function vortex_record.account_owns_any_record_in_current_scope_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.account_owns_any_record_in_current_scope_internal(uuid) is
  'Private undisclosed completeness check across every organisation-account-owned storage contract pinned to the current installation, application-contained and organisation-shared alike, blind to lifecycle state and per-record disclosure. Returns only a boolean.';

-- The protected flow itself: accounts.manage once, the undisclosed check,
-- and only on a proven-empty result does it hand the closing account to
-- Identity's finalize transition. A refusal never says which record remains.
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
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  scope record;
  owns_any boolean;
  changed record;
begin
  if p_organization_account_id is null or p_organization_account_id = nil_uuid then
    raise exception using errcode = '22023', message = 'Account deletion command is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  owns_any := vortex_record.account_owns_any_record_in_current_scope_internal(p_organization_account_id);
  if owns_any then
    return pg_catalog.jsonb_build_object(
      'outcome', 'records_remain',
      'accessVersion', scope.access_version
    );
  end if;

  select result.* into strict changed
  from vortex_identity.finalize_organization_account_deletion(p_organization_account_id) as result;

  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id then
    raise exception using errcode = '42501', message = 'Account deletion result is unavailable';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', changed.outcome,
    'organizationAccountId', changed.organization_account_id,
    'state', changed.state,
    'revision', changed.revision,
    'accessVersion', scope.access_version
  );
end
$function$;

revoke all on function vortex_record.finalize_account_deletion_fence(uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.finalize_account_deletion_fence(uuid) to vortex_request;
comment on function vortex_record.finalize_account_deletion_fence(uuid) is
  'Protected final account-deletion fence: accounts.manage once, then the undisclosed completeness check for the current installation and organisation-shared scope; deletion proceeds only when it reports nothing owned.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
