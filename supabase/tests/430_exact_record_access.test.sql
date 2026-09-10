begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- Function shape and ACL assertions for the two new owner-only objects in
-- 20260910040755_compose_exact_record_access_decision.sql. Neither carries a
-- request/runtime/module-owner/record-owner/record-adapter grant: the row-scope
-- composer is invoker-rights because it recurses under the decision's own
-- single Access-version/time sample, and the decision function alone samples
-- validated_human_request_context() and clock_timestamp().
select has_function(
  'vortex_access', 'evaluate_record_permission_row_scope_internal',
  array[
    'jsonb', 'timestamptz', 'timestamptz', 'uuid', 'jsonb', 'jsonb', 'uuid',
    'jsonb', 'uuid[]'
  ],
  'Access owns one private row-scope composition predicate'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig
    )
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the row-scope composer is owner-held, volatile, invoker-rights and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private row-scope composer'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request'), ('vortex_module_owner'),
  ('vortex_record_owner'), ('vortex_record_adapter')
) as caller(role_name)
order by caller.role_name collate "C";

select has_function(
  'vortex_access', 'evaluate_organization_record_access_internal',
  array['jsonb', 'uuid', 'jsonb'],
  'Access owns one private complete exact-record access decision'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig,
      'result', pg_catalog.pg_get_function_result(procedure_row.oid)
    )
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
    'configuration', array['search_path=""'], 'result', 'jsonb'
  ),
  'the decision function is owner-held, volatile, definer-rights and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private decision function'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request'), ('vortex_module_owner'),
  ('vortex_record_owner'), ('vortex_record_adapter')
) as caller(role_name)
order by caller.role_name collate "C";

-- ============================================================================
-- Fixture. One tenant/organisation/Access-version scope, one acting account
-- (self) and one foreign account (other), one application/module, five neutral
-- record types (owned/team/child/mid/top -- no business names), four
-- relationships and one saved condition, fifteen catalogue permissions (twelve
-- held by self through standing roles, three deliberately unassigned), one
-- current Group membership, and four direct-record-share rows. Every
-- record/relationship/edge/condition below this point is pure facts jsonb
-- built by the helper functions further down, never stored rows -- only
-- identity, catalogue, role, group and share state are real tables.
-- ============================================================================

create function pg_temp.build_identity_scope()
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
    '14300000-0000-4000-8000-000000000001', 'exact_record_access',
    'Exact record access', 'active', operation_at,
    '94300000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '24300000-0000-4000-8000-000000000001',
    '14300000-0000-4000-8000-000000000001', 'exact_record_access',
    'Exact record access', 'active', operation_at,
    '94300000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    (
      '44300000-0000-4000-8000-000000000001', 'active', operation_at,
      operation_at, '94300000-0000-4000-8000-000000000001',
      'a4300000-0000-4000-8000-000000000001', 1
    ),
    (
      '44300000-0000-4000-8000-000000000002', 'active', operation_at,
      operation_at, '94300000-0000-4000-8000-000000000001',
      'a4300000-0000-4000-8000-000000000002', 1
    );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    (
      '54300000-0000-4000-8000-000000000001',
      '24300000-0000-4000-8000-000000000001',
      '44300000-0000-4000-8000-000000000001', 'Acting account', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94300000-0000-4000-8000-000000000001',
      'a4300000-0000-4000-8000-000000000003', 1
    ),
    (
      '54300000-0000-4000-8000-000000000002',
      '24300000-0000-4000-8000-000000000001',
      '44300000-0000-4000-8000-000000000002', 'Other account', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94300000-0000-4000-8000-000000000001',
      'a4300000-0000-4000-8000-000000000004', 1
    );

  perform 1 from vortex_access.initialize_organization_access_version(
    '24300000-0000-4000-8000-000000000001',
    '94300000-0000-4000-8000-000000000001',
    'a4300000-0000-4000-8000-000000000005'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24300000-0000-4000-8000-000000000001',
    '94300000-0000-4000-8000-000000000001',
    'a4300000-0000-4000-8000-000000000006'
  );
end
$function$;

select pg_temp.build_identity_scope();

