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
  ('vortex_record_owner')
) as caller(role_name)
order by caller.role_name collate "C";
-- #401 (20260912011556_fixed_record_adapters.sql) granted exactly one role
-- execution of the decision: vortex_record_adapter, which owns the fixed record
-- adapters. That is the grant this function's own comment anticipated ("#45
-- grants its own adapter owner later"). The row-scope composer above keeps no
-- grant at all, including for that role: it is reached only by recursion inside
-- this decision, never by an adapter directly.
select ok(
  pg_catalog.has_function_privilege(
    'vortex_record_adapter',
    'vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)',
    'EXECUTE'
  ),
  'the record-adapter owner can execute the private decision function'
);
select is(
  (
    select pg_catalog.array_agg(
      grantee_role.rolname || '=' || privilege.privilege_type
      order by grantee_role.rolname collate "C"
    )
    from pg_catalog.pg_proc as procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) as privilege
    join pg_catalog.pg_roles as grantee_role on grantee_role.oid = privilege.grantee
    where procedure_row.oid =
      'vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'::regprocedure
  ),
  array['postgres=EXECUTE', 'vortex_record_adapter=EXECUTE'],
  'the decision grants execution to its owner and the record-adapter owner alone'
);

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
-- Every assertion below checks the exact value the contract requires. A server
-- exception is a failure here, not a result to be absorbed: it propagates and
-- fails the run.
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
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
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
-- Cases. Every assertion checks the exact value the brief and
-- organizationRecordAccessDecisionSchema require. A server exception is a
-- failure, not a result: it propagates and fails the run.
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

-- ============================================================================
-- Slice 3 (#35): the same decision proved through real database policies
-- under the restricted vortex_request role, not merely computable. Three
-- neutral business-row tables (test_neutral_alpha/beta/gamma) with row
-- security enabled and forced; owner-only fixture tables for the release
-- shape, installed bindings and captured decisions; five fixed adapters,
-- each security definer/owner postgres/empty search path, that resolve
-- their own installed binding, build their own facts from their own row and
-- related rows, call the one shared decision function above, and record the
-- outcome; the four policies on test_neutral_beta and one on
-- test_neutral_gamma; and a restricted-role matrix across two organisations,
-- two applications and several accounts. No migration change in this slice.
-- ============================================================================

create table vortex_access.test_neutral_alpha (
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  module_root_id uuid not null
    check (module_root_id = '34300500-0000-4000-8000-000000000003'::uuid),
  record_type_id uuid not null
    check (record_type_id = 'd4300500-0000-4000-8000-000000000001'::uuid),
  storage_contract_id uuid not null
    check (storage_contract_id = 'b4300500-0000-4000-8000-000000000001'::uuid),
  record_id uuid primary key,
  application_root_id uuid not null,
  owner_organization_account_id uuid,
  owner_group_id uuid,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'soft_deleted', 'removal_pending')),
  f_alpha_link uuid not null,
  foreign key (organization_id, owner_organization_account_id)
    references vortex_identity.organization_accounts (organization_id, organization_account_id),
  check (owner_organization_account_id is not null and owner_group_id is null)
);
alter table vortex_access.test_neutral_alpha enable row level security;
alter table vortex_access.test_neutral_alpha force row level security;

create table vortex_access.test_neutral_beta (
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  module_root_id uuid not null
    check (module_root_id = '34300500-0000-4000-8000-000000000003'::uuid),
  record_type_id uuid not null
    check (record_type_id = 'd4300500-0000-4000-8000-000000000002'::uuid),
  storage_contract_id uuid not null
    check (storage_contract_id = 'b4300500-0000-4000-8000-000000000002'::uuid),
  record_id uuid primary key,
  application_root_id uuid not null,
  owner_organization_account_id uuid,
  owner_group_id uuid,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'soft_deleted', 'removal_pending')),
  f_beta_actor text,
  f_beta_note text,
  foreign key (organization_id, owner_group_id)
    references vortex_access.organization_groups (organization_id, group_id),
  check (owner_group_id is not null and owner_organization_account_id is null)
);
alter table vortex_access.test_neutral_beta enable row level security;
alter table vortex_access.test_neutral_beta force row level security;

create table vortex_access.test_neutral_gamma (
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  module_root_id uuid not null
    check (module_root_id = '34300500-0000-4000-8000-000000000003'::uuid),
  record_type_id uuid not null
    check (record_type_id = 'd4300500-0000-4000-8000-000000000003'::uuid),
  storage_contract_id uuid not null
    check (storage_contract_id = 'b4300500-0000-4000-8000-000000000003'::uuid),
  record_id uuid primary key,
  application_root_id uuid not null,
  owner_organization_account_id uuid,
  owner_group_id uuid,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in ('active', 'soft_deleted', 'removal_pending')),
  f_gamma_link uuid not null,
  check (owner_organization_account_id is null and owner_group_id is null)
);
alter table vortex_access.test_neutral_gamma enable row level security;
alter table vortex_access.test_neutral_gamma force row level security;

-- Owner-only fixture: the installed binding per record type per organisation
-- and application, plus a superseded decoy no adapter should ever resolve.
create table vortex_access.test_neutral_bindings (
  binding_id uuid primary key,
  organization_id uuid not null,
  application_root_id uuid not null,
  type_key text not null check (type_key in ('alpha', 'beta', 'gamma')),
  module_root_id uuid not null,
  record_type_id uuid not null,
  storage_contract_id uuid not null,
  storage_scope text not null default 'application_contained',
  state text not null check (state in ('current', 'superseded'))
);
create unique index test_neutral_bindings_current_uq
  on vortex_access.test_neutral_bindings (organization_id, application_root_id, type_key)
  where state = 'current';

-- Owner-only fixture: evidence capture written by every adapter call.
create table vortex_access.test_neutral_decisions (
  decision_id bigint generated always as identity primary key,
  record_id uuid not null,
  operation_key text not null,
  decision jsonb not null,
  observed_at timestamptz not null default pg_catalog.clock_timestamp()
);

-- The release-level definition (record types with their ownershipMode, R1/R2/
-- R3, and the one saved condition on TB) is a definition-time constant, not a
-- per-call/per-binding value, so each adapter compiles it inline rather than
-- re-reading it every call -- exactly as bindings vary at runtime but the
-- shape a release publishes does not. This row exists as the authoritative,
-- auditable record of that same shape (see the R2/R3 direction note by the
-- gamma adapter for why R3 exists alongside R2).

-- ============================================================================
-- Five fixed adapters. Each is security definer, owner postgres, empty
-- search path, and resolves its own installed binding before building facts
-- and calling the one shared decision function.
-- ============================================================================

create function vortex_access.test_neutral_beta_read_allowed(
  p_row vortex_access.test_neutral_beta
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34300500-0000-4000-8000-000000000001';
  module_id constant uuid := '34300500-0000-4000-8000-000000000003';
  alpha_type_id constant uuid := 'd4300500-0000-4000-8000-000000000001';
  beta_type_id constant uuid := 'd4300500-0000-4000-8000-000000000002';
  r1_id constant uuid := 'f4300500-0000-4000-8000-000000000001';
  condition_id constant uuid := 'b4300500-0000-4000-8000-000000000101';
  f_beta_actor_id constant uuid := 'b4300500-0000-4000-8000-000000000201';
  permission_ids constant uuid[] := array[
    'c4300500-0000-4000-8000-000000000001'::uuid,
    'c4300500-0000-4000-8000-000000000002'::uuid,
    'c4300500-0000-4000-8000-000000000003'::uuid,
    'c4300500-0000-4000-8000-000000000004'::uuid
  ];
  ctx_org uuid := vortex_context.organization_id();
  beta_binding vortex_access.test_neutral_bindings;
  alpha_binding vortex_access.test_neutral_bindings;
  beta_record jsonb;
  alpha_records jsonb := '[]'::jsonb;
  alpha_edges jsonb := '[]'::jsonb;
  alpha_row vortex_access.test_neutral_alpha;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
begin
  select b.* into beta_binding from vortex_access.test_neutral_bindings as b
  where b.organization_id = ctx_org and b.application_root_id = app_root_id
    and b.type_key = 'beta' and b.state = 'current';
  select a.* into alpha_binding from vortex_access.test_neutral_bindings as a
  where a.organization_id = ctx_org and a.application_root_id = app_root_id
    and a.type_key = 'alpha' and a.state = 'current';

  if beta_binding.binding_id is null or alpha_binding.binding_id is null then
    return false;
  end if;

  beta_record := pg_catalog.jsonb_build_object(
    'recordScope', pg_catalog.jsonb_build_object(
      'storageScope', 'application_contained',
      'organizationId', p_row.organization_id,
      'moduleRootId', module_id,
      'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'recordId', p_row.record_id,
      'applicationRootId', p_row.application_root_id
    ),
    'ownerGroupId', p_row.owner_group_id,
    'lifecycleState', p_row.lifecycle_state,
    'fieldValues', pg_catalog.jsonb_build_object(
      f_beta_actor_id::text, p_row.f_beta_actor
    )
  );

  for alpha_row in
    select * from vortex_access.test_neutral_alpha where f_alpha_link = p_row.record_id
  loop
    alpha_records := alpha_records || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', alpha_row.organization_id,
        'moduleRootId', module_id,
        'recordTypeId', alpha_type_id,
        'storageContractId', alpha_binding.storage_contract_id,
        'recordId', alpha_row.record_id,
        'applicationRootId', alpha_row.application_root_id
      ),
      'ownerOrganizationAccountId', alpha_row.owner_organization_account_id,
      'lifecycleState', alpha_row.lifecycle_state,
      'fieldValues', '{}'::jsonb
    ));
    alpha_edges := alpha_edges || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', r1_id,
      'fromRecordId', alpha_row.record_id,
      'toRecordId', p_row.record_id
    ));
  end loop;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_id, 'recordTypeId', alpha_type_id,
        'storageContractId', alpha_binding.storage_contract_id,
        'storageScope', 'application_contained',
        'ownershipMode', 'organization_account', 'fields', '[]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_id, 'recordTypeId', beta_type_id,
        'storageContractId', beta_binding.storage_contract_id,
        'storageScope', 'application_contained',
        'ownershipMode', 'team',
        'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'fieldId', f_beta_actor_id, 'type', 'text'
        ))
      )
    ),
    'relationships', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', r1_id, 'fromModuleRootId', module_id, 'fromRecordTypeId', alpha_type_id,
      'toModuleRootId', module_id, 'toRecordTypeId', beta_type_id
    )),
    'sharingConditions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'conditionId', condition_id, 'sourceRecordTypeId', beta_type_id,
      'publishedRevision', 1,
      'contractFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
      'parameters', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', 'actor_account', 'type', 'text')
      ),
      'condition', pg_catalog.jsonb_build_object(
        'kind', 'comparison', 'operator', 'equals',
        'left', pg_catalog.jsonb_build_object('source', 'field', 'fieldId', f_beta_actor_id),
        'right', pg_catalog.jsonb_build_object('source', 'parameter', 'key', 'actor_account')
      ),
      'declaredFieldIds', pg_catalog.jsonb_build_array(f_beta_actor_id)
    )),
    'records', pg_catalog.jsonb_build_array(beta_record) || alpha_records,
    'edges', alpha_edges
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.beta.read',
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
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_row.record_id, facts
  );

  insert into vortex_access.test_neutral_decisions (record_id, operation_key, decision)
  values (p_row.record_id, 'record.beta.read', decision);

  return decision ->> 'outcome' = 'allowed';
end
$function$;

