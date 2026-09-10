begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #37 slice 2: field projection and refused writes proved at the database
-- boundary. Slice 1 (20260910094534_resolve_record_field_bounds.sql) resolves
-- which fields an allowed record decision permits; #35's decision function
-- (20260910040755_compose_exact_record_access_decision.sql) decides which
-- rows are reached. Neither hides a column by itself: a row policy either
-- returns the row or it does not. So the restricted role vortex_request holds
-- NO privilege at all on the content table below, and reaches it only through
-- two fixed adapters that project readable fields and validate changed
-- fields. No migration: this file proves enforcement at the boundary using
-- the two objects above plus #35/#36, exactly as 430 proved row policies.
--
-- One neutral table, one record type, one organisation, three accounts:
--   OWNER   holds owner_read/owner_update (route: ownership) and owns every
--           row used below.
--   SHARED  holds share_read/share_update (route: direct_share) and reaches
--           rows only through explicit organization_direct_record_shares
--           rows, each narrowing the permission's own field policy.
--   OUTSIDER holds no permission at all.
-- Three business columns distinguish the three field outcomes: f_open (every
-- holder can read and change it), f_locked (every holder can read it, only
-- OWNER's permission can change it), f_secret (declared on the record type
-- but never named by any field policy anywhere -- always withheld).
-- ============================================================================

create table vortex_access.test_field_rows (
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  module_root_id uuid not null
    check (module_root_id = '34450000-0000-4000-8000-000000000002'::uuid),
  record_type_id uuid not null
    check (record_type_id = 'd4450000-0000-4000-8000-000000000001'::uuid),
  storage_contract_id uuid not null
    check (storage_contract_id = 'b4450000-0000-4000-8000-000000000001'::uuid),
  record_id uuid primary key,
  application_root_id uuid not null,
  owner_organization_account_id uuid not null,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'soft_deleted', 'removal_pending')),
  f_open text,
  f_locked text,
  f_secret text,
  foreign key (organization_id, owner_organization_account_id)
    references vortex_identity.organization_accounts (organization_id, organization_account_id)
);
alter table vortex_access.test_field_rows enable row level security;
alter table vortex_access.test_field_rows force row level security;

-- No grant of any kind to vortex_request on this table. That absence -- not a
-- row policy -- is what stops vortex_request from ever seeing a raw row.

-- ============================================================================
-- Identity/organisation fixture: one tenant, one organisation, three accounts.
-- ============================================================================