-- One application registration owning fifteen record-scoped read/update/create
-- permissions across five record types. Record type key:
--   d...0001 owned  (organization_account ownership; carries fld_flag)
--   d...0002 team   (team/Group ownership)
--   d...0003 child  (inherited ownership, parent edge -> owned)
--   d...0004 mid    (relationship target of owned; relationship source of top)
--   d...0005 top    (relationship target of mid)
-- Relationship key: f...0001 owned->mid, f...0002 mid->top,
--   f...0003 child->owned (the ownership-inheritance edge), f...0004 owned->owned
--   (self, for the cycle case).
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
    '24300000-0000-4000-8000-000000000001', 'application',
    '34300000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.exact_record_access', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94300000-0000-4000-8000-000000000001',
    'a4300000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24300000-0000-4000-8000-000000000001', 'application',
    '34300000-0000-4000-8000-000000000001', 'active', 1,
    'example.exact_record_access', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94300000-0000-4000-8000-000000000001',
    'a4300000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope
  )
  select
    '24300000-0000-4000-8000-000000000001'::uuid, 'application',
    '34300000-0000-4000-8000-000000000001'::uuid, 1,
    '34300000-0000-4000-8000-000000000001'::uuid, 'application',
    '34300000-0000-4000-8000-000000000001'::uuid,
    permission.permission_id, permission.permission_key,
    permission.label, 'Exact record access fixture.',
    permission.record_type_id, permission.action_kind, null, false,
    'application', 'example.exact_record_access',
    '34300000-0000-4000-8000-000000000001'::uuid, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64),
    permission.record_scope
  from (values
    ('c4300000-0000-4000-8000-000000000001'::uuid,
      'exact_record_access.held_ownership', 'Held ownership',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', '1',
      '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000002'::uuid,
      'exact_record_access.unheld_share', 'Unheld share',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', '2',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000003'::uuid,
      'exact_record_access.held_share', 'Held share',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', '3',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000004'::uuid,
      'exact_record_access.unheld_ownership', 'Unheld ownership',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', '4',
      '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000005'::uuid,
      'exact_record_access.held_share_update', 'Held share update',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'update', '5',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000006'::uuid,
      'exact_record_access.held_share_create', 'Held share create',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'create', '6',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000007'::uuid,
      'exact_record_access.root_unheld', 'Root unheld',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', '7',
      '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000008'::uuid,
      'exact_record_access.mid_relationship', 'Mid relationship',
      'd4300000-0000-4000-8000-000000000004'::uuid, 'read', '8',
      '{"routes":[{"kind":"relationship","relationshipId":"f4300000-0000-4000-8000-000000000001","sourcePermissionId":"c4300000-0000-4000-8000-000000000001"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000009'::uuid,
      'exact_record_access.mid_unheld_source', 'Mid unheld source',
      'd4300000-0000-4000-8000-000000000004'::uuid, 'read', '9',
      '{"routes":[{"kind":"relationship","relationshipId":"f4300000-0000-4000-8000-000000000001","sourcePermissionId":"c4300000-0000-4000-8000-000000000007"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000010'::uuid,
      'exact_record_access.top_relationship', 'Top relationship',
      'd4300000-0000-4000-8000-000000000005'::uuid, 'read', 'a',
      '{"routes":[{"kind":"relationship","relationshipId":"f4300000-0000-4000-8000-000000000002","sourcePermissionId":"c4300000-0000-4000-8000-000000000008"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000011'::uuid,
      'exact_record_access.cycle', 'Cycle',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', 'b',
      '{"routes":[{"kind":"relationship","relationshipId":"f4300000-0000-4000-8000-000000000004","sourcePermissionId":"c4300000-0000-4000-8000-000000000011"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000012'::uuid,
      'exact_record_access.team_ownership', 'Team ownership',
      'd4300000-0000-4000-8000-000000000002'::uuid, 'read', 'c',
      '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000013'::uuid,
      'exact_record_access.child_ownership', 'Child ownership',
      'd4300000-0000-4000-8000-000000000003'::uuid, 'read', 'd',
      '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300000-0000-4000-8000-000000000014'::uuid,
      'exact_record_access.own_condition', 'Own condition',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', 'e',
      ('{"routes":[{"kind":"ownership"}],"savedCondition":{"conditionId":"b4300000-0000-4000-8000-000000000401","publishedRevision":1,"contractFingerprint":"'
        || ('sha256:' || pg_catalog.repeat('7', 64))
        || '","parameterBindings":[]}}')::jsonb),
    ('c4300000-0000-4000-8000-000000000015'::uuid,
      'exact_record_access.all_condition', 'All condition',
      'd4300000-0000-4000-8000-000000000001'::uuid, 'read', 'f',
      ('{"routes":[{"kind":"all_records"}],"savedCondition":{"conditionId":"b4300000-0000-4000-8000-000000000401","publishedRevision":1,"contractFingerprint":"'
        || ('sha256:' || pg_catalog.repeat('7', 64))
        || '","parameterBindings":[]}}')::jsonb)
  ) as permission(
    permission_id, permission_key, label, record_type_id, action_kind,
    fingerprint_character, record_scope
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
  where entry.organization_id = '24300000-0000-4000-8000-000000000001'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id =
      '34300000-0000-4000-8000-000000000001';
end
$function$;

select pg_temp.seed_catalogue();

-- A minimal standing direct grant to the acting account, one call per held
-- permission. Group and activation routing are already proven by 290/300/425;
-- this file exercises row-scope composition, not role-path route selection.
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
    '24300000-0000-4000-8000-000000000001', p_role_id, 'custom',
    p_role_key, 1, '94300000-0000-4000-8000-000000000001', operation_at
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
  where entry.organization_id = '24300000-0000-4000-8000-000000000001'
    and entry.permission_id = p_permission_id;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '24300000-0000-4000-8000-000000000001', p_role_id, 1, 'custom',
    'active', 'standard', 'standing', 1, 1,
    p_role_key, 'Exact record access role',
    'Exact record access role fixture.',
    '94300000-0000-4000-8000-000000000001', operation_at, p_role_id
  );
end
$function$;

select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000001', 'held_ownership',
  'c4300000-0000-4000-8000-000000000001'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000002', 'held_share',
  'c4300000-0000-4000-8000-000000000003'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000003', 'held_share_update',
  'c4300000-0000-4000-8000-000000000005'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000004', 'held_share_create',
  'c4300000-0000-4000-8000-000000000006'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000005', 'mid_relationship',
  'c4300000-0000-4000-8000-000000000008'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000006', 'mid_unheld_source',
  'c4300000-0000-4000-8000-000000000009'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000007', 'top_relationship',
  'c4300000-0000-4000-8000-000000000010'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000008', 'cycle',
  'c4300000-0000-4000-8000-000000000011'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000009', 'team_ownership',
  'c4300000-0000-4000-8000-000000000012'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000010', 'child_ownership',
  'c4300000-0000-4000-8000-000000000013'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000011', 'own_condition',
  'c4300000-0000-4000-8000-000000000014'
);
select pg_temp.seed_role(
  '64300000-0000-4000-8000-000000000012', 'all_condition',
  'c4300000-0000-4000-8000-000000000015'
);
-- Permissions ...002 (unheld share), ...004 (unheld ownership) and ...007
-- (unheld relationship source) deliberately receive no role assignment.

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
-- Four hours, deliberately wider than the two-hour request context below: the
-- context's expiresAt must be the deterministic binding deadline whenever no
-- share/membership deadline is tighter, so validUntil is exactly predictable
-- in assertions instead of racing two independently-sampled ~2-hour instants.
select '24300000-0000-4000-8000-000000000001', assignment.role_assignment_id,
  assignment.role_id, 'organization_account',
  '54300000-0000-4000-8000-000000000001', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  assignment.correlation_id, '94300000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), assignment.correlation_id
