begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #37 slice 3: the protected same-organisation direct-share grant/revoke
-- operations. Mirrors 445's fixture style: one organisation, a neutral
-- record type with no real content table (the share's own writer never
-- reads business rows -- see 20260907023622's own header comment), a
-- catalogue with two direct_share-routed record permissions (chain_read,
-- chain_update), one grantor holding both by standing role assignment, and
-- pre-existing shares (seeded directly, as 445 seeds its own) that give the
-- grantor their own current read/update ceiling on each target record. Every
-- assertion below runs the protected functions under `set local role
-- vortex_request`, exactly as 430/445 do.
-- ============================================================================

-- ============================================================================
-- Identity/organisation fixture: two tenants (home + foreign), one home
-- organisation with four accounts and one Group, one foreign organisation
-- with one account and one Group.
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
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000005', 1);

  -- Home organisation: GRANTOR, RECIPIENT, a spare account, ADMIN (the
  -- original grantor of the pre-existing shares below).
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
      '94500000-0000-4000-8000-000000000001', 'a4500000-0000-4000-8000-000000000015', 1);

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
-- Permission catalogue: one application registration on the home
-- organisation owning two record-scoped permissions on one neutral record
-- type -- chain_read and chain_update -- each routed on direct_share only,
-- so eligibility (a standing role assignment) is necessary but the actual
-- row reached is always an explicit organization_direct_record_shares row.
-- Three fields: F1/F2 are named by both permissions' field policy; F3 is
-- declared nowhere, so no share can ever carry it.
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
      '{"readableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"],"changeableFieldIds":["b4500000-0000-4000-8000-000000000101","b4500000-0000-4000-8000-000000000102","b4500000-0000-4000-8000-000000000103"]}'::jsonb)
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

-- One custom role per permission, assigned as standing to GRANTOR alone.
-- Eligibility for both is necessary but not sufficient: reaching any given
-- record still requires an explicit direct_share row, seeded below.
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

-- GRANTOR holds chain_read and chain_update by standing assignment.
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
    '54500000-0000-4000-8000-000000000001'::uuid, 'a4500000-0000-4000-8000-000000000052'::uuid)
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

-- Establishes the real session request context the protected functions
-- sample via validated_human_request_context(). Callable repeatedly to
-- switch the acting account between cases.
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
  where version.organization_id = '24500000-0000-4000-8000-000000000001';

  select account.identity_id into strict acting_identity_id
  from vortex_identity.organization_accounts as account
  where account.organization_id = '24500000-0000-4000-8000-000000000001'
    and account.organization_account_id = p_account_id;

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'a4500000-0000-4000-8000-000000000091',
    'tenantId', '14500000-0000-4000-8000-000000000001',
    'organizationId', '24500000-0000-4000-8000-000000000001',
    'organizationAccountId', p_account_id,
    'identityId', acting_identity_id,
    'applicationRootId', '34500000-0000-4000-8000-000000000001',
    'sessionId', 'a4500000-0000-4000-8000-000000000092',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '2 hours',
    'accessVersion', current_access_version,
    'correlationId', 'a4500000-0000-4000-8000-000000000093',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

-- Test-only pgTAP visibility while vortex_request is active, following
-- supabase/tests/445's own pattern.
grant usage on schema extensions to vortex_request;

-- ============================================================================
-- GRANT: happy path. GRANTOR's current authority on RECORD_A is read-only
-- (F1, F2; no changeable field). Sharing exactly one readable field with no
-- changeable field succeeds and is a real, minimal exercise of "read-only
-- sharing requires current read authority but not update authority".
-- ============================================================================

select pg_temp.install_request_context('54500000-0000-4000-8000-000000000001');
set local role vortex_request;

select lives_ok(
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000101', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000102', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000103', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000104', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000105', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000005', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign organisation recipient',
    'web', 'a4500000-0000-4000-8000-000000000205')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'a recipient account in another organisation is refused'
);
select throws_ok(
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000106', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    'f4500000-0000-4000-8000-000000000999', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Unknown recipient',
    'web', 'a4500000-0000-4000-8000-000000000206')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'an unknown recipient account id is refused'
);
select throws_ok(
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000107', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000001', 'group', null,
    '84500000-0000-4000-8000-000000000002',
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign organisation Group recipient',
    'web', 'a4500000-0000-4000-8000-000000000207')$$,
  '42501', 'Protected record-share recipient is unavailable',
  'a Group in another organisation is refused'
);
select throws_ok(
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000108', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000109', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000110', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000111', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
    'e4500000-0000-4000-8000-000000000001', 'organization_account',
    '54500000-0000-4000-8000-000000000002', null,
    array['b4500000-0000-4000-8000-000000000101']::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Attempted re-share after source access withdrawn',
    'web', 'a4500000-0000-4000-8000-000000000213')$$,
  '42501', 'Protected record-share grant exceeds current read authority',
  'once the grantor''s own source access to a record is withdrawn, they can no longer create a new share on it'
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
  $$select * from vortex_access.grant_record_share_for_administration(
    '94500000-0000-4000-8000-000000000112', 'application_contained',
    '34500000-0000-4000-8000-000000000001', '34500000-0000-4000-8000-000000000002',
    'd4500000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001',
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
  $$select * from vortex_access.revoke_record_share_for_administration(
    '94500000-0000-4000-8000-000000000112', 2,
    'Stale revocation attempt', 'web', 'a4500000-0000-4000-8000-000000000215')$$,
  '40001', 'Direct record-share revocation is stale or unavailable',
  'a stale expected revision refuses revocation'
);
select lives_ok(
  $$select * from vortex_access.revoke_record_share_for_administration(
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
  $$select * from vortex_access.revoke_record_share_for_administration(
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
  $$select * from vortex_access.revoke_record_share_for_administration(
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
-- Boundary assertions: the restricted role can execute exactly these two
-- protected functions and none of the private writers, resolver or record
-- decision they call internally.
-- ============================================================================

select ok(
  pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request can execute ' || target.signature
)
from (values
  ('vortex_access.grant_record_share_for_administration(uuid,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid)'),
  ('vortex_access.revoke_record_share_for_administration(uuid,bigint,text,text,uuid)')
) as target(signature)
order by target.signature collate "C";

select ok(
  not pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request cannot execute ' || target.signature
)
from (values
  ('vortex_access.grant_organization_direct_record_share(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,uuid,uuid,text,uuid)'),
  ('vortex_access.revoke_organization_direct_record_share(uuid,uuid,bigint,text,uuid,uuid,text,uuid)'),
  ('vortex_access.resolve_record_field_bounds_internal(jsonb)'),
  ('vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'),
  ('vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])'),
  ('vortex_access.evaluate_organization_record_permission_eligibility_internal(jsonb,jsonb,timestamptz)'),
  ('vortex_access.read_current_direct_record_share_contributions(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz)')
) as target(signature)
order by target.signature collate "C";

-- The two protected functions are owner-held, security definer,
-- empty-search-path -- never invoker-rights, never a different owner.
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

set constraints all immediate;

select * from finish();

rollback;
