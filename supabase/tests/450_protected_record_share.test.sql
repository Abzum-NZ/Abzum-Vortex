begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #37 slice 3: the protected same-organisation direct-share grant/revoke
-- operations, corrected in slice 5 after independent review found the
-- grantor's and revoker's authority was re-derived against fabricated facts
-- rather than the record's real row, and in slice 6 (N1/N2) after a further
-- review found revocation wrongly required its target record to be visible,
-- and found (but deliberately did not "fix") the grant path's declaration
-- raising when an unrelated held permission's route or condition is outside
-- the adapter's facts -- see
-- 20260910114716_coordinate_protected_record_share.sql's own header. Mirrors
-- 445's fixture style: one organisation, a neutral record type with a real
-- content table (test_share_rows, added in slice 5 -- there was none before),
-- a catalogue with direct_share-, all_records-, ownership-, relationship- and
-- condition-scoped record permissions, several grantors each holding a
-- different route to the same authority, and pre-existing shares (seeded
-- directly, as 445 seeds its own) that give some of them their own current
-- read/update ceiling on specific target records. `grant_record_share_for_
-- administration` and `revoke_record_share_for_administration` are owner-only
-- as of slice 5: every assertion below reaches them only through the two
-- fixed adapters at the bottom of the fixture section, exactly as 430/445
-- reach the record decision only through their own fixed adapters.
-- ============================================================================