revoke execute on function vortex_access.test_neutral_beta_read_allowed(vortex_access.test_neutral_beta)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_neutral_beta_read_allowed(vortex_access.test_neutral_beta)
  to vortex_request;

create function vortex_access.test_neutral_beta_create_allowed(
  p_row vortex_access.test_neutral_beta
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34300500-0000-4000-8000-000000000001';
  module_id constant uuid := '34300500-0000-4000-8000-000000000003';
  beta_type_id constant uuid := 'd4300500-0000-4000-8000-000000000002';
  condition_id constant uuid := 'b4300500-0000-4000-8000-000000000101';
  f_beta_actor_id constant uuid := 'b4300500-0000-4000-8000-000000000201';
  permission_ids constant uuid[] := array['c4300500-0000-4000-8000-000000000005'::uuid];
  ctx_org uuid := vortex_context.organization_id();
  beta_binding vortex_access.test_neutral_bindings;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
begin
  select b.* into beta_binding from vortex_access.test_neutral_bindings as b
  where b.organization_id = ctx_org and b.application_root_id = app_root_id
    and b.type_key = 'beta' and b.state = 'current';
  if beta_binding.binding_id is null then
    return false;
  end if;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained', 'ownershipMode', 'team',
      'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'fieldId', f_beta_actor_id, 'type', 'text'
      ))
    )),
    'relationships', '[]'::jsonb,
    'sharingConditions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'conditionId', condition_id, 'sourceRecordTypeId', beta_type_id,
      'publishedRevision', 1,
      'contractFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
      'parameters', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', 'actor_account', 'type', 'text')
      ),
      'condition', pg_catalog.jsonb_build_object(
        'kind', 'comparison', 'operator', 'equals',
        'left', pg_catalog.jsonb_build_object('source', 'field', 'fieldId', f_beta_actor_id),
        'right', pg_catalog.jsonb_build_object('source', 'parameter', 'key', 'actor_account')
      ),
      'declaredFieldIds', pg_catalog.jsonb_build_array(f_beta_actor_id)
    )),
    'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', p_row.organization_id,
        'moduleRootId', module_id, 'recordTypeId', beta_type_id,
        'storageContractId', beta_binding.storage_contract_id,
        'recordId', p_row.record_id, 'applicationRootId', p_row.application_root_id
      ),
      'ownerGroupId', p_row.owner_group_id,
      'lifecycleState', p_row.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(f_beta_actor_id::text, p_row.f_beta_actor)
    )),
    'edges', '[]'::jsonb
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.beta.create',
    'action', pg_catalog.jsonb_build_object('actionKind', 'create'),
    'target', pg_catalog.jsonb_build_object('kind', 'application', 'applicationRootId', app_root_id),
    'requiredPermissions', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId', app_root_id, 'ownerKind', 'application',
        'ownerId', app_root_id, 'permissionId', item.value
      ) order by item.ordinality)
      from pg_catalog.unnest(permission_ids) with ordinality as item(value, ordinality)
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_row.record_id, facts
  );

  insert into vortex_access.test_neutral_decisions (record_id, operation_key, decision)
  values (p_row.record_id, 'record.beta.create', decision);

  return decision ->> 'outcome' = 'allowed';
end
$function$;

revoke execute on function vortex_access.test_neutral_beta_create_allowed(vortex_access.test_neutral_beta)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_neutral_beta_create_allowed(vortex_access.test_neutral_beta)
  to vortex_request;

create function vortex_access.test_neutral_beta_update_allowed(
  p_row vortex_access.test_neutral_beta
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34300500-0000-4000-8000-000000000001';
  module_id constant uuid := '34300500-0000-4000-8000-000000000003';
  beta_type_id constant uuid := 'd4300500-0000-4000-8000-000000000002';
  f_beta_actor_id constant uuid := 'b4300500-0000-4000-8000-000000000201';
  permission_ids constant uuid[] := array[
    'c4300500-0000-4000-8000-000000000006'::uuid,
    'c4300500-0000-4000-8000-000000000007'::uuid
  ];
  ctx_org uuid := vortex_context.organization_id();
  beta_binding vortex_access.test_neutral_bindings;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
begin
  select b.* into beta_binding from vortex_access.test_neutral_bindings as b
  where b.organization_id = ctx_org and b.application_root_id = app_root_id
    and b.type_key = 'beta' and b.state = 'current';
  if beta_binding.binding_id is null then
    return false;
  end if;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained', 'ownershipMode', 'team',
      'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'fieldId', f_beta_actor_id, 'type', 'text'
      ))
    )),
    'relationships', '[]'::jsonb,
    'sharingConditions', '[]'::jsonb,
    'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', p_row.organization_id,
        'moduleRootId', module_id, 'recordTypeId', beta_type_id,
        'storageContractId', beta_binding.storage_contract_id,
        'recordId', p_row.record_id, 'applicationRootId', p_row.application_root_id
      ),
      'ownerGroupId', p_row.owner_group_id,
      'lifecycleState', p_row.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(f_beta_actor_id::text, p_row.f_beta_actor)
    )),
    'edges', '[]'::jsonb
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.beta.update',
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
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_row.record_id, facts
  );

  insert into vortex_access.test_neutral_decisions (record_id, operation_key, decision)
  values (p_row.record_id, 'record.beta.update', decision);

  return decision ->> 'outcome' = 'allowed';
end
$function$;

revoke execute on function vortex_access.test_neutral_beta_update_allowed(vortex_access.test_neutral_beta)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_neutral_beta_update_allowed(vortex_access.test_neutral_beta)
  to vortex_request;

create function vortex_access.test_neutral_beta_delete_allowed(
  p_row vortex_access.test_neutral_beta
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34300500-0000-4000-8000-000000000001';
  module_id constant uuid := '34300500-0000-4000-8000-000000000003';
  beta_type_id constant uuid := 'd4300500-0000-4000-8000-000000000002';
  f_beta_actor_id constant uuid := 'b4300500-0000-4000-8000-000000000201';
  permission_ids constant uuid[] := array['c4300500-0000-4000-8000-000000000008'::uuid];
  ctx_org uuid := vortex_context.organization_id();
  beta_binding vortex_access.test_neutral_bindings;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
begin
  select b.* into beta_binding from vortex_access.test_neutral_bindings as b
  where b.organization_id = ctx_org and b.application_root_id = app_root_id
    and b.type_key = 'beta' and b.state = 'current';
  if beta_binding.binding_id is null then
    return false;
  end if;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained', 'ownershipMode', 'team',
      'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'fieldId', f_beta_actor_id, 'type', 'text'
      ))
    )),
    'relationships', '[]'::jsonb,
    'sharingConditions', '[]'::jsonb,
    'records', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', p_row.organization_id,
        'moduleRootId', module_id, 'recordTypeId', beta_type_id,
        'storageContractId', beta_binding.storage_contract_id,
        'recordId', p_row.record_id, 'applicationRootId', p_row.application_root_id
      ),
      'ownerGroupId', p_row.owner_group_id,
      'lifecycleState', p_row.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(f_beta_actor_id::text, p_row.f_beta_actor)
    )),
    'edges', '[]'::jsonb
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.beta.delete',
    'action', pg_catalog.jsonb_build_object('actionKind', 'delete'),
    'target', pg_catalog.jsonb_build_object('kind', 'application', 'applicationRootId', app_root_id),
    'requiredPermissions', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId', app_root_id, 'ownerKind', 'application',
        'ownerId', app_root_id, 'permissionId', item.value
      ) order by item.ordinality)
      from pg_catalog.unnest(permission_ids) with ordinality as item(value, ordinality)
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', beta_type_id,
      'storageContractId', beta_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_row.record_id, facts
  );

  insert into vortex_access.test_neutral_decisions (record_id, operation_key, decision)
  values (p_row.record_id, 'record.beta.delete', decision);

  return decision ->> 'outcome' = 'allowed';
end
$function$;

revoke execute on function vortex_access.test_neutral_beta_delete_allowed(vortex_access.test_neutral_beta)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_neutral_beta_delete_allowed(vortex_access.test_neutral_beta)
  to vortex_request;