from (values
  ('74300000-0000-4000-8000-000000000001'::uuid, '64300000-0000-4000-8000-000000000001'::uuid, 'a4300000-0000-4000-8000-000000000021'::uuid),
  ('74300000-0000-4000-8000-000000000002'::uuid, '64300000-0000-4000-8000-000000000002'::uuid, 'a4300000-0000-4000-8000-000000000022'::uuid),
  ('74300000-0000-4000-8000-000000000003'::uuid, '64300000-0000-4000-8000-000000000003'::uuid, 'a4300000-0000-4000-8000-000000000023'::uuid),
  ('74300000-0000-4000-8000-000000000004'::uuid, '64300000-0000-4000-8000-000000000004'::uuid, 'a4300000-0000-4000-8000-000000000024'::uuid),
  ('74300000-0000-4000-8000-000000000005'::uuid, '64300000-0000-4000-8000-000000000005'::uuid, 'a4300000-0000-4000-8000-000000000025'::uuid),
  ('74300000-0000-4000-8000-000000000006'::uuid, '64300000-0000-4000-8000-000000000006'::uuid, 'a4300000-0000-4000-8000-000000000026'::uuid),
  ('74300000-0000-4000-8000-000000000007'::uuid, '64300000-0000-4000-8000-000000000007'::uuid, 'a4300000-0000-4000-8000-000000000027'::uuid),
  ('74300000-0000-4000-8000-000000000008'::uuid, '64300000-0000-4000-8000-000000000008'::uuid, 'a4300000-0000-4000-8000-000000000028'::uuid),
  ('74300000-0000-4000-8000-000000000009'::uuid, '64300000-0000-4000-8000-000000000009'::uuid, 'a4300000-0000-4000-8000-000000000029'::uuid),
  ('74300000-0000-4000-8000-000000000010'::uuid, '64300000-0000-4000-8000-000000000010'::uuid, 'a4300000-0000-4000-8000-000000000030'::uuid),
  ('74300000-0000-4000-8000-000000000011'::uuid, '64300000-0000-4000-8000-000000000011'::uuid, 'a4300000-0000-4000-8000-000000000031'::uuid),
  ('74300000-0000-4000-8000-000000000012'::uuid, '64300000-0000-4000-8000-000000000012'::uuid, 'a4300000-0000-4000-8000-000000000032'::uuid)
) as assignment(role_assignment_id, role_id, correlation_id);

set constraints all immediate;
set constraints all deferred;

-- One current Group (self is a live member, membership expires in 20 minutes)
-- and one Group the acting account never joined, for the team-ownership
-- record type d...0002.
insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '24300000-0000-4000-8000-000000000001', '84300000-0000-4000-8000-000000000001',
  'current_group', 'Current Group', 'active', 1,
  '94300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  '94300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4300000-0000-4000-8000-000000000041'
), (
  '24300000-0000-4000-8000-000000000001', '84300000-0000-4000-8000-000000000002',
  'foreign_group', 'Foreign Group', 'active', 1,
  '94300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  '94300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4300000-0000-4000-8000-000000000042'
);

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24300000-0000-4000-8000-000000000001', '84300000-0000-4000-8000-000000000101',
  '84300000-0000-4000-8000-000000000001', '54300000-0000-4000-8000-000000000001',
  1, pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.clock_timestamp() + interval '20 minutes', 'live',
  '94300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4300000-0000-4000-8000-000000000043', '94300000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 'a4300000-0000-4000-8000-000000000043'
);

-- Four direct-record-share rows on the owned record type, all recipients the
-- acting account: one active (15-minute deadline, tighter than every role
-- assignment and the request context, to prove the earliest-deadline rule),
-- one already expired, one revoked, and one active but with no changeable
-- field (read admits, update refuses).
-- op.now is sampled once and reused for granted_at/changed_at on every row:
-- the insert trigger requires them identical, so two separate
-- clock_timestamp() calls (which can each return a distinct instant) would
-- intermittently fail it.
insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '24300000-0000-4000-8000-000000000001', share.direct_share_id,
  'application_contained', '34300000-0000-4000-8000-000000000001',
  '34300000-0000-4000-8000-000000000002', 'd4300000-0000-4000-8000-000000000001',
  'b4300000-0000-4000-8000-000000000001', share.record_id,
  'organization_account', '54300000-0000-4000-8000-000000000001', null,
  share.readable_field_ids, share.changeable_field_ids,
  op.now + share.start_offset,
  case when share.expiry_offset is null then null else op.now + share.expiry_offset end,
  'active', 1, '54300000-0000-4000-8000-000000000001', op.now,
  share.correlation_id, share.reason, op.now