-- ============================================================================
-- Identity/organisation fixture: two tenants (home + foreign), one home
-- organisation with nine accounts and one Group, one foreign organisation
-- with one account and one Group. Of the nine home accounts: GRANTOR,
-- RECIPIENT, a spare (retired) account and ADMIN are #37 slice 3's own
-- fixture; NO_SHARE_GRANTOR and ALL_RECORDS_GRANTOR are slice 4's, proving
-- F1's regression (read/update without share) and the all_records route
-- respectively; OWNER_GRANTOR, RELATIONSHIP_GRANTOR and CONDITION_GRANTOR are
-- slice 5's, proving the three route kinds slice 4's fabricated facts always
-- excluded -- see their own seeded roles and real rows below.
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
  ) values
    ('14500000-0000-4000-8000-000000000001', 'record_share',
      'Record share', 'active', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at, 1),
    ('14500000-0000-4000-8000-000000000002', 'record_share_foreign',
      'Record share foreign', 'active', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at, 1);

  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values
    ('24500000-0000-4000-8000-000000000001', '14500000-0000-4000-8000-000000000001',
      'record_share', 'Record share', 'active', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at, 1),
    ('24500000-0000-4000-8000-000000000002', '14500000-0000-4000-8000-000000000002',
      'record_share_foreign', 'Record share foreign', 'active', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at, 1);

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('44500000-0000-4000-8000-000000000001', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000001', 1),
    ('44500000-0000-4000-8000-000000000002', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000002', 1),
    ('44500000-0000-4000-8000-000000000003', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000003', 1),
    ('44500000-0000-4000-8000-000000000004', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000004', 1),
    ('44500000-0000-4000-8000-000000000005', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000005', 1),
    ('44500000-0000-4000-8000-000000000006', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000006', 1),
    ('44500000-0000-4000-8000-000000000007', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000007', 1),
    ('44500000-0000-4000-8000-000000000008', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000008', 1),
    ('44500000-0000-4000-8000-000000000009', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000009', 1),
    ('44500000-0000-4000-8000-000000000010', 'active', operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-00000000000a', 1);

  -- Home organisation: GRANTOR, RECIPIENT, a spare account, ADMIN, then
  -- NO_SHARE_GRANTOR/ALL_RECORDS_GRANTOR (slice 4), then OWNER_GRANTOR/
  -- RELATIONSHIP_GRANTOR/CONDITION_GRANTOR (slice 5).
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, closed_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('54500000-0000-4000-8000-000000000001', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000001', 'Grantor account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000011', 1),
    ('54500000-0000-4000-8000-000000000002', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000002', 'Recipient account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000012', 1),
    ('54500000-0000-4000-8000-000000000003', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000003', 'Retired recipient account', 'closed',
      operation_at - interval '1 minute', operation_at, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000013', 1),
    ('54500000-0000-4000-8000-000000000004', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000004', 'Admin account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000014', 1),
    ('54500000-0000-4000-8000-000000000005', '24500000-0000-4000-8000-000000000002',
      '44500000-0000-4000-8000-000000000005', 'Foreign account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000015', 1),
    ('54500000-0000-4000-8000-000000000006', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000006', 'No-share grantor account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000016', 1),
    ('54500000-0000-4000-8000-000000000007', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000007', 'All-records grantor account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000017', 1),
    ('54500000-0000-4000-8000-000000000008', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000008', 'Owner grantor account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000018', 1),
    ('54500000-0000-4000-8000-000000000009', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000009', 'Relationship grantor account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000019', 1),
    ('54500000-0000-4000-8000-000000000010', '24500000-0000-4000-8000-000000000001',
      '44500000-0000-4000-8000-000000000010', 'Condition grantor account', 'active',
      operation_at - interval '1 minute', null, operation_at, operation_at,
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-00000000001a', 1);

  perform 1 from vortex_access.initialize_organization_access_version(
    '24500000-0000-4000-8000-000000000001', '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000021'
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    '24500000-0000-4000-8000-000000000002', '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000022'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24500000-0000-4000-8000-000000000001', '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000023'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24500000-0000-4000-8000-000000000002', '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000024'
  );

  -- One home Group (valid recipient) and one foreign Group (refused
  -- recipient), plus a retired home Group (refused recipient).
  insert into vortex_access.organization_groups (
    organization_id, group_id, group_key, label, state, revision,
    created_by, created_at, changed_by, changed_at, change_correlation_id
  ) values
    ('24500000-0000-4000-8000-000000000001', '84500000-0000-4000-8000-000000000001',
      'home_group', 'Home group', 'active', 1,
      '94500000-0000-4000-8000-000000000001', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at,
      'a4500000-0000-4000-8000-000000000031'),
    ('24500000-0000-4000-8000-000000000001', '84500000-0000-4000-8000-000000000003',
      'retired_home_group', 'Retired home group', 'active', 1,
      '94500000-0000-4000-8000-000000000001', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at,
      'a4500000-0000-4000-8000-000000000032'),
    ('24500000-0000-4000-8000-000000000002', '84500000-0000-4000-8000-000000000002',
      'foreign_group', 'Foreign group', 'active', 1,
      '94500000-0000-4000-8000-000000000001', operation_at,
      '94500000-0000-4000-8000-000000000001', operation_at,
      'a4500000-0000-4000-8000-000000000033');

  -- Retire the third Group by a real state transition (insert must begin
  -- active at revision one).
  update vortex_access.organization_groups
  set state = 'retired', revision = 2, changed_by = '94500000-0000-4000-8000-000000000001',
    changed_at = operation_at, change_correlation_id = 'a4500000-0000-4000-8000-000000000034'
  where organization_id = '24500000-0000-4000-8000-000000000001'
    and group_id = '84500000-0000-4000-8000-000000000003';
end
$function$;

select pg_temp.seed_identity();

-- ============================================================================
-- Content table (added in slice 5 -- there was none before, and the shared
-- record identifiers existed in no table at all). One neutral record type,
-- following 445's own shape: module/record-type/storage-contract pinned by
-- CHECK, an owner, a lifecycle state, three business fields (F1/F2/F3,
-- exactly the ids every direct_share/all_records/ownership permission below
-- already names) and one boolean flag field (F_FLAG) used only by the
-- condition-scoped permission. f_source_link is a plain, hand-written
-- self-link: a row that names another row as its f_source_link is that
-- row's relationship *source* under the one self-relationship R1 declared
-- by the two adapters below, exactly as 430's own alpha.f_alpha_link links
-- alpha rows to the beta row they relate to.
-- ============================================================================

create table vortex_access.test_share_rows (
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  module_root_id uuid not null
    check (module_root_id = '34500000-0000-4000-8000-000000000002'::uuid),
  record_type_id uuid not null
    check (record_type_id = 'd4500000-0000-4000-8000-000000000001'::uuid),
  storage_contract_id uuid not null
    check (storage_contract_id = 'b4500000-0000-4000-8000-000000000001'::uuid),
  record_id uuid primary key,
  application_root_id uuid not null,
  owner_organization_account_id uuid not null,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'soft_deleted', 'removal_pending')),
  f1 text,
  f2 text,
  f3 text,
  f_flag boolean not null default false,
  f_source_link uuid references vortex_access.test_share_rows (record_id),
  foreign key (organization_id, owner_organization_account_id)
    references vortex_identity.organization_accounts (organization_id, organization_account_id)
);
alter table vortex_access.test_share_rows enable row level security;
alter table vortex_access.test_share_rows force row level security;

-- No grant of any kind to vortex_request on this table. That absence -- not a
-- row policy -- is what stops vortex_request from ever seeing a raw row,
-- exactly as 445's own content table.

-- ============================================================================
-- Permission catalogue: one application registration on the home
-- organisation. chain_read and chain_update are routed on direct_share only,
-- so eligibility (a standing role assignment) is necessary but the actual row
-- reached is always an explicit organization_direct_record_shares row.
-- chain_share (#37 slice 4, F1) and chain_read_all are routed all_records.
-- owned_read/owned_share/owned_update (slice 5) are routed ownership.
-- owned_share_relationship (slice 5) is routed relationship, over the one
-- self-relationship R1, sourced from owned_read. owned_share_conditional
-- (slice 5) is routed ownership narrowed by one saved condition comparing
-- F_FLAG to true. Fields: F1/F2/F3 are named by every read/update
-- permission's field policy; F_FLAG is named only by the saved condition
-- (never a readable/changeable field of any permission); no permission ever
-- names any other field id, so a share can never carry one.
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
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.record_share', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000041'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 'active', 1,
    'example.record_share', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000041'
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
    '24500000-0000-4000-8000-000000000001'::uuid, 'application',
    '34500000-0000-4000-8000-000000000001'::uuid, 1,
    '34500000-0000-4000-8000-000000000001'::uuid, 'application',
    '34500000-0000-4000-8000-000000000001'::uuid,
    permission.permission_id, permission.permission_key,
    permission.label, 'Record share fixture.',
    'd4500000-0000-4000-8000-000000000001'::uuid, permission.action_kind,
    null, false,
    'application', 'example.record_share',
    '34500000-0000-4000-8000-000000000001'::uuid, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64),
    permission.record_scope, permission.field_policy
  from (values
    ('c4500000-0000-4000-8000-000000000001'::uuid,
      'record_share.chain_read', 'Chain read', 'read', '1',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb,
      '{"readableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"],"changeableFieldIds":[]}'::jsonb),
    ('c4500000-0000-4000-8000-000000000002'::uuid,
      'record_share.chain_update', 'Chain update', 'update', '2',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb,
      '{"readableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"],"changeableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"]}'::jsonb),
    ('c4500000-0000-4000-8000-000000000003'::uuid,
      'record_share.chain_share', 'Chain share', 'share', '3',
      '{"routes":[{"kind":"all_records"}]}'::jsonb, null::jsonb),
    ('c4500000-0000-4000-8000-000000000004'::uuid,
      'record_share.chain_read_all', 'Chain read (all records)', 'read', '4',
      '{"routes":[{"kind":"all_records"}]}'::jsonb,
      '{"readableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102"],"changeableFieldIds":[]}'::jsonb),
    ('c4500000-0000-4000-8000-000000000005'::uuid,
      'record_share.owned_read', 'Owned read', 'read', '5',
      '{"routes":[{"kind":"ownership"}]}'::jsonb,
      '{"readableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"],"changeableFieldIds":[]}'::jsonb),
    ('c4500000-0000-4000-8000-000000000006'::uuid,
      'record_share.owned_share', 'Owned share', 'share', '6',
      '{"routes":[{"kind":"ownership"}]}'::jsonb, null::jsonb),
    ('c4500000-0000-4000-8000-000000000007'::uuid,
      'record_share.owned_update', 'Owned update', 'update', '7',
      '{"routes":[{"kind":"ownership"}]}'::jsonb,
      '{"readableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"],"changeableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"]}'::jsonb),
    ('c4500000-0000-4000-8000-000000000008'::uuid,
      'record_share.owned_share_relationship', 'Owned share (relationship)', 'share', '8',
      '{"routes":[{"kind":"relationship","relationshipId":"f4500000-0000-4000-8000-000000000001","sourcePermissionId":"c4500000-0000-4000-8000-000000000005"}]}'::jsonb,
      null::jsonb),
    ('c4500000-0000-4000-8000-000000000009'::uuid,
      'record_share.owned_share_conditional', 'Owned share (conditional)', 'share', '9',
      ('{"routes":[{"kind":"ownership"}],"savedCondition":{"conditionId":"b4500000-0000-4000-8000-000000000401","publishedRevision":1,"contractFingerprint":"'
        || ('sha256:' || pg_catalog.repeat('7', 64))
        || '","parameterBindings":[]}}')::jsonb,
      null::jsonb)
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
  where entry.organization_id = '24500000-0000-4000-8000-000000000001'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = '34500000-0000-4000-8000-000000000001';
end
$function$;

select pg_temp.seed_catalogue();

-- One custom role per permission, assigned as standing. Eligibility for a
-- direct_share- or relationship-routed permission is necessary but not
-- sufficient: reaching any given record still requires the matching real
-- row (ownership/edge) or an explicit direct_share row, seeded below.
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
    '24500000-0000-4000-8000-000000000001', p_role_id, 'custom',
    p_role_key, 1, '94500000-0000-4000-8000-000000000001', operation_at
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
  where entry.organization_id = '24500000-0000-4000-8000-000000000001'
    and entry.permission_id = p_permission_id;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '24500000-0000-4000-8000-000000000001', p_role_id, 1, 'custom',
    'active', 'standard', 'standing', 1, 1,
    p_role_key, 'Record share role',
    'Record share role fixture.',
    '94500000-0000-4000-8000-000000000001', operation_at, p_role_id
  );
end
$function$;

select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000001', 'chain_read', 'c4500000-0000-4000-8000-000000000001'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000002', 'chain_update', 'c4500000-0000-4000-8000-000000000002'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000003', 'chain_share', 'c4500000-0000-4000-8000-000000000003'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000004', 'chain_read_all', 'c4500000-0000-4000-8000-000000000004'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000005', 'owned_read', 'c4500000-0000-4000-8000-000000000005'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000006', 'owned_share', 'c4500000-0000-4000-8000-000000000006'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000007', 'owned_update', 'c4500000-0000-4000-8000-000000000007'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000008', 'owned_share_relationship', 'c4500000-0000-4000-8000-000000000008'
);
select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000009', 'owned_share_conditional', 'c4500000-0000-4000-8000-000000000009'
);

-- GRANTOR holds chain_read, chain_update and chain_share by standing
-- assignment. NO_SHARE_GRANTOR holds chain_read and chain_update only, never
-- chain_share: F1's regression fixture. ALL_RECORDS_GRANTOR holds chain_share
-- and chain_read_all only -- both all_records-routed, no direct_share row of
-- its own anywhere below. OWNER_GRANTOR holds owned_read/owned_share/
-- owned_update, all ownership-routed. RELATIONSHIP_GRANTOR holds owned_read
-- (its own source-permission eligibility, over a record it owns directly),
-- owned_share_relationship (relationship-routed) and chain_read_all (its
-- read ceiling on the relationship target, proving all_records admits a read
-- ceiling exactly as it already does for ALL_RECORDS_GRANTOR). CONDITION_
-- GRANTOR holds owned_read and owned_share_conditional.
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select '24500000-0000-4000-8000-000000000001', assignment.role_assignment_id,
  assignment.role_id, 'organization_account', assignment.account_id, null,
  'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  assignment.correlation_id, '94500000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), assignment.correlation_id
from (values
  ('74500000-0000-4000-8000-000000000001'::uuid, '64500000-0000-4000-8000-000000000001'::uuid,
    '54500000-0000-4000-8000-000000000001'::uuid, 'a4500000-0000-4000-8000-000000000051'::uuid),
  ('74500000-0000-4000-8000-000000000002'::uuid, '64500000-0000-4000-8000-000000000002'::uuid,
    '54500000-0000-4000-8000-000000000001'::uuid, 'a4500000-0000-4000-8000-000000000052'::uuid),
  ('74500000-0000-4000-8000-000000000003'::uuid, '64500000-0000-4000-8000-000000000003'::uuid,
    '54500000-0000-4000-8000-000000000001'::uuid, 'a4500000-0000-4000-8000-000000000053'::uuid),
  ('74500000-0000-4000-8000-000000000004'::uuid, '64500000-0000-4000-8000-000000000001'::uuid,
    '54500000-0000-4000-8000-000000000006'::uuid, 'a4500000-0000-4000-8000-000000000054'::uuid),
  ('74500000-0000-4000-8000-000000000005'::uuid, '64500000-0000-4000-8000-000000000002'::uuid,
    '54500000-0000-4000-8000-000000000006'::uuid, 'a4500000-0000-4000-8000-000000000055'::uuid),
  ('74500000-0000-4000-8000-000000000006'::uuid, '64500000-0000-4000-8000-000000000003'::uuid,
    '54500000-0000-4000-8000-000000000007'::uuid, 'a4500000-0000-4000-8000-000000000056'::uuid),
  ('74500000-0000-4000-8000-000000000007'::uuid, '64500000-0000-4000-8000-000000000004'::uuid,
    '54500000-0000-4000-8000-000000000007'::uuid, 'a4500000-0000-4000-8000-000000000057'::uuid),
  ('74500000-0000-4000-8000-000000000301'::uuid, '64500000-0000-4000-8000-000000000005'::uuid,
    '54500000-0000-4000-8000-000000000008'::uuid, 'a4500000-0000-4000-8000-000000000301'::uuid),
  ('74500000-0000-4000-8000-000000000302'::uuid, '64500000-0000-4000-8000-000000000006'::uuid,
    '54500000-0000-4000-8000-000000000008'::uuid, 'a4500000-0000-4000-8000-000000000302'::uuid),
  ('74500000-0000-4000-8000-000000000303'::uuid, '64500000-0000-4000-8000-000000000007'::uuid,
    '54500000-0000-4000-8000-000000000008'::uuid, 'a4500000-0000-4000-8000-000000000303'::uuid),
  ('74500000-0000-4000-8000-000000000304'::uuid, '64500000-0000-4000-8000-000000000005'::uuid,
    '54500000-0000-4000-8000-000000000009'::uuid, 'a4500000-0000-4000-8000-000000000304'::uuid),
  ('74500000-0000-4000-8000-000000000305'::uuid, '64500000-0000-4000-8000-000000000008'::uuid,
    '54500000-0000-4000-8000-000000000009'::uuid, 'a4500000-0000-4000-8000-000000000305'::uuid),
  ('74500000-0000-4000-8000-000000000306'::uuid, '64500000-0000-4000-8000-000000000004'::uuid,
    '54500000-0000-4000-8000-000000000009'::uuid, 'a4500000-0000-4000-8000-000000000306'::uuid),
  ('74500000-0000-4000-8000-000000000307'::uuid, '64500000-0000-4000-8000-000000000005'::uuid,
    '54500000-0000-4000-8000-000000000010'::uuid, 'a4500000-0000-4000-8000-000000000307'::uuid),
  ('74500000-0000-4000-8000-000000000308'::uuid, '64500000-0000-4000-8000-000000000009'::uuid,
    '54500000-0000-4000-8000-000000000010'::uuid, 'a4500000-0000-4000-8000-000000000308'::uuid)
) as assignment(role_assignment_id, role_id, account_id, correlation_id);

-- ============================================================================
-- Pre-existing direct shares: ADMIN's earlier grants to GRANTOR, each
-- narrowing chain_read/chain_update's own field policy to this fixture's own
-- ceiling for that exact record. This *is* the grantor's current
-- readable/changeable authority the protected functions must re-derive.
--   RECORD_A: readable F1,F2; changeable none      (read-only authority)
--   RECORD_B: readable F1,F2; changeable F1         (partial update authority)
--   RECORD_E: readable F1;    changeable none       (read-only, for revoke-
--             after-narrowing)
-- RECORD_F below is the same shape as RECORD_B, but granted to NO_SHARE_
-- GRANTOR instead of GRANTOR -- full read/update authority with no chain_
-- share assignment at all.
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
  '24500000-0000-4000-8000-000000000001', share.direct_share_id,
  'application_contained', '34500000-0000-4000-8000-000000000001',
  '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
  'b4500000-0000-4000-8000-000000000001', share.record_id,
  'organization_account', '54500000-0000-4000-8000-000000000001', null,
  share.readable_field_ids, share.changeable_field_ids,
  op.now - interval '1 minute', op.now + interval '4 hours',
  'active', 1, '54500000-0000-4000-8000-000000000004', op.now,
  share.correlation_id, share.reason, op.now
from (select pg_catalog.clock_timestamp() as now) as op
cross join (values
  ('74500000-0000-4000-8000-000000000011'::uuid, 'e4500000-0000-4000-8000-000000000001'::uuid,
    array['b4500000-0000-4000-8000-000000000101','b4500000-0000-4000-8000-000000000102']::uuid[],
    array[]::uuid[],
    'a4500000-0000-4000-8000-000000000061'::uuid, 'Admin grant to grantor on record A'),
  ('74500000-0000-4000-8000-000000000012'::uuid, 'e4500000-0000-4000-8000-000000000002'::uuid,
    array['b4500000-0000-4000-8000-000000000101','b4500000-0000-4000-8000-000000000102']::uuid[],
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'a4500000-0000-4000-8000-000000000062'::uuid, 'Admin grant to grantor on record B'),
  ('74500000-0000-4000-8000-000000000015'::uuid, 'e4500000-0000-4000-8000-000000000005'::uuid,
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    array[]::uuid[],
    'a4500000-0000-4000-8000-000000000065'::uuid, 'Admin grant to grantor on record E')
) as share(
  direct_share_id, record_id, readable_field_ids, changeable_field_ids,
  correlation_id, reason
);

-- ADMIN's grant to NO_SHARE_GRANTOR on RECORD_F: the same readable F1,F2 /
-- changeable F1 shape as RECORD_B, but this recipient never holds chain_share
-- -- F1's regression fixture (full read/update authority is not, by itself,
-- share authority).
insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '24500000-0000-4000-8000-000000000001', '74500000-0000-4000-8000-000000000016',
  'application_contained', '34500000-0000-4000-8000-000000000001',
  '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
  'b4500000-0000-4000-8000-000000000001', 'e4500000-0000-4000-8000-000000000006',
  'organization_account', '54500000-0000-4000-8000-000000000006', null,
  array['b4500000-0000-4000-8000-000000000101','b4500000-0000-4000-8000-000000000102']::uuid[],
  array['b4500000-0000-4000-8000-000000000101']::uuid[],
  op.now - interval '1 minute', op.now + interval '4 hours',
  'active', 1, '54500000-0000-4000-8000-000000000004', op.now,
  'a4500000-0000-4000-8000-000000000066', 'Admin grant to no-share account on record F',
  op.now
from (select pg_catalog.clock_timestamp() as now) as op;

-- ============================================================================
-- Real content rows. e...0001/0002/0005/0006/0007 are slice 3/4's own
-- existing record ids -- every share above and below targets a real,
-- active, ADMIN-owned row now, where before slice 5 it targeted no row at
-- all. Everything from e...0020 on is slice 5's own: a relationship-source
-- pair, one plain ownership pair, one condition-true/condition-false pair,
-- one soft-deleted row and one disagreement-test row. e...0099 is
-- deliberately never inserted.
-- ============================================================================

insert into vortex_access.test_share_rows (
  organization_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, owner_organization_account_id,
  lifecycle_state, f1, f2, f3, f_flag, f_source_link
)
values
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000004', 'active', 'open-1', 'open-2', 'open-3', false, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000002', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000004', 'active', 'open-1', 'open-2', 'open-3', false, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000005', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000004', 'active', 'open-1', 'open-2', 'open-3', false, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000006', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000004', 'active', 'open-1', 'open-2', 'open-3', false, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000007', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000004', 'active', 'open-1', 'open-2', 'open-3', false, null),
  -- Relationship source (owned by RELATIONSHIP_GRANTOR) and target (owned by
  -- ADMIN, never RELATIONSHIP_GRANTOR): the target is reachable only through
  -- the edge the source declares below.
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000021', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000004', 'active', 'open-21', 'open-22', 'open-23', false, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000020', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000009', 'active', 'open-20', 'open-20', 'open-20', false,
    'e4500000-0000-4000-8000-000000000021'),
  -- Plain ownership: read-only and changeable proofs.
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000030', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000008', 'active', 'open-30', 'open-30', 'open-30', false, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000031', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000008', 'active', 'open-31', 'open-31', 'open-31', false, null),
  -- Condition-true / condition-false, both owned by CONDITION_GRANTOR.
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000040', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000010', 'active', 'open-40', 'open-40', 'open-40', true, null),
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000041', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000010', 'active', 'open-41', 'open-41', 'open-41', false, null),
  -- Soft-deleted, owned by OWNER_GRANTOR -- without the lifecycle check this
  -- would otherwise admit through the ownership route.
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000050', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000008', 'soft_deleted', 'open-50', 'open-50', 'open-50', false, null),
  -- Disagreement-test row, owned by OWNER_GRANTOR.
  ('24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000060', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000008', 'active', 'open-60', 'open-60', 'open-60', false, null);

-- Establishes the real session request context the protected functions
-- sample via validated_human_request_context(). Callable repeatedly to
-- switch the acting account between cases.
-- p_stale installs an accessVersion one behind the live value -- always
-- stale, since validated_human_request_context() requires an exact match --
-- to prove a stale Access version refuses both the grant and the revocation.
-- p_delegated adds a structurally valid delegatedContext, which the shared
-- eligibility core refuses outright for any record-permission declaration
-- (supportContext is refused by the identical check; only one is exercised
-- below since both share the one code path) -- to prove a delegated or
-- support context cannot revoke.
-- p_application_root_id defaults to this fixture's one home application;
-- the F1 (slice 7) boundary cases below pass the foreign application root
-- instead, to prove an organisation_shared share revokes from any
-- application while an application_contained one does not.
create function pg_temp.install_request_context(
  p_account_id uuid,
  p_stale boolean default false,
  p_delegated boolean default false,
  p_application_root_id uuid default '34500000-0000-4000-8000-000000000001'
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
  acting_identity_id uuid;
  context_value jsonb;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24500000-0000-4000-8000-000000000001';

  select account.identity_id into strict acting_identity_id
  from vortex_identity.organization_accounts as account
  where account.organization_id = '24500000-0000-4000-8000-000000000001'
    and account.organization_account_id = p_account_id;

  context_value := pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'a4500000-0000-4000-8000-000000000091',
    'tenantId', '14500000-0000-4000-8000-000000000001',
    'organizationId', '24500000-0000-4000-8000-000000000001',
    'organizationAccountId', p_account_id,
    'identityId', acting_identity_id,
    'applicationRootId', p_application_root_id,
    'sessionId', 'a4500000-0000-4000-8000-000000000092',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '2 hours',
    'accessVersion',
      case when p_stale then current_access_version - 1 else current_access_version end,
    'correlationId', 'a4500000-0000-4000-8000-000000000093',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  );

  if p_delegated then
    context_value := context_value || pg_catalog.jsonb_build_object(
      'delegatedContext', pg_catalog.jsonb_build_object(
        'delegatedByOrganizationAccountId', '54500000-0000-4000-8000-000000000004',
        'reason', 'Support-assisted action while the true grantor is unavailable',
        'expiresAt', operation_at + interval '1 hour'
      )
    );
  end if;

  perform vortex_context.initialize(context_value);
end
$function$;

-- Test-only pgTAP visibility while vortex_request is active, following
-- supabase/tests/445's own pattern.
grant usage on schema extensions to vortex_request;

-- Cross-statement checkpoints for the "writes nothing, including no Access
-- version change" proofs below -- an absolute version number would depend on
-- the exact order of every earlier case in this file; comparing against a
-- value captured immediately before the refused attempt does not.
create temporary table share_test_checkpoint (
  checkpoint_key text primary key,
  access_version bigint not null
) on commit drop;

-- ============================================================================
-- Two fixed adapters (slice 5, revoke's simplified in slice 6). Both
-- security definer, owner postgres, empty search path, never granted to
-- vortex_request directly. The grant adapter resolves its own installed
-- binding (hardcoded, exactly as 430/445's own adapters), reads the real
-- row(s) from test_share_rows, loads the real self-relationship edge when
-- one exists, and calls the protected grant operation below -- never a
-- decision, a permission, a field set or the record's binding from its own
-- caller; its caller supplies only the target record id and the share's own
-- terms (recipient, fields, window, reason, activity). The revoke adapter
-- (N1) resolves and loads nothing at all -- revocation's authority check no
-- longer needs a row -- and is a pure pass-through; its caller supplies
-- only the share id, expected revision, reason and activity, exactly the
-- same public shape the protected revoke function had before slice 5.
-- ============================================================================

create function vortex_access.test_share_grant(
  p_direct_share_id uuid,
  p_record_id uuid,
  p_recipient_kind text,
  p_organization_account_id uuid,
  p_group_id uuid,
  p_readable_field_ids uuid[],
  p_changeable_field_ids uuid[],
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_reason text,
  p_activity_source text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  module_id constant uuid := '34500000-0000-4000-8000-000000000002';
  type_id constant uuid := 'd4500000-0000-4000-8000-000000000001';
  contract_id constant uuid := 'b4500000-0000-4000-8000-000000000001';
  r1_id constant uuid := 'f4500000-0000-4000-8000-000000000001';
  condition_id constant uuid := 'b4500000-0000-4000-8000-000000000401';
  f1_id constant uuid := 'b4500000-0000-4000-8000-000000000101';
  f2_id constant uuid := 'b4500000-0000-4000-8000-000000000102';
  f3_id constant uuid := 'b4500000-0000-4000-8000-000000000103';
  f_flag_id constant uuid := 'b4500000-0000-4000-8000-000000000104';
  ctx_org uuid := vortex_context.organization_id();
  target_row vortex_access.test_share_rows;
  source_row vortex_access.test_share_rows;
  target_records jsonb := '[]'::jsonb;
  source_records jsonb := '[]'::jsonb;
  edges jsonb := '[]'::jsonb;
  facts jsonb;
begin
  select * into target_row from vortex_access.test_share_rows
  where organization_id = ctx_org and record_id = p_record_id;
  if found then
    target_records := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', target_row.organization_id,
        'moduleRootId', module_id, 'recordTypeId', type_id,
        'storageContractId', contract_id,
        'recordId', target_row.record_id,
        'applicationRootId', target_row.application_root_id
      ),
      'ownerOrganizationAccountId', target_row.owner_organization_account_id,
      'lifecycleState', target_row.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(
        f1_id::text, target_row.f1, f2_id::text, target_row.f2,
        f3_id::text, target_row.f3, f_flag_id::text, target_row.f_flag
      )
    ));
  end if;

  -- Every row that names this target as its own f_source_link is that
  -- target's relationship source under R1 -- both a fact record and an
  -- edge, exactly as 430's own alpha/beta adapter loads a related table.
  for source_row in
    select * from vortex_access.test_share_rows
    where organization_id = ctx_org and f_source_link = p_record_id
  loop
    source_records := source_records || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', source_row.organization_id,
        'moduleRootId', module_id, 'recordTypeId', type_id,
        'storageContractId', contract_id,
        'recordId', source_row.record_id,
        'applicationRootId', source_row.application_root_id
      ),
      'ownerOrganizationAccountId', source_row.owner_organization_account_id,
      'lifecycleState', source_row.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(
        f1_id::text, source_row.f1, f2_id::text, source_row.f2,
        f3_id::text, source_row.f3, f_flag_id::text, source_row.f_flag
      )
    ));
    edges := edges || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', r1_id, 'fromRecordId', source_row.record_id, 'toRecordId', p_record_id
    ));
  end loop;

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
        pg_catalog.jsonb_build_object('fieldId', f1_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f2_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f3_id, 'type', 'text'),
        pg_catalog.jsonb_build_object('fieldId', f_flag_id, 'type', 'yes_no')
      )
    )),
    'relationships', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', r1_id, 'fromModuleRootId', module_id, 'fromRecordTypeId', type_id,
      'toModuleRootId', module_id, 'toRecordTypeId', type_id
    )),
    'sharingConditions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'conditionId', condition_id, 'sourceRecordTypeId', type_id,
      'publishedRevision', 1,
      'contractFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
      'parameters', '[]'::jsonb,
      'condition', pg_catalog.jsonb_build_object(
        'kind', 'comparison', 'operator', 'equals',
        'left', pg_catalog.jsonb_build_object('source', 'field', 'fieldId', f_flag_id),
        'right', pg_catalog.jsonb_build_object('source', 'value', 'value', true)
      ),
      'declaredFieldIds', pg_catalog.jsonb_build_array(f_flag_id)
    )),
    'records', target_records || source_records,
    'edges', edges
  );

  return vortex_access.grant_record_share_for_administration(
    p_direct_share_id, p_record_id, p_recipient_kind, p_organization_account_id,
    p_group_id, p_readable_field_ids, p_changeable_field_ids, p_starts_at,
    p_expires_at, p_reason, p_activity_source, p_activity_id, facts
  );
