-- #408 dependency slice: authoritative Record recovery provenance and legal-hold state.
--
-- This pre-target migration deliberately does not define the full record-type lifecycle
-- policy.  `20260923010000_record_type_lifecycle_policies.sql` remains reserved for that
-- owner.  It provides the narrow state and owner-only composition seams that migration,
-- #50's protected restore writer, and #117's protected removal transaction consume.
--
-- Invariants:
--   * every Record fact is keyed by organisation + permanent application scope +
--     storage contract + record identity;
--   * application scope is null only for organisation-shared storage;
--   * recovery is derived from persisted deletion/removal times and exact policy
--     identity/revision evidence, never from a caller-writable protection boolean;
--   * missing, stale, or contradictory policy/provenance evidence fails closed;
--   * legal holds are organisation-owned, versioned, exact-scope matched, releasable,
--     and have no relationship to ordinary Record visibility;
--   * all mutators remain owner-only.  The two request-callable readers are content-free
--     and require the already-established exact request context.

set local role vortex_record_owner;

create table vortex_record.record_recovery_policy_states (
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid,
  application_scope_key uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  storage_scope text not null check (
    storage_scope in ('organization_shared', 'application_contained')
  ),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  record_type_id uuid not null,
  policy_id uuid not null check (
    policy_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  policy_revision bigint not null check (
    policy_revision between 1 and 9007199254740991
  ),
  recovery_period_days integer not null check (recovery_period_days between 0 and 3650),
  recorded_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (
    organization_id, application_scope_key, storage_contract_id, record_type_id
  ),
  check (
    (storage_scope = 'organization_shared' and application_root_id is null)
    or (storage_scope = 'application_contained' and application_root_id is not null)
  )
);

create table vortex_record.record_removal_guards (
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid,
  application_scope_key uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  storage_scope text not null check (
    storage_scope in ('organization_shared', 'application_contained')
  ),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  record_type_id uuid not null,
  record_id uuid not null check (
    record_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  protection_revision bigint not null default 1 check (
    protection_revision between 1 and 9007199254740991
  ),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (
    organization_id, application_scope_key, storage_contract_id, record_id
  ),
  check (
    (storage_scope = 'organization_shared' and application_root_id is null)
    or (storage_scope = 'application_contained' and application_root_id is not null)
  )
);

create table vortex_record.record_recovery_provenance (
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid,
  application_scope_key uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  storage_scope text not null check (
    storage_scope in ('organization_shared', 'application_contained')
  ),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  record_type_id uuid not null,
  record_id uuid not null check (
    record_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  deletion_record_revision bigint not null check (
    deletion_record_revision between 1 and 9007199254740991
  ),
  deleted_at timestamptz not null,
  removal_due_at timestamptz not null,
  policy_id uuid not null check (
    policy_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  policy_revision bigint not null check (
    policy_revision between 1 and 9007199254740991
  ),
  recovery_period_days integer not null check (recovery_period_days between 0 and 3650),
  recorded_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (
    organization_id, application_scope_key, storage_contract_id, record_id
  ),
  check (
    (storage_scope = 'organization_shared' and application_root_id is null)
    or (storage_scope = 'application_contained' and application_root_id is not null)
  ),
  check (
    removal_due_at = deleted_at + pg_catalog.make_interval(days => recovery_period_days)
  )
);

create table vortex_record.record_legal_holds (
  organization_id uuid not null references vortex_identity.organizations (organization_id),
  legal_hold_id uuid not null check (
    legal_hold_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  application_root_id uuid,
  application_scope_key uuid generated always as (
    coalesce(
      application_root_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) stored,
  storage_scope text not null check (
    storage_scope in ('organization_shared', 'application_contained')
  ),
  storage_contract_id uuid not null references vortex_record.storage_catalogue,
  record_type_id uuid not null,
  record_id uuid not null check (
    record_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  hold_revision bigint not null check (hold_revision between 1 and 9007199254740991),
  reason text not null check (
    pg_catalog.length(pg_catalog.btrim(reason)) between 1 and 1000
  ),
  created_by_organization_account_id uuid not null,
  started_at timestamptz not null,
  review_at timestamptz not null,
  released_at timestamptz,
  released_by_organization_account_id uuid,
  release_reason text,
  primary key (organization_id, legal_hold_id),
  foreign key (organization_id, created_by_organization_account_id)
    references vortex_identity.organization_accounts (
      organization_id, organization_account_id
    ),
  foreign key (organization_id, released_by_organization_account_id)
    references vortex_identity.organization_accounts (
      organization_id, organization_account_id
    ),
  check (
    (storage_scope = 'organization_shared' and application_root_id is null)
    or (storage_scope = 'application_contained' and application_root_id is not null)
  ),
  check (review_at > started_at),
  check (
    (released_at is null and released_by_organization_account_id is null
      and release_reason is null)
    or (released_at is not null and released_by_organization_account_id is not null
      and pg_catalog.length(pg_catalog.btrim(release_reason)) between 1 and 1000
      and released_at >= started_at)
  )
);

create index record_legal_holds_active_scope_idx
  on vortex_record.record_legal_holds (
    organization_id, application_scope_key, storage_contract_id, record_id
  )
  where released_at is null;

alter table vortex_record.record_recovery_policy_states enable row level security;
alter table vortex_record.record_recovery_policy_states force row level security;
alter table vortex_record.record_removal_guards enable row level security;
alter table vortex_record.record_removal_guards force row level security;
alter table vortex_record.record_recovery_provenance enable row level security;
alter table vortex_record.record_recovery_provenance force row level security;
alter table vortex_record.record_legal_holds enable row level security;
alter table vortex_record.record_legal_holds force row level security;

create policy record_recovery_policy_adapter_scope
  on vortex_record.record_recovery_policy_states
  for all to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  )
  with check (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  );

create policy record_removal_guard_adapter_scope
  on vortex_record.record_removal_guards
  for all to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  )
  with check (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  );

create policy record_recovery_provenance_adapter_scope
  on vortex_record.record_recovery_provenance
  for all to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  )
  with check (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  );

create policy record_legal_hold_adapter_scope
  on vortex_record.record_legal_holds
  for all to vortex_record_adapter
  using (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  )
  with check (
    organization_id = vortex_context.organization_id()
    and application_root_id is not distinct from
      case when storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end
  );

revoke all on vortex_record.record_recovery_policy_states,
  vortex_record.record_removal_guards,
  vortex_record.record_recovery_provenance,
  vortex_record.record_legal_holds
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant select, insert, update on vortex_record.record_recovery_policy_states,
  vortex_record.record_removal_guards,
  vortex_record.record_recovery_provenance,
  vortex_record.record_legal_holds
  to vortex_record_adapter;

grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

alter default privileges
  revoke execute on functions from public, anon, authenticated, service_role,
    vortex_runtime, vortex_request;

-- The reserved lifecycle-policy migration records its accepted current recovery
-- evidence through this owner-only projection.  Missing evidence remains a refusal.
create function vortex_record.record_current_recovery_policy_internal(
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_recovery_period_days integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  target_application_root_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  current_row vortex_record.record_recovery_policy_states%rowtype;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_policy_id is null or p_policy_id = nil_uuid
    or p_policy_revision is null
      or p_policy_revision not between 1 and 9007199254740991
    or p_recovery_period_days is null or p_recovery_period_days not between 0 and 3650 then
    raise exception using errcode = '22023',
      message = 'Record recovery policy evidence is invalid';
  end if;

  context_organization_id := vortex_context.organization_id();
  context_application_root_id := vortex_context.application_root_id(false);

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.record_type_id <> p_record_type_id then
    raise exception using errcode = '55000',
      message = 'Record recovery policy scope is unavailable';
  end if;
  target_application_root_id := case
    when catalogue_row.storage_scope = 'application_contained'
      then context_application_root_id else null end;
  if catalogue_row.storage_scope = 'application_contained'
    and target_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record recovery policy requires application context';
  end if;

  insert into vortex_record.record_recovery_policy_states (
    organization_id, application_root_id, storage_scope, storage_contract_id,
    record_type_id, policy_id, policy_revision, recovery_period_days, recorded_at
  ) values (
    context_organization_id, target_application_root_id, catalogue_row.storage_scope,
    p_storage_contract_id, p_record_type_id, p_policy_id, p_policy_revision,
    p_recovery_period_days, pg_catalog.statement_timestamp()
  )
  on conflict (
    organization_id, application_scope_key, storage_contract_id, record_type_id
  ) do nothing
  returning * into current_row;

  if found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'recorded', 'policyRevision', current_row.policy_revision,
      'replayed', false
    );
  end if;

  -- A conflicting first writer is complete before DO NOTHING returns. Lock its
  -- committed row, then apply the same identity/revision rules as every later
  -- writer; no absent-scope path can bypass this check.
  select state.* into current_row
  from vortex_record.record_recovery_policy_states as state
  where state.organization_id = context_organization_id
    and state.application_root_id is not distinct from target_application_root_id
    and state.storage_contract_id = p_storage_contract_id
    and state.record_type_id = p_record_type_id
  for update;
  if not found or current_row.policy_id <> p_policy_id
    or p_policy_revision < current_row.policy_revision
    or (p_policy_revision = current_row.policy_revision
      and current_row.recovery_period_days <> p_recovery_period_days) then
    raise exception using errcode = '40001',
      message = 'Record recovery policy evidence is stale';
  end if;
  if p_policy_revision = current_row.policy_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'recorded', 'policyRevision', current_row.policy_revision,
      'replayed', true
    );
  end if;

  update vortex_record.record_recovery_policy_states as state
  set policy_revision = p_policy_revision,
      recovery_period_days = p_recovery_period_days,
      recorded_at = pg_catalog.statement_timestamp()
  where state.organization_id = context_organization_id
    and state.application_root_id is not distinct from target_application_root_id
    and state.storage_contract_id = p_storage_contract_id
    and state.record_type_id = p_record_type_id
  returning * into current_row;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recorded', 'policyRevision', current_row.policy_revision,
    'replayed', false
  );
end
$function$;

-- Called in the same protected transaction after the existing #49 soft-delete
-- primitive.  It derives deletion time from the locked source row, calculates the
-- exact due time from accepted current-policy evidence, persists both, and never
-- performs deletion, restore, archive, Activity, Event, or receipt work.
create function vortex_record.record_recovery_provenance_internal(
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_record_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_organization_id uuid;
  context_application_root_id uuid;
  target_application_root_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  policy_row vortex_record.record_recovery_policy_states%rowtype;
  existing_provenance vortex_record.record_recovery_provenance%rowtype;
  stored_deleted_at timestamptz;
  stored_removal_due_at timestamptz;
  stored_revision bigint;
  stored_lifecycle_state text;
  calculated_removal_due_at timestamptz;
  changed_rows integer;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_expected_record_revision is null
      or p_expected_record_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Record recovery provenance input is invalid';
  end if;

  context_organization_id := vortex_context.organization_id();
  context_application_root_id := vortex_context.application_root_id(false);
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.physical_schema_token <> 'record_data' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;
  target_application_root_id := case
    when catalogue_row.storage_scope = 'application_contained'
      then context_application_root_id else null end;
  if catalogue_row.storage_scope = 'application_contained'
    and target_application_root_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  insert into vortex_record.record_removal_guards (
    organization_id, application_root_id, storage_scope, storage_contract_id,
    record_type_id, record_id
  ) values (
    context_organization_id, target_application_root_id, catalogue_row.storage_scope,
    p_storage_contract_id, p_record_type_id, p_record_id
  ) on conflict do nothing;
  perform guard.protection_revision
  from vortex_record.record_removal_guards as guard
  where guard.organization_id = context_organization_id
    and guard.application_root_id is not distinct from target_application_root_id
    and guard.storage_contract_id = p_storage_contract_id
    and guard.record_id = p_record_id
  for update;

  select state.* into policy_row
  from vortex_record.record_recovery_policy_states as state
  where state.organization_id = context_organization_id
    and state.application_root_id is not distinct from target_application_root_id
    and state.storage_contract_id = p_storage_contract_id
    and state.record_type_id = p_record_type_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  execute pg_catalog.format(
    'select stored.deleted_at, stored.removal_due_at,
            stored.concurrency_number, stored.lifecycle_state
       from record_data.%I as stored
      where stored.organisation_id = $1
        and stored.application_root_id is not distinct from $2
        and stored.record_id = $3
      for update',
    catalogue_row.physical_table_token
  ) into stored_deleted_at, stored_removal_due_at, stored_revision,
    stored_lifecycle_state
  using context_organization_id, target_application_root_id, p_record_id;

  if not found or stored_lifecycle_state not in ('soft_deleted', 'removal_pending')
    or stored_deleted_at is null or stored_revision <> p_expected_record_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  calculated_removal_due_at := stored_deleted_at
    + pg_catalog.make_interval(days => policy_row.recovery_period_days);
  if stored_removal_due_at is not null
    and stored_removal_due_at <> calculated_removal_due_at then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  select provenance.* into existing_provenance
  from vortex_record.record_recovery_provenance as provenance
  where provenance.organization_id = context_organization_id
    and provenance.application_root_id is not distinct from target_application_root_id
    and provenance.storage_contract_id = p_storage_contract_id
    and provenance.record_id = p_record_id
  for update;
  if found
    and existing_provenance.record_type_id = p_record_type_id
    and existing_provenance.deletion_record_revision = p_expected_record_revision
    and existing_provenance.deleted_at = stored_deleted_at
    and existing_provenance.removal_due_at = calculated_removal_due_at
    and existing_provenance.policy_id = policy_row.policy_id
    and existing_provenance.policy_revision = policy_row.policy_revision
    and existing_provenance.recovery_period_days = policy_row.recovery_period_days then
    return pg_catalog.jsonb_build_object(
      'outcome', 'recorded',
      'recordId', p_record_id,
      'recordRevision', p_expected_record_revision,
      'policyRevision', policy_row.policy_revision,
      'replayed', true
    );
  end if;
  if existing_provenance.record_id is not null
    and existing_provenance.deletion_record_revision >= p_expected_record_revision then
    raise exception using errcode = '40001',
      message = 'Record recovery provenance is stale';
  end if;

  if stored_removal_due_at is null then
    execute pg_catalog.format(
      'update record_data.%I as stored
          set removal_due_at = $4
        where stored.organisation_id = $1
          and stored.application_root_id is not distinct from $2
          and stored.record_id = $3
          and stored.deleted_at = $5
          and stored.concurrency_number = $6',
      catalogue_row.physical_table_token
    ) using context_organization_id, target_application_root_id, p_record_id,
      calculated_removal_due_at, stored_deleted_at, p_expected_record_revision;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001',
        message = 'Record recovery provenance revision changed';
    end if;
  end if;

  insert into vortex_record.record_recovery_provenance (
    organization_id, application_root_id, storage_scope, storage_contract_id,
    record_type_id, record_id, deletion_record_revision, deleted_at,
    removal_due_at, policy_id, policy_revision, recovery_period_days, recorded_at
  ) values (
    context_organization_id, target_application_root_id, catalogue_row.storage_scope,
    p_storage_contract_id, p_record_type_id, p_record_id,
    p_expected_record_revision, stored_deleted_at, calculated_removal_due_at,
    policy_row.policy_id, policy_row.policy_revision, policy_row.recovery_period_days,
    pg_catalog.statement_timestamp()
  )
  on conflict (
    organization_id, application_scope_key, storage_contract_id, record_id
  ) do update set
    record_type_id = excluded.record_type_id,
    deletion_record_revision = excluded.deletion_record_revision,
    deleted_at = excluded.deleted_at,
    removal_due_at = excluded.removal_due_at,
    policy_id = excluded.policy_id,
    policy_revision = excluded.policy_revision,
    recovery_period_days = excluded.recovery_period_days,
    recorded_at = excluded.recorded_at
  where vortex_record.record_recovery_provenance.deleted_at = excluded.deleted_at
    or vortex_record.record_recovery_provenance.deletion_record_revision
      < excluded.deletion_record_revision;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record recovery provenance is stale';
  end if;

  update vortex_record.record_removal_guards as guard
  set protection_revision = protection_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
  where guard.organization_id = context_organization_id
    and guard.application_root_id is not distinct from target_application_root_id
    and guard.storage_contract_id = p_storage_contract_id
    and guard.record_id = p_record_id
    and guard.protection_revision < 9007199254740991;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '22003',
      message = 'Record removal protection revision is exhausted';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recorded',
    'recordId', p_record_id,
    'recordRevision', p_expected_record_revision,
    'policyRevision', policy_row.policy_revision,
    'replayed', false
  );
end
$function$;

-- Exact #50 consumer seam.  This is intentionally content-free and read-only.
create function vortex_record.resolve_record_recovery_eligibility(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_scope text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_deleted_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  provenance_row vortex_record.record_recovery_provenance%rowtype;
  policy_row vortex_record.record_recovery_policy_states%rowtype;
  effective_due_at timestamptz;
begin
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_storage_scope not in ('organization_shared', 'application_contained')
    or (p_storage_scope = 'organization_shared' and p_application_root_id is not null)
    or (p_storage_scope = 'application_contained'
      and (p_application_root_id is null or p_application_root_id = nil_uuid))
    or p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_deleted_at is null
    or p_organization_id <> vortex_context.organization_id()
    or p_application_root_id is distinct from
      case when p_storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  select provenance.* into provenance_row
  from vortex_record.record_recovery_provenance as provenance
  where provenance.organization_id = p_organization_id
    and provenance.application_root_id is not distinct from p_application_root_id
    and provenance.storage_scope = p_storage_scope
    and provenance.storage_contract_id = p_storage_contract_id
    and provenance.record_type_id = p_record_type_id
    and provenance.record_id = p_record_id
    and provenance.deleted_at = p_deleted_at;
  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  select state.* into policy_row
  from vortex_record.record_recovery_policy_states as state
  where state.organization_id = p_organization_id
    and state.application_root_id is not distinct from p_application_root_id
    and state.storage_scope = p_storage_scope
    and state.storage_contract_id = p_storage_contract_id
    and state.record_type_id = p_record_type_id
  for share;
  if not found or policy_row.policy_id <> provenance_row.policy_id
    or policy_row.policy_revision < provenance_row.policy_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  effective_due_at := least(
    provenance_row.removal_due_at,
    provenance_row.deleted_at
      + pg_catalog.make_interval(days => policy_row.recovery_period_days)
  );
  if pg_catalog.statement_timestamp() >= effective_due_at then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_expired'
    );
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'eligible');
end
$function$;

-- Owner-only hold composition point for a later protected Access wrapper.
create function vortex_record.change_record_legal_hold_internal(
  p_operation text,
  p_legal_hold_id uuid,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_hold_revision bigint,
  p_reason text,
  p_review_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_account_id uuid;
  target_application_root_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  hold_row vortex_record.record_legal_holds%rowtype;
  record_exists boolean;
  next_revision bigint;
  changed_rows integer;
begin
  if p_operation not in ('apply', 'release')
    or p_legal_hold_id is null or p_legal_hold_id = nil_uuid
    or p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason)) not between 1 and 1000
    or (p_operation = 'apply' and (p_expected_hold_revision is not null
      or p_review_at is null or p_review_at <= pg_catalog.statement_timestamp()))
    or (p_operation = 'release' and (p_expected_hold_revision is null
      or p_expected_hold_revision not between 1 and 9007199254740991)) then
    raise exception using errcode = '22023', message = 'Legal hold change is invalid';
  end if;

  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' <> 'human'
    or not (context_value ? 'organizationAccountId') then
    raise exception using errcode = '42501',
      message = 'Legal hold change requires protected human context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case when context_value ? 'applicationRootId'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.record_type_id <> p_record_type_id then
    raise exception using errcode = '55000', message = 'Legal hold scope is unavailable';
  end if;
  target_application_root_id := case
    when catalogue_row.storage_scope = 'application_contained'
      then context_application_root_id else null end;
  if catalogue_row.storage_scope = 'application_contained'
    and target_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Legal hold requires application context';
  end if;

  -- Every recovery/hold/removal participant takes the exact guard first, then
  -- the generated Record row. This common order prevents guard/row inversion.
  insert into vortex_record.record_removal_guards (
    organization_id, application_root_id, storage_scope, storage_contract_id,
    record_type_id, record_id
  ) values (
    context_organization_id, target_application_root_id, catalogue_row.storage_scope,
    p_storage_contract_id, p_record_type_id, p_record_id
  ) on conflict do nothing;
  perform guard.protection_revision
  from vortex_record.record_removal_guards as guard
  where guard.organization_id = context_organization_id
    and guard.application_root_id is not distinct from target_application_root_id
    and guard.storage_contract_id = p_storage_contract_id
    and guard.record_id = p_record_id
  for update;

  execute pg_catalog.format(
    'select true from record_data.%I as stored
      where stored.organisation_id = $1
        and stored.application_root_id is not distinct from $2
        and stored.record_id = $3 for share',
    catalogue_row.physical_table_token
  ) into record_exists using context_organization_id, target_application_root_id,
    p_record_id;
  if not coalesce(record_exists, false) then
    raise exception using errcode = '55000', message = 'Legal hold scope is unavailable';
  end if;

  if p_operation = 'apply' then
    insert into vortex_record.record_legal_holds (
      organization_id, legal_hold_id, application_root_id, storage_scope,
      storage_contract_id, record_type_id, record_id, hold_revision, reason,
      created_by_organization_account_id, started_at, review_at
    ) values (
      context_organization_id, p_legal_hold_id, target_application_root_id,
      catalogue_row.storage_scope, p_storage_contract_id, p_record_type_id,
      p_record_id, 1, pg_catalog.btrim(p_reason), context_account_id,
      pg_catalog.statement_timestamp(), p_review_at
    );
    next_revision := 1;
  else
    select hold.* into hold_row
    from vortex_record.record_legal_holds as hold
    where hold.organization_id = context_organization_id
      and hold.legal_hold_id = p_legal_hold_id
      and hold.application_root_id is not distinct from target_application_root_id
      and hold.storage_contract_id = p_storage_contract_id
      and hold.record_type_id = p_record_type_id
      and hold.record_id = p_record_id
    for update;
    if not found or hold_row.released_at is not null
      or hold_row.hold_revision <> p_expected_hold_revision then
      raise exception using errcode = '40001', message = 'Legal hold revision changed';
    end if;
    if hold_row.hold_revision = 9007199254740991 then
      raise exception using errcode = '22003', message = 'Legal hold revision is exhausted';
    end if;
    next_revision := hold_row.hold_revision + 1;
    update vortex_record.record_legal_holds as hold
    set hold_revision = next_revision,
        released_at = pg_catalog.statement_timestamp(),
        released_by_organization_account_id = context_account_id,
        release_reason = pg_catalog.btrim(p_reason)
    where hold.organization_id = context_organization_id
      and hold.legal_hold_id = p_legal_hold_id;
  end if;

  update vortex_record.record_removal_guards as guard
  set protection_revision = protection_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
  where guard.organization_id = context_organization_id
    and guard.application_root_id is not distinct from target_application_root_id
    and guard.storage_contract_id = p_storage_contract_id
    and guard.record_id = p_record_id
    and guard.protection_revision < 9007199254740991;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '22003',
      message = 'Record removal protection revision is exhausted';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', case when p_operation = 'apply' then 'held' else 'released' end,
    'legalHoldId', p_legal_hold_id,
    'holdRevision', next_revision
  );