from (select pg_catalog.clock_timestamp() as now) as op
cross join (values
  ('b4300000-0000-4000-8000-000000000601'::uuid, 'e4300000-0000-4000-8000-000000000004'::uuid,
    array['b4300000-0000-4000-8000-000000000501','b4300000-0000-4000-8000-000000000502']::uuid[],
    array['b4300000-0000-4000-8000-000000000502']::uuid[],
    interval '-1 minute', interval '15 minutes',
    'a4300000-0000-4000-8000-000000000051'::uuid, 'Active share fixture'),
  ('b4300000-0000-4000-8000-000000000602'::uuid, 'e4300000-0000-4000-8000-000000000005'::uuid,
    array['b4300000-0000-4000-8000-000000000501']::uuid[],
    array['b4300000-0000-4000-8000-000000000501']::uuid[],
    interval '-10 minutes', interval '-1 minute',
    'a4300000-0000-4000-8000-000000000052'::uuid, 'Expired share fixture'),
  ('b4300000-0000-4000-8000-000000000603'::uuid, 'e4300000-0000-4000-8000-000000000006'::uuid,
    array['b4300000-0000-4000-8000-000000000501']::uuid[],
    array['b4300000-0000-4000-8000-000000000501']::uuid[],
    interval '-1 minute', null::interval,
    'a4300000-0000-4000-8000-000000000053'::uuid, 'Revoked share fixture'),
  ('b4300000-0000-4000-8000-000000000604'::uuid, 'e4300000-0000-4000-8000-000000000007'::uuid,
    array['b4300000-0000-4000-8000-000000000501']::uuid[],
    array[]::uuid[],
    interval '-1 minute', null::interval,
    'a4300000-0000-4000-8000-000000000054'::uuid, 'No changeable field share fixture')
) as share(
  direct_share_id, record_id, readable_field_ids, changeable_field_ids,
  start_offset, expiry_offset, correlation_id, reason
);

-- revoked_at must equal changed_at exactly, so both are set from the same
-- sampled instant rather than two independent clock_timestamp() calls.
update vortex_access.organization_direct_record_shares as shares
set state = 'revoked', revision = 2,
  revoked_by = '54300000-0000-4000-8000-000000000001',
  revoked_at = op.now,
  revocation_correlation_id = 'a4300000-0000-4000-8000-000000000055',
  revocation_reason = 'No longer required',
  changed_at = op.now
from (select pg_catalog.clock_timestamp() as now) as op
where shares.organization_id = '24300000-0000-4000-8000-000000000001'
  and shares.direct_share_id = 'b4300000-0000-4000-8000-000000000603';

-- Exact deadlines read back from the real rows above, for precise validUntil
-- assertions. pg_temp.install_request_context() adds 'context_expiry' once
-- it samples the context's own expiresAt.
create temporary table expected_deadlines (
  key text primary key,
  expires_at timestamptz not null
) on commit drop;

insert into expected_deadlines (key, expires_at)
select 'team_membership', membership.expires_at
from vortex_access.organization_group_memberships as membership
where membership.organization_id = '24300000-0000-4000-8000-000000000001'
  and membership.membership_id = '84300000-0000-4000-8000-000000000101'
union all
select 'share_active', share.expires_at
from vortex_access.organization_direct_record_shares as share
where share.organization_id = '24300000-0000-4000-8000-000000000001'
  and share.direct_share_id = 'b4300000-0000-4000-8000-000000000601';

set constraints all immediate;
set constraints all deferred;

-- ============================================================================
-- Facts and declaration helpers. Record types, relationships, sharing
-- conditions, records and edges are pure jsonb -- never stored rows -- so
-- every scenario below reuses one comprehensive, valid facts universe and
-- only swaps the top-level `binding` to match whichever record type is under
-- test. Extra facts entries a given call never touches are simply unused:
-- eligibility comes from the declaration's requiredPermissions against the
-- real catalogue/role fixture above, not from facts.
-- ============================================================================

create function pg_temp.type_binding(p_type_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'moduleRootId', '34300000-0000-4000-8000-000000000002',
    'recordTypeId', case p_type_key
      when 'owned' then 'd4300000-0000-4000-8000-000000000001'
      when 'team' then 'd4300000-0000-4000-8000-000000000002'
      when 'child' then 'd4300000-0000-4000-8000-000000000003'
      when 'mid' then 'd4300000-0000-4000-8000-000000000004'
      when 'top' then 'd4300000-0000-4000-8000-000000000005'
    end,
    'storageContractId', case p_type_key
      when 'owned' then 'b4300000-0000-4000-8000-000000000001'
      when 'team' then 'b4300000-0000-4000-8000-000000000002'
      when 'child' then 'b4300000-0000-4000-8000-000000000003'
      when 'mid' then 'b4300000-0000-4000-8000-000000000004'
      when 'top' then 'b4300000-0000-4000-8000-000000000005'
    end,
    'storageScope', 'application_contained'
  )
$function$;

create function pg_temp.fact_sharing_conditions()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'conditionId', 'b4300000-0000-4000-8000-000000000401',
    'sourceRecordTypeId', 'd4300000-0000-4000-8000-000000000001',
    'publishedRevision', 1,
    'contractFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
    'parameters', '[]'::jsonb,
    'condition', pg_catalog.jsonb_build_object(
      'kind', 'comparison', 'operator', 'equals',
      'left', pg_catalog.jsonb_build_object(
        'source', 'field', 'fieldId', 'b4300000-0000-4000-8000-000000000101'
      ),
      'right', pg_catalog.jsonb_build_object('source', 'value', 'value', true)
    ),
    'declaredFieldIds', pg_catalog.jsonb_build_array('b4300000-0000-4000-8000-000000000101')
  ))