end
$function$;

revoke execute on function vortex_access.test_share_grant(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_share_grant(
  uuid, uuid, text, uuid, uuid, uuid[], uuid[], timestamptz, timestamptz, text, text, uuid
) to vortex_request;

create function vortex_access.test_share_revoke(
  p_direct_share_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_source text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- N1 (slice 6): revocation no longer needs the share's target row at all
  -- -- its authority check is the pre-row record.share eligibility check,
  -- not the complete record decision -- so this adapter has nothing left to
  -- resolve or load. It stays a fixed, owner-held pass-through rather than
  -- being granted directly to vortex_request, for the same boundary reason
  -- every other adapter in this fixture does.
  return vortex_access.revoke_record_share_for_administration(
    p_direct_share_id, p_expected_revision, p_reason, p_activity_source, p_activity_id
  );
end
$function$;

revoke execute on function vortex_access.test_share_revoke(uuid, bigint, text, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_share_revoke(uuid, bigint, text, text, uuid)
  to vortex_request;

-- ============================================================================
-- GRANT: happy path. GRANTOR's current authority on RECORD_A is read-only
-- (F1, F2; no changeable field). Sharing exactly one readable field with no
-- changeable field succeeds and is a real, minimal exercise of "read-only
-- sharing requires current read authority but not update authority".
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;

select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000101',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Read-only re-share of record A',
    'web', 'a4500000-0000-4000-8000-000000000201')$$,
  'a grantor may re-share a subset of their own current readable fields with no changeable fields proposed'
);

reset role;

select is(
  (select pg_catalog.jsonb_build_object(
    'state', state, 'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000101'),
  pg_catalog.jsonb_build_object(
    'state', 'active',
    'readable', array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'changeable', array[]::uuid[]
  ),
  'the stored share carries exactly the proposed subset, not the grantor''s whole ceiling'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and action = 'grant_direct_record_share'
     and subject_ids = array['94500000-0000-4000-8000-000000000101']::uuid[]),
  1::bigint,
  'exactly one Activity row records the grant -- the existing writer''s own append, not a second one'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '24500000-0000-4000-8000-000000000001'),
  3::bigint,
  'exactly one Access version change results from this grant on top of platform-catalogue initialisation'
);