end
$function$;

-- Content-free enrichment facts for the lifecycle selection reader.  Unknown
-- deleted-row provenance is protected, never silently eligible for removal.
create function vortex_record.read_lifecycle_removal_protection_facts(
  p_storage_contract_id uuid
)
returns table (
  record_id uuid,
  record_revision bigint,
  lifecycle_state text,
  deleted_at timestamptz,
  removal_due_at timestamptz,
  is_held boolean,
  is_recovery_protected boolean,
  protection_revision bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  target_application_root_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  read_sql text;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record removal protection storage contract is invalid';
  end if;
  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or context_value ->> 'authenticationStrength' is distinct from 'service'
    or not (context_value ? 'systemActorId') then
    raise exception using errcode = '42501',
      message = 'Record removal protection facts require system context';
  end if;
  context_organization_id := vortex_context.organization_id();
  context_application_root_id := vortex_context.application_root_id(false);
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.physical_schema_token <> 'record_data' then
    raise exception using errcode = '55000',
      message = 'Record removal protection scope is unavailable';
  end if;
  target_application_root_id := case
    when catalogue_row.storage_scope = 'application_contained'
      then context_application_root_id else null end;
  if catalogue_row.storage_scope = 'application_contained'
    and target_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record removal protection requires application context';
  end if;

  read_sql := pg_catalog.format($sql$
    select stored.record_id,
      stored.concurrency_number as record_revision,
      stored.lifecycle_state,
      stored.deleted_at,
      stored.removal_due_at,
      exists (
        select 1 from vortex_record.record_legal_holds as hold
        where hold.organization_id = $1
          and hold.application_root_id is not distinct from $2
          and hold.storage_contract_id = $3
          and hold.record_id = stored.record_id
          and hold.released_at is null
      ) as is_held,
      case
        when stored.lifecycle_state = 'active' then false
        when provenance.record_id is null or policy.policy_id is null then true
        when provenance.deleted_at is distinct from stored.deleted_at
          or provenance.removal_due_at is distinct from stored.removal_due_at
          or policy.policy_id <> provenance.policy_id
          or policy.policy_revision < provenance.policy_revision then true
        else pg_catalog.statement_timestamp() < least(
          provenance.removal_due_at,
          provenance.deleted_at
            + pg_catalog.make_interval(days => policy.recovery_period_days)
        )
      end as is_recovery_protected,
      coalesce(guard.protection_revision, 0) as protection_revision
    from record_data.%I as stored
    left join vortex_record.record_recovery_provenance as provenance
      on provenance.organization_id = $1
      and provenance.application_root_id is not distinct from $2
      and provenance.storage_contract_id = $3
      and provenance.record_type_id = $4
      and provenance.record_id = stored.record_id
    left join vortex_record.record_recovery_policy_states as policy
      on policy.organization_id = $1
      and policy.application_root_id is not distinct from $2
      and policy.storage_contract_id = $3
      and policy.record_type_id = $4
    left join vortex_record.record_removal_guards as guard
      on guard.organization_id = $1
      and guard.application_root_id is not distinct from $2
      and guard.storage_contract_id = $3
      and guard.record_id = stored.record_id
    where stored.organisation_id = $1
      and stored.application_root_id is not distinct from $2
      and stored.lifecycle_state in ('active', 'soft_deleted', 'removal_pending')
    order by stored.record_id
  $sql$, catalogue_row.physical_table_token);
  return query execute read_sql using context_organization_id,
    target_application_root_id, p_storage_contract_id, catalogue_row.record_type_id;
end
$function$;

-- Final #117 composition seam.  Its guard lock is held by the caller's transaction,
-- so a concurrent hold apply/release serializes before the irreversible delete.
create function vortex_record.resolve_permanent_record_removal_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_scope text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_record_revision bigint,
  p_deleted_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  catalogue_row vortex_record.storage_catalogue%rowtype;
  provenance_row vortex_record.record_recovery_provenance%rowtype;
  policy_row vortex_record.record_recovery_policy_states%rowtype;
  guard_revision bigint;
  stored_revision bigint;
  stored_state text;
  stored_deleted_at timestamptz;
  stored_removal_due_at timestamptz;
  effective_due_at timestamptz;
begin
  if p_organization_id is null or p_storage_scope not in (
      'organization_shared', 'application_contained'
    )
    or (p_storage_scope = 'organization_shared' and p_application_root_id is not null)
    or (p_storage_scope = 'application_contained' and p_application_root_id is null)
    or p_storage_contract_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_record_revision is null or p_deleted_at is null
    or p_organization_id <> vortex_context.organization_id()
    or p_application_root_id is distinct from
      case when p_storage_scope = 'application_contained'
        then vortex_context.application_root_id(true) else null end then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'removal_unavailable'
    );
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.storage_scope = p_storage_scope
    and catalogue.state = 'active';
  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'removal_unavailable'
    );
  end if;

  select guard.protection_revision into guard_revision
  from vortex_record.record_removal_guards as guard
  where guard.organization_id = p_organization_id
    and guard.application_root_id is not distinct from p_application_root_id
    and guard.storage_contract_id = p_storage_contract_id
    and guard.record_id = p_record_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;

  execute pg_catalog.format(
    'select stored.concurrency_number, stored.lifecycle_state,
            stored.deleted_at, stored.removal_due_at
       from record_data.%I as stored
      where stored.organisation_id = $1
        and stored.application_root_id is not distinct from $2
        and stored.record_id = $3
      for update',
    catalogue_row.physical_table_token
  ) into stored_revision, stored_state, stored_deleted_at, stored_removal_due_at
  using p_organization_id, p_application_root_id, p_record_id;
  if not found or stored_revision <> p_expected_record_revision
    or stored_state <> 'removal_pending'
    or stored_deleted_at is distinct from p_deleted_at then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if exists (
    select 1 from vortex_record.record_legal_holds as hold
    where hold.organization_id = p_organization_id
      and hold.application_root_id is not distinct from p_application_root_id
      and hold.storage_contract_id = p_storage_contract_id
      and hold.record_type_id = p_record_type_id
      and hold.record_id = p_record_id
      and hold.released_at is null
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'legal_hold'
    );
  end if;

  select provenance.* into provenance_row
  from vortex_record.record_recovery_provenance as provenance
  where provenance.organization_id = p_organization_id
    and provenance.application_root_id is not distinct from p_application_root_id
    and provenance.storage_contract_id = p_storage_contract_id
    and provenance.record_type_id = p_record_type_id
    and provenance.record_id = p_record_id
    and provenance.deleted_at = p_deleted_at;
  select state.* into policy_row
  from vortex_record.record_recovery_policy_states as state
  where state.organization_id = p_organization_id
    and state.application_root_id is not distinct from p_application_root_id
    and state.storage_contract_id = p_storage_contract_id
    and state.record_type_id = p_record_type_id
  for share;
  if provenance_row.record_id is null or policy_row.policy_id is null
    or provenance_row.removal_due_at is distinct from stored_removal_due_at
    or policy_row.policy_id <> provenance_row.policy_id
    or policy_row.policy_revision < provenance_row.policy_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_unavailable'
    );
  end if;
  effective_due_at := least(
    provenance_row.removal_due_at,
    provenance_row.deleted_at
      + pg_catalog.make_interval(days => policy_row.recovery_period_days)
  );
  if pg_catalog.statement_timestamp() < effective_due_at then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_active'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'eligible', 'protectionRevision', guard_revision
  );