create function vortex_access.test_neutral_gamma_read_allowed(
  p_row vortex_access.test_neutral_gamma
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  app_root_id constant uuid := '34300500-0000-4000-8000-000000000001';
  module_id constant uuid := '34300500-0000-4000-8000-000000000003';
  alpha_type_id constant uuid := 'd4300500-0000-4000-8000-000000000001';
  beta_type_id constant uuid := 'd4300500-0000-4000-8000-000000000002';
  gamma_type_id constant uuid := 'd4300500-0000-4000-8000-000000000003';
  r1_id constant uuid := 'f4300500-0000-4000-8000-000000000001';
  -- R2 (TG->TB) is gamma's ownershipRelationshipId for the inherited-owner
  -- chase; it walks FROM the child TO the owning parent, so its declared
  -- toRecordTypeId is TB. The relationship-route validation inside
  -- evaluate_record_permission_row_scope_internal instead requires the
  -- ROUTE relationship's toRecordTypeId to equal the CURRENT target
  -- record's own type -- here that target is always the gamma row itself,
  -- so a route reaching it needs toRecordTypeId = TG. One relationship id
  -- cannot satisfy both directions at once, so R3 (TB->TG) is the distinct,
  -- oppositely-directed relationship gamma.read.related's route resolves
  -- against; both are compiled from the same f_gamma_link column. Confirmed
  -- by direct inspection of evaluate_record_permission_row_scope_internal's
  -- relationship-route check (raises 22023 'Record access facts are
  -- invalid' otherwise) -- see the defect note near the gamma catalogue seed.
  r2_id constant uuid := 'f4300500-0000-4000-8000-000000000002';
  r3_id constant uuid := 'f4300500-0000-4000-8000-000000000003';
  f_beta_actor_id constant uuid := 'b4300500-0000-4000-8000-000000000201';
  permission_ids constant uuid[] := array[
    'c4300500-0000-4000-8000-00000000000a'::uuid,
    'c4300500-0000-4000-8000-00000000000b'::uuid
  ];
  ctx_org uuid := vortex_context.organization_id();
  alpha_binding vortex_access.test_neutral_bindings;
  beta_binding vortex_access.test_neutral_bindings;
  gamma_binding vortex_access.test_neutral_bindings;
  gamma_record jsonb;
  beta_parent vortex_access.test_neutral_beta;
  beta_record jsonb := 'null'::jsonb;
  alpha_records jsonb := '[]'::jsonb;
  edges jsonb := '[]'::jsonb;
  alpha_row vortex_access.test_neutral_alpha;
  records jsonb;
  facts jsonb;
  declaration jsonb;
  decision jsonb;
begin
  select a.* into alpha_binding from vortex_access.test_neutral_bindings as a
  where a.organization_id = ctx_org and a.application_root_id = app_root_id
    and a.type_key = 'alpha' and a.state = 'current';
  select b.* into beta_binding from vortex_access.test_neutral_bindings as b
  where b.organization_id = ctx_org and b.application_root_id = app_root_id
    and b.type_key = 'beta' and b.state = 'current';
  select g.* into gamma_binding from vortex_access.test_neutral_bindings as g
  where g.organization_id = ctx_org and g.application_root_id = app_root_id
    and g.type_key = 'gamma' and g.state = 'current';

  if alpha_binding.binding_id is null or beta_binding.binding_id is null
    or gamma_binding.binding_id is null then
    return false;
  end if;

  gamma_record := pg_catalog.jsonb_build_object(
    'recordScope', pg_catalog.jsonb_build_object(
      'storageScope', 'application_contained',
      'organizationId', p_row.organization_id,
      'moduleRootId', module_id, 'recordTypeId', gamma_type_id,
      'storageContractId', gamma_binding.storage_contract_id,
      'recordId', p_row.record_id, 'applicationRootId', p_row.application_root_id
    ),
    'lifecycleState', p_row.lifecycle_state,
    'fieldValues', '{}'::jsonb
  );

  select * into beta_parent from vortex_access.test_neutral_beta
  where record_id = p_row.f_gamma_link;

  records := pg_catalog.jsonb_build_array(gamma_record);

  if found then
    beta_record := pg_catalog.jsonb_build_object(
      'recordScope', pg_catalog.jsonb_build_object(
        'storageScope', 'application_contained',
        'organizationId', beta_parent.organization_id,
        'moduleRootId', module_id, 'recordTypeId', beta_type_id,
        'storageContractId', beta_binding.storage_contract_id,
        'recordId', beta_parent.record_id, 'applicationRootId', beta_parent.application_root_id
      ),
      'ownerGroupId', beta_parent.owner_group_id,
      'lifecycleState', beta_parent.lifecycle_state,
      'fieldValues', pg_catalog.jsonb_build_object(f_beta_actor_id::text, beta_parent.f_beta_actor)
    );
    records := records || pg_catalog.jsonb_build_array(beta_record);
    edges := edges || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', r2_id, 'fromRecordId', p_row.record_id, 'toRecordId', beta_parent.record_id
    )) || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', r3_id, 'fromRecordId', beta_parent.record_id, 'toRecordId', p_row.record_id
    ));

    for alpha_row in
      select * from vortex_access.test_neutral_alpha where f_alpha_link = beta_parent.record_id
    loop
      alpha_records := alpha_records || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordScope', pg_catalog.jsonb_build_object(
          'storageScope', 'application_contained',
          'organizationId', alpha_row.organization_id,
          'moduleRootId', module_id, 'recordTypeId', alpha_type_id,
          'storageContractId', alpha_binding.storage_contract_id,
          'recordId', alpha_row.record_id, 'applicationRootId', alpha_row.application_root_id
        ),
        'ownerOrganizationAccountId', alpha_row.owner_organization_account_id,
        'lifecycleState', alpha_row.lifecycle_state,
        'fieldValues', '{}'::jsonb
      ));
      edges := edges || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'relationshipId', r1_id, 'fromRecordId', alpha_row.record_id, 'toRecordId', beta_parent.record_id
      ));
    end loop;
    records := records || alpha_records;
  end if;

  facts := pg_catalog.jsonb_build_object(
    'binding', pg_catalog.jsonb_build_object(
      'moduleRootId', module_id, 'recordTypeId', gamma_type_id,
      'storageContractId', gamma_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recordTypes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_id, 'recordTypeId', alpha_type_id,
        'storageContractId', alpha_binding.storage_contract_id,
        'storageScope', 'application_contained',
        'ownershipMode', 'organization_account', 'fields', '[]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_id, 'recordTypeId', beta_type_id,
        'storageContractId', beta_binding.storage_contract_id,
        'storageScope', 'application_contained', 'ownershipMode', 'team',
        'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'fieldId', f_beta_actor_id, 'type', 'text'
        ))
      ),
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_id, 'recordTypeId', gamma_type_id,
        'storageContractId', gamma_binding.storage_contract_id,
        'storageScope', 'application_contained', 'ownershipMode', 'inherited',
        'ownershipRelationshipId', r2_id, 'fields', '[]'::jsonb
      )
    ),
    'relationships', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'relationshipId', r1_id, 'fromModuleRootId', module_id, 'fromRecordTypeId', alpha_type_id,
        'toModuleRootId', module_id, 'toRecordTypeId', beta_type_id
      ),
      pg_catalog.jsonb_build_object(
        'relationshipId', r2_id, 'fromModuleRootId', module_id, 'fromRecordTypeId', gamma_type_id,
        'toModuleRootId', module_id, 'toRecordTypeId', beta_type_id
      ),
      pg_catalog.jsonb_build_object(
        'relationshipId', r3_id, 'fromModuleRootId', module_id, 'fromRecordTypeId', beta_type_id,
        'toModuleRootId', module_id, 'toRecordTypeId', gamma_type_id
      )
    ),
    'sharingConditions', '[]'::jsonb,
    'records', records,
    'edges', edges
  );

  declaration := pg_catalog.jsonb_build_object(
    'operationKey', 'record.gamma.read',
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
      'moduleRootId', module_id, 'recordTypeId', gamma_type_id,
      'storageContractId', gamma_binding.storage_contract_id,
      'storageScope', 'application_contained'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  );

  decision := vortex_access.evaluate_organization_record_access_internal(
    declaration, p_row.record_id, facts
  );

  insert into vortex_access.test_neutral_decisions (record_id, operation_key, decision)
  values (p_row.record_id, 'record.gamma.read', decision);

  return decision ->> 'outcome' = 'allowed';
end
$function$;

revoke execute on function vortex_access.test_neutral_gamma_read_allowed(vortex_access.test_neutral_gamma)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_neutral_gamma_read_allowed(vortex_access.test_neutral_gamma)
  to vortex_request;

-- ============================================================================
-- Policies and grants.
-- ============================================================================

create policy test_neutral_beta_select on vortex_access.test_neutral_beta
  for select to vortex_request
  using (vortex_access.test_neutral_beta_read_allowed(test_neutral_beta));
create policy test_neutral_beta_insert on vortex_access.test_neutral_beta
  for insert to vortex_request
  with check (vortex_access.test_neutral_beta_create_allowed(test_neutral_beta));
create policy test_neutral_beta_update on vortex_access.test_neutral_beta
  for update to vortex_request
  using (vortex_access.test_neutral_beta_update_allowed(test_neutral_beta))
  with check (vortex_access.test_neutral_beta_update_allowed(test_neutral_beta));
create policy test_neutral_beta_delete on vortex_access.test_neutral_beta
  for delete to vortex_request
  using (vortex_access.test_neutral_beta_delete_allowed(test_neutral_beta));

create policy test_neutral_gamma_select on vortex_access.test_neutral_gamma
  for select to vortex_request
  using (vortex_access.test_neutral_gamma_read_allowed(test_neutral_gamma));

grant select, insert, update, delete on vortex_access.test_neutral_beta to vortex_request;
grant select on vortex_access.test_neutral_gamma to vortex_request;

-- ============================================================================
-- Two-organisation identity/catalogue/role/group fixture.
-- ============================================================================