create function pg_temp.seed_identity()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '14450000-0000-4000-8000-000000000001', 'field_access',
    'Field access', 'active', operation_at,
    '94450000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '24450000-0000-4000-8000-000000000001', '14450000-0000-4000-8000-000000000001',
    'field_access', 'Field access', 'active', operation_at,
    '94450000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('44450000-0000-4000-8000-000000000001', 'active', operation_at, operation_at,
      '94450000-0000-4000-8000-000000000001', 'a4450000-0000-4000-8000-000000000001', 1),
    ('44450000-0000-4000-8000-000000000002', 'active', operation_at, operation_at,
      '94450000-0000-4000-8000-000000000001', 'a4450000-0000-4000-8000-000000000002', 1),
    ('44450000-0000-4000-8000-000000000003', 'active', operation_at, operation_at,
      '94450000-0000-4000-8000-000000000001', 'a4450000-0000-4000-8000-000000000003', 1);

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('54450000-0000-4000-8000-000000000001', '24450000-0000-4000-8000-000000000001',
      '44450000-0000-4000-8000-000000000001', 'Owner account', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94450000-0000-4000-8000-000000000001', 'a4450000-0000-4000-8000-000000000011', 1),
    ('54450000-0000-4000-8000-000000000002', '24450000-0000-4000-8000-000000000001',
      '44450000-0000-4000-8000-000000000002', 'Shared account', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94450000-0000-4000-8000-000000000001', 'a4450000-0000-4000-8000-000000000012', 1),
    ('54450000-0000-4000-8000-000000000003', '24450000-0000-4000-8000-000000000001',
      '44450000-0000-4000-8000-000000000003', 'Outsider account', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94450000-0000-4000-8000-000000000001', 'a4450000-0000-4000-8000-000000000013', 1);

  perform 1 from vortex_access.initialize_organization_access_version(
    '24450000-0000-4000-8000-000000000001', '94450000-0000-4000-8000-000000000001',
    'a4450000-0000-4000-8000-000000000021'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24450000-0000-4000-8000-000000000001', '94450000-0000-4000-8000-000000000001',
    'a4450000-0000-4000-8000-000000000022'
  );
end
$function$;

select pg_temp.seed_identity();

-- ============================================================================
-- Permission catalogue: one application registration owning four record-
-- scoped permissions on the one record type, each with its own field_policy.
-- owner_* route on ownership; share_* route on direct_share only, so SHARED
-- reaches a row solely through an explicit organization_direct_record_shares
-- row for that exact record.
-- ============================================================================

create function pg_temp.seed_catalogue()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24450000-0000-4000-8000-000000000001', 'application',
    '34450000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.field_access', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94450000-0000-4000-8000-000000000001',
    'a4450000-0000-4000-8000-000000000031'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24450000-0000-4000-8000-000000000001', 'application',
    '34450000-0000-4000-8000-000000000001', 'active', 1,
    'example.field_access', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94450000-0000-4000-8000-000000000001',
    'a4450000-0000-4000-8000-000000000031'
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope, field_policy
  )
  select
    '24450000-0000-4000-8000-000000000001'::uuid, 'application',
    '34450000-0000-4000-8000-000000000001'::uuid, 1,
    '34450000-0000-4000-8000-000000000001'::uuid, 'application',
    '34450000-0000-4000-8000-000000000001'::uuid,
    permission.permission_id, permission.permission_key,
    permission.label, 'Field access fixture.',
    'd4450000-0000-4000-8000-000000000001'::uuid, permission.action_kind,
    null, false,
    'application', 'example.field_access',
    '34450000-0000-4000-8000-000000000001'::uuid, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64),
    permission.record_scope, permission.field_policy
  from (values
    ('c4450000-0000-4000-8000-000000000001'::uuid,
      'field_access.owner_read', 'Owner read', 'read', '1',
      '{"routes":[{"kind":"ownership"}]}'::jsonb,
      '{"readableFieldIds":["b4450000-0000-4000-8000-000000000101","b4450000-0000-4000-8000-000000000102"],"changeableFieldIds":[]}'::jsonb),
    ('c4450000-0000-4000-8000-000000000002'::uuid,
      'field_access.owner_update', 'Owner update', 'update', '2',
      '{"routes":[{"kind":"ownership"}]}'::jsonb,
      '{"readableFieldIds":["b4450000-0000-4000-8000-000000000101","b4450000-0000-4000-8000-000000000102"],"changeableFieldIds":["b4450000-0000-4000-8000-000000000101"]}'::jsonb),
    ('c4450000-0000-4000-8000-000000000003'::uuid,
      'field_access.share_read', 'Share read', 'read', '3',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb,
      '{"readableFieldIds":["b4450000-0000-4000-8000-000000000101","b4450000-0000-4000-8000-000000000102"],"changeableFieldIds":[]}'::jsonb),
    ('c4450000-0000-4000-8000-000000000004'::uuid,
      'field_access.share_update', 'Share update', 'update', '4',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb,
      '{"readableFieldIds":["b4450000-0000-4000-8000-000000000101","b4450000-0000-4000-8000-000000000102"],"changeableFieldIds":["b4450000-0000-4000-8000-000000000101","b4450000-0000-4000-8000-000000000102"]}'::jsonb)
  ) as permission(
    permission_id, permission_key, label, action_kind, fingerprint_character,
    record_scope, field_policy
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, entry.application_root_id, entry.owner_kind,
    entry.owner_id, entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, 'available', 1, entry.meaning_fingerprint,
    1, operation_at
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = '24450000-0000-4000-8000-000000000001'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = '34450000-0000-4000-8000-000000000001';
end
$function$;

select pg_temp.seed_catalogue();

-- One custom role per permission (mirrors 430's own pattern), each assigned
-- standing to the account that should hold it.
create function pg_temp.seed_role(
  p_role_id uuid,
  p_role_key text,
  p_permission_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision,
    created_by, created_at
  ) values (
    '24450000-0000-4000-8000-000000000001', p_role_id, 'custom',
    p_role_key, 1, '94450000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, p_role_id, 1, 1, 'custom', null,
    entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id is not distinct from
      entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from
      entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '24450000-0000-4000-8000-000000000001'
    and entry.permission_id = p_permission_id;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '24450000-0000-4000-8000-000000000001', p_role_id, 1, 'custom',
    'active', 'standard', 'standing', 1, 1,
    p_role_key, 'Field access role',
    'Field access role fixture.',
    '94450000-0000-4000-8000-000000000001', operation_at, p_role_id
  );
end
$function$;

select pg_temp.seed_role(
  '64450000-0000-4000-8000-000000000001', 'owner_read', 'c4450000-0000-4000-8000-000000000001'
);
select pg_temp.seed_role(
  '64450000-0000-4000-8000-000000000002', 'owner_update', 'c4450000-0000-4000-8000-000000000002'
);
select pg_temp.seed_role(
  '64450000-0000-4000-8000-000000000003', 'share_read', 'c4450000-0000-4000-8000-000000000003'
);
select pg_temp.seed_role(
  '64450000-0000-4000-8000-000000000004', 'share_update', 'c4450000-0000-4000-8000-000000000004'
);

-- OWNER holds owner_read/owner_update. SHARED holds share_read/share_update.
-- OUTSIDER holds nothing.
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select '24450000-0000-4000-8000-000000000001', assignment.role_assignment_id,
  assignment.role_id, 'organization_account', assignment.account_id, null,
  'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94450000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  assignment.correlation_id, '94450000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), assignment.correlation_id
from (values
  ('74450000-0000-4000-8000-000000000001'::uuid, '64450000-0000-4000-8000-000000000001'::uuid,
    '54450000-0000-4000-8000-000000000001'::uuid, 'a4450000-0000-4000-8000-000000000041'::uuid),
  ('74450000-0000-4000-8000-000000000002'::uuid, '64450000-0000-4000-8000-000000000002'::uuid,
    '54450000-0000-4000-8000-000000000001'::uuid, 'a4450000-0000-4000-8000-000000000042'::uuid),
  ('74450000-0000-4000-8000-000000000003'::uuid, '64450000-0000-4000-8000-000000000003'::uuid,
    '54450000-0000-4000-8000-000000000002'::uuid, 'a4450000-0000-4000-8000-000000000043'::uuid),
  ('74450000-0000-4000-8000-000000000004'::uuid, '64450000-0000-4000-8000-000000000004'::uuid,
    '54450000-0000-4000-8000-000000000002'::uuid, 'a4450000-0000-4000-8000-000000000044'::uuid)
) as assignment(role_assignment_id, role_id, account_id, correlation_id);

-- ============================================================================
-- Direct shares: SHARED's only route to a record is one of these. Both share
-- rows narrow the held permission's own field policy -- record_1 to a
-- smaller readable set (proves narrowing on read), record_6 to zero
-- changeable fields (proves a share can admit read but forbid every write
-- even though share_update's own policy would allow one).
-- ============================================================================

insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '24450000-0000-4000-8000-000000000001', share.direct_share_id,
  'application_contained', '34450000-0000-4000-8000-000000000001',
  '34450000-0000-4000-8000-000000000002', 'd4450000-0000-4000-8000-000000000001',
  'b4450000-0000-4000-8000-000000000001', share.record_id,
  'organization_account', '54450000-0000-4000-8000-000000000002', null,
  share.readable_field_ids, share.changeable_field_ids,
  op.now - interval '1 minute', op.now + interval '4 hours',
  'active', 1, '54450000-0000-4000-8000-000000000001', op.now,
  share.correlation_id, share.reason, op.now
from (select pg_catalog.clock_timestamp() as now) as op
cross join (values
  ('74450000-0000-4000-8000-000000000101'::uuid, 'e4450000-0000-4000-8000-000000000001'::uuid,
    array['b4450000-0000-4000-8000-000000000101']::uuid[],
    array[]::uuid[],
    'a4450000-0000-4000-8000-000000000051'::uuid, 'Narrowed read share fixture'),
  ('74450000-0000-4000-8000-000000000102'::uuid, 'e4450000-0000-4000-8000-000000000006'::uuid,
    array['b4450000-0000-4000-8000-000000000101']::uuid[],
    array[]::uuid[],
    'a4450000-0000-4000-8000-000000000052'::uuid, 'No changeable field share fixture')
) as share(
  direct_share_id, record_id, readable_field_ids, changeable_field_ids,
  correlation_id, reason
);

-- ============================================================================
-- Content rows. record_1 is read-only fixture data shared by every projection
-- case; the rest are each mutated by exactly one write case so no case can
-- observe another's write.
-- ============================================================================

insert into vortex_access.test_field_rows (
  organization_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, owner_organization_account_id,
  f_open, f_locked, f_secret
)
values
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-1', 'locked-1', 'secret-1'),
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000002', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-2', 'locked-2', 'secret-2'),
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000003', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-3', 'locked-3', 'secret-3'),
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000004', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-4', 'locked-4', 'secret-4'),
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000005', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-5', 'locked-5', 'secret-5'),
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000006', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-6', 'locked-6', 'secret-6'),
  ('24450000-0000-4000-8000-000000000001', '34450000-0000-4000-8000-000000000002',
    'd4450000-0000-4000-8000-000000000001', 'b4450000-0000-4000-8000-000000000001',
    'e4450000-0000-4000-8000-000000000007', '34450000-0000-4000-8000-000000000001',
    '54450000-0000-4000-8000-000000000001', 'open-7', 'locked-7', 'secret-7');