-- ============================================================================
-- GRANT: refusals that must write nothing. Each attempted direct_share_id is
-- fresh, so a surviving row of that id would itself prove a wrongful write.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000102',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000103']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Field the grantor cannot currently read',
    'web', 'a4500000-0000-4000-8000-000000000202')$$,
  '42501', 'Protected record-share grant exceeds current read authority',
  'proposing a readable field (F3) the grantor cannot currently read is refused'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000102'),
  0::bigint,
  'the unreadable-field refusal writes nothing'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000103',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    pg_catalog.clock_timestamp(), null, 'Field grantor can read but not change on record A',
    'web', 'a4500000-0000-4000-8000-000000000203')$$,
  '42501', 'Protected record-share grant exceeds current update authority',
  'proposing a changeable field (F1) the grantor can read but not change is refused'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000103'),
  0::bigint,
  'the ungranted-changeable-authority refusal writes nothing'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000104',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array[]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Zero readable fields',
    'web', 'a4500000-0000-4000-8000-000000000204')$$,
  '22023', 'Protected record-share grant input is invalid',
  'a share proposing zero readable fields is refused structurally'
);
reset role;

-- ============================================================================
-- GRANT: recipient validation. A recipient in another organisation, an
-- unknown recipient and a Group from another organisation each refuse --
-- along with a retired Group in the grantor's own organisation.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000105',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000005', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign organisation recipient',
    'web', 'a4500000-0000-4000-8000-000000000205')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'a recipient account in another organisation is refused'
);
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000106',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    'f4500000-0000-4000-8000-000000000999', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Unknown recipient',
    'web', 'a4500000-0000-4000-8000-000000000206')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'an unknown recipient account id is refused'
);
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000107',
    'e4500000-0000-4000-8000-000000000001', 'group', null,
    '84500000-0000-4000-8000-000000000002',
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign organisation Group recipient',
    'web', 'a4500000-0000-4000-8000-000000000207')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'a Group in another organisation is refused'
);
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000108',
    'e4500000-0000-4000-8000-000000000001', 'group', null,
    '84500000-0000-4000-8000-000000000003',
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Retired Group recipient',
    'web', 'a4500000-0000-4000-8000-000000000208')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'a retired Group in the grantor''s own organisation is refused'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id in (
       '94500000-0000-4000-8000-000000000105', '94500000-0000-4000-8000-000000000106',
       '94500000-0000-4000-8000-000000000107', '94500000-0000-4000-8000-000000000108'
     )),
  0::bigint,
  'no refused recipient case writes a share row'
);

-- ============================================================================
-- GRANT: changeable fields, using RECORD_B where the grantor's current
-- authority is readable F1,F2 / changeable F1.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000109',
    'e4500000-0000-4000-8000-000000000002', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    pg_catalog.clock_timestamp(), null, 'Changeable re-share of record B',
    'web', 'a4500000-0000-4000-8000-000000000209')$$,
  'a changeable field within the grantor''s own current changeable set succeeds'
);
reset role;
select is(
  (select pg_catalog.jsonb_build_object(
    'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000109'),
  pg_catalog.jsonb_build_object(
    'readable', array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'changeable', array['b4500000-0000-4000-8000-000000000101']::uuid[]
  ),
  'the stored share carries exactly the proposed readable and changeable fields'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000110',
    'e4500000-0000-4000-8000-000000000002', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000102']::uuid[],
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    pg_catalog.clock_timestamp(), null, 'Changeable field outside proposed readable set',
    'web', 'a4500000-0000-4000-8000-000000000210')$$,
  '22023', 'Protected record-share grant input is invalid',
  'a changeable field (F1) not inside the proposed readable set (F2) is refused structurally, even though the grantor may currently change F1 on this record'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000110'),
  0::bigint,
  'the changeable-outside-readable refusal writes nothing'
);

-- ============================================================================
-- GRANT: after the grantor's own source access is withdrawn, they can no
-- longer create a new share -- but the share they created earlier (while
-- they still held access) keeps functioning for its recipient. Revocation
-- of the grantor's own upstream share is a separate act from anything this
-- migration owns, so it is exercised directly through the existing private
-- writer, exactly as this fixture's own setup already does.
-- ============================================================================