$function$;

-- Static facts minus `binding`, which pg_temp.facts_for() supplies per call.
create function pg_temp.facts_base()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypes', '[
      {"moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","storageScope":"application_contained","ownershipMode":"organization_account","fields":[{"fieldId":"b4300000-0000-4000-8000-000000000101","type":"yes_no"}]},
      {"moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000002","storageContractId":"b4300000-0000-4000-8000-000000000002","storageScope":"application_contained","ownershipMode":"team","fields":[]},
      {"moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000003","storageContractId":"b4300000-0000-4000-8000-000000000003","storageScope":"application_contained","ownershipMode":"inherited","ownershipRelationshipId":"f4300000-0000-4000-8000-000000000003","fields":[]},
      {"moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000004","storageContractId":"b4300000-0000-4000-8000-000000000004","storageScope":"application_contained","ownershipMode":"none","fields":[]},
      {"moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000005","storageContractId":"b4300000-0000-4000-8000-000000000005","storageScope":"application_contained","ownershipMode":"none","fields":[]}
    ]'::jsonb,
    'relationships', '[
      {"relationshipId":"f4300000-0000-4000-8000-000000000001","fromModuleRootId":"34300000-0000-4000-8000-000000000002","fromRecordTypeId":"d4300000-0000-4000-8000-000000000001","toModuleRootId":"34300000-0000-4000-8000-000000000002","toRecordTypeId":"d4300000-0000-4000-8000-000000000004"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000002","fromModuleRootId":"34300000-0000-4000-8000-000000000002","fromRecordTypeId":"d4300000-0000-4000-8000-000000000004","toModuleRootId":"34300000-0000-4000-8000-000000000002","toRecordTypeId":"d4300000-0000-4000-8000-000000000005"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000003","fromModuleRootId":"34300000-0000-4000-8000-000000000002","fromRecordTypeId":"d4300000-0000-4000-8000-000000000003","toModuleRootId":"34300000-0000-4000-8000-000000000002","toRecordTypeId":"d4300000-0000-4000-8000-000000000001"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000004","fromModuleRootId":"34300000-0000-4000-8000-000000000002","fromRecordTypeId":"d4300000-0000-4000-8000-000000000001","toModuleRootId":"34300000-0000-4000-8000-000000000002","toRecordTypeId":"d4300000-0000-4000-8000-000000000001"}
    ]'::jsonb,
    'sharingConditions', pg_temp.fact_sharing_conditions(),
    'records', '[
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000001","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000001","lifecycleState":"active","fieldValues":{"b4300000-0000-4000-8000-000000000101":true}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000002","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000002","lifecycleState":"active","fieldValues":{"b4300000-0000-4000-8000-000000000101":true}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000003","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000001","lifecycleState":"active","fieldValues":{"b4300000-0000-4000-8000-000000000101":false}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000004","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000002","lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000005","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000002","lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000006","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000002","lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000007","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerOrganizationAccountId":"54300000-0000-4000-8000-000000000002","lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000001","storageContractId":"b4300000-0000-4000-8000-000000000001","recordId":"e4300000-0000-4000-8000-000000000008","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000002","storageContractId":"b4300000-0000-4000-8000-000000000002","recordId":"e4300000-0000-4000-8000-000000000011","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerGroupId":"84300000-0000-4000-8000-000000000001","lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000002","storageContractId":"b4300000-0000-4000-8000-000000000002","recordId":"e4300000-0000-4000-8000-000000000012","applicationRootId":"34300000-0000-4000-8000-000000000001"},"ownerGroupId":"84300000-0000-4000-8000-000000000002","lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000003","storageContractId":"b4300000-0000-4000-8000-000000000003","recordId":"e4300000-0000-4000-8000-000000000021","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000003","storageContractId":"b4300000-0000-4000-8000-000000000003","recordId":"e4300000-0000-4000-8000-000000000022","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000004","storageContractId":"b4300000-0000-4000-8000-000000000004","recordId":"e4300000-0000-4000-8000-000000000031","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000004","storageContractId":"b4300000-0000-4000-8000-000000000004","recordId":"e4300000-0000-4000-8000-000000000032","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000004","storageContractId":"b4300000-0000-4000-8000-000000000004","recordId":"e4300000-0000-4000-8000-000000000033","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}},
      {"recordScope":{"storageScope":"application_contained","organizationId":"24300000-0000-4000-8000-000000000001","moduleRootId":"34300000-0000-4000-8000-000000000002","recordTypeId":"d4300000-0000-4000-8000-000000000005","storageContractId":"b4300000-0000-4000-8000-000000000005","recordId":"e4300000-0000-4000-8000-000000000041","applicationRootId":"34300000-0000-4000-8000-000000000001"},"lifecycleState":"active","fieldValues":{}}
    ]'::jsonb,
    'edges', '[
      {"relationshipId":"f4300000-0000-4000-8000-000000000003","fromRecordId":"e4300000-0000-4000-8000-000000000021","toRecordId":"e4300000-0000-4000-8000-000000000001"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000003","fromRecordId":"e4300000-0000-4000-8000-000000000022","toRecordId":"e4300000-0000-4000-8000-000000000004"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000001","fromRecordId":"e4300000-0000-4000-8000-000000000001","toRecordId":"e4300000-0000-4000-8000-000000000031"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000001","fromRecordId":"e4300000-0000-4000-8000-000000000002","toRecordId":"e4300000-0000-4000-8000-000000000032"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000001","fromRecordId":"e4300000-0000-4000-8000-000000000001","toRecordId":"e4300000-0000-4000-8000-000000000033"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000002","fromRecordId":"e4300000-0000-4000-8000-000000000031","toRecordId":"e4300000-0000-4000-8000-000000000041"},
      {"relationshipId":"f4300000-0000-4000-8000-000000000004","fromRecordId":"e4300000-0000-4000-8000-000000000008","toRecordId":"e4300000-0000-4000-8000-000000000008"}
    ]'::jsonb
  )