-- Establishes the real session request context the decision function samples
-- itself via validated_human_request_context(). Callable repeatedly to switch
-- the acting account between cases; each call clears the transaction-local
-- GUC first since vortex_context.initialize() refuses to run over an
-- already-established context.
create function pg_temp.install_request_context(p_account_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
  acting_identity_id uuid;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);

  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24450000-0000-4000-8000-000000000001';

  select account.identity_id into strict acting_identity_id
  from vortex_identity.organization_accounts as account
  where account.organization_id = '24450000-0000-4000-8000-000000000001'
    and account.organization_account_id = p_account_id;

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'a4450000-0000-4000-8000-000000000091',
    'tenantId', '14450000-0000-4000-8000-000000000001',
    'organizationId', '24450000-0000-4000-8000-000000000001',
    'organizationAccountId', p_account_id,
    'identityId', acting_identity_id,
    'applicationRootId', '34450000-0000-4000-8000-000000000001',
    'sessionId', 'a4450000-0000-4000-8000-000000000092',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '2 hours',
    'accessVersion', current_access_version,
    'correlationId', 'a4450000-0000-4000-8000-000000000093',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

-- ============================================================================
-- Two fixed adapters. Both security definer, owner postgres, empty search
-- path. Each resolves its own binding, builds its own facts from the row and
-- calls the one shared decision function, then resolve_record_field_bounds_
-- internal. The caller supplies only a record id and, for a change, the
-- proposed values -- never a permission, a field set, a table or a predicate.
-- ============================================================================