select lives_ok(
  $$select * from vortex_access.revoke_organization_direct_record_share(
    '24500000-0000-4000-8000-000000000001', '74500000-0000-4000-8000-000000000011',
    1, 'Admin withdraws grantor''s own access to record A',
    '54500000-0000-4000-8000-000000000004', 'a4500000-0000-4000-8000-000000000211',
    'web', 'a4500000-0000-4000-8000-000000000212')$$,
  'the grantor''s own upstream share on record A can be withdrawn directly through the existing writer'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000111',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Attempted re-share after source access withdrawn',
    'web', 'a4500000-0000-4000-8000-000000000213')$$,
  '42501', 'Protected record-share grant requires a current read permission',
  'once the grantor''s own source access to a record is withdrawn, they hold no current read authority on it at all, so the refusal names that -- not an exceeded ceiling -- and they can no longer create a new share on it'
);
reset role;

select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000101'),
  'active',
  'the share the grantor created earlier, while they still held access, remains active -- revocation is a separate act'
);
select is(
  (select pg_catalog.count(*) from vortex_access.read_current_direct_record_share_contributions(
    '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
    'b4500000-0000-4000-8000-000000000001', 'application_contained',
    'e4500000-0000-4000-8000-000000000001',
    '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000002', pg_catalog.clock_timestamp()
  )),
  1::bigint,
  'the earlier share still contributes to the recipient''s own current projection of record A'
);

-- ============================================================================
-- REVOKE: correct expected revision succeeds; a stale expected revision
-- refuses; a revoked share contributes nothing to the recipient's next
-- projection. RECORD_E: grantor's own current authority is readable F1 only.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000112',
    'e4500000-0000-4000-8000-000000000005', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Share of record E to revoke',
    'web', 'a4500000-0000-4000-8000-000000000214')$$,
  'the grantor creates a share on record E to exercise revocation against'
);
reset role;

-- The grant above just changed Access; refresh the grantor's own session
-- context before the next protected call, exactly as every other case does.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000112', 2,
    'Stale revocation attempt', 'web', 'a4500000-0000-4000-8000-000000000215')$$,
  '40001', 'Direct record-share revocation is stale or unavailable',
  'a stale expected revision refuses revocation'
);
select lives_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000112', 1,
    'Correct revocation', 'web', 'a4500000-0000-4000-8000-000000000216')$$,
  'revocation with the correct expected revision succeeds'
);
reset role;

select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000112'),
  'revoked',
  'the share is now revoked'
);
select is(
  (select pg_catalog.count(*) from vortex_access.read_current_direct_record_share_contributions(
    '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
    'b4500000-0000-4000-8000-000000000001', 'application_contained',
    'e4500000-0000-4000-8000-000000000005',
    '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000002', pg_catalog.clock_timestamp()
  )),
  0::bigint,
  'the revoked share contributes nothing to the recipient''s projection on the next request'
);

-- ============================================================================
-- REVOKE: succeeds even where the grantor's own field ceiling has since
-- narrowed. Reuses the record B share created earlier (readable F1,
-- changeable F1); the grantor's own source access to record B is withdrawn
-- first, narrowing their ceiling to nothing, yet they can still revoke the
-- share they created while they held it.
-- ============================================================================

select lives_ok(
  $$select * from vortex_access.revoke_organization_direct_record_share(
    '24500000-0000-4000-8000-000000000001', '74500000-0000-4000-8000-000000000012',
    1, 'Admin withdraws grantor''s own access to record B',
    '54500000-0000-4000-8000-000000000004', 'a4500000-0000-4000-8000-000000000217',
    'web', 'a4500000-0000-4000-8000-000000000218')$$,
  'the grantor''s own upstream share on record B can be withdrawn directly through the existing writer'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000109', 1,
    'Revoke record B share after source access narrowed',
    'web', 'a4500000-0000-4000-8000-000000000219')$$,
  'revocation succeeds even though the grantor''s own current field ceiling on record B has since narrowed to nothing'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000109'),
  'revoked',
  'the record B share the grantor created is now revoked'
);

-- ============================================================================
-- REVOKE: current authority over the share means its own grantor -- the
-- recipient of a share, who holds no authority over the share itself, may
-- not revoke it merely by having received it.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000002');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000101', 1,
    'Recipient attempts to revoke their own received share',
    'web', 'a4500000-0000-4000-8000-000000000220')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'the share''s recipient, who is not its grantor, cannot revoke it'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000101'),
  'active',
  'the share remains active after the recipient''s refused revocation attempt'
);

-- ============================================================================
-- GRANT: F1's regression -- a grantor who currently holds read and update
-- authority for a record, but no current record.share permission at all, is
-- refused before any ceiling comparison, and nothing is written. The message
-- is distinct from every "exceeds current read/update authority" refusal
-- above: this grantor is never even measured against a ceiling, because they
-- never clear the share gate in the first place. NO_SHARE_GRANTOR holds
-- chain_read and chain_update on record F (readable F1,F2; changeable F1 --
-- full update authority) but was never assigned chain_share.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000006');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000113',
    'e4500000-0000-4000-8000-000000000006', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'No-share grantor attempts to re-share record F',
    'web', 'a4500000-0000-4000-8000-000000000221')$$,
  '42501', 'Protected record-share grant requires a current share permission',
  'a grantor holding current read and update authority but no share permission is refused, naming the missing permission rather than an exceeded ceiling'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000113'),
  0::bigint,
  'the missing-share-permission refusal writes nothing'
);

-- ============================================================================
-- GRANT: an all_records-routed grantor succeeds, proving the second route
-- the migration admits for the read/update ceiling -- chain_read's own
-- direct_share route is already proven throughout every case above.
-- ALL_RECORDS_GRANTOR holds chain_share and chain_read_all, both
-- all_records-routed, and no direct_share row of its own anywhere in this
-- fixture: record G is reached purely through the all_records route.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000007');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000114',
    'e4500000-0000-4000-8000-000000000007', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'All-records-routed grantor shares record G',
    'web', 'a4500000-0000-4000-8000-000000000222')$$,
  'a grantor whose share and read authority are both all_records-routed, with no direct_share row at all, succeeds'
);
reset role;
select is(
  (select pg_catalog.jsonb_build_object(
    'state', state, 'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000114'),
  pg_catalog.jsonb_build_object(
    'state', 'active',
    'readable', array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'changeable', array[]::uuid[]
  ),
  'the all_records-routed grant stores exactly the proposed subset'
);

-- ============================================================================
-- REVOKE: F4 -- a delegated (or, identically, support) context cannot
-- revoke, even for the account that would otherwise currently hold
-- record.share authority. The shared eligibility core refuses any
-- record-permission declaration outright once delegatedContext or
-- supportContext is present; this is that refusal exercised through the
-- revoke path, not the old (and wrong) identity comparison. Both keys are
-- refused by the identical check, so only delegatedContext is exercised here.
-- ============================================================================

select pg_temp.install_request_context(
  '54500000-0000-4000-8000-000000000001', false, true
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000101', 1,
    'Delegated context attempts revocation', 'web',
    'a4500000-0000-4000-8000-000000000223')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'a delegated context cannot revoke, even for an account that otherwise currently holds record.share'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000101'),
  'active',
  'the share remains active after the delegated context''s refused revocation attempt'
);

-- ============================================================================
-- GRANT and REVOKE: a stale Access version refuses both, before any
-- authority is even evaluated -- validated_human_request_context() itself
-- requires an exact match against the live Access version.
-- ============================================================================

select pg_temp.install_request_context(
  '54500000-0000-4000-8000-000000000001', true
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000115',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Stale-context grant attempt',
    'web', 'a4500000-0000-4000-8000-000000000224')$$,
  '42501', 'Request access version is stale or unavailable',
  'a stale Access version refuses the grant before any authority is evaluated'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000115'),
  0::bigint,
  'the stale-context grant refusal writes nothing'
);

select pg_temp.install_request_context(
  '54500000-0000-4000-8000-000000000001', true
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000101', 1,
    'Stale-context revocation attempt', 'web',
    'a4500000-0000-4000-8000-000000000225')$$,
  '42501', 'Request access version is stale or unavailable',
  'a stale Access version refuses the revocation the same way'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000101'),
  'active',
  'the share remains active after the stale-context revocation attempt'
);