$function$;

create function pg_temp.facts_for(p_type_key text)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_temp.facts_base()
    || pg_catalog.jsonb_build_object('binding', pg_temp.type_binding(p_type_key))
$function$;

create function pg_temp.permission_ref(p_permission_id uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'applicationRootId', '34300000-0000-4000-8000-000000000001',
    'ownerKind', 'application',
    'ownerId', '34300000-0000-4000-8000-000000000001',
    'permissionId', p_permission_id
  )
$function$;

create function pg_temp.declaration(
  p_permission_ids uuid[],
  p_type_key text,
  p_action_kind text default 'read'
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operationKey', 'record.' || p_action_kind,
    'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '34300000-0000-4000-8000-000000000001'
    ),
    'requiredPermissions', (
      select pg_catalog.jsonb_agg(
        pg_temp.permission_ref(item.value) order by item.ordinality
      )
      from pg_catalog.unnest(p_permission_ids) with ordinality as item(value, ordinality)
    ),
    'recordBinding', pg_temp.type_binding(p_type_key),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
$function$;

-- Primary call helper for the decision function: one or more permission
-- alternatives (already in canonical id order), the record type key the
-- target belongs to, the target record id, and the action kind.
--
-- Every assertion below still checks the exact value the contract requires --
-- none is weakened to fit observed behaviour. The `others` handler exists
-- solely so that ONE unexpected server exception (see the defect noted
-- further down: every row-scope composition currently raises
-- `42883 function pg_catalog.coalesce(...) does not exist`) turns into a
-- normal failed `is()` comparison instead of aborting this file's single
-- transaction and cascading into every later, otherwise-independent case.
-- Without this, the whole file would stop at the first such call and report
-- nothing beyond it.
create function pg_temp.decide(
  p_permission_ids uuid[],
  p_type_key text,
  p_target_record_id uuid,
  p_action_kind text default 'read'
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
begin
  return vortex_access.evaluate_organization_record_access_internal(
    pg_temp.declaration(p_permission_ids, p_type_key, p_action_kind),
    p_target_record_id,
    pg_temp.facts_for(p_type_key)
  );
exception
  when others then
    return pg_catalog.jsonb_build_object(
      'outcome', '__unexpected_server_exception__',
      'sqlstate', sqlstate,
      'message', sqlerrm
    );
end
$function$;

-- Establishes the real session request context evaluate_organization_record_
-- access_internal samples itself via validated_human_request_context(). One
-- installation covers every call below since it lives for the transaction.
create function pg_temp.install_request_context()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24300000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'a4300000-0000-4000-8000-000000000091',
    'tenantId', '14300000-0000-4000-8000-000000000001',
    'organizationId', '24300000-0000-4000-8000-000000000001',
    'organizationAccountId', '54300000-0000-4000-8000-000000000001',
    'identityId', '44300000-0000-4000-8000-000000000001',
    'applicationRootId', '34300000-0000-4000-8000-000000000001',
    'sessionId', 'a4300000-0000-4000-8000-000000000092',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '2 hours',
    'accessVersion', current_access_version,
    'correlationId', 'a4300000-0000-4000-8000-000000000093',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));

  insert into expected_deadlines (key, expires_at)
  values ('context_expiry', operation_at + interval '2 hours');
end
$function$;

select pg_temp.install_request_context();

-- ============================================================================
-- DEFECT, confirmed independently of this fixture:
-- `pg_catalog.coalesce(...)` is used at lines 437, 479, 834 and 845 of
-- 20260910040755_compose_exact_record_access_decision.sql. COALESCE is a
-- SQL special form (like CASE), never a catalogued, schema-qualifiable
-- function, so every one of those calls raises `42883 function
-- pg_catalog.coalesce(...) does not exist` -- confirmed directly with
-- `select pg_catalog.coalesce(1,2)` against this same database, independent
-- of any fixture here. Line 437 sits in evaluate_record_permission_row_
-- scope_internal's saved-condition gate and is reached unconditionally on
-- every call for any active, correctly-typed record (every case below hits
-- it save the malformed-facts and pre-row-scope-refusal cases), so no
-- 'allowed' outcome, and no row-scope-derived 'refused', can currently be
-- produced by either function. Every assertion below still checks the exact
-- value the contract requires; pg_temp.decide() only prevents this one
-- server exception from aborting the rest of the file (see its comment).
-- ============================================================================

-- ============================================================================
-- Cases. Every assertion checks the exact value the brief and
-- organizationRecordAccessDecisionSchema require; pg_temp.decide()'s
-- exception catch (see its own comment) only keeps the one server exception
-- documented above from aborting every later, otherwise-independent case.
-- ============================================================================

-- ---- Account ownership (coverage allows) -----------------------------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000001'
  ) ->> 'outcome',
  'allowed',
  'the exact current account owner is admitted through the ownership route'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000001'
  ) -> 'matchedContributions' -> 0 -> 'route',
  '{"kind":"ownership"}'::jsonb,
  'the matched route is a bare ownership route'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000002'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a record owned by a different account refuses'
);