-- Projects exactly the readable fields of one record for the caller's own
-- held permissions. A refused decision returns {"outcome":"refused"} and
-- nothing else -- never a partially populated row, never an empty stand-in
-- for a withheld field.
create function vortex_access.test_field_project(
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34450000-0000-4000-8000-000000000001';
  module_id constant uuid := '34450000-0000-4000-8000-000000000002';
  type_id constant uuid := 'd4450000-0000-4000-8000-000000000001';
  contract_id constant uuid := 'b4450000-0000-4000-8000-000000000001';
  f_open_id constant uuid := 'b4450000-0000-4000-8000-000000000101';
  f_locked_id constant uuid := 'b4450000-0000-4000-8000-000000000102';
  f_secret_id constant uuid := 'b4450000-0000-4000-8000-000000000103';
  permission_ids constant uuid[] := array[
    'c4450000-0000-4000-8000-000000000001'::uuid, -- owner_read
    'c4450000-0000-4000-8000-000000000003'::uuid  -- share_read
  ];
  row_val vortex_access.test_field_rows;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
  bounds jsonb;
  all_values jsonb;
  result jsonb;
  field_id text;
begin
  select * into row_val from vortex_access.test_field_rows where record_id = p_record_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', type_id,
      'storageContractId', contract_id, 'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', type_id,
      'storageContractId', contract_id, 'storageScope', 'application_contained',
      'ownershipMode', 'organization_account',
      'fields', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId', f_open_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f_locked_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f_secret_id, 'type', 'text')
      )
    )),
    'relationships', '[]'::jsonb,
    'sharingConditions', '[]'::jsonb,
    'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', row_val.organization_id,
        'moduleRootId', module_id, 'recordTypeId', type_id,
        'storageContractId', contract_id,
        'recordId', row_val.record_id, 'applicationRootId', row_val.application_root_id
      ),
      'ownerOrganizationAccountId', row_val.owner_organization_account_id,
      'lifecycleState', row_val.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(
        f_open_id::text, row_val.f_open,
        f_locked_id::text, row_val.f_locked,
        f_secret_id::text, row_val.f_secret
      )
    )),
    'edges', '[]'::jsonb
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.field_access.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object('kind', 'application', 'applicationRootId', app_root_id),
    'requiredPermissions', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId', app_root_id, 'ownerKind', 'application',
        'ownerId', app_root_id, 'permissionId', item.value
      ) order by item.ordinality)
      from pg_catalog.unnest(permission_ids) with ordinality as item(value, ordinality)
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', type_id,
      'storageContractId', contract_id, 'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_record_id, facts
  );

  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  bounds := vortex_access.resolve_record_field_bounds_internal(decision);

  all_values := pg_catalog.jsonb_build_object(
    f_open_id::text, row_val.f_open,
    f_locked_id::text, row_val.f_locked,
    f_secret_id::text, row_val.f_secret
  );

  result := pg_catalog.jsonb_build_object('outcome', 'allowed');
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    result := result || pg_catalog.jsonb_build_object(field_id, all_values -> field_id);
  end loop;

  return result;