-- ============================================================================
-- GRANT (slice 5): an ownership-routed grantor shares successfully -- the
-- case this whole slice exists for. OWNER_GRANTOR owns OWNERSHIP_RECORD
-- directly: no direct share, no all_records permission, nothing but
-- owned_read/owned_share, both ownership-routed and both evaluated against
-- the record's real owner column for the first time.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000301',
    'e4500000-0000-4000-8000-000000000030', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Ownership-routed share',
    'web', 'a4500000-0000-4000-8000-000000000401')$$,
  'an ownership-routed grantor -- owning the record directly, with no direct share and no all_records permission -- shares successfully'
);
reset role;
select is(
  (select pg_catalog.jsonb_build_object(
    'state', state, 'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000301'),
  pg_catalog.jsonb_build_object(
    'state', 'active',
    'readable', array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'changeable', array[]::uuid[]
  ),
  'the ownership-routed grant stores exactly the proposed subset'
);

-- The same ownership route also carries a changeable field -- the field
-- ceiling is derived from ownership too, not only from direct_share.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000302',
    'e4500000-0000-4000-8000-000000000031', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    array['b4500000-0000-4000-8000-000000000101']::uuid[],
    pg_catalog.clock_timestamp(), null, 'Ownership-routed changeable share',
    'web', 'a4500000-0000-4000-8000-000000000402')$$,
  'an ownership-routed grantor can also share a changeable field, proving the update ceiling is derived from ownership too'
);
reset role;
select is(
  (select pg_catalog.jsonb_build_object(
    'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000302'),
  pg_catalog.jsonb_build_object(
    'readable', array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'changeable', array['b4500000-0000-4000-8000-000000000101']::uuid[]
  ),
  'the ownership-routed changeable grant stores exactly the proposed readable and changeable fields'
);

-- ============================================================================
-- GRANT (slice 5): a relationship-routed grantor shares successfully.
-- RELATIONSHIP_GRANTOR owns the source record (e...020) directly and holds
-- owned_read (eligibility and ownership for that source permission) plus
-- owned_share_relationship, routed through R1 (source->target self edge) to
-- the target (e...021), which RELATIONSHIP_GRANTOR does not own -- ADMIN
-- does. Their read ceiling on the target comes from chain_read_all
-- (all_records), already proven independently by ALL_RECORDS_GRANTOR above;
-- what is new here is that the share permission itself is relationship-
-- routed and is evaluated rather than excluded.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000009');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000303',
    'e4500000-0000-4000-8000-000000000021', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Relationship-routed share',
    'web', 'a4500000-0000-4000-8000-000000000403')$$,
  'a relationship-routed grantor -- reaching the target only through an edge from a record they own -- shares successfully'
);
reset role;
select is(
  (select pg_catalog.jsonb_build_object(
    'state', state, 'readable', readable_field_ids, 'changeable', changeable_field_ids
  ) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000303'),
  pg_catalog.jsonb_build_object(
    'state', 'active',
    'readable', array['b4500000-0000-4000-8000-000000000101']::uuid[],
    'changeable', array[]::uuid[]
  ),
  'the relationship-routed grant stores exactly the proposed subset'
);

-- ============================================================================
-- GRANT (slice 5): a condition-scoped share permission is evaluated, not
-- excluded. CONDITION_GRANTOR owns both records and holds the identical
-- owned_share_conditional permission over both; only the record's own
-- F_FLAG value differs. The outcome tracking that value -- not a constant
-- refusal or a constant admission -- is what "evaluated rather than
-- excluded" means.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000010');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000304',
    'e4500000-0000-4000-8000-000000000040', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Condition-true share',
    'web', 'a4500000-0000-4000-8000-000000000404')$$,
  'a condition-scoped share permission admits when the saved condition currently evaluates true against the record''s real field value'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000304'),
  'active',
  'the condition-true grant is stored active'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000010');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000305',
    'e4500000-0000-4000-8000-000000000041', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Condition-false share',
    'web', 'a4500000-0000-4000-8000-000000000405')$$,
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'the same condition-scoped share permission refuses when the saved condition currently evaluates false against a different record -- proving it is evaluated, not excluded or constantly admitted -- and the refusal names the target, since CONDITION_GRANTOR does hold an eligible share permission in general'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000305'),
  0::bigint,
  'the condition-false refusal writes nothing'
);

-- ============================================================================
-- GRANT (slice 5): a record that exists in no table refuses, and writes no
-- share row, no Activity entry and no Access version change.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
insert into share_test_checkpoint (checkpoint_key, access_version)
select 'nonexistent_record', current_version from vortex_access.organization_access_versions
where organization_id = '24500000-0000-4000-8000-000000000001';
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000306',
    'e4500000-0000-4000-8000-000000000099', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Nonexistent record',
    'web', 'a4500000-0000-4000-8000-000000000406')$$,
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'sharing a record that exists in no content table refuses, naming the target rather than the permission -- OWNER_GRANTOR does hold a current, eligible share permission in general'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000306'),
  0::bigint,
  'sharing a nonexistent record writes no share row'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and action = 'grant_direct_record_share'
     and subject_ids = array['94500000-0000-4000-8000-000000000306']::uuid[]),
  0::bigint,
  'sharing a nonexistent record writes no Activity entry'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '24500000-0000-4000-8000-000000000001'),
  (select access_version from share_test_checkpoint where checkpoint_key = 'nonexistent_record'),
  'sharing a nonexistent record causes no Access version change'
);

-- ============================================================================
-- GRANT (slice 5): a soft-deleted record refuses the same way, and writes
-- the same nothing. SOFT_DELETED_RECORD is owned by OWNER_GRANTOR -- the
-- very account attempting to share it, and the same account whose ownership
-- route already succeeded twice above -- so this failure is attributable to
-- the record's lifecycle state alone, not to a missing owner.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
insert into share_test_checkpoint (checkpoint_key, access_version)
select 'soft_deleted_record', current_version from vortex_access.organization_access_versions
where organization_id = '24500000-0000-4000-8000-000000000001';
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000307',
    'e4500000-0000-4000-8000-000000000050', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Soft-deleted record',
    'web', 'a4500000-0000-4000-8000-000000000407')$$,
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'sharing a soft-deleted record -- owned by the very grantor attempting to share it -- refuses, naming the target rather than the permission'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000307'),
  0::bigint,
  'sharing a soft-deleted record writes no share row'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and action = 'grant_direct_record_share'
     and subject_ids = array['94500000-0000-4000-8000-000000000307']::uuid[]),
  0::bigint,
  'sharing a soft-deleted record writes no Activity entry'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '24500000-0000-4000-8000-000000000001'),
  (select access_version from share_test_checkpoint where checkpoint_key = 'soft_deleted_record'),
  'sharing a soft-deleted record causes no Access version change'
);

-- ============================================================================
-- GRANT (slice 5): a facts payload whose top-level binding names a module
-- root and storage contract that disagree with the target record's own
-- real, resolved scope cannot reach the persisted share row. Called
-- directly against the protected function -- not through the adapter, and
-- not as vortex_request -- because the adapter never accepts a module root
-- or storage contract from its own caller at all (it resolves both itself,
-- as the boundary assertions below confirm); this instead proves the
-- protected function's own defence, the record decision's target-row check,
-- refuses a facts object that disagrees with itself rather than trusting
-- whichever binding a caller names.
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
select throws_ok(
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000308',
    'e4500000-0000-4000-8000-000000000060', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Disagreeing binding',
    'web', 'a4500000-0000-4000-8000-000000000408',
    pg_catalog.jsonb_build_object(
      'binding', pg_catalog.jsonb_build_object(
        'moduleRootId', '34500000-0000-4000-8000-000000000099',
        'recordTypeId', 'd4500000-0000-4000-8000-000000000001',
        'storageContractId', 'b4500000-0000-4000-8000-000000000099',
        'storageScope', 'application_contained'
      ),
      'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'moduleRootId', '34500000-0000-4000-8000-000000000099',
        'recordTypeId', 'd4500000-0000-4000-8000-000000000001',
        'storageContractId', 'b4500000-0000-4000-8000-000000000099',
        'storageScope', 'application_contained',
        'ownershipMode', 'organization_account', 'fields', '[]'::jsonb
      )),
      'relationships', '[]'::jsonb,
      'sharingConditions', '[]'::jsonb,
      'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordScope', pg_catalog.jsonb_build_object(
          'storageScope', 'application_contained',
          'organizationId', '24500000-0000-4000-8000-000000000001',
          'moduleRootId', '34500000-0000-4000-8000-000000000002',
          'recordTypeId', 'd4500000-0000-4000-8000-000000000001',
          'storageContractId', 'b4500000-0000-4000-8000-000000000001',
          'recordId', 'e4500000-0000-4000-8000-000000000060',
          'applicationRootId', '34500000-0000-4000-8000-000000000001'
        ),
        'ownerOrganizationAccountId', '54500000-0000-4000-8000-000000000008',
        'lifecycleState', 'active',
        'fieldValues', '{}'::jsonb
      )),
      'edges', '[]'::jsonb
    ))$$,
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'a facts payload whose top-level binding names a different module root and storage contract than the target record''s own real, resolved scope refuses -- the disagreeing values never reach the persisted row, and the refusal names the target rather than the permission'
);
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000308'),
  0::bigint,
  'the disagreeing-binding refusal writes nothing'
);

-- ============================================================================
-- GRANT (slice 6, N2 -- pinned, not fixed). OWNER_GRANTOR also holds
-- owned_share_unrouted: a further 'share'-kind permission, routed through a
-- relationship (f...0099) the fixed adapter's facts never carry, alongside
-- their existing, otherwise-sufficient owned_share (ownership-routed).
-- Because F3 removed the route exclusions, the declaration this migration
-- builds is synthesised from every current 'share'-kind permission on this
-- record type -- not just the one the grantor means to rely on -- and
-- OWNER_GRANTOR is eligible for both, via two independent live standing
-- assignments. Row-scope composition evaluates every eligible alternative's
-- own routes, so the unrouted alternative's own route is evaluated too, and
-- raises before the otherwise-successful ownership route changes anything.
-- Proven against record e...031, which OWNER_GRANTOR already shared
-- successfully earlier above using exactly that ownership route -- nothing
-- about this attempt differs except the additional permission now also
-- held.
-- ============================================================================

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint, record_scope, field_policy
) values (
  '24500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001', 1,
  '34500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001',
  'c4500000-0000-4000-8000-000000000010', 'record_share.owned_share_unrouted',
  'Owned share (unrouted relationship)', 'Record share fixture.',
  'd4500000-0000-4000-8000-000000000001', 'share', null, false,
  'application', 'example.record_share',
  '34500000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('a', 64),
  pg_catalog.jsonb_build_object(
    'routes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', 'relationship',
      'relationshipId', 'f4500000-0000-4000-8000-000000000099',
      'sourcePermissionId', 'c4500000-0000-4000-8000-000000000005'
    ))
  ),
  null
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
  1, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24500000-0000-4000-8000-000000000001'
  and entry.permission_id = 'c4500000-0000-4000-8000-000000000010';

select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000010', 'owned_share_unrouted',
  'c4500000-0000-4000-8000-000000000010'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001', '74500000-0000-4000-8000-000000000501',
  '64500000-0000-4000-8000-000000000010', 'organization_account',
  '54500000-0000-4000-8000-000000000008', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4500000-0000-4000-8000-000000000501', '94500000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 'a4500000-0000-4000-8000-000000000501'
);

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000309',
    'e4500000-0000-4000-8000-000000000031', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null,
    'Grantor also holds a relationship-routed permission the adapter cannot supply',
    'web', 'a4500000-0000-4000-8000-000000000502')$$,
  '22023', 'Record access facts are invalid',
  'a grantor holding an additional relationship-routed share permission whose relationship the adapter does not supply raises, even though their ownership route alone would otherwise succeed -- the declaration is synthesised from the whole catalogue, not authored, so an adapter for this migration must supply the complete relationship graph (N2)'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000309'),
  0::bigint,
  'the pinned facts-insufficiency raise writes nothing'
);

