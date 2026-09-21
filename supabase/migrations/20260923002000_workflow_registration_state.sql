-- #408 dependency slice: source-owned workflow registration readiness foundation.
--
-- This pre-target migration models immutable workflow roots, exact registered,
-- prepared, and verified revisions with fingerprints, organization and permanent
-- application authorization, lifecycle state transitions, and an owner-projected
-- read/check surface that the later `20260923010000_record_type_lifecycle_policies.sql`
-- migration can consume.
--
-- Invariants:
--   * Workflow roots are permanent and immutable once created;
--   * Workflow revisions progress through defined lifecycle states:
--       registered -> prepared -> verified -> active;
--   * An active revision can be transitioned to inactive (deactivated) or
--     superseded (when replaced by a newer active revision);
--   * Exactly one active revision per workflow root at any time;
--   * Prepared and verified fingerprints must match when a revision is verified or active;
--   * Permanent application authorization is explicitly tracked per workflow root;
--   * Readiness check surface rejects pending, inactive, superseded states,
--     wrong organization, unauthorized application, stale revision, stale fingerprint,
--     destination mismatch, caller booleans, and arbitrary UUID evidence;
--   * Follows existing workflow/publication conventions: no invented generic readiness table,
--     no credential/destination secret storage, no archive execution.

create schema if not exists vortex_workflow authorization postgres;

revoke all on schema vortex_workflow
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

alter default privileges for role postgres in schema vortex_workflow
  revoke all on tables
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_workflow
  revoke all on sequences
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
alter default privileges for role postgres in schema vortex_workflow
  revoke execute on functions
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant usage on schema vortex_workflow to vortex_request, vortex_runtime;