-- ---- Group/team ownership: current membership keeps its own deadline
-- (coverage allows) ----------------------------------------------------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000012'::uuid], 'team',
    'e4300000-0000-4000-8000-000000000011'
  ) ->> 'outcome',
  'allowed',
  'current Group ownership is admitted'
);
select is(
  (pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000012'::uuid], 'team',
    'e4300000-0000-4000-8000-000000000011'
  ) ->> 'validUntil')::timestamptz,
  (select expires_at from expected_deadlines where key = 'team_membership'),
  'Group ownership retains the exact current membership deadline'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000012'::uuid], 'team',
    'e4300000-0000-4000-8000-000000000012'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a Group the acting account never joined supplies no ownership route'
);

-- ---- Inherited ownership through the declared parent edge, and a parent's
-- direct share is not child ownership (must not be omitted) -----------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000013'::uuid], 'child',
    'e4300000-0000-4000-8000-000000000021'
  ) ->> 'outcome',
  'allowed',
  'inherited ownership admits through the declared parent edge to an owned parent'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000013'::uuid], 'child',
    'e4300000-0000-4000-8000-000000000021'
  ) -> 'matchedContributions' -> 0 -> 'route',
  '{"kind":"ownership"}'::jsonb,
  'inherited ownership still reports the bare ownership route kind, not a relationship'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000013'::uuid], 'child',
    'e4300000-0000-4000-8000-000000000022'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a parent that is only shared, not owned, contributes no ownership to its child'
);

-- ---- Direct share: admits with its own field bounds, expired refuses,
-- revoked refuses, no changeable field refuses update but not read, and a
-- share contributes nothing to create (must not be omitted) -----------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000003'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000004'
  ) ->> 'outcome',
  'allowed',
  'an active account share admits read'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000003'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000004'
  ) -> 'matchedContributions' -> 0 -> 'route',
  pg_catalog.jsonb_build_object(
    'kind', 'direct_share',
    'directShareId', 'b4300000-0000-4000-8000-000000000601',
    'directShareRevision', 1,
    'readableFieldIds', pg_catalog.jsonb_build_array(
      'b4300000-0000-4000-8000-000000000501', 'b4300000-0000-4000-8000-000000000502'
    ),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4300000-0000-4000-8000-000000000502')
  ),
  'the share contribution carries its own identity, revision and exact field bounds'
);
select is(
  (pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000003'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000004'
  ) ->> 'validUntil')::timestamptz,
  (select expires_at from expected_deadlines where key = 'share_active'),
  'the decision validUntil is the share''s own tighter deadline, not the two-hour context ceiling'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000005'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000004', 'update'
  ) ->> 'outcome',
  'allowed',
  'the same share admits update when it carries a changeable field'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000003'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000005'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'an expired share refuses'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000003'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000006'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a revoked share refuses'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000003'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000007'
  ) ->> 'outcome',
  'allowed',
  'a share with no changeable field still admits read'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000005'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000007', 'update'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'the same share with no changeable field refuses update'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000006'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000004', 'create'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a share contributes nothing to create even when its permission is held for create'
);

-- ---- Relationship routes: one-hop admit records sourceRecordId, an unowned
-- source refuses, an unheld source permission refuses, a two-hop route
-- admits, and a relationship cycle refuses (must not be omitted) ------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000008'::uuid], 'mid',
    'e4300000-0000-4000-8000-000000000031'
  ) ->> 'outcome',
  'allowed',
  'a record reachable from an owned source admits through the relationship route'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000008'::uuid], 'mid',
    'e4300000-0000-4000-8000-000000000031'
  ) -> 'matchedContributions' -> 0 -> 'route',
  pg_catalog.jsonb_build_object(
    'kind', 'relationship',
    'relationshipId', 'f4300000-0000-4000-8000-000000000001',
    'sourcePermissionId', 'c4300000-0000-4000-8000-000000000001',
    'sourceRecordId', 'e4300000-0000-4000-8000-000000000001'
  ),
  'the relationship contribution names the exact relationship, source permission and source record'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000008'::uuid], 'mid',
    'e4300000-0000-4000-8000-000000000032'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a record linked only from a source the acting account does not own refuses'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000009'::uuid], 'mid',
    'e4300000-0000-4000-8000-000000000033'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a relationship route whose source permission is not held refuses'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000010'::uuid], 'top',
    'e4300000-0000-4000-8000-000000000041'
  ) ->> 'outcome',
  'allowed',
  'a two-hop relationship route admits'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000010'::uuid], 'top',
    'e4300000-0000-4000-8000-000000000041'
  ) -> 'matchedContributions' -> 0 -> 'route' ->> 'sourceRecordId',
  'e4300000-0000-4000-8000-000000000031',
  'the two-hop contribution records its own immediate source record, not the root two hops back'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000011'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000008'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a relationship cycle refuses'
);

-- ---- Saved condition: false hides an owned row, and narrows all_records too
-- (must not be omitted) ------------------------------------------------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000014'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000001'
  ) ->> 'outcome',
  'allowed',
  'an owned row with the condition field true is admitted'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000014'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000003'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'a saved condition evaluating false hides an owned row'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000015'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000002'
  ) ->> 'outcome',
  'allowed',
  'all_records with the condition field true admits a row the acting account does not own'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000015'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000003'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'the saved condition narrows all_records too'
);