end
$function$;

revoke execute on function vortex_access.test_field_project(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_field_project(uuid) to vortex_request;

-- Validates the proposed object's keys against the caller's own changeable
-- set and, only if every key is inside it, applies exactly the proposed
-- fields. Any proposed field outside the changeable set refuses the whole
-- operation before any write -- never a partial apply of the permitted
-- subset.
create function vortex_access.test_field_change(
  p_record_id uuid,
  p_proposed jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34450000-0000-4000-8000-000000000001';
  module_id constant uuid := '34450000-0000-4000-8000-000000000002';
  type_id constant uuid := 'd4450000-0000-4000-8000-000000000001';
  contract_id constant uuid := 'b4450000-0000-4000-8000-000000000001';
  f_open_id constant uuid := 'b4450000-0000-4000-8000-000000000101';
  f_locked_id constant uuid := 'b4450000-0000-4000-8000-000000000102';
  f_secret_id constant uuid := 'b4450000-0000-4000-8000-000000000103';
  permission_ids constant uuid[] := array[
    'c4450000-0000-4000-8000-000000000002'::uuid, -- owner_update
    'c4450000-0000-4000-8000-000000000004'::uuid  -- share_update
  ];
  row_val vortex_access.test_field_rows;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_key text;
  affected integer;
begin
  if p_proposed is null or pg_catalog.jsonb_typeof(p_proposed) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  -- Field ids are canonically lowercase -- matching both
  -- resolve_record_field_bounds_internal's own canonicalisation and a uuid
  -- value's own ::text form. Normalise the proposed object's keys to that
  -- same case once, here, so the authorisation check below and the UPDATE's
  -- own key lookups agree on exactly the same keys: an upper-case field id
  -- must not be authorised under a case-insensitive comparison and then
  -- silently fail to apply because the UPDATE looked for a differently-cased
  -- key that was never there.
  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(entry.key), entry.value), '{}'::jsonb)
  into p_proposed
  from pg_catalog.jsonb_each(p_proposed) as entry(key, value);

  select * into row_val from vortex_access.test_field_rows where record_id = p_record_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', type_id,
      'storageContractId', contract_id, 'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', type_id,
      'storageContractId', contract_id, 'storageScope', 'application_contained',
      'ownershipMode', 'organization_account',
      'fields', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId', f_open_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f_locked_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f_secret_id, 'type', 'text')
      )
    )),
    'relationships', '[]'::jsonb,
    'sharingConditions', '[]'::jsonb,
    'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', row_val.organization_id,
        'moduleRootId', module_id, 'recordTypeId', type_id,
        'storageContractId', contract_id,
        'recordId', row_val.record_id, 'applicationRootId', row_val.application_root_id
      ),
      'ownerOrganizationAccountId', row_val.owner_organization_account_id,
      'lifecycleState', row_val.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(
        f_open_id::text, row_val.f_open,
        f_locked_id::text, row_val.f_locked,
        f_secret_id::text, row_val.f_secret
      )
    )),
    'edges', '[]'::jsonb
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.field_access.update',
    'action', pg_catalog.jsonb_build_object('actionKind', 'update'),
    'target', pg_catalog.jsonb_build_object('kind', 'application', 'applicationRootId', app_root_id),
    'requiredPermissions', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId', app_root_id, 'ownerKind', 'application',
        'ownerId', app_root_id, 'permissionId', item.value
      ) order by item.ordinality)
      from pg_catalog.unnest(permission_ids) with ordinality as item(value, ordinality)
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', type_id,
      'storageContractId', contract_id, 'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_record_id, facts
  );

  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  bounds := vortex_access.resolve_record_field_bounds_internal(decision);

  select pg_catalog.array_agg(item.value #>> '{}')
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
  changeable := coalesce(changeable, array[]::text[]);

  -- Every proposed key must be inside the changeable set. p_proposed's keys
  -- are already lowercased above, matching changeable's own canonical case,
  -- so this is a plain membership test -- the same keys the UPDATE below
  -- looks up, not a case-insensitive comparison against differently-cased
  -- keys it will then fail to find. The first field outside it refuses the
  -- whole proposal before any UPDATE statement runs, so a permitted field
  -- named alongside a forbidden one is never applied.
  for proposed_key in select * from pg_catalog.jsonb_object_keys(p_proposed)
  loop
    if not (proposed_key = any (changeable)) then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
  end loop;

  update vortex_access.test_field_rows
  set
    f_open = case when p_proposed ? f_open_id::text
      then p_proposed ->> f_open_id::text else f_open end,
    f_locked = case when p_proposed ? f_locked_id::text
      then p_proposed ->> f_locked_id::text else f_locked end
  where record_id = p_record_id;

  get diagnostics affected = row_count;

  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'rowsChanged', affected);