end
$function$;

revoke all on function
  vortex_record.record_current_recovery_policy_internal(uuid, uuid, uuid, bigint, integer),
  vortex_record.record_recovery_provenance_internal(uuid, uuid, uuid, bigint),
  vortex_record.change_record_legal_hold_internal(text, uuid, uuid, uuid, uuid, bigint, text, timestamptz),
  vortex_record.resolve_permanent_record_removal_internal(uuid, uuid, text, uuid, uuid, uuid, bigint, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

revoke all on function
  vortex_record.resolve_record_recovery_eligibility(uuid, uuid, text, uuid, uuid, uuid, timestamptz),
  vortex_record.read_lifecycle_removal_protection_facts(uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.resolve_record_recovery_eligibility(uuid, uuid, text, uuid, uuid, uuid, timestamptz),
  vortex_record.read_lifecycle_removal_protection_facts(uuid)
  to vortex_request;

comment on function vortex_record.resolve_record_recovery_eligibility(
  uuid, uuid, text, uuid, uuid, uuid, timestamptz
) is
  '#408/#50 content-free current-policy recovery resolver. Missing/stale evidence refuses; a newer tighter policy can shorten but never extend the recorded deletion window.';
comment on function vortex_record.resolve_permanent_record_removal_internal(
  uuid, uuid, text, uuid, uuid, uuid, bigint, timestamptz
) is
  '#408/#117 owner-only final removal guard. Locks the exact protection revision and rechecks current recovery and legal-hold state in the caller transaction.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