create function pg_temp.build_row_policy_identity()
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
    '14300500-0000-4000-8000-000000000001', 'row_policy_proof',
    'Row policy proof', 'active', operation_at,
    '94300500-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values
  (
    '24300500-0000-4000-8000-000000000001', '14300500-0000-4000-8000-000000000001',
    'row_policy_org1', 'Row policy org1', 'active', operation_at,
    '94300500-0000-4000-8000-000000000001', operation_at, 1
  ), (
    '24300500-0000-4000-8000-000000000002', '14300500-0000-4000-8000-000000000001',
    'row_policy_org2', 'Row policy org2', 'active', operation_at,
    '94300500-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('44300500-0000-4000-8000-000000000001', 'active', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000001', 1),
    ('44300500-0000-4000-8000-000000000002', 'active', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000002', 1),
    ('44300500-0000-4000-8000-000000000003', 'active', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000003', 1),
    ('44300500-0000-4000-8000-000000000004', 'active', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000004', 1);

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('54300500-0000-4000-8000-000000000001', '24300500-0000-4000-8000-000000000001',
      '44300500-0000-4000-8000-000000000001', 'Org1 account1', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000011', 1),
    ('54300500-0000-4000-8000-000000000002', '24300500-0000-4000-8000-000000000002',
      '44300500-0000-4000-8000-000000000002', 'Org2 account2', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000012', 1),
    ('54300500-0000-4000-8000-000000000003', '24300500-0000-4000-8000-000000000001',
      '44300500-0000-4000-8000-000000000003', 'Org1 account3 (shared-only)', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000013', 1),
    ('54300500-0000-4000-8000-000000000004', '24300500-0000-4000-8000-000000000001',
      '44300500-0000-4000-8000-000000000004', 'Org1 account4 (settings-only)', 'active',
      operation_at - interval '1 minute', operation_at, operation_at,
      '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000014', 1);

  perform 1 from vortex_access.initialize_organization_access_version(
    '24300500-0000-4000-8000-000000000001', '94300500-0000-4000-8000-000000000001',
    'a4300500-0000-4000-8000-000000000021'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24300500-0000-4000-8000-000000000001', '94300500-0000-4000-8000-000000000001',
    'a4300500-0000-4000-8000-000000000022'
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    '24300500-0000-4000-8000-000000000002', '94300500-0000-4000-8000-000000000001',
    'a4300500-0000-4000-8000-000000000023'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24300500-0000-4000-8000-000000000002', '94300500-0000-4000-8000-000000000001',
    'a4300500-0000-4000-8000-000000000024'
  );

  insert into vortex_access.organization_groups (
    organization_id, group_id, group_key, label, state, revision,
    created_by, created_at, changed_by, changed_at, change_correlation_id
  ) values
  (
    '24300500-0000-4000-8000-000000000001', '84300500-0000-4000-8000-000000000001',
    'org1_team', 'Org1 team', 'active', 1,
    '94300500-0000-4000-8000-000000000001', operation_at,
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000031'
  ), (
    '24300500-0000-4000-8000-000000000002', '84300500-0000-4000-8000-000000000002',
    'org2_team', 'Org2 team', 'active', 1,
    '94300500-0000-4000-8000-000000000001', operation_at,
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000032'
  );

  insert into vortex_access.organization_group_memberships (
    organization_id, membership_id, group_id, organization_account_id,
    revision, starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values
  (
    '24300500-0000-4000-8000-000000000001', '84300500-0000-4000-8000-000000000101',
    '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001',
    1, operation_at - interval '1 minute', null, 'live',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000041',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000041'
  ), (
    '24300500-0000-4000-8000-000000000001', '84300500-0000-4000-8000-000000000102',
    '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000003',
    1, operation_at - interval '1 minute', null, 'live',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000042',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000042'
  ), (
    '24300500-0000-4000-8000-000000000001', '84300500-0000-4000-8000-000000000103',
    '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000004',
    1, operation_at - interval '1 minute', null, 'live',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000043',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000043'
  ), (
    '24300500-0000-4000-8000-000000000002', '84300500-0000-4000-8000-000000000104',
    '84300500-0000-4000-8000-000000000002', '54300500-0000-4000-8000-000000000002',
    1, operation_at - interval '1 minute', null, 'live',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000044',
    '94300500-0000-4000-8000-000000000001', operation_at, 'a4300500-0000-4000-8000-000000000044'
  );
end
$function$;

select pg_temp.build_row_policy_identity();

-- Catalogue: 13 permissions, registered identically (same app1 root, same
-- module, same permission ids) under each organisation independently -- both
-- orgs install "the same app1", each with its own registration/catalogue row.
create function pg_temp.seed_row_policy_catalogue(p_organization_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  app1_root constant uuid := '34300500-0000-4000-8000-000000000001';
  module_id constant uuid := '34300500-0000-4000-8000-000000000003';
  ta constant uuid := 'd4300500-0000-4000-8000-000000000001';
  tb constant uuid := 'd4300500-0000-4000-8000-000000000002';
  tg constant uuid := 'd4300500-0000-4000-8000-000000000003';
  condition_id constant uuid := 'b4300500-0000-4000-8000-000000000101';
  r1_id constant uuid := 'f4300500-0000-4000-8000-000000000001';
  r3_id constant uuid := 'f4300500-0000-4000-8000-000000000003';
begin
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', app1_root, 1, 'active', 'register',
    'row_policy.app1', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    operation_at, '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000051'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', app1_root, 'active', 1,
    'row_policy.app1', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    operation_at, '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000051'
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
    p_organization_id, 'application', app1_root, 1, app1_root, 'application',
    app1_root, permission.permission_id, permission.permission_key,
    permission.label, 'Row policy fixture.', permission.record_type_id,
    permission.action_kind, null, false, 'application', 'row_policy.app1',
    app1_root, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64),
    permission.record_scope
  from (values
    ('c4300500-0000-4000-8000-000000000002'::uuid, 'row_policy.beta.read.own', 'Beta read own',
      tb, 'read', '1',
      ('{"routes":[{"kind":"ownership"}],"savedCondition":{"conditionId":"' || condition_id
        || '","publishedRevision":1,"contractFingerprint":"sha256:' || pg_catalog.repeat('7', 64)
        || '","parameterBindings":[{"key":"actor_account","source":"current_organization_account_id"}]}}')::jsonb),
    ('c4300500-0000-4000-8000-000000000001'::uuid, 'row_policy.beta.read.all', 'Beta read all',
      tb, 'read', '2', '{"routes":[{"kind":"all_records"}]}'::jsonb),
    ('c4300500-0000-4000-8000-000000000004'::uuid, 'row_policy.beta.read.shared', 'Beta read shared',
      tb, 'read', '3', '{"routes":[{"kind":"direct_share"}]}'::jsonb),
    ('c4300500-0000-4000-8000-000000000003'::uuid, 'row_policy.beta.read.related', 'Beta read related',
      tb, 'read', '4',
      ('{"routes":[{"kind":"relationship","relationshipId":"' || r1_id
        || '","sourcePermissionId":"c4300500-0000-4000-8000-000000000009"}]}')::jsonb),
    ('c4300500-0000-4000-8000-000000000005'::uuid, 'row_policy.beta.create.own', 'Beta create own',
      tb, 'create', '5',
      ('{"routes":[{"kind":"ownership"}],"savedCondition":{"conditionId":"' || condition_id
        || '","publishedRevision":1,"contractFingerprint":"sha256:' || pg_catalog.repeat('7', 64)
        || '","parameterBindings":[{"key":"actor_account","source":"current_organization_account_id"}]}}')::jsonb),
    ('c4300500-0000-4000-8000-000000000006'::uuid, 'row_policy.beta.update.own', 'Beta update own',
      tb, 'update', '6', '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300500-0000-4000-8000-000000000007'::uuid, 'row_policy.beta.update.shared', 'Beta update shared',
      tb, 'update', '7', '{"routes":[{"kind":"direct_share"}]}'::jsonb),
    ('c4300500-0000-4000-8000-000000000008'::uuid, 'row_policy.beta.delete.own', 'Beta delete own',
      tb, 'delete', '8', '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300500-0000-4000-8000-000000000009'::uuid, 'row_policy.alpha.read', 'Alpha read',
      ta, 'read', '9', '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300500-0000-4000-8000-00000000000a'::uuid, 'row_policy.gamma.read.own', 'Gamma read own',
      tg, 'read', 'a', '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4300500-0000-4000-8000-00000000000b'::uuid, 'row_policy.gamma.read.related', 'Gamma read related',
      tg, 'read', 'b',
      ('{"routes":[{"kind":"relationship","relationshipId":"' || r3_id
        || '","sourcePermissionId":"c4300500-0000-4000-8000-000000000003"}]}')::jsonb),
    ('c4300500-0000-4000-8000-00000000000c'::uuid, 'row_policy.beta.read.legacy', 'Beta read legacy',
      tb, 'read', 'c', null::jsonb),
    ('c4300500-0000-4000-8000-00000000000d'::uuid, 'row_policy.beta.settings.read', 'Beta settings read',
      null, 'read', 'd', null::jsonb)
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
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = app1_root;
end
$function$;

select pg_temp.seed_row_policy_catalogue('24300500-0000-4000-8000-000000000001');
select pg_temp.seed_row_policy_catalogue('24300500-0000-4000-8000-000000000002');

-- One standing direct role per held permission, mirroring 430's seed_role but
-- parameterized by organisation.
create function pg_temp.seed_row_policy_role(
  p_organization_id uuid, p_role_id uuid, p_role_key text, p_permission_id uuid
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
    p_organization_id, p_role_id, 'custom', p_role_key, 1,
    '94300500-0000-4000-8000-000000000001', operation_at
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
    entry.permission_id, entry.registration_kind, entry.registration_owner_id,
    entry.registration_revision, registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id is not distinct from entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = p_organization_id and entry.permission_id = p_permission_id;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description, changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'custom', 'active', 'standard', 'standing',
    1, 1, p_role_key, 'Row policy role', 'Row policy role fixture.',
    '94300500-0000-4000-8000-000000000001', operation_at, p_role_id
  );
end
$function$;

-- account1 (org1): the full working set except read.all/legacy/settings.
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000001', 'a1_beta_read_own', 'c4300500-0000-4000-8000-000000000002');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000002', 'a1_beta_read_related', 'c4300500-0000-4000-8000-000000000003');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000003', 'a1_beta_create_own', 'c4300500-0000-4000-8000-000000000005');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000004', 'a1_beta_update_own', 'c4300500-0000-4000-8000-000000000006');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000005', 'a1_beta_update_shared', 'c4300500-0000-4000-8000-000000000007');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000006', 'a1_beta_delete_own', 'c4300500-0000-4000-8000-000000000008');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000007', 'a1_alpha_read', 'c4300500-0000-4000-8000-000000000009');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000008', 'a1_gamma_read_own', 'c4300500-0000-4000-8000-00000000000a');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000009', 'a1_gamma_read_related', 'c4300500-0000-4000-8000-00000000000b');

-- account2 (org2): minimal mirror of the main matrix.
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000002',
  '64300500-0000-4000-8000-000000000011', 'a2_beta_read_own', 'c4300500-0000-4000-8000-000000000002');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000002',
  '64300500-0000-4000-8000-000000000012', 'a2_beta_create_own', 'c4300500-0000-4000-8000-000000000005');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000002',
  '64300500-0000-4000-8000-000000000013', 'a2_beta_update_own', 'c4300500-0000-4000-8000-000000000006');
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000002',
  '64300500-0000-4000-8000-000000000014', 'a2_beta_delete_own', 'c4300500-0000-4000-8000-000000000008');

-- account3 (org1): shared-read only, for the reversed complete-pair case.
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000021', 'a3_beta_read_shared', 'c4300500-0000-4000-8000-000000000004');

-- account4 (org1): non-record settings permission only.
select pg_temp.seed_row_policy_role('24300500-0000-4000-8000-000000000001',
  '64300500-0000-4000-8000-000000000031', 'a4_beta_settings_read', 'c4300500-0000-4000-8000-00000000000d');

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select assignment.organization_id, assignment.role_assignment_id, assignment.role_id,
  'organization_account', assignment.account_id, null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '4 hours', 'live',
  '94300500-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  assignment.correlation_id, '94300500-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), assignment.correlation_id
from (values
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000001'::uuid, '64300500-0000-4000-8000-000000000001'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000061'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000002'::uuid, '64300500-0000-4000-8000-000000000002'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000062'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000003'::uuid, '64300500-0000-4000-8000-000000000003'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000063'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000004'::uuid, '64300500-0000-4000-8000-000000000004'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000064'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000005'::uuid, '64300500-0000-4000-8000-000000000005'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000065'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000006'::uuid, '64300500-0000-4000-8000-000000000006'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000066'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000007'::uuid, '64300500-0000-4000-8000-000000000007'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000067'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000008'::uuid, '64300500-0000-4000-8000-000000000008'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000068'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000009'::uuid, '64300500-0000-4000-8000-000000000009'::uuid, '54300500-0000-4000-8000-000000000001'::uuid, 'a4300500-0000-4000-8000-000000000069'::uuid),
  ('24300500-0000-4000-8000-000000000002'::uuid, '74300500-0000-4000-8000-000000000011'::uuid, '64300500-0000-4000-8000-000000000011'::uuid, '54300500-0000-4000-8000-000000000002'::uuid, 'a4300500-0000-4000-8000-000000000071'::uuid),
  ('24300500-0000-4000-8000-000000000002'::uuid, '74300500-0000-4000-8000-000000000012'::uuid, '64300500-0000-4000-8000-000000000012'::uuid, '54300500-0000-4000-8000-000000000002'::uuid, 'a4300500-0000-4000-8000-000000000072'::uuid),
  ('24300500-0000-4000-8000-000000000002'::uuid, '74300500-0000-4000-8000-000000000013'::uuid, '64300500-0000-4000-8000-000000000013'::uuid, '54300500-0000-4000-8000-000000000002'::uuid, 'a4300500-0000-4000-8000-000000000073'::uuid),
  ('24300500-0000-4000-8000-000000000002'::uuid, '74300500-0000-4000-8000-000000000014'::uuid, '64300500-0000-4000-8000-000000000014'::uuid, '54300500-0000-4000-8000-000000000002'::uuid, 'a4300500-0000-4000-8000-000000000074'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000021'::uuid, '64300500-0000-4000-8000-000000000021'::uuid, '54300500-0000-4000-8000-000000000003'::uuid, 'a4300500-0000-4000-8000-000000000081'::uuid),
  ('24300500-0000-4000-8000-000000000001'::uuid, '74300500-0000-4000-8000-000000000031'::uuid, '64300500-0000-4000-8000-000000000031'::uuid, '54300500-0000-4000-8000-000000000004'::uuid, 'a4300500-0000-4000-8000-000000000091'::uuid)
) as assignment(organization_id, role_assignment_id, role_id, account_id, correlation_id);

set constraints all immediate;
set constraints all deferred;

-- Bindings: current for every (org, app1, type), plus one superseded decoy
-- pointing at a wrong storage contract id that must never be resolved.
insert into vortex_access.test_neutral_bindings (
  binding_id, organization_id, application_root_id, type_key,
  module_root_id, record_type_id, storage_contract_id, storage_scope, state
) values
  ('b4300500-0000-4000-8000-000000000301', '24300500-0000-4000-8000-000000000001',
    '34300500-0000-4000-8000-000000000001', 'alpha', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000001', 'b4300500-0000-4000-8000-000000000001',
    'application_contained', 'current'),
  ('b4300500-0000-4000-8000-000000000302', '24300500-0000-4000-8000-000000000001',
    '34300500-0000-4000-8000-000000000001', 'beta', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
    'application_contained', 'current'),
  ('b4300500-0000-4000-8000-000000000303', '24300500-0000-4000-8000-000000000001',
    '34300500-0000-4000-8000-000000000001', 'gamma', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000003', 'b4300500-0000-4000-8000-000000000003',
    'application_contained', 'current'),
  ('b4300500-0000-4000-8000-000000000304', '24300500-0000-4000-8000-000000000002',
    '34300500-0000-4000-8000-000000000001', 'alpha', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000001', 'b4300500-0000-4000-8000-000000000001',
    'application_contained', 'current'),
  ('b4300500-0000-4000-8000-000000000305', '24300500-0000-4000-8000-000000000002',
    '34300500-0000-4000-8000-000000000001', 'beta', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
    'application_contained', 'current'),
  ('b4300500-0000-4000-8000-000000000306', '24300500-0000-4000-8000-000000000002',
    '34300500-0000-4000-8000-000000000001', 'gamma', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000003', 'b4300500-0000-4000-8000-000000000003',
    'application_contained', 'current'),
  ('b4300500-0000-4000-8000-000000000399', '24300500-0000-4000-8000-000000000001',
    '34300500-0000-4000-8000-000000000001', 'beta', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000099',
    'application_contained', 'superseded');

-- A foreign team in org1 that neither account1, account3 nor account4 belong
-- to, used for "owned by someone else" negative rows.
insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '24300500-0000-4000-8000-000000000001', '84300500-0000-4000-8000-000000000005',
  'org1_foreign_team', 'Org1 foreign team', 'active', 1,
  '94300500-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  '94300500-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4300500-0000-4000-8000-000000000035'
);