end
$function$;

revoke execute on function vortex_access.test_field_change(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_field_change(uuid, jsonb) to vortex_request;

-- Business-field snapshot of one row, for asserting a refused write left the
-- record completely untouched -- the stored values, not just the absence of
-- an error. Security definer: vortex_request holds no privilege on the
-- table, so this independent verification channel (not the adapter under
-- test) needs the owner's own rights to read ground truth back.
create function pg_temp.field_snapshot(p_record_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'f_open', f_open, 'f_locked', f_locked, 'f_secret', f_secret
  )
  from vortex_access.test_field_rows where record_id = p_record_id
$function$;
grant execute on function pg_temp.field_snapshot(uuid) to vortex_request;

-- Test-only pgTAP visibility while vortex_request is active, following
-- supabase/tests/290's own pattern.
grant usage on schema extensions to vortex_request;

-- ============================================================================
-- OWNER: holds owner_read/owner_update through the ownership route and owns
-- every row below. Context is installed, then the role switches to
-- vortex_request for every call -- these are real calls made by the
-- restricted role through the two granted adapters, not calls made by the
-- connecting role on its behalf.
-- ============================================================================

reset role;
select pg_temp.install_request_context('54450000-0000-4000-8000-000000000001');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

-- ---- Projection ----

select is(
  vortex_access.test_field_project('e4450000-0000-4000-8000-000000000001'),
  pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'b4450000-0000-4000-8000-000000000101', 'open-1',
    'b4450000-0000-4000-8000-000000000102', 'locked-1'
  ),
  'OWNER reads record_1: both readable fields are present with their real values, exactly'
);
select ok(
  not (vortex_access.test_field_project('e4450000-0000-4000-8000-000000000001') ? 'b4450000-0000-4000-8000-000000000103'),
  'OWNER''s projection of record_1 does not contain the withheld secret field''s key at all'
);

-- ---- Writes ----

select is(
  vortex_access.test_field_change(
    'e4450000-0000-4000-8000-000000000002',
    pg_catalog.jsonb_build_object('b4450000-0000-4000-8000-000000000101', 'open-2-changed')
  ),
  pg_catalog.jsonb_build_object('outcome', 'allowed', 'rowsChanged', 1),
  'OWNER changes the changeable open field on record_2: allowed'
);
select is(
  pg_temp.field_snapshot('e4450000-0000-4000-8000-000000000002'),
  pg_catalog.jsonb_build_object('f_open', 'open-2-changed', 'f_locked', 'locked-2', 'f_secret', 'secret-2'),
  'record_2 persists the new open value; locked and secret are untouched by an open-only change'
);