-- ---- The complete-pair rule: eligibility from one permission plus a route
-- matching only a different, unheld permission still refuses in both
-- directions, and matched contributions never name an alternative whose own
-- scope failed (must not be omitted) -----------------------------------------
select is(
  pg_temp.decide(
    array[
      'c4300000-0000-4000-8000-000000000001'::uuid,
      'c4300000-0000-4000-8000-000000000002'::uuid
    ], 'owned', 'e4300000-0000-4000-8000-000000000004'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'held ownership does not match a merely-shared record, and the unheld share alternative that would match is never consulted'
);
select is(
  pg_temp.decide(
    array[
      'c4300000-0000-4000-8000-000000000003'::uuid,
      'c4300000-0000-4000-8000-000000000004'::uuid
    ], 'owned', 'e4300000-0000-4000-8000-000000000001'
  ) ->> 'reasonCode',
  'record_scope_refused',
  'reversed: held direct-share does not match an unshared owned record, and the unheld ownership alternative that would match is never consulted'
);
select is(
  pg_catalog.jsonb_array_length(
    pg_temp.decide(
      array[
        'c4300000-0000-4000-8000-000000000001'::uuid,
        'c4300000-0000-4000-8000-000000000003'::uuid
      ], 'owned', 'e4300000-0000-4000-8000-000000000001'
    ) -> 'matchedContributions'
  ),
  1,
  'when ownership and share are both held but only ownership matches the record, exactly one contribution results'
);
select is(
  pg_temp.decide(
    array[
      'c4300000-0000-4000-8000-000000000001'::uuid,
      'c4300000-0000-4000-8000-000000000003'::uuid
    ], 'owned', 'e4300000-0000-4000-8000-000000000001'
  ) -> 'matchedContributions' -> 0 -> 'permission' ->> 'permissionId',
  'c4300000-0000-4000-8000-000000000001',
  'matched contributions never name an alternative whose own scope failed -- only the ownership permission is named, never the share permission'
);

-- ---- Evidence: refused evidence still carries the exact recordId, and a
-- decision for one record is never returned for another (must not be
-- omitted) --------------------------------------------------------------
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000002'
  ) ->> 'recordId',
  'e4300000-0000-4000-8000-000000000002',
  'refused evidence still carries the exact record identifier that was checked'
);
select isnt(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000001'
  ) ->> 'recordId',
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000012'::uuid], 'team',
    'e4300000-0000-4000-8000-000000000011'
  ) ->> 'recordId',
  'a decision for one record carries a different recordId than a decision made for another record'
);
select is(
  pg_temp.decide(
    array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned',
    'e4300000-0000-4000-8000-000000000001'
  ) ->> 'recordId',
  'e4300000-0000-4000-8000-000000000001',
  'and each decision still carries its own exact recordId, never the other one''s'
);

-- ---- Malformed facts raise 22023 (must not be omitted). These are
-- unaffected by the defect above: facts-shape validation is the first thing
-- evaluate_organization_record_access_internal does, well before the row-
-- scope composer is ever reached. --------------------------------------------
select throws_ok(
  $$
    select vortex_access.evaluate_organization_record_access_internal(
      pg_temp.declaration(array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned'),
      'e4300000-0000-4000-8000-000000000001',
      pg_temp.facts_for('owned') - 'edges'
    )
  $$,
  '22023', 'Record access facts are invalid',
  'facts missing a required top-level key are rejected'
);
select throws_ok(
  $$
    select vortex_access.evaluate_organization_record_access_internal(
      pg_temp.declaration(array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned'),
      'e4300000-0000-4000-8000-000000000001',
      pg_temp.facts_for('owned') || '{"extra":true}'::jsonb
    )
  $$,
  '22023', 'Record access facts are invalid',
  'facts carrying an undeclared top-level key are rejected'
);
select throws_ok(
  $$
    select vortex_access.evaluate_organization_record_access_internal(
      pg_temp.declaration(array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned'),
      'e4300000-0000-4000-8000-000000000001',
      pg_temp.facts_for('team')
    )
  $$,
  '22023', 'Record access facts are invalid',
  'facts whose binding differs from the declaration''s recordBinding are rejected'
);
select throws_ok(
  $$
    select vortex_access.evaluate_organization_record_access_internal(
      pg_temp.declaration(array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned'),
      'e4300000-0000-4000-8000-000000000001',
      pg_temp.facts_for('owned') || pg_catalog.jsonb_build_object(
        'recordTypes',
        (pg_temp.facts_for('owned') -> 'recordTypes') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'moduleRootId', '34300000-0000-4000-8000-000000000002',
            'recordTypeId', 'd4300000-0000-4000-8000-000000000001',
            'storageContractId', 'b4300000-0000-4000-8000-000000000001',
            'storageScope', 'application_contained',
            'ownershipMode', 'organization_account',
            'fields', '[]'::jsonb
          )
        )
      )
    )
  $$,
  '22023', 'Record access facts are invalid',
  'a duplicate record type identity is rejected'
);
select throws_ok(
  $$
    select vortex_access.evaluate_organization_record_access_internal(
      pg_temp.declaration(array['c4300000-0000-4000-8000-000000000001'::uuid], 'owned'),
      'e4300000-0000-4000-8000-000000000001',
      pg_temp.facts_for('owned') || pg_catalog.jsonb_build_object(
        'edges',
        (pg_temp.facts_for('owned') -> 'edges') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', 'f4300000-0000-4000-8000-000000000099',
            'fromRecordId', 'e4300000-0000-4000-8000-000000000001',
            'toRecordId', 'e4300000-0000-4000-8000-000000000001'
          )
        )
      )
    )
  $$,
  '22023', 'Record access facts are invalid',
  'an edge referencing an unknown relationship identity is rejected'
);

select * from finish();

rollback;