-- Alpha rows (org1/app1, individually owned by account1).
insert into vortex_access.test_neutral_alpha (
  organization_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, owner_organization_account_id, f_alpha_link
) values
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000001', 'b4300500-0000-4000-8000-000000000001',
   'e4300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
   '54300500-0000-4000-8000-000000000001', 'e4300500-0000-4000-8000-000000000010'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000001', 'b4300500-0000-4000-8000-000000000001',
   'e4300500-0000-4000-8000-000000000003', '34300500-0000-4000-8000-000000000001',
   '54300500-0000-4000-8000-000000000001', 'e4300500-0000-4000-8000-000000000022');

-- Beta rows: org1/app1 (team-owned unless noted), org1/app2 (app separation),
-- org2/app1 (cross-organisation).
insert into vortex_access.test_neutral_beta (
  organization_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, owner_group_id, f_beta_actor, f_beta_note
) values
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000010', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n10'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000011', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000002', 'n11'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000013', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n13'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000015', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n15'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000016', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n16'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000017', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n17'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000018', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000005', '54300500-0000-4000-8000-000000000001', 'n18'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000019', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n19'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000020', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n20'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000021', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000005', '54300500-0000-4000-8000-000000000001', 'n21'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000022', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000005', '54300500-0000-4000-8000-000000000001', 'n22'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000023', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000005', '54300500-0000-4000-8000-000000000001', 'n23'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000024', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000005', '54300500-0000-4000-8000-000000000001', 'n24'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000060', '34300500-0000-4000-8000-000000000002',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n60'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000061', '34300500-0000-4000-8000-000000000002',
   '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n61'),
  ('24300500-0000-4000-8000-000000000002', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000043', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000002', '54300500-0000-4000-8000-000000000002', 'n43'),
  ('24300500-0000-4000-8000-000000000002', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000044', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000002', '54300500-0000-4000-8000-000000000002', 'n44'),
  ('24300500-0000-4000-8000-000000000002', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
   'e4300500-0000-4000-8000-000000000045', '34300500-0000-4000-8000-000000000001',
   '84300500-0000-4000-8000-000000000002', '54300500-0000-4000-8000-000000000002', 'n45');

-- Gamma rows (org1/app1). e0030 chases ownership to a team-owned parent
-- (e0010); e0040 chases to a foreign-team parent but is reachable through the
-- two-hop relationship route via alpha e0003 -> beta e0022.
insert into vortex_access.test_neutral_gamma (
  organization_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, f_gamma_link
) values
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000003', 'b4300500-0000-4000-8000-000000000003',
   'e4300500-0000-4000-8000-000000000030', '34300500-0000-4000-8000-000000000001',
   'e4300500-0000-4000-8000-000000000010'),
  ('24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
   'd4300500-0000-4000-8000-000000000003', 'b4300500-0000-4000-8000-000000000003',
   'e4300500-0000-4000-8000-000000000040', '34300500-0000-4000-8000-000000000001',
   'e4300500-0000-4000-8000-000000000022');

-- Direct shares: e0021 (active, changeable) for the complete-pair reversed
-- case; e0024 (active, no changeable field) for the widen-scope case.
insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id, reason, changed_at
)
select '24300500-0000-4000-8000-000000000001', share.direct_share_id,
  'application_contained', '34300500-0000-4000-8000-000000000001',
  '34300500-0000-4000-8000-000000000003', 'd4300500-0000-4000-8000-000000000002',
  'b4300500-0000-4000-8000-000000000002', share.record_id,
  'organization_account', '54300500-0000-4000-8000-000000000001', null,
  share.readable_field_ids, share.changeable_field_ids,
  op.now - interval '1 minute', null, 'active', 1,
  '54300500-0000-4000-8000-000000000001', op.now, share.correlation_id, share.reason, op.now
from (select pg_catalog.clock_timestamp() as now) as op
cross join (values
  ('b4300500-0000-4000-8000-000000000601'::uuid, 'e4300500-0000-4000-8000-000000000021'::uuid,
    array['b4300500-0000-4000-8000-000000000202']::uuid[],
    array['b4300500-0000-4000-8000-000000000202']::uuid[],
    'a4300500-0000-4000-8000-000000000601'::uuid, 'Complete-pair share fixture'),
  ('b4300500-0000-4000-8000-000000000602'::uuid, 'e4300500-0000-4000-8000-000000000024'::uuid,
    array['b4300500-0000-4000-8000-000000000202']::uuid[],
    array[]::uuid[],
    'a4300500-0000-4000-8000-000000000602'::uuid, 'No changeable field share fixture')
) as share(direct_share_id, record_id, readable_field_ids, changeable_field_ids, correlation_id, reason);

set constraints all immediate;
set constraints all deferred;

-- Context helper: establishes vortex_context for whichever org/app/account
-- the case under test needs. Re-establishing between blocks follows
-- supabase/tests/290:360-376's pattern: as the owner, delete this backend's
-- vortex_context.request_contexts row before initialising again.
create function pg_temp.install_row_policy_context(
  p_organization_id uuid, p_application_root_id uuid, p_account_id uuid,
  p_identity_id uuid, p_access_version_delta bigint default 0
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'a4300500-0000-4000-8000-000000000901',
    'tenantId', '14300500-0000-4000-8000-000000000001',
    'organizationId', p_organization_id,
    'organizationAccountId', p_account_id,
    'identityId', p_identity_id,
    'applicationRootId', p_application_root_id,
    'sessionId', 'a4300500-0000-4000-8000-000000000902',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '2 hours',
    'accessVersion', current_access_version + p_access_version_delta,
    'correlationId', 'a4300500-0000-4000-8000-000000000903',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

-- Test-only pgTAP visibility while vortex_request is active, following
-- supabase/tests/290's own pattern.
grant usage on schema extensions to vortex_request;

-- Helpers used from here on: a row-count-affected probe (runs the real DML as
-- vortex_request and returns rows affected via GET DIAGNOSTICS, invoker
-- rights so it executes with the caller's own privileges/RLS), and a
-- deliberately slow value for the expiry race.
create function pg_temp.exec_affected_rows(p_sql text)
returns bigint
language plpgsql
volatile
as $function$
declare
  affected bigint;
begin
  execute p_sql;
  get diagnostics affected = row_count;
  return affected;
end
$function$;
grant execute on function pg_temp.exec_affected_rows(text) to vortex_request;

create function pg_temp.slow_value(p_seconds numeric, p_value text)
returns text
language plpgsql
volatile
as $function$
begin
  perform pg_catalog.pg_sleep(p_seconds);
  return p_value;
end
$function$;
grant execute on function pg_temp.slow_value(numeric, text) to vortex_request;

create function pg_temp.beta_row_with_note(p_record_id uuid, p_note text)
returns vortex_access.test_neutral_beta
language plpgsql
volatile
as $function$
declare
  row_val vortex_access.test_neutral_beta;
begin
  select * into row_val from vortex_access.test_neutral_beta where record_id = p_record_id;
  row_val.f_beta_note := p_note;
  return row_val;
end
$function$;
grant execute on function pg_temp.beta_row_with_note(uuid, text) to vortex_request;

-- ============================================================================
-- Main matrix: both organisation directions, application separation.
-- ============================================================================

select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  (select count(*)::int from vortex_access.test_neutral_beta),
  8,
  'org1/app1/account1: sees exactly the admitted rows (7 owned + 1 relationship-admitted), counted before any filtering'
);
select is(
  (select count(*)::int from vortex_access.test_neutral_gamma),
  2,
  'org1/app1/account1: sees both admitted gamma rows (inherited-ownership chase and two-hop relationship)'
);
select ok(
  exists(select 1 from vortex_access.test_neutral_gamma where record_id = 'e4300500-0000-4000-8000-000000000030'),
  'gamma e0030 admitted through the inherited-ownership chase to a team-owned parent'
);
select ok(
  exists(select 1 from vortex_access.test_neutral_gamma where record_id = 'e4300500-0000-4000-8000-000000000040'),
  'gamma e0040 admitted through the genuine two-hop relationship route (foreign-team parent, alpha-owned source)'
);

select ok(
  pg_temp.exec_affected_rows(
    $$insert into vortex_access.test_neutral_beta (
      organization_id, module_root_id, record_type_id, storage_contract_id,
      record_id, application_root_id, owner_group_id, f_beta_actor, f_beta_note
    ) values (
      '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
      'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
      'e4300500-0000-4000-8000-000000000012', '34300500-0000-4000-8000-000000000001',
      '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'inserted'
    )$$
  ) = 1,
  'org1/app1/account1 inserts an owned row'
);
select ok(
  pg_temp.exec_affected_rows(
    $$update vortex_access.test_neutral_beta set f_beta_note = 'updated'
      where record_id = 'e4300500-0000-4000-8000-000000000013'$$
  ) = 1,
  'org1/app1/account1 updates its owned row'
);
select ok(
  pg_temp.exec_affected_rows(
    $$delete from vortex_access.test_neutral_beta
      where record_id = 'e4300500-0000-4000-8000-000000000015'$$
  ) = 1,
  'org1/app1/account1 deletes its owned row'
);

-- App separation, still under org1/app1/account1: an app2-tagged row is
-- invisible and cannot be affected, even though it is otherwise team-owned.
select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000060'),
  0,
  'org1/app1 context sees no app2 row'
);
select ok(
  pg_temp.exec_affected_rows(
    $$update vortex_access.test_neutral_beta set f_beta_note = 'x'
      where record_id = 'e4300500-0000-4000-8000-000000000060'$$
  ) = 0,
  'org1/app1 context cannot update an app2 row (affects 0 rows)'
);
select ok(
  pg_temp.exec_affected_rows(
    $$delete from vortex_access.test_neutral_beta
      where record_id = 'e4300500-0000-4000-8000-000000000061'$$
  ) = 0,
  'org1/app1 context cannot delete an app2 row (affects 0 rows)'
);

-- Cross-organisation from org1's own side: org2 rows are invisible and
-- unaffected.
select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id in (
     'e4300500-0000-4000-8000-000000000043', 'e4300500-0000-4000-8000-000000000044',
     'e4300500-0000-4000-8000-000000000045'
   )),
  0,
  'org1 sees no org2 row'
);
select ok(
  pg_temp.exec_affected_rows(
    $$update vortex_access.test_neutral_beta set f_beta_note = 'x'
      where record_id = 'e4300500-0000-4000-8000-000000000044'$$
  ) = 0,
  'org1 cannot update an org2 row (affects 0 rows)'
);
select ok(
  pg_temp.exec_affected_rows(
    $$delete from vortex_access.test_neutral_beta
      where record_id = 'e4300500-0000-4000-8000-000000000045'$$
  ) = 0,
  'org1 cannot delete an org2 row (affects 0 rows)'
);

reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- The reverse organisation direction: org2/app1/account2.
select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000002', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000002', '44300500-0000-4000-8000-000000000002'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  (select count(*)::int from vortex_access.test_neutral_beta),
  3,
  'org2/app1/account2 sees exactly its own three admitted rows'
);
select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000010'),
  0,
  'org2 sees no org1 row'
);
select ok(
  pg_temp.exec_affected_rows(
    $$update vortex_access.test_neutral_beta set f_beta_note = 'x'
      where record_id = 'e4300500-0000-4000-8000-000000000010'$$
  ) = 0,
  'org2 cannot update an org1 row (affects 0 rows)'
);
select ok(
  pg_temp.exec_affected_rows(
    $$delete from vortex_access.test_neutral_beta
      where record_id = 'e4300500-0000-4000-8000-000000000010'$$
  ) = 0,
  'org2 cannot delete an org1 row (affects 0 rows)'
);
select throws_ok(
  $$insert into vortex_access.test_neutral_beta (
    organization_id, module_root_id, record_type_id, storage_contract_id,
    record_id, application_root_id, owner_group_id, f_beta_actor, f_beta_note
  ) values (
    '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
    'e4300500-0000-4000-8000-000000000046', '34300500-0000-4000-8000-000000000001',
    '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000002', 'forged org'
  )$$,
  '42501'::char(5), null::text,
  'org2 cannot insert an org1-scoped row'
);

reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- Application separation, second half: the fixed app1 declaration refuses an
-- app2 context uniformly, before any row is even considered.
select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000002',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  (select count(*)::int from vortex_access.test_neutral_beta),
  0,
  'an app2 context is refused uniformly by the fixed app1 declaration'
);
reset role;
select is(
  (
    select decision ->> 'reasonCode' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000010'
    order by decision_id desc limit 1
  ),
  'target_policy_unavailable',
  'the app2 context refusal is recorded as target_policy_unavailable'
);

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- ============================================================================
-- Complete-pair rule under the real role.
-- ============================================================================

select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

-- beta.read.all is held by nobody: a row visible only via a route (ownership)
-- whose permission is not held admits nothing.
select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000018'),
  0,
  'a row owned by a team nobody in this test holds a route for, and unreachable by any held permission, admits nothing'
);

-- account1 holds beta.read.own but not beta.read.shared: a row that is only
-- shared (not owned by account1's team) still refuses.
select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000021'),
  0,
  'eligibility from beta.read.own plus a share matching only beta.read.shared (not held) refuses'
);

reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- account3 holds beta.read.shared but not beta.read.own: a row that is
-- team-owned (account3 is a member) but never shared with account3 refuses.
select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000003', '44300500-0000-4000-8000-000000000003'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000019'),
  0,
  'eligibility from beta.read.shared plus ownership matching only beta.read.own (not held) refuses'
);

reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- account4 holds only the non-record beta.settings.read.
select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000004', '44300500-0000-4000-8000-000000000004'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  (select count(*)::int from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000019'),
  0,
  'an owned row is refused when the account holds only the non-record beta.settings.read'
);
reset role;
select is(
  (
    select decision ->> 'reasonCode' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000019'
    order by decision_id desc limit 1
  ),
  'permission_not_effective',
  'holding only a non-record permission leaves every alternative without an effective path'
);
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- Withdrawing the catalogue continuity for a held single-alternative
-- permission (beta.delete.own) refuses with permission_unavailable, both in
-- direct evidence and in the real DELETE statement.
-- last_processed_registration_revision is FK'd to permission_registration_
-- revisions, so withdrawing continuity for one permission means recording a
-- new registration revision the continuity now points at.
insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '24300500-0000-4000-8000-000000000001', 'application',
  '34300500-0000-4000-8000-000000000001', 2, 'active', 'register',
  'row_policy.app1', '1.0.1', 2, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('5', 64),
  pg_catalog.clock_timestamp(), '94300500-0000-4000-8000-000000000001',
  'a4300500-0000-4000-8000-000000000052'
);

update vortex_access.permission_continuities
set state = 'unavailable', continuity_revision = continuity_revision + 1,
  last_processed_registration_revision = last_processed_registration_revision + 1,
  changed_at = pg_catalog.clock_timestamp()
where organization_id = '24300500-0000-4000-8000-000000000001'
  and permission_id = 'c4300500-0000-4000-8000-000000000008';

select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select ok(
  not vortex_access.test_neutral_beta_delete_allowed(
    (select b from vortex_access.test_neutral_beta as b
     where record_id = 'e4300500-0000-4000-8000-000000000020')
  ),
  'direct evidence: delete refuses once the catalogue continuity is withdrawn'
);
-- DELETE has no WITH CHECK (there is no proposed new row), so a USING-level
-- refusal is silent: the row is simply excluded, affecting 0 rows rather
-- than raising -- unlike INSERT/UPDATE, which raise 42501 specifically when
-- a row passes other filters but its WITH CHECK evaluates false.
select ok(
  pg_temp.exec_affected_rows(
    $$delete from vortex_access.test_neutral_beta
      where record_id = 'e4300500-0000-4000-8000-000000000020'$$
  ) = 0,
  'the real DELETE also refuses once delete.own''s catalogue continuity is withdrawn (affects 0 rows)'
);

reset role;
select is(
  (
    select decision ->> 'reasonCode' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000020'
    order by decision_id desc limit 1
  ),
  'permission_unavailable',
  'the withdrawal is recorded as permission_unavailable, not a row-scope refusal'
);
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- ============================================================================
-- Context integrity.
-- ============================================================================

-- A forged context naming an unknown account fails closed. initialize()
-- itself accepts any shape-valid claim; the unknown account is only
-- discovered -- and refused -- the first time it is actually put to use.
select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  'a4300500-0000-4000-8000-000000000999', '44300500-0000-4000-8000-000000000001'
);
grant execute on function vortex_access.test_neutral_beta_read_allowed(vortex_access.test_neutral_beta) to vortex_request;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select count(*) from vortex_access.test_neutral_beta$$,
  '42501'::char(5), null::text,
  'a forged context naming an unknown account fails closed'
);
reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- A stale Access version fails closed.
select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001',
  -1
);
grant execute on function vortex_access.test_neutral_beta_read_allowed(vortex_access.test_neutral_beta) to vortex_request;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select count(*) from vortex_access.test_neutral_beta$$,
  '42501'::char(5), 'Request access version is stale or unavailable',
  'a stale Access version fails closed'
);
reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- A revoked assignment refuses on the next context. beta.create.own is a
-- single-alternative declaration, so revoking its one live assignment
-- removes the only path and the eligibility-level reasonCode is exact.
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '24300500-0000-4000-8000-000000000001',
  '74300500-0000-4000-8000-000000000003', 1,
  null, null, null, null, null, null, null, null,
  '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000911'
);

select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select ok(
  not vortex_access.test_neutral_beta_create_allowed(
    pg_catalog.jsonb_populate_record(null::vortex_access.test_neutral_beta, pg_catalog.jsonb_build_object(
      'organization_id', '24300500-0000-4000-8000-000000000001',
      'module_root_id', '34300500-0000-4000-8000-000000000003',
      'record_type_id', 'd4300500-0000-4000-8000-000000000002',
      'storage_contract_id', 'b4300500-0000-4000-8000-000000000002',
      'record_id', 'e4300500-0000-4000-8000-000000000901',
      'application_root_id', '34300500-0000-4000-8000-000000000001',
      'owner_group_id', '84300500-0000-4000-8000-000000000001',
      'lifecycle_state', 'active',
      'f_beta_actor', '54300500-0000-4000-8000-000000000001',
      'f_beta_note', 'n901'
    ))
  ),
  'direct evidence: create refuses once the assignment is revoked'
);
select throws_ok(
  $$insert into vortex_access.test_neutral_beta (
    organization_id, module_root_id, record_type_id, storage_contract_id,
    record_id, application_root_id, owner_group_id, f_beta_actor, f_beta_note
  ) values (
    '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
    'e4300500-0000-4000-8000-000000000902', '34300500-0000-4000-8000-000000000001',
    '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000001', 'n902'
  )$$,
  '42501'::char(5), null::text,
  'the real INSERT also refuses once the assignment is revoked'
);
reset role;
select is(
  (
    select decision ->> 'reasonCode' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000901'
    order by decision_id desc limit 1
  ),
  'permission_not_effective',
  'the revocation is recorded as permission_not_effective on the next context'
);
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- ============================================================================
-- UPDATE cannot widen scope.
-- ============================================================================

select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$update vortex_access.test_neutral_beta
    set owner_group_id = '84300500-0000-4000-8000-000000000005'
    where record_id = 'e4300500-0000-4000-8000-000000000017'$$,
  '42501'::char(5), null::text,
  'moving an owned row to another team''s ownership is refused by WITH CHECK'
);
select throws_ok(
  $$update vortex_access.test_neutral_beta
    set application_root_id = '34300500-0000-4000-8000-000000000002'
    where record_id = 'e4300500-0000-4000-8000-000000000017'$$,
  '42501'::char(5), null::text,
  'moving the row to another application is refused'
);
select throws_ok(
  $$insert into vortex_access.test_neutral_beta (
    organization_id, module_root_id, record_type_id, storage_contract_id,
    record_id, application_root_id, owner_group_id, f_beta_actor, f_beta_note
  ) values (
    '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000003',
    'd4300500-0000-4000-8000-000000000002', 'b4300500-0000-4000-8000-000000000002',
    'e4300500-0000-4000-8000-000000000903', '34300500-0000-4000-8000-000000000001',
    '84300500-0000-4000-8000-000000000001', '54300500-0000-4000-8000-000000000002', 'wrong actor'
  )$$,
  '42501'::char(5), null::text,
  'breaking the saved condition (actor is not the creator) is refused even though the team is owned'
);
-- The share carries no changeable field, so the row admits no candidate at
-- all under USING (not just a WITH CHECK refusal on the proposed row): the
-- update silently affects 0 rows, exactly like the widen-scope DELETE cases
-- above -- there is no "old row" for the share route to admit in the first
-- place.
select ok(
  pg_temp.exec_affected_rows(
    $$update vortex_access.test_neutral_beta set f_beta_note = 'x'
      where record_id = 'e4300500-0000-4000-8000-000000000024'$$
  ) = 0,
  'an update by a share recipient whose share has no changeable fields is refused (affects 0 rows)'
);

select is(
  (select owner_group_id::text from vortex_access.test_neutral_beta
   where record_id = 'e4300500-0000-4000-8000-000000000017'),
  '84300500-0000-4000-8000-000000000001',
  'e0017''s ownership is unchanged after the refused widen attempts'
);

reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- ============================================================================
-- Expiry between the two UPDATE checks.
--
-- The real UPDATE below (throws_ok, 42501) is the actual proof that the
-- database enforces this: target-list evaluation for pg_temp.slow_value(...)
-- runs between the scan qualification (USING, against the old row) and the
-- new-row check (WITH CHECK, against the proposed row), so the assignment
-- that is live when USING runs has expired by the time WITH CHECK runs.
--
-- That real statement is caught by throws_ok, and PostgreSQL's ordinary
-- per-statement atomicity rolls back everything the failing statement did --
-- including both of the adapter's own test_neutral_decisions inserts made
-- while evaluating USING and WITH CHECK for this row: a failing statement is
-- rolled back to its implicit statement-level savepoint, which discards the
-- policy function's own inserts along with the update. There is no ordinary-means way to keep one failing
-- statement's own nested writes durable inside the same transaction (no
-- autonomous transactions without dblink, and dblink cannot see this
-- transaction's own uncommitted objects regardless).
--
-- So the exact allowed-then-refused, timestamp-ordered transition is instead
-- captured durably by calling the SAME real update adapter directly, once
-- before the seeded expiry and once after with a row value built the same
-- way PostgreSQL would build the proposed new row (see
-- pg_temp.beta_row_with_note). Neither direct call is part of a failing
-- statement, so both decisions commit normally and can be read back below.
-- ============================================================================