select is(
  vortex_access.test_field_change(
    'e4450000-0000-4000-8000-000000000003',
    pg_catalog.jsonb_build_object('b4450000-0000-4000-8000-000000000102', 'locked-3-changed')
  ),
  pg_catalog.jsonb_build_object('outcome', 'refused'),
  'OWNER changing only the locked field on record_3 is refused: readable is not changeable'
);
select is(
  pg_temp.field_snapshot('e4450000-0000-4000-8000-000000000003'),
  pg_catalog.jsonb_build_object('f_open', 'open-3', 'f_locked', 'locked-3', 'f_secret', 'secret-3'),
  'record_3 is completely unchanged after the refused not-changeable-field proposal'
);

-- The single most important case in the slice: mixing one permitted field
-- with one forbidden field refuses the whole proposal, and the permitted
-- field is never silently applied on its own.
select is(
  vortex_access.test_field_change(
    'e4450000-0000-4000-8000-000000000004',
    pg_catalog.jsonb_build_object(
      'b4450000-0000-4000-8000-000000000101', 'open-4-changed',
      'b4450000-0000-4000-8000-000000000102', 'locked-4-changed'
    )
  ),
  pg_catalog.jsonb_build_object('outcome', 'refused'),
  'OWNER proposing one permitted field (open) alongside one forbidden field (locked) on record_4 is refused whole'
);
select is(
  pg_temp.field_snapshot('e4450000-0000-4000-8000-000000000004'),
  pg_catalog.jsonb_build_object('f_open', 'open-4', 'f_locked', 'locked-4', 'f_secret', 'secret-4'),
  'record_4''s permitted open field did not change either -- the mixed proposal touched nothing'
);

select is(
  vortex_access.test_field_change(
    'e4450000-0000-4000-8000-000000000005',
    pg_catalog.jsonb_build_object('b4450000-0000-4000-8000-000000000199', 'x')
  ),
  pg_catalog.jsonb_build_object('outcome', 'refused'),
  'OWNER naming a field id that exists on no policy at all (not a real field on the record type) is refused'
);
select is(
  pg_temp.field_snapshot('e4450000-0000-4000-8000-000000000005'),
  pg_catalog.jsonb_build_object('f_open', 'open-5', 'f_locked', 'locked-5', 'f_secret', 'secret-5'),
  'record_5 is untouched after the unknown-field proposal'
);

-- Case sensitivity: authorisation and application must agree on the same
-- key. An upper-cased field id is authorised (the changeable-set membership
-- check compares on the field ids' own canonical lowercase form) and must
-- therefore actually be applied under that same case -- not silently dropped
-- by a case-sensitive key lookup that still goes on to report the row as
-- changed.
select is(
  vortex_access.test_field_change(
    'e4450000-0000-4000-8000-000000000007',
    pg_catalog.jsonb_build_object('B4450000-0000-4000-8000-000000000101', 'open-7-changed')
  ),
  pg_catalog.jsonb_build_object('outcome', 'allowed', 'rowsChanged', 1),
  'OWNER changing the open field on record_7 via an upper-cased field id is authorised'
);
select is(
  pg_temp.field_snapshot('e4450000-0000-4000-8000-000000000007'),
  pg_catalog.jsonb_build_object('f_open', 'open-7-changed', 'f_locked', 'locked-7', 'f_secret', 'secret-7'),
  'the upper-cased field id is actually applied, not silently dropped while still reporting a changed row'
);

reset role;

-- ============================================================================
-- SHARED: holds share_read/share_update through the direct_share route only,
-- and reaches record_1/record_6 solely through the explicit
-- organization_direct_record_shares rows seeded above.
-- ============================================================================

select pg_temp.install_request_context('54450000-0000-4000-8000-000000000002');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

-- ---- Projection: same row as OWNER, different key set ----

select is(
  vortex_access.test_field_project('e4450000-0000-4000-8000-000000000001'),
  pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'b4450000-0000-4000-8000-000000000101', 'open-1'
  ),
  'SHARED reads the same record_1 through a direct share narrowed to one field: only that field, exactly -- a strictly smaller key set than OWNER''s {open, locked}'
);
select ok(
  not (vortex_access.test_field_project('e4450000-0000-4000-8000-000000000001') ? 'b4450000-0000-4000-8000-000000000102'),
  'SHARED''s projection lacks the locked field''s key even though share_read''s own policy allows it -- the share narrows it away'
);
select ok(
  not (vortex_access.test_field_project('e4450000-0000-4000-8000-000000000001') ? 'b4450000-0000-4000-8000-000000000103'),
  'SHARED''s projection of record_1 does not contain the withheld secret field''s key at all'
);