-- ============================================================================
-- Table 1: vortex_workflow.workflow_roots
-- Immutable workflow roots owned by an organization.
-- ============================================================================
create table vortex_workflow.workflow_roots (
  workflow_id uuid not null,
  organization_id uuid not null,
  workflow_key text not null,
  workflow_name text not null default '',
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  created_by uuid not null,
  constraint workflow_roots_pk primary key (workflow_id),
  constraint workflow_roots_workflow_id_non_nil check (
    workflow_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint workflow_roots_organization_id_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint workflow_roots_created_by_non_nil check (
    created_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint workflow_roots_created_at_finite check (
    created_at <> '-infinity'::timestamptz and created_at <> 'infinity'::timestamptz
  ),
  constraint workflow_roots_workflow_key_format check (
    pg_catalog.char_length(workflow_key) between 3 and 120
    and workflow_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    and workflow_key !~ '(^|\.)[^.]{41,}(\.|$)'
  ),
  constraint workflow_roots_org_key_unique unique (organization_id, workflow_key),
  constraint workflow_roots_organization_fk foreign key (organization_id)
    references vortex_identity.organizations (organization_id)
);

alter table vortex_workflow.workflow_roots enable row level security;
alter table vortex_workflow.workflow_roots force row level security;

-- Immutability enforcement for workflow root identity and core metadata.
create function vortex_workflow.protect_workflow_root_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.workflow_id is distinct from old.workflow_id
    or new.organization_id is distinct from old.organization_id
    or new.workflow_key is distinct from old.workflow_key
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by then
    raise exception using
      errcode = '23514',
      message = 'Workflow root identity, organization, key and creation evidence are permanent';
  end if;

  return new;
end
$function$;

create trigger workflow_roots_immutability
  before update on vortex_workflow.workflow_roots
  for each row execute function vortex_workflow.protect_workflow_root_identity();

-- ============================================================================
-- Table 2: vortex_workflow.workflow_revisions
-- Exact registered, prepared, and verified revisions and fingerprints.
-- ============================================================================
create table vortex_workflow.workflow_revisions (
  workflow_id uuid not null,
  revision bigint not null,
  state text not null,
  definition_fingerprint text not null,
  prepared_flow_fingerprint text,
  verified_flow_fingerprint text,
  supported_destinations text[] not null default '{}'::text[],
  registered_at timestamptz not null default pg_catalog.statement_timestamp(),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  changed_by uuid not null,
  change_correlation_id uuid not null,
  constraint workflow_revisions_pk primary key (workflow_id, revision),
  constraint workflow_revisions_workflow_fk foreign key (workflow_id)
    references vortex_workflow.workflow_roots (workflow_id),
  constraint workflow_revisions_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint workflow_revisions_state_valid check (
    state in ('registered', 'prepared', 'verified', 'active', 'inactive', 'superseded')
  ),
  constraint workflow_revisions_definition_fingerprint_format check (
    definition_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint workflow_revisions_prepared_fingerprint_format check (
    prepared_flow_fingerprint is null
    or prepared_flow_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint workflow_revisions_verified_fingerprint_format check (
    verified_flow_fingerprint is null
    or verified_flow_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint workflow_revisions_state_fingerprint_coherence check (
    (state = 'registered')
    or (state = 'prepared' and prepared_flow_fingerprint is not null)
    or (state = 'verified' and prepared_flow_fingerprint is not null and verified_flow_fingerprint is not null and prepared_flow_fingerprint = verified_flow_fingerprint)
    or (state = 'active' and prepared_flow_fingerprint is not null and verified_flow_fingerprint is not null and prepared_flow_fingerprint = verified_flow_fingerprint)
    or (state in ('inactive', 'superseded'))
  ),
  constraint workflow_revisions_registered_at_finite check (
    registered_at <> '-infinity'::timestamptz and registered_at <> 'infinity'::timestamptz
  ),
  constraint workflow_revisions_changed_at_finite check (
    changed_at <> '-infinity'::timestamptz and changed_at <> 'infinity'::timestamptz
  ),
  constraint workflow_revisions_changed_by_non_nil check (
    changed_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint workflow_revisions_correlation_non_nil check (
    change_correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid
  )
);

alter table vortex_workflow.workflow_revisions enable row level security;
alter table vortex_workflow.workflow_revisions force row level security;

-- Ensure at most one active revision exists per workflow root.
create unique index workflow_revisions_single_active_idx
  on vortex_workflow.workflow_revisions (workflow_id)
  where (state = 'active');

-- Protect revision immutability and enforce valid lifecycle state transitions.
create function vortex_workflow.protect_workflow_revision_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.workflow_id is distinct from old.workflow_id
    or new.revision is distinct from old.revision
    or new.definition_fingerprint is distinct from old.definition_fingerprint
    or new.registered_at is distinct from old.registered_at then
    raise exception using
      errcode = '23514',
      message = 'Workflow revision identity, definition fingerprint and registration time are immutable';
  end if;

  -- Superseded revisions are terminal and cannot be modified or reactivated.
  if old.state = 'superseded' and new.state <> 'superseded' then
    raise exception using errcode = '23514',
      message = 'Superseded workflow revision is permanent and cannot be reactivated';
  end if;

  -- Lifecycle progression guards:
  if old.state = 'registered' and new.state not in ('registered', 'prepared', 'inactive') then
    raise exception using errcode = '23514',
      message = 'Registered workflow revision must be prepared before verification or activation';
  end if;

  if old.state = 'prepared' and new.state not in ('prepared', 'verified', 'inactive') then
    raise exception using errcode = '23514',
      message = 'Prepared workflow revision must be verified before activation';
  end if;

  if old.state = 'verified' and new.state not in ('verified', 'active', 'inactive') then
    raise exception using errcode = '23514',
      message = 'Verified workflow revision can only transition to active or inactive';
  end if;

  return new;
end
$function$;

create trigger workflow_revisions_state_transition
  before update on vortex_workflow.workflow_revisions
  for each row execute function vortex_workflow.protect_workflow_revision_identity();

-- ============================================================================
-- Table 3: vortex_workflow.workflow_application_authorizations
-- Explicit permanent application authorizations for workflow roots.
-- ============================================================================
create table vortex_workflow.workflow_application_authorizations (
  workflow_id uuid not null,
  application_root_id uuid not null,
  authorized_at timestamptz not null default pg_catalog.statement_timestamp(),
  authorized_by uuid not null,
  constraint workflow_app_auth_pk primary key (workflow_id, application_root_id),
  constraint workflow_app_auth_workflow_fk foreign key (workflow_id)
    references vortex_workflow.workflow_roots (workflow_id),
  constraint workflow_app_auth_application_fk foreign key (application_root_id)
    references vortex_definition.roots (root_id),
  constraint workflow_app_auth_app_non_nil check (
    application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint workflow_app_auth_by_non_nil check (
    authorized_by <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint workflow_app_auth_at_finite check (
    authorized_at <> '-infinity'::timestamptz and authorized_at <> 'infinity'::timestamptz
  )
);

alter table vortex_workflow.workflow_application_authorizations enable row level security;
alter table vortex_workflow.workflow_application_authorizations force row level security;

-- ============================================================================
-- Owner-level internal functions for lifecycle state management.
-- ============================================================================

-- Register a new immutable workflow root for an organization.
create function vortex_workflow.register_workflow_root_internal(
  p_workflow_id uuid,
  p_organization_id uuid,
  p_workflow_key text,
  p_created_by uuid,
  p_workflow_name text default ''
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  insert into vortex_workflow.workflow_roots (
    workflow_id, organization_id, workflow_key, workflow_name, created_by
  ) values (
    p_workflow_id, p_organization_id, p_workflow_key, coalesce(p_workflow_name, ''), p_created_by
  );
end
$function$;

-- Authorize a permanent application root to use a workflow root.
-- Enforces that the application root belongs to the same organization.
create function vortex_workflow.authorize_workflow_application_internal(
  p_workflow_id uuid,
  p_application_root_id uuid,
  p_authorized_by uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  workflow_org_id uuid;
  app_org_id uuid;
begin
  select root.organization_id into workflow_org_id
  from vortex_workflow.workflow_roots as root
  where root.workflow_id = p_workflow_id;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Workflow root not found for application authorization';
  end if;

  select def.organization_id into app_org_id
  from vortex_definition.roots as def
  where def.root_id = p_application_root_id
    and def.kind = 'application';

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Application root not found for workflow authorization';
  end if;

  if workflow_org_id <> app_org_id then
    raise exception using errcode = '23514',
      message = 'Workflow root and application root must belong to the same organization';
  end if;

  insert into vortex_workflow.workflow_application_authorizations (
    workflow_id, application_root_id, authorized_by
  ) values (
    p_workflow_id, p_application_root_id, p_authorized_by
  )
  on conflict (workflow_id, application_root_id) do nothing;
end
$function$;

-- Register a new workflow revision in 'registered' state.
create function vortex_workflow.register_workflow_revision_internal(
  p_workflow_id uuid,
  p_revision bigint,
  p_definition_fingerprint text,
  p_supported_destinations text[],
  p_changed_by uuid,
  p_change_correlation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  insert into vortex_workflow.workflow_revisions (
    workflow_id, revision, state, definition_fingerprint,
    supported_destinations, changed_by, change_correlation_id
  ) values (
    p_workflow_id, p_revision, 'registered', p_definition_fingerprint,
    coalesce(p_supported_destinations, '{}'::text[]), p_changed_by, p_change_correlation_id
  );
end
$function$;

-- Record external flow preparation and update state to 'prepared'.
create function vortex_workflow.prepare_workflow_revision_internal(
  p_workflow_id uuid,
  p_revision bigint,
  p_prepared_flow_fingerprint text,
  p_changed_by uuid,
  p_change_correlation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  update vortex_workflow.workflow_revisions
  set state = 'prepared',
      prepared_flow_fingerprint = p_prepared_flow_fingerprint,
      changed_at = pg_catalog.statement_timestamp(),
      changed_by = p_changed_by,
      change_correlation_id = p_change_correlation_id
  where workflow_id = p_workflow_id
    and revision = p_revision
    and state = 'registered';

  if not found then
    raise exception using errcode = '55000',
      message = 'Workflow revision cannot be prepared: revision not found or not in registered state';
  end if;
end
$function$;

-- Verify deployed external flow fingerprint against prepared flow and advance to 'verified'.
create function vortex_workflow.verify_workflow_revision_internal(
  p_workflow_id uuid,
  p_revision bigint,
  p_verified_flow_fingerprint text,
  p_changed_by uuid,
  p_change_correlation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  prepared_fp text;
begin
  select rev.prepared_flow_fingerprint into prepared_fp
  from vortex_workflow.workflow_revisions as rev
  where rev.workflow_id = p_workflow_id
    and rev.revision = p_revision
    and rev.state = 'prepared';

  if not found then
    raise exception using errcode = '55000',
      message = 'Workflow revision cannot be verified: revision not found or not in prepared state';
  end if;

  if prepared_fp is distinct from p_verified_flow_fingerprint then
    raise exception using errcode = '23514',
      message = 'Verified flow fingerprint must match prepared flow fingerprint';
  end if;

  update vortex_workflow.workflow_revisions
  set state = 'verified',
      verified_flow_fingerprint = p_verified_flow_fingerprint,
      changed_at = pg_catalog.statement_timestamp(),
      changed_by = p_changed_by,
      change_correlation_id = p_change_correlation_id
  where workflow_id = p_workflow_id
    and revision = p_revision;
end
$function$;

-- Activate a verified workflow revision.
-- Supersedes any currently active revision for the workflow root.
create function vortex_workflow.activate_workflow_revision_internal(
  p_workflow_id uuid,
  p_revision bigint,
  p_changed_by uuid,
  p_change_correlation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- 1. Supersede any existing active revision for this workflow root.
  update vortex_workflow.workflow_revisions
  set state = 'superseded',
      changed_at = pg_catalog.statement_timestamp(),
      changed_by = p_changed_by,
      change_correlation_id = p_change_correlation_id
  where workflow_id = p_workflow_id
    and state = 'active'
    and revision <> p_revision;

  -- 2. Activate the verified revision.
  update vortex_workflow.workflow_revisions
  set state = 'active',
      changed_at = pg_catalog.statement_timestamp(),
      changed_by = p_changed_by,
      change_correlation_id = p_change_correlation_id
  where workflow_id = p_workflow_id
    and revision = p_revision
    and state in ('verified', 'inactive');

  if not found then
    raise exception using errcode = '55000',
      message = 'Workflow revision cannot be activated: revision not found or not in verified/inactive state';
  end if;
end
$function$;

-- Deactivate an active workflow revision to 'inactive'.
create function vortex_workflow.deactivate_workflow_revision_internal(
  p_workflow_id uuid,
  p_revision bigint,
  p_changed_by uuid,
  p_change_correlation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  update vortex_workflow.workflow_revisions
  set state = 'inactive',
      changed_at = pg_catalog.statement_timestamp(),
      changed_by = p_changed_by,
      change_correlation_id = p_change_correlation_id
  where workflow_id = p_workflow_id
    and revision = p_revision
    and state = 'active';

  if not found then
    raise exception using errcode = '55000',
      message = 'Workflow revision cannot be deactivated: revision not found or not active';
  end if;
end
$function$;

-- Convenience owner function: directly record workflow registration state
-- (used for installation activation, migration, and test fixtures).
create function vortex_workflow.record_workflow_registration_internal(
  p_workflow_id uuid,
  p_organization_id uuid,
  p_workflow_key text,
  p_revision bigint,
  p_definition_fingerprint text,
  p_flow_fingerprint text,
  p_authorized_application_ids uuid[],
  p_supported_destinations text[],
  p_state text,
  p_changed_by uuid,
  p_change_correlation_id uuid,
  p_workflow_name text default ''
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_app_id uuid;
begin
  -- 1. Upsert workflow root (root is immutable once created)
  insert into vortex_workflow.workflow_roots (
    workflow_id, organization_id, workflow_key, workflow_name, created_by
  ) values (
    p_workflow_id, p_organization_id, p_workflow_key, coalesce(p_workflow_name, ''), p_changed_by
  )
  on conflict (workflow_id) do nothing;

  -- 2. Authorize applications
  if p_authorized_application_ids is not null then
    foreach target_app_id in array p_authorized_application_ids loop
      if target_app_id <> '00000000-0000-0000-0000-000000000000'::uuid then
        perform vortex_workflow.authorize_workflow_application_internal(
          p_workflow_id, target_app_id, p_changed_by
        );
      end if;
    end loop;
  end if;

  -- 3. If transitioning to active, supersede any existing active revision
  if p_state = 'active' then
    update vortex_workflow.workflow_revisions
    set state = 'superseded',
        changed_at = pg_catalog.statement_timestamp(),
        changed_by = p_changed_by,
        change_correlation_id = p_change_correlation_id
    where workflow_id = p_workflow_id
      and state = 'active'
      and revision <> p_revision;
  end if;

  -- 4. Upsert revision
  insert into vortex_workflow.workflow_revisions (
    workflow_id, revision, state, definition_fingerprint,
    prepared_flow_fingerprint, verified_flow_fingerprint,
    supported_destinations, changed_by, change_correlation_id
  ) values (
    p_workflow_id, p_revision, p_state, p_definition_fingerprint,
    case when p_state in ('prepared', 'verified', 'active') then p_flow_fingerprint else null end,
    case when p_state in ('verified', 'active') then p_flow_fingerprint else null end,
    coalesce(p_supported_destinations, '{}'::text[]),
    p_changed_by, p_change_correlation_id
  )
  on conflict (workflow_id, revision) do update
  set state = excluded.state,
      prepared_flow_fingerprint = excluded.prepared_flow_fingerprint,
      verified_flow_fingerprint = excluded.verified_flow_fingerprint,
      supported_destinations = excluded.supported_destinations,
      changed_at = pg_catalog.statement_timestamp(),
      changed_by = excluded.changed_by,
      change_correlation_id = excluded.change_correlation_id;
end
$function$;

-- ============================================================================
-- Owner-projected read/check surface.
-- Consumable by `vortex_request` and the later `20260923010000` policy migration.
-- ============================================================================

-- Authoritative readiness check for an archive workflow dependency.
--
-- Rejects:
--   * Pending states ('registered', 'prepared', 'verified')
--   * Inactive states ('inactive')
--   * Superseded states ('superseded')
--   * Non-active states
--   * Wrong organization (mismatch with root or request context)
--   * Unauthorized application (scope mismatch or missing authorization)
--   * Stale revision (expected revision not found or not active)
--   * Stale fingerprint (expected fingerprint mismatch)
--   * Destination mismatch (workflow does not support requested archive destination)
--   * Caller booleans (never accepted; all state derived from authoritative tables)
--   * Arbitrary UUID evidence (must exist in authoritative storage)
create function vortex_workflow.check_workflow_registration_readiness(
  p_workflow_id uuid,
  p_expected_revision bigint,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_archive_destination text default null,
  p_expected_fingerprint text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_org_id uuid;
  root_row vortex_workflow.workflow_roots%rowtype;
  revision_row vortex_workflow.workflow_revisions%rowtype;
  is_app_authorized boolean;
begin
  -- 1. Validate inputs and reject arbitrary/nil UUIDs or invalid parameters
  if p_workflow_id is null or p_workflow_id = nil_uuid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_workflow_identity',
      'reasonMessage', 'Workflow identity is missing or nil'
    );
  end if;

  if p_organization_id is null or p_organization_id = nil_uuid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_organization_identity',
      'reasonMessage', 'Organization identity is missing or nil'
    );
  end if;

  if p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_workflow_revision',
      'reasonMessage', 'Expected workflow revision is out of range'
    );
  end if;

  if p_application_root_id is not null and p_application_root_id = nil_uuid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_application_identity',
      'reasonMessage', 'Application identity is nil UUID'
    );
  end if;

  if p_archive_destination is not null and (
    pg_catalog.char_length(p_archive_destination) < 1
    or pg_catalog.char_length(p_archive_destination) > 120
    or p_archive_destination !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_archive_destination',
      'reasonMessage', 'Archive destination format is invalid'
    );
  end if;

  -- 2. Context organization binding: if context is established, verify match
  begin
    context_org_id := vortex_context.organization_id();
  exception when others then
    context_org_id := null;
  end;

  if context_org_id is not null and context_org_id <> p_organization_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'wrong_organization',
      'reasonMessage', 'Caller context organization does not match policy organization'
    );
  end if;

  -- 3. Workflow root lookup and organization isolation
  select root.* into root_row
  from vortex_workflow.workflow_roots as root
  where root.workflow_id = p_workflow_id;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'archive_workflow_not_registered',
      'reasonMessage', 'Workflow is not registered in runtime workflows'
    );
  end if;

  if root_row.organization_id <> p_organization_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'wrong_organization',
      'reasonMessage', 'Workflow belongs to a different organization'
    );
  end if;

  -- 4. Permanent application scope and authorization
  -- Registered archive workflows strictly require permanent application scope.
  if p_application_root_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'archive_workflow_scope_mismatch',
      'reasonMessage', 'Organisation-shared policy cannot activate archive_workflow because registered workflows require permanent application scope'
    );
  end if;

  select exists (
    select 1
    from vortex_workflow.workflow_application_authorizations as auth
    where auth.workflow_id = p_workflow_id
      and auth.application_root_id = p_application_root_id
  ) into is_app_authorized;

  if not is_app_authorized then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'archive_workflow_scope_mismatch',
      'reasonMessage', 'Registered workflow is not authorized for permanent application root'
    );
  end if;

  -- 5. Exact revision and lifecycle state verification
  select rev.* into revision_row
  from vortex_workflow.workflow_revisions as rev
  where rev.workflow_id = p_workflow_id
    and rev.revision = p_expected_revision;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_revision',
      'reasonMessage', 'Expected workflow revision does not exist'
    );
  end if;

  -- Reject pending states
  if revision_row.state in ('registered', 'prepared', 'verified') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'workflow_state_pending',
      'reasonMessage', 'Workflow revision is pending activation and cannot be consumed'
    );
  end if;

  -- Reject inactive state
  if revision_row.state = 'inactive' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'workflow_state_inactive',
      'reasonMessage', 'Workflow revision is inactive'
    );
  end if;

  -- Reject superseded state
  if revision_row.state = 'superseded' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'workflow_state_superseded',
      'reasonMessage', 'Workflow revision has been superseded by a newer revision'
    );
  end if;

  -- Reject any non-active state
  if revision_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'workflow_not_active',
      'reasonMessage', 'Workflow revision is not in active state'
    );
  end if;

  -- 6. Fingerprint verification
  if revision_row.prepared_flow_fingerprint is null
    or revision_row.verified_flow_fingerprint is null
    or revision_row.prepared_flow_fingerprint <> revision_row.verified_flow_fingerprint then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_fingerprint',
      'reasonMessage', 'Workflow revision flow fingerprint is unverified or incoherent'
    );
  end if;

  if p_expected_fingerprint is not null and (
    p_expected_fingerprint <> revision_row.definition_fingerprint
    and p_expected_fingerprint <> revision_row.verified_flow_fingerprint
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_fingerprint',
      'reasonMessage', 'Expected fingerprint does not match workflow definition or verified flow fingerprint'
    );
  end if;

  -- 7. Destination check
  if p_archive_destination is not null then
    if not (p_archive_destination = any(revision_row.supported_destinations)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused',
        'reasonCode', 'destination_mismatch',
        'reasonMessage', 'Workflow revision does not support the requested archive destination'
      );
    end if;
  end if;

  -- 8. Ready
  return pg_catalog.jsonb_build_object(
    'outcome', 'ready',
    'workflowId', p_workflow_id,
    'workflowRevision', p_expected_revision,
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'state', 'active',
    'definitionFingerprint', revision_row.definition_fingerprint,
    'verifiedFlowFingerprint', revision_row.verified_flow_fingerprint,
    'supportedDestinations', pg_catalog.to_jsonb(revision_row.supported_destinations)
  );
end
$function$;

comment on function vortex_workflow.check_workflow_registration_readiness(
  uuid, bigint, uuid, uuid, text, text
) is
  '#408 Slice: checks authoritative workflow registration readiness for archive_workflow lifecycle policy dependency. Rejects pending/inactive/superseded states, wrong organization/application, stale revision/fingerprint, destination mismatch, caller booleans, and arbitrary UUID evidence.';

-- Read registered active workflow evidence items for an organization,
-- projecting the contract shape consumed by `lifecycleReadinessEvidenceSchema`.
create function vortex_workflow.read_registered_workflow_evidence(
  p_organization_id uuid,
  p_application_root_id uuid default null
)
returns table (
  workflow_id uuid,
  workflow_revision bigint,
  organization_id uuid,
  authorized_application_ids uuid[],
  state text,
  definition_fingerprint text,
  verified_flow_fingerprint text,
  supported_destinations text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_org_id uuid;
begin
  if p_organization_id is null or p_organization_id = nil_uuid then
    return;
  end if;

  begin
    context_org_id := vortex_context.organization_id();
  exception when others then
    context_org_id := null;
  end;

  if context_org_id is not null and context_org_id <> p_organization_id then
    return;
  end if;

  return query
  select
    root.workflow_id,
    rev.revision as workflow_revision,
    root.organization_id,
    coalesce(
      (
        select pg_catalog.array_agg(auth.application_root_id order by auth.application_root_id)
        from vortex_workflow.workflow_application_authorizations as auth
        where auth.workflow_id = root.workflow_id
      ),
      '{}'::uuid[]
    ) as authorized_application_ids,
    rev.state,
    rev.definition_fingerprint,
    rev.verified_flow_fingerprint,
    rev.supported_destinations
  from vortex_workflow.workflow_roots as root
  join vortex_workflow.workflow_revisions as rev
    on rev.workflow_id = root.workflow_id
   and rev.state = 'active'
  where root.organization_id = p_organization_id
    and (
      p_application_root_id is null
      or exists (
        select 1
        from vortex_workflow.workflow_application_authorizations as auth
        where auth.workflow_id = root.workflow_id
          and auth.application_root_id = p_application_root_id
      )
    )
  order by root.workflow_id, rev.revision;
end
$function$;

comment on function vortex_workflow.read_registered_workflow_evidence(uuid, uuid) is
  '#408 Slice: projects active registered workflow evidence for an organization matching registeredWorkflowEvidenceSchema.';

-- ============================================================================
-- Function execution grants.
-- Read/check functions are granted to vortex_request and vortex_runtime.
-- Internal mutator functions remain owner-only (postgres).
-- ============================================================================
grant execute on function
  vortex_workflow.check_workflow_registration_readiness(uuid, bigint, uuid, uuid, text, text),
  vortex_workflow.read_registered_workflow_evidence(uuid, uuid)
  to vortex_request, vortex_runtime;