-- ============================================================================
-- REVOKE (slice 6, N1): a soft-deleted record's live share can still be
-- revoked by someone with current record.share authority -- the regression
-- this slice fixes. Reuses OWNER_GRANTOR's own earlier share on OWNERSHIP_
-- RECORD (e...030, share ...301): OWNER_GRANTOR still currently holds
-- owned_share, ownership-routed, whose *eligibility* needs no row at all.
-- A delegated context and the share's own recipient are each still refused
-- while the record is soft-deleted -- proving the fix narrows nothing it
-- should not -- and after the record is restored, the earlier revocation is
-- genuinely permanent rather than silently re-armed.
-- ============================================================================

update vortex_access.test_share_rows
set lifecycle_state = 'soft_deleted'
where organization_id = '24500000-0000-4000-8000-000000000001'
  and record_id = 'e4500000-0000-4000-8000-000000000030';

-- A delegated context is refused exactly as it would be for an active
-- record -- the eligibility core's context check runs before anything else.
select pg_temp.install_request_context(
  '54500000-0000-4000-8000-000000000008', false, true
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000301', 1,
    'Delegated context attempts revocation of a soft-deleted record''s share',
    'web', 'a4500000-0000-4000-8000-000000000511')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'a delegated context still cannot revoke a soft-deleted record''s share'
);
reset role;

-- The share's recipient, who holds no record.share authority at all, is
-- still refused while the record is soft-deleted.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000002');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000301', 1,
    'Recipient attempts to revoke a soft-deleted record''s share',
    'web', 'a4500000-0000-4000-8000-000000000512')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'the recipient still cannot revoke a soft-deleted record''s share'
);
reset role;

select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000301'),
  'active',
  'the share is still active -- neither refused attempt above revoked it'
);

-- OWNER_GRANTOR, who still currently holds owned_share (ownership-routed,
-- whose eligibility needs no row), revokes the share while the record
-- remains soft-deleted. Before this slice, evaluating the complete record
-- decision refused this exact attempt -- the regression -- because the
-- record was not active.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000301', 1,
    'Grantor revokes their own share while the record is soft-deleted',
    'web', 'a4500000-0000-4000-8000-000000000513')$$,
  'a grantor currently holding record.share eligibility may revoke a soft-deleted record''s share -- revocation never depends on the record''s own visibility'
);
reset role;

select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000301'),
  'revoked',
  'the share is now revoked while the record is still soft-deleted'
);

-- Restoring the record does not silently re-arm the revocation: the share
-- stays gone, and contributes nothing to the recipient's next projection.
update vortex_access.test_share_rows
set lifecycle_state = 'active'
where organization_id = '24500000-0000-4000-8000-000000000001'
  and record_id = 'e4500000-0000-4000-8000-000000000030';

select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000301'),
  'revoked',
  'the share remains revoked after the record is restored -- a restore never re-arms a revocation'
);
select is(
  (select pg_catalog.count(*) from vortex_access.read_current_direct_record_share_contributions(
    '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
    'b4500000-0000-4000-8000-000000000001', 'application_contained',
    'e4500000-0000-4000-8000-000000000030',
    '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000002', pg_catalog.clock_timestamp()
  )),
  0::bigint,
  'the revoked share contributes nothing to the recipient''s projection after the record is restored'
);

-- ============================================================================
-- REVOKE (slice 7, F1): the application boundary. Both shares below are
-- seeded directly, exactly as this fixture already seeds ADMIN's own
-- pre-existing shares, because the protected grant path always stamps a new
-- share with the *caller's* current application -- it cannot itself produce
-- a share whose application differs from its own grantor's, which is
-- exactly the shape this boundary case needs to construct. A second
-- application root, home to the same organisation, stands in for #45's real
-- foreign application.
-- ============================================================================

-- Share A: application_contained, stamped with the foreign application, but
-- granted_by GRANTOR -- so identity alone would otherwise admit revocation.
-- granted_at and changed_at must be the identical instant (the insert
-- trigger requires it), so both are the one sampled op.now, exactly as this
-- fixture's own pre-existing-share seed above does.
insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '24500000-0000-4000-8000-000000000001', '94500000-0000-4000-8000-000000000601',
  'application_contained', '34500000-0000-4000-8000-000000000006',
  '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
  'b4500000-0000-4000-8000-000000000001', 'e4500000-0000-4000-8000-000000000001',
  'organization_account', '54500000-0000-4000-8000-000000000002', null,
  array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
  op.now - interval '1 minute', op.now + interval '4 hours',
  'active', 1, '54500000-0000-4000-8000-000000000001', op.now,
  'a4500000-0000-4000-8000-000000000601', 'Share stamped with a foreign application',
  op.now
from (select pg_catalog.clock_timestamp() as now) as op;

-- Share B: organisation_shared, also granted_by GRANTOR, application_root_id
-- null by the table's own shape constraint.
insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '24500000-0000-4000-8000-000000000001', '94500000-0000-4000-8000-000000000602',
  'organization_shared', null,
  '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
  'b4500000-0000-4000-8000-000000000001', 'e4500000-0000-4000-8000-000000000001',
  'organization_account', '54500000-0000-4000-8000-000000000002', null,
  array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
  op.now - interval '1 minute', op.now + interval '4 hours',
  'active', 1, '54500000-0000-4000-8000-000000000001', op.now,
  'a4500000-0000-4000-8000-000000000602', 'Organisation-shared share',
  op.now
from (select pg_catalog.clock_timestamp() as now) as op;

-- GRANTOR, acting in the *home* application (the default), attempts to
-- revoke Share A -- stamped with the foreign application. Identity matches
-- (GRANTOR is the real granted_by), so without the boundary this would
-- admit through the grantor branch; the application mismatch refuses it
-- first.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000601', 1,
    'Home-application grantor attempts to revoke a foreign-application share',
    'web', 'a4500000-0000-4000-8000-000000000603')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'a share stamped with a foreign application cannot be revoked from this application''s context, even by its own real grantor'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000601'),
  'active',
  'the foreign-application share remains active after the refused revocation attempt'
);

-- GRANTOR, now acting in the *foreign* application, revokes Share B --
-- organisation_shared, so the application boundary does not apply, and
-- identity still matches. This is the same account as the case just above;
-- only the acting application and the target share differ.
select pg_temp.install_request_context(
  '54500000-0000-4000-8000-000000000001', false, false,
  '34500000-0000-4000-8000-000000000006'
);
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000602', 1,
    'Foreign-application grantor revokes an organisation-shared share',
    'web', 'a4500000-0000-4000-8000-000000000604')$$,
  'an organisation_shared share can be revoked from a different application context than the one it was granted from'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000602'),
  'revoked',
  'the organisation-shared share is now revoked'
);

-- ============================================================================
-- REVOKE (slice 7, F2): current authority is restricted to a route the
-- eligibility core can resolve without the record row. A fresh grantor,
-- DIRECT_SHARE_GRANTOR, holds a 'share' permission routed direct_share --
-- the one route the grant path already refuses for share actions, so this
-- account could never itself create a share. OWNER_GRANTOR (ownership-routed
-- share authority elsewhere in this fixture) and RELATIONSHIP_GRANTOR
-- (relationship-routed) hold real share authority over *other* records, but
-- not over this one and not through a route revocation admits. All three
-- attempt to revoke a share none of them granted, over a record none of
-- them owns or has any edge to; all three are refused. ALL_RECORDS_GRANTOR,
-- holding chain_share (all_records-routed), then revokes the same share --
-- neither its grantor nor its recipient, and after the record has been
-- soft-deleted -- proving all_records is current authority enough on its
-- own, regardless of the record's lifecycle.
-- ============================================================================

-- DIRECT_SHARE_GRANTOR: a fresh identity and account, holding one
-- direct_share-routed 'share' permission and nothing else. Kept separate
-- from every existing account so its one permission cannot be mistaken for
-- broader authority any of them already holds.
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
)
select '44500000-0000-4000-8000-000000000011', 'active', op.now,
  op.now, '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000610', 1
from (select pg_catalog.clock_timestamp() as now) as op;

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, closed_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
)
select '54500000-0000-4000-8000-000000000011', '24500000-0000-4000-8000-000000000001',
  '44500000-0000-4000-8000-000000000011', 'Direct-share-only grantor account', 'active',
  op.now - interval '1 minute', null, op.now,
  op.now, '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000611', 1
from (select pg_catalog.clock_timestamp() as now) as op;

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint, record_scope, field_policy
) values (
  '24500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001', 1,
  '34500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001',
  'c4500000-0000-4000-8000-000000000011', 'record_share.chain_share_direct',
  'Chain share (direct_share-routed)', 'Record share fixture.',
  'd4500000-0000-4000-8000-000000000001', 'share', null, false,
  'application', 'example.record_share',
  '34500000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('b', 64),
  pg_catalog.jsonb_build_object(
    'routes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', 'direct_share'
    ))
  ),
  null
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
  1, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24500000-0000-4000-8000-000000000001'
  and entry.permission_id = 'c4500000-0000-4000-8000-000000000011';

select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000011', 'chain_share_direct',
  'c4500000-0000-4000-8000-000000000011'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001', '74500000-0000-4000-8000-000000000601',
  '64500000-0000-4000-8000-000000000011', 'organization_account',
  '54500000-0000-4000-8000-000000000011', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4500000-0000-4000-8000-000000000612', '94500000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 'a4500000-0000-4000-8000-000000000612'
);

-- CONDITION_NARROWED_GRANTOR: holds an all_records-routed 'share'
-- permission that is narrowed by a saved condition (F_FLAG = true), and
-- nothing else. The target record below has f_flag = false, so this
-- account's share authority genuinely cannot reach it -- the grant path
-- refuses it. Reading the route in isolation would nonetheless admit this
-- permission to the pre-row eligibility branch, because its sole route is
-- all_records; a saved condition narrows every route, including that one,
-- and is evaluated from the target row's own field values, so this scope
-- is row-dependent and must not confer revoke authority.
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
)
select '44500000-0000-4000-8000-000000000012', 'active', op.now,
  op.now, '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000618', 1