-- update.shared is also revoked here (e0016 carries no share in any case, so
-- this does not change what the row-scope composer would find -- but it
-- keeps update.own as the declaration's only alternative with any live
-- path, so the post-expiry refusal is the clean eligibility-level
-- permission_not_effective the brief names, not a row-scope refusal from a
-- second, merely-inapplicable alternative).
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '24300500-0000-4000-8000-000000000001',
  '74300500-0000-4000-8000-000000000005', 1,
  null, null, null, null, null, null, null, null,
  '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000920'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '24300500-0000-4000-8000-000000000001',
  '74300500-0000-4000-8000-000000000004', 1,
  null, null, null, null, null, null, null, null,
  '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000921'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '24300500-0000-4000-8000-000000000001',
  '74300500-0000-4000-8000-000000000904', null,
  '64300500-0000-4000-8000-000000000004', 1,
  'organization_account', '54300500-0000-4000-8000-000000000001', null, 'standing',
  pg_catalog.clock_timestamp() - interval '1 second',
  pg_catalog.clock_timestamp() + interval '5 seconds',
  '94300500-0000-4000-8000-000000000001', 'a4300500-0000-4000-8000-000000000922'
);

select pg_temp.install_row_policy_context(
  '24300500-0000-4000-8000-000000000001', '34300500-0000-4000-8000-000000000001',
  '54300500-0000-4000-8000-000000000001', '44300500-0000-4000-8000-000000000001'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select ok(
  vortex_access.test_neutral_beta_update_allowed(
    (select b from vortex_access.test_neutral_beta as b
     where record_id = 'e4300500-0000-4000-8000-000000000016')
  ),
  'direct evidence before expiry: the old row is allowed while the short-lived assignment is still live'
);

select throws_ok(
  $$update vortex_access.test_neutral_beta
    set f_beta_note = pg_temp.slow_value(8, 'later')
    where record_id = 'e4300500-0000-4000-8000-000000000016'$$,
  '42501'::char(5), null::text,
  'the real UPDATE refuses once the assignment expires between the scan qualification and the new-row check'
);

select ok(
  not vortex_access.test_neutral_beta_update_allowed(
    pg_temp.beta_row_with_note('e4300500-0000-4000-8000-000000000016', 'later')
  ),
  'direct evidence after expiry: the same proposed new row is refused once the assignment has expired'
);

reset role;

select is(
  (
    select decision ->> 'outcome' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id asc limit 1
  ),
  'allowed',
  'expiry race: the earlier direct decision was allowed'
);
select ok(
  (
    select (decision ->> 'checkedAt')::timestamptz from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id asc limit 1
  ) < (
    select expires_at from vortex_access.organization_role_assignments
    where role_assignment_id = '74300500-0000-4000-8000-000000000904'
  ),
  'expiry race: the earlier decision''s checkedAt is before the seeded expires_at'
);
select is(
  (
    select decision ->> 'outcome' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id desc limit 1
  ),
  'refused',
  'expiry race: the later direct decision was refused'
);
select is(
  (
    select decision ->> 'reasonCode' from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id desc limit 1
  ),
  'permission_not_effective',
  'expiry race: the later refusal is permission_not_effective'
);
select ok(
  (
    select (decision ->> 'checkedAt')::timestamptz from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id desc limit 1
  ) > (
    select expires_at from vortex_access.organization_role_assignments
    where role_assignment_id = '74300500-0000-4000-8000-000000000904'
  ),
  'expiry race: the later decision''s checkedAt is after the seeded expires_at'
);
select ok(
  (
    select (decision ->> 'checkedAt')::timestamptz from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id asc limit 1
  ) < (
    select (decision ->> 'checkedAt')::timestamptz from vortex_access.test_neutral_decisions
    where record_id = 'e4300500-0000-4000-8000-000000000016'
    order by decision_id desc limit 1
  ),
  'expiry race: the two samples are strictly ordered in time, allowed before refused'
);

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

-- ============================================================================
-- Boundary assertions.
-- ============================================================================

select is(
  (select count(*)::int from pg_catalog.pg_policies as p
   where p.schemaname = 'vortex_access' and p.tablename = 'test_neutral_beta'),
  4,
  'test_neutral_beta has exactly four policies'
);
select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'cmd', p.cmd, 'roles', p.roles, 'qual', p.qual, 'with_check', p.with_check
    ) order by p.policyname)
    from pg_catalog.pg_policies as p
    where p.schemaname = 'vortex_access' and p.tablename = 'test_neutral_beta'
  ),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'cmd', 'DELETE', 'roles', array['vortex_request'],
      'qual', 'vortex_access.test_neutral_beta_delete_allowed(test_neutral_beta.*)',
      'with_check', null
    ),
    pg_catalog.jsonb_build_object(
      'cmd', 'INSERT', 'roles', array['vortex_request'],
      'qual', null,
      'with_check', 'vortex_access.test_neutral_beta_create_allowed(test_neutral_beta.*)'
    ),
    pg_catalog.jsonb_build_object(
      'cmd', 'SELECT', 'roles', array['vortex_request'],
      'qual', 'vortex_access.test_neutral_beta_read_allowed(test_neutral_beta.*)',
      'with_check', null
    ),
    pg_catalog.jsonb_build_object(
      'cmd', 'UPDATE', 'roles', array['vortex_request'],
      'qual', 'vortex_access.test_neutral_beta_update_allowed(test_neutral_beta.*)',
      'with_check', 'vortex_access.test_neutral_beta_update_allowed(test_neutral_beta.*)'
    )
  ),
  'each policy is to vortex_request only and its expression names only the fixed adapter; the update policy carries both USING and WITH CHECK'
);
select is(
  (select count(*)::int from pg_catalog.pg_policies as p
   where p.schemaname = 'vortex_access' and p.tablename = 'test_neutral_gamma'),
  1,
  'test_neutral_gamma has exactly one policy'
);

-- Adapters are owner-held, security definer, empty search path.
select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname, 'securityDefiner', procedure_row.prosecdef,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.pronamespace = 'vortex_access'::regnamespace
      and procedure_row.proname like 'test_neutral_%_allowed'
  ),
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', 'postgres', 'securityDefiner', true, 'configuration', array['search_path=""']
    ) order by name.value)
    from (values ('test_neutral_beta_create_allowed'), ('test_neutral_beta_delete_allowed'),
      ('test_neutral_beta_read_allowed'), ('test_neutral_beta_update_allowed'),
      ('test_neutral_gamma_read_allowed')
    ) as name(value)
  ),
  'all five adapters are owner-held, security definer and empty-search-path'
);

-- The restricted role cannot execute any private evaluator or predicate.
select ok(
  not pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request cannot execute ' || target.signature
)
from (values
  ('vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'),
  ('vortex_access.evaluate_organization_record_permission_eligibility_internal(jsonb,jsonb,timestamptz)'),
  ('vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])'),
  ('vortex_access.evaluate_permission_role_path_internal(jsonb,timestamptz,jsonb,jsonb,uuid)'),
  ('vortex_access.recent_authentication_deadline_internal(jsonb,timestamptz,jsonb)'),
  ('vortex_access.evaluate_current_record_ownership_visibility(jsonb,text,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid,uuid,uuid,timestamptz)'),
  ('vortex_access.read_current_direct_record_share_contributions(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz)'),
  ('vortex_access.record_relationship_witness_matches(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,uuid,uuid)'),
  ('vortex_access.evaluate_permission_saved_condition(jsonb,jsonb,jsonb,jsonb,uuid)')
) as target(signature)
order by target.signature collate "C";

-- The restricted role has no privilege on the alpha, release, binding or
-- decision fixtures.
select ok(
  not (
    pg_catalog.has_table_privilege('vortex_request', target.relation, 'SELECT')
    or pg_catalog.has_table_privilege('vortex_request', target.relation, 'INSERT')
    or pg_catalog.has_table_privilege('vortex_request', target.relation, 'UPDATE')
    or pg_catalog.has_table_privilege('vortex_request', target.relation, 'DELETE')
  ),
  'vortex_request has no privilege on ' || target.relation
)
from (values
  ('vortex_access.test_neutral_alpha'),
  ('vortex_access.test_neutral_bindings'), ('vortex_access.test_neutral_decisions')
) as target(relation)
order by target.relation collate "C";

-- No relation outside test_neutral_% in these four schemas grants any
-- privilege or policy to the request/runtime/anon/authenticated/service_role/
-- public roles.
select is(
  (
    select count(*)::int from information_schema.role_table_grants as g
    where g.table_schema in ('vortex_identity', 'vortex_definition', 'vortex_access', 'vortex_activity')
      and g.table_name not like 'test_neutral_%'
      and g.grantee in ('vortex_request', 'vortex_runtime', 'anon', 'authenticated', 'service_role', 'PUBLIC')
  ),
  0,
  'no relation outside test_neutral_% grants any table privilege to a restricted role'
);
select is(
  (
    select count(*)::int from pg_catalog.pg_policies as p
    where p.schemaname in ('vortex_identity', 'vortex_definition', 'vortex_access', 'vortex_activity')
      and p.tablename not like 'test_neutral_%'
      and p.roles && array['vortex_request', 'vortex_runtime', 'anon', 'authenticated', 'service_role', 'public']::name[]
  ),
  0,
  'no relation outside test_neutral_% carries a policy naming a restricted role'
);

-- The superseded binding is never resolved: every successful decision this
-- file captured for a beta or gamma record carries the real, current
-- storage contract id, never the decoy value on the superseded row.
select is(
  (
    select count(*)::int from vortex_access.test_neutral_decisions
    where decision -> 'recordBinding' ->> 'storageContractId' = 'b4300500-0000-4000-8000-000000000099'
  ),
  0,
  'the superseded binding''s decoy storage contract id never appears in any captured decision'
);

-- ============================================================================
-- #395: saved-condition bindings stored in byte order, evaluated end to end.
-- The compiler emits parameter bindings in code-point order, so [a1, a_b] is a
-- valid published shape and the stored-scope CHECK accepts it. Under the
-- database's ICU collation `a_b` sorts before `a1`, and the consumer's former
-- binding-order re-check raised 22023 for every record evaluated under such a
-- permission. This case stores that scope through the owning writers and
-- evaluates it through the exact record decision, which must decide.
--
-- Writers used: vortex_definition.append_release (through
-- pg_temp.append_writer_release), vortex_access.
-- coordinate_application_access_change, coordinate_organization_role_change
-- and coordinate_organization_role_assignment_change.
-- Direct insert, and why no writer can produce it: the application's
-- definition root, because create_root generates its own root identifier and
-- this case needs a fixed one (as helpers/record-field-access-fixture.psql
-- does). The record type, records and saved condition are facts jsonb, as
-- everywhere else in this file.
-- ============================================================================

\ir helpers/definition-release-writer.psql

insert into vortex_definition.roots (root_id, organization_id, kind, key, created_at, created_by)
values (
  '34300000-0000-4000-8000-000000000395', '24300000-0000-4000-8000-000000000001',
  'application', 'example.binding_order', pg_catalog.clock_timestamp() - interval '1 minute',
  '94300000-0000-4000-8000-000000000001'
);