-- ---- Write: a share whose changeable set is empty cannot change anything,
-- even though share_update's own policy would allow changing open. ----

select is(
  vortex_access.test_field_change(
    'e4450000-0000-4000-8000-000000000006',
    pg_catalog.jsonb_build_object('b4450000-0000-4000-8000-000000000101', 'open-6-changed')
  ),
  pg_catalog.jsonb_build_object('outcome', 'refused'),
  'SHARED cannot change the open field on record_6: the concrete share''s changeableFieldIds is empty, even though share_update''s own policy allows open'
);
select is(
  pg_temp.field_snapshot('e4450000-0000-4000-8000-000000000006'),
  pg_catalog.jsonb_build_object('f_open', 'open-6', 'f_locked', 'locked-6', 'f_secret', 'secret-6'),
  'record_6 is untouched: the empty-changeable share refused the whole operation'
);

reset role;

-- ============================================================================
-- OUTSIDER: holds no permission at all.
-- ============================================================================

select pg_temp.install_request_context('54450000-0000-4000-8000-000000000003');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  vortex_access.test_field_project('e4450000-0000-4000-8000-000000000001'),
  pg_catalog.jsonb_build_object('outcome', 'refused'),
  'OUTSIDER holds no permission at all: record_1 is refused with no field data whatsoever, not even an empty stand-in'
);

reset role;
select pg_catalog.set_config('vortex.request_context', '', true);

-- ============================================================================
-- Boundary assertions.
-- ============================================================================

-- vortex_request holds no privilege at all on the content table -- not a row
-- policy, an absent grant, which is what a row policy alone could never do.
select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_access.test_field_rows', privilege.kind),
  'vortex_request has no ' || privilege.kind || ' privilege on test_field_rows'
)
from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as privilege(kind)
order by privilege.kind collate "C";

-- The same absence proved as a real refused statement, not just an
-- introspection query.
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select * from vortex_access.test_field_rows',
  '42501'::char(5), null::text,
  'a direct select against test_field_rows under vortex_request is refused'
);
reset role;

-- vortex_request can execute exactly the two fixed adapters, and none of the
-- private evaluators or #36 predicates they call internally.
select ok(
  pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request can execute ' || target.signature
)
from (values
  ('vortex_access.test_field_project(uuid)'),
  ('vortex_access.test_field_change(uuid,jsonb)')
) as target(signature)
order by target.signature collate "C";

select ok(
  not pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request cannot execute ' || target.signature
)
from (values
  ('vortex_access.resolve_record_field_bounds_internal(jsonb)'),
  ('vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'),
  ('vortex_access.evaluate_current_record_ownership_visibility(jsonb,text,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid,uuid,uuid,timestamptz)'),
  ('vortex_access.read_current_direct_record_share_contributions(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz)'),
  ('vortex_access.record_relationship_witness_matches(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,uuid,uuid)'),
  ('vortex_access.evaluate_permission_saved_condition(jsonb,jsonb,jsonb,jsonb,uuid)')
) as target(signature)
order by target.signature collate "C";

-- The adapters themselves are owner-held, security definer, empty search
-- path -- never invoker-rights, never a different owner.
select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname, 'securityDefiner', procedure_row.prosecdef,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.pronamespace = 'vortex_access'::regnamespace
      and procedure_row.proname in ('test_field_project', 'test_field_change')
  ),
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', 'postgres', 'securityDefiner', true, 'configuration', array['search_path=""']
    ) order by name.value)
    from (values ('test_field_change'), ('test_field_project')) as name(value)
  ),
  'both adapters are owner-held, security definer and empty-search-path'
);

set constraints all immediate;

select * from finish();

rollback;