from (select pg_catalog.clock_timestamp() as now) as op;

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, closed_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
)
select '54500000-0000-4000-8000-000000000012', '24500000-0000-4000-8000-000000000001',
  '44500000-0000-4000-8000-000000000012', 'Condition-narrowed all_records grantor account',
  'active', op.now - interval '1 minute', null, op.now,
  op.now, '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000619', 1
from (select pg_catalog.clock_timestamp() as now) as op;

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint, record_scope, field_policy
) values (
  '24500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001', 1,
  '34500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001',
  'c4500000-0000-4000-8000-000000000012',
  'record_share.chain_share_all_records_conditional',
  'Chain share (all_records, condition-narrowed)', 'Record share fixture.',
  'd4500000-0000-4000-8000-000000000001', 'share', null, false,
  'application', 'example.record_share',
  '34500000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('c', 64),
  ('{"routes":[{"kind":"all_records"}],"savedCondition":{"conditionId":"b4500000-0000-4000-8000-000000000401","publishedRevision":1,"contractFingerprint":"'
    || ('sha256:' || pg_catalog.repeat('7', 64))
    || '","parameterBindings":[]}}')::jsonb,
  null
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
  1, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24500000-0000-4000-8000-000000000001'
  and entry.permission_id = 'c4500000-0000-4000-8000-000000000012';

select pg_temp.seed_role(
  '64500000-0000-4000-8000-000000000012', 'chain_share_all_records_conditional',
  'c4500000-0000-4000-8000-000000000012'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001', '74500000-0000-4000-8000-000000000602',
  '64500000-0000-4000-8000-000000000012', 'organization_account',
  '54500000-0000-4000-8000-000000000012', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4500000-0000-4000-8000-000000000620', '94500000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 'a4500000-0000-4000-8000-000000000620'
);

-- The target record and share: owned and granted by ADMIN, to keep every
-- attempted revoker below equally a non-grantor.
insert into vortex_access.test_share_rows (
  organization_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, owner_organization_account_id,
  lifecycle_state, f1, f2, f3, f_flag, f_source_link
) values (
  '24500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
  'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
  'e4500000-0000-4000-8000-000000000072', '34500000-0000-4000-8000-000000000001',
  '54500000-0000-4000-8000-000000000004', 'active', 'open-72', 'open-72', 'open-72', false, null
);

insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '24500000-0000-4000-8000-000000000001', '94500000-0000-4000-8000-000000000603',
  'application_contained', '34500000-0000-4000-8000-000000000001',
  '34500000-0000-4000-8000-000000000002', 'd4500000-0000-4000-8000-000000000001',
  'b4500000-0000-4000-8000-000000000001', 'e4500000-0000-4000-8000-000000000072',
  'organization_account', '54500000-0000-4000-8000-000000000002', null,
  array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
  op.now - interval '1 minute', op.now + interval '4 hours',
  'active', 1, '54500000-0000-4000-8000-000000000004', op.now,
  'a4500000-0000-4000-8000-000000000613', 'Admin grant, target for the route-restriction cases',
  op.now
from (select pg_catalog.clock_timestamp() as now) as op;

-- Ownership-routed: OWNER_GRANTOR holds real share authority (owned_share)
-- but not over this record, which it does not own.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000008');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000603', 1,
    'Ownership-routed account attempts to revoke a share over a record it does not own',
    'web', 'a4500000-0000-4000-8000-000000000614')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'an ownership-routed account cannot revoke a share over a record it does not own -- ownership is not a route the eligibility core can resolve without the row'
);
reset role;

-- Relationship-routed: RELATIONSHIP_GRANTOR holds real share authority
-- (owned_share_relationship) but has no edge reaching this record.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000009');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000603', 1,
    'Relationship-routed account attempts to revoke a share over a record with no edge to it',
    'web', 'a4500000-0000-4000-8000-000000000615')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'a relationship-routed account cannot revoke a share over a record with no edge to it -- relationship is not a route the eligibility core can resolve without the row'
);
reset role;

-- Direct_share-routed: DIRECT_SHARE_GRANTOR holds a 'share' permission, but
-- it could never have created a share in the first place (the grant path
-- already refuses direct_share for share actions), so it cannot revoke one
-- either.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000011');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000603', 1,
    'Direct_share-routed account attempts to revoke a share it could never have granted',
    'web', 'a4500000-0000-4000-8000-000000000616')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'a direct_share-routed account cannot revoke -- it could never grant one, and direct_share is excluded from the pre-row eligibility branch the same way ownership and relationship are'
);
reset role;

-- Condition-narrowed all_records: the scope's sole route is all_records, but
-- a saved condition narrows it, and record ...0072 has f_flag = false. The
-- grant refusal below establishes that this account's share authority really
-- cannot reach this record; the revoke refusal is the point of the case.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000012');
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.test_share_grant(
    '94500000-0000-4000-8000-000000000604',
    'e4500000-0000-4000-8000-000000000072', 'organization_account',
    '54500000-0000-4000-8000-000000000009', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null,
    'Condition-narrowed account attempts to share a record its condition excludes',
    'web', 'a4500000-0000-4000-8000-000000000621')$$,
  '42501',
  'Protected record-share grant target record is not within your current share authority',
  'a condition-narrowed all_records account cannot grant a share over a record its saved condition excludes'
);
select throws_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000603', 1,
    'Condition-narrowed account attempts to revoke a share over a record its condition excludes',
    'web', 'a4500000-0000-4000-8000-000000000622')$$,
  '42501', 'Protected record-share revocation is unavailable',
  'a condition-narrowed all_records account cannot revoke a share over a record its saved condition excludes -- a saved condition narrows every route including all_records, so the scope is not decidable without the row'
);
reset role;

select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000603'),
  'active',
  'the share remains active after all four scope-restricted refusals'
);

-- The record is soft-deleted before the successful revocation below, to
-- prove the all_records branch -- like the grantor branch proven earlier in
-- the N1 section -- does not depend on the record's visibility either.
update vortex_access.test_share_rows
set lifecycle_state = 'soft_deleted'
where organization_id = '24500000-0000-4000-8000-000000000001'
  and record_id = 'e4500000-0000-4000-8000-000000000072';

-- ALL_RECORDS_GRANTOR: neither this share's grantor (ADMIN) nor its
-- recipient, and holding no ownership, relationship or direct_share
-- authority over this record at all -- only chain_share, all_records-routed
-- -- revokes it successfully, soft-deleted record included.
select pg_temp.install_request_context('54500000-0000-4000-8000-000000000007');
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.test_share_revoke(
    '94500000-0000-4000-8000-000000000603', 1,
    'All-records-routed administrator revokes a share it did not grant, over a soft-deleted record',
    'web', 'a4500000-0000-4000-8000-000000000617')$$,
  'an all_records-routed current share permission is authority enough to revoke a share the account neither granted nor received, and the record''s soft-deleted lifecycle does not block it'
);
reset role;
select is(
  (select state from vortex_access.organization_direct_record_shares
   where organization_id = '24500000-0000-4000-8000-000000000001'
     and direct_share_id = '94500000-0000-4000-8000-000000000603'),
  'revoked',
  'the share is now revoked'
);

-- ============================================================================
-- Boundary assertions. vortex_request can execute exactly the two fixed
-- adapters -- not the protected functions themselves, and none of the
-- private writers, resolver or record decision they call internally.
-- ============================================================================

select ok(
  pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request can execute ' || target.signature
)
from (values
  ('vortex_access.test_share_grant(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid)'),
  ('vortex_access.test_share_revoke(uuid,bigint,text,text,uuid)')
) as target(signature)
order by target.signature collate "C";

select ok(
  not pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request cannot execute ' || target.signature
)
from (values
  ('vortex_access.grant_record_share_for_administration(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid,jsonb)'),
  ('vortex_access.revoke_record_share_for_administration(uuid,bigint,text,text,uuid)'),
  ('vortex_access.grant_organization_direct_record_share(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,uuid,uuid,text,uuid)'),
  ('vortex_access.revoke_organization_direct_record_share(uuid,uuid,bigint,text,uuid,uuid,text,uuid)'),
  ('vortex_access.resolve_record_field_bounds_internal(jsonb)'),
  ('vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'),
  ('vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])'),
  ('vortex_access.evaluate_organization_record_permission_eligibility_internal(jsonb,jsonb,timestamptz)'),
  ('vortex_access.read_current_direct_record_share_contributions(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz)')
) as target(signature)
order by target.signature collate "C";

-- The two protected functions remain owner-held, security definer,
-- empty-search-path -- never invoker-rights, never a different owner. Only
-- their grant to vortex_request changed in slice 5, not their shape.
select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname, 'securityDefiner', procedure_row.prosecdef,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.pronamespace = 'vortex_access'::regnamespace
      and procedure_row.proname in (
        'grant_record_share_for_administration', 'revoke_record_share_for_administration'
      )
  ),
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', 'postgres', 'securityDefiner', true, 'configuration', array['search_path=""']
    ) order by name.value)
    from (values
      ('grant_record_share_for_administration'), ('revoke_record_share_for_administration')
    ) as name(value)
  ),
  'both protected functions are owner-held, security definer and empty-search-path'
);

-- The two fixed adapters are likewise owner-held, security definer,
-- empty-search-path, exactly as 430/445's own adapters.
select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname, 'securityDefiner', procedure_row.prosecdef,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.pronamespace = 'vortex_access'::regnamespace
      and procedure_row.proname in ('test_share_grant', 'test_share_revoke')
  ),
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', 'postgres', 'securityDefiner', true, 'configuration', array['search_path=""']
    ) order by name.value)
    from (values ('test_share_grant'), ('test_share_revoke')) as name(value)
  ),
  'both fixed adapters are owner-held, security definer and empty-search-path'
);

-- vortex_request holds no privilege at all on the content table -- not a row
-- policy, an absent grant, exactly as 445's own content table.
select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_access.test_share_rows', privilege.kind),
  'vortex_request has no ' || privilege.kind || ' privilege on test_share_rows'
)
from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as privilege(kind)
order by privilege.kind collate "C";

set constraints all immediate;

select * from finish();

rollback;