create function pg_temp.binding_order_scope()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'routes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'all_records')),
    'savedCondition', pg_catalog.jsonb_build_object(
      'conditionId', 'b4300000-0000-4000-8000-000000000397',
      'publishedRevision', 1,
      'contractFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
      'parameterBindings', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('key', 'a1', 'source', 'literal', 'value', 'north'),
        pg_catalog.jsonb_build_object('key', 'a_b', 'source', 'current_organization_account_id')
      )
    )
  )
$function$;

-- Publishes one application release carrying the permission, registers it,
-- and grants it to the acting account through a standing custom role.
create function pg_temp.register_binding_order_permission()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  fixture_organization_id constant uuid := '24300000-0000-4000-8000-000000000001';
  fixture_application_root_id constant uuid := '34300000-0000-4000-8000-000000000395';
  fixture_role_id constant uuid := '64300000-0000-4000-8000-000000000395';
  actor_id constant uuid := '94300000-0000-4000-8000-000000000001';
  permission jsonb := pg_catalog.jsonb_build_object(
    'permissionId', 'c4300000-0000-4000-8000-000000000395',
    'key', 'exact_record_access.binding_order',
    'label', 'Binding order',
    'description', 'Byte-ordered saved-condition bindings fixture.',
    'recordTypeId', 'd4300000-0000-4000-8000-000000000395',
    'recordScope', pg_temp.binding_order_scope(),
    'actionKind', 'read',
    'administrative', false
  );
  release_row vortex_definition.releases%rowtype;
  release_value jsonb;
  entry_value jsonb;
  registered record;
  refs jsonb;
  role_revision bigint;
begin
  perform pg_temp.append_writer_release(
    fixture_application_root_id, '1.0.0', '[]'::jsonb,
    pg_catalog.jsonb_build_object('permissions', pg_catalog.jsonb_build_array(permission))
  );
  select release.* into strict release_row
  from vortex_definition.releases as release
  where release.root_id = fixture_application_root_id and release.release_revision = 1;

  release_value := pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', 'example.binding_order',
    'rootId', fixture_application_root_id,
    'releaseRevision', release_row.release_revision,
    'releaseVersion', release_row.release_version,
    'validationContractVersion', release_row.validation_contract_version,
    'contentFingerprint', release_row.content_fingerprint,
    'resolutionFingerprint', release_row.resolution_fingerprint
  );
  entry_value := pg_catalog.jsonb_build_object(
    'applicationRootId', fixture_application_root_id, 'ownerKind', 'application',
    'ownerId', fixture_application_root_id, 'permission', permission,
    'sourceRelease', release_value,
    'meaningFingerprint', pg_temp.writer_fixture_fingerprint('meaning:binding_order')
  );

  select result.* into strict registered
  from vortex_access.coordinate_application_access_change(
    'register', null,
    pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
      'permissionRegistration', pg_catalog.jsonb_build_object(
        'contractVersion', '1.0.0',
        'organizationId', fixture_organization_id,
        'applicationRootId', fixture_application_root_id,
        'applicationRelease', release_value,
        'applicationCatalogueFingerprint',
          pg_temp.writer_fixture_fingerprint('catalogue:binding_order'),
        'applicationPermissionIds', pg_catalog.jsonb_build_array(permission -> 'permissionId'),
        'entries', pg_catalog.jsonb_build_array(entry_value),
        'candidateFingerprint', pg_temp.writer_fixture_fingerprint('candidate:binding_order')
      ),
      'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template', pg_catalog.jsonb_build_object(
          'roleId', pg_catalog.gen_random_uuid(),
          'key', 'binding_order_template',
          'name', 'Binding order template',
          'homePageId', pg_catalog.gen_random_uuid(),
          'permissionKeys', pg_catalog.jsonb_build_array(permission -> 'key'),
          'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
        ),
        'sourceTemplateFingerprint', pg_temp.writer_fixture_fingerprint('template:binding_order'),
        'sourcePermissions', pg_catalog.jsonb_build_array(entry_value),
        'livePermissions', pg_catalog.jsonb_build_array(entry_value)
      )),
      'candidateFingerprint', pg_temp.writer_fixture_fingerprint('preparation:binding_order')
    ),
    fixture_organization_id, fixture_application_root_id, actor_id,
    'a4300000-0000-4000-8000-000000000395'
  ) as result;
  if registered.outcome <> 'changed' then
    raise exception 'Binding-order registration was not applied';
  end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'kind', 'exact',
    'applicationRootId', entry.application_root_id,
    'ownerKind', entry.owner_kind,
    'ownerId', entry.owner_id,
    'permissionId', entry.permission_id,
    'acceptedRegistrationRevision', registration.revision,
    'catalogueFingerprint', registration.permission_catalogue_fingerprint,
    'continuityRevision', continuity.continuity_revision,
    'meaningFingerprint', entry.meaning_fingerprint
  ))
  into strict refs
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where registration.organization_id = fixture_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = fixture_application_root_id
    and registration.state = 'active';

  perform 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'candidate', pg_catalog.jsonb_build_object(
        'operation', 'create_custom',
        'organizationId', fixture_organization_id,
        'roleId', fixture_role_id,
        'key', 'binding_order',
        'label', 'Binding order',
        'description', 'Byte-ordered saved-condition bindings role.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
        'permissions', refs
      ),
      'roleCandidateFingerprint', pg_temp.writer_fixture_fingerprint('role:binding_order')
    ),
    actor_id, 'a4300000-0000-4000-8000-000000000396'
  );

  select role.live_revision into strict role_revision
  from vortex_access.organization_roles as role
  where role.organization_id = fixture_organization_id and role.role_id = fixture_role_id;

  perform 1 from vortex_access.coordinate_organization_role_assignment_change(
    'grant', fixture_organization_id, '74300000-0000-4000-8000-000000000395', null,
    fixture_role_id, role_revision, 'organization_account',
    '54300000-0000-4000-8000-000000000001', null, 'standing',
    pg_catalog.clock_timestamp() - interval '1 minute', null,
    actor_id, 'a4300000-0000-4000-8000-000000000397'
  );
end
$function$;

select pg_temp.register_binding_order_permission();

select is(
  (
    select entry.record_scope
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = '24300000-0000-4000-8000-000000000001'
      and entry.application_root_id = '34300000-0000-4000-8000-000000000395'
      and entry.permission_id = 'c4300000-0000-4000-8000-000000000395'
  ),
  pg_temp.binding_order_scope(),
  'the registration writer stores bindings [a1, a_b] in byte order and the stored-scope CHECK accepts them'
);

-- The acting account's request context in the new application, at the
-- Access version the writers above advanced to.
create function pg_temp.install_binding_order_context()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
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
    'applicationRootId', '34300000-0000-4000-8000-000000000395',
    'sessionId', 'a4300000-0000-4000-8000-000000000092',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '2 hours',
    'accessVersion', current_access_version,
    'correlationId', 'a4300000-0000-4000-8000-000000000398',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

-- One exact record decision under the registered permission. The saved
-- condition requires field ...0398 to equal the literal bound to `a1` and
-- field ...0399 to equal the current account bound to `a_b`. Returns the
-- outcome (and reason when refused), or the SQLSTATE the decision raised.
create function pg_temp.binding_order_decision(p_record_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $function$
declare
  record_binding constant jsonb := pg_catalog.jsonb_build_object(
    'moduleRootId', '34300000-0000-4000-8000-000000000002',
    'recordTypeId', 'd4300000-0000-4000-8000-000000000395',
    'storageContractId', 'b4300000-0000-4000-8000-000000000395',
    'storageScope', 'application_contained'
  );
  decision jsonb;
begin
  decision := vortex_access.evaluate_organization_record_access_internal(
    pg_catalog.jsonb_build_object(
      'operationKey', 'record.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', '34300000-0000-4000-8000-000000000395'
      ),
      'requiredPermissions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'applicationRootId', '34300000-0000-4000-8000-000000000395',
        'ownerKind', 'application',
        'ownerId', '34300000-0000-4000-8000-000000000395',
        'permissionId', 'c4300000-0000-4000-8000-000000000395'
      )),
      'recordBinding', record_binding,
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    ),
    p_record_id,
    pg_catalog.jsonb_build_object(
      'binding', record_binding,
      'recordTypes', pg_catalog.jsonb_build_array(record_binding || pg_catalog.jsonb_build_object(
        'ownershipMode', 'none',
        'fields', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('fieldId', 'b4300000-0000-4000-8000-000000000398', 'type', 'text'),
          pg_catalog.jsonb_build_object('fieldId', 'b4300000-0000-4000-8000-000000000399', 'type', 'text')
        )
      )),
      'relationships', '[]'::jsonb,
      'sharingConditions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'conditionId', 'b4300000-0000-4000-8000-000000000397',
        'sourceRecordTypeId', 'd4300000-0000-4000-8000-000000000395',
        'publishedRevision', 1,
        'contractFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
        'parameters', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('key', 'a1', 'type', 'text'),
          pg_catalog.jsonb_build_object('key', 'a_b', 'type', 'text')
        ),
        'condition', pg_catalog.jsonb_build_object(
          'kind', 'all',
          'conditions', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'kind', 'comparison', 'operator', 'equals',
              'left', pg_catalog.jsonb_build_object(
                'source', 'field', 'fieldId', 'b4300000-0000-4000-8000-000000000398'
              ),
              'right', pg_catalog.jsonb_build_object('source', 'parameter', 'key', 'a1')
            ),
            pg_catalog.jsonb_build_object(
              'kind', 'comparison', 'operator', 'equals',
              'left', pg_catalog.jsonb_build_object(
                'source', 'field', 'fieldId', 'b4300000-0000-4000-8000-000000000399'
              ),
              'right', pg_catalog.jsonb_build_object('source', 'parameter', 'key', 'a_b')
            )
          )
        ),
        'declaredFieldIds', pg_catalog.jsonb_build_array(
          'b4300000-0000-4000-8000-000000000398', 'b4300000-0000-4000-8000-000000000399'
        )
      )),
      'records', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'recordScope', pg_catalog.jsonb_build_object(
            'storageScope', 'application_contained',
            'organizationId', '24300000-0000-4000-8000-000000000001',
            'moduleRootId', '34300000-0000-4000-8000-000000000002',
            'recordTypeId', 'd4300000-0000-4000-8000-000000000395',
            'storageContractId', 'b4300000-0000-4000-8000-000000000395',
            'recordId', candidate.record_id,
            'applicationRootId', '34300000-0000-4000-8000-000000000395'
          ),
          'lifecycleState', 'active',
          'fieldValues', pg_catalog.jsonb_build_object(
            'b4300000-0000-4000-8000-000000000398', candidate.region,
            'b4300000-0000-4000-8000-000000000399', '54300000-0000-4000-8000-000000000001'
          )
        ) order by candidate.record_id)
        from (values
          ('e4300000-0000-4000-8000-000000000395'::uuid, 'north'),
          ('e4300000-0000-4000-8000-000000000396'::uuid, 'south')
        ) as candidate(record_id, region)
      ),
      'edges', '[]'::jsonb
    )
  );
  return (decision ->> 'outcome') || coalesce(':' || (decision ->> 'reasonCode'), '');
exception when others then
  return 'error:' || sqlstate;
end
$function$;

select pg_temp.install_binding_order_context();

select is(
  pg_temp.binding_order_decision('e4300000-0000-4000-8000-000000000395'),
  'allowed',
  'a stored scope with bindings [a1, a_b] yields an exact record decision, not 22023'
);
select is(
  pg_temp.binding_order_decision('e4300000-0000-4000-8000-000000000396'),
  'refused:record_scope_refused',
  'the same bindings still narrow the record: one the saved condition excludes is refused, not raised'
);

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

select * from finish();

rollback;
