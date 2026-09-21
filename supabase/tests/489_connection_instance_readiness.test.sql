\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_runtime, vortex_request;

select no_plan();

-- ----------------------------------------------------------------------------
-- 1. Private Schema Assertions & Role Privileges
-- ----------------------------------------------------------------------------
select * from pg_temp.vortex_private_schema_assertions(
  'vortex_connection', 'postgres', true, true
);

select has_table(
  'vortex_connection', 'connection_instances',
  'connection_instances authoritative table exists'
);

select has_table(
  'vortex_connection', 'connection_application_grants',
  'connection_application_grants authoritative table exists'
);

select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_connection.connection_instances'::regclass
  ) and (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_connection.connection_application_grants'::regclass
  ),
  'both vortex_connection tables are forced-RLS private storage'
);

-- vortex_request table access: SELECT only
select ok(
  pg_catalog.has_table_privilege('vortex_request', 'vortex_connection.connection_instances', 'SELECT')
  and pg_catalog.has_table_privilege('vortex_request', 'vortex_connection.connection_application_grants', 'SELECT')
  and not pg_catalog.has_table_privilege('vortex_request', 'vortex_connection.connection_instances', 'INSERT,UPDATE,DELETE')
  and not pg_catalog.has_table_privilege('vortex_request', 'vortex_connection.connection_application_grants', 'INSERT,UPDATE,DELETE'),
  'vortex_request has read-only table privilege on connection tables'
);

-- vortex_runtime has NO direct table privilege
select ok(
  not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_connection.connection_instances', 'SELECT,INSERT,UPDATE,DELETE')
  and not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_connection.connection_application_grants', 'SELECT,INSERT,UPDATE,DELETE'),
  'vortex_runtime has zero direct table privilege on connection tables'
);

-- public, anon, authenticated have no privileges
select ok(
  not pg_catalog.has_table_privilege(candidate.role_name, 'vortex_connection.connection_instances', 'SELECT,INSERT,UPDATE,DELETE')
  and not pg_catalog.has_table_privilege(candidate.role_name, 'vortex_connection.connection_application_grants', 'SELECT,INSERT,UPDATE,DELETE'),
  candidate.role_name || ' has no raw table access on vortex_connection'
)
  from (values ('public'::name), ('anon'::name), ('authenticated'::name), ('service_role'::name)) as candidate(role_name);

-- Function privileges
select ok(
  pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.resolve_connection_instance_readiness(uuid,uuid,uuid,text,bigint,text)', 'EXECUTE')
  and pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.read_active_connection_evidence(uuid)', 'EXECUTE'),
  'vortex_request can execute readiness resolver and evidence reader'
);

select ok(
  not pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.register_connection_instance_internal(uuid,uuid,uuid,text,text,text,uuid,timestamptz)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.grant_connection_application_internal(uuid,uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.revoke_connection_application_internal(uuid,uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.record_connection_health_check_internal(uuid,bigint,text,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.revoke_connection_instance_internal(uuid,bigint,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_connection.reauthorize_connection_instance_internal(uuid,bigint,uuid,text,timestamptz)', 'EXECUTE'),
  'vortex_request cannot execute mutator functions'
);

select ok(
  pg_catalog.has_function_privilege('vortex_runtime', 'vortex_connection.register_connection_instance_internal(uuid,uuid,uuid,text,text,text,uuid,timestamptz)', 'EXECUTE')
  and pg_catalog.has_function_privilege('vortex_runtime', 'vortex_connection.grant_connection_application_internal(uuid,uuid,uuid)', 'EXECUTE')
  and pg_catalog.has_function_privilege('vortex_runtime', 'vortex_connection.revoke_connection_application_internal(uuid,uuid,uuid)', 'EXECUTE')
  and pg_catalog.has_function_privilege('vortex_runtime', 'vortex_connection.record_connection_health_check_internal(uuid,bigint,text,uuid)', 'EXECUTE')
  and pg_catalog.has_function_privilege('vortex_runtime', 'vortex_connection.revoke_connection_instance_internal(uuid,bigint,uuid)', 'EXECUTE')
  and pg_catalog.has_function_privilege('vortex_runtime', 'vortex_connection.reauthorize_connection_instance_internal(uuid,bigint,uuid,text,timestamptz)', 'EXECUTE'),
  'vortex_runtime can execute governed connection mutators'
);

-- Function volatility check: resolver MUST be volatile for legal row-locking
select ok(
  (
    select provolatile = 'v'
    from pg_catalog.pg_proc
    where proname = 'resolve_connection_instance_readiness'
      and pronamespace = 'vortex_connection'::regnamespace
  ),
  'resolve_connection_instance_readiness is VOLATILE for legal FOR SHARE row-locking'
);

select ok(
  (
    select provolatile = 'v'
    from pg_catalog.pg_proc
    where proname = 'read_active_connection_evidence'
      and pronamespace = 'vortex_connection'::regnamespace
  ),
  'read_active_connection_evidence is VOLATILE for legal Connection and grant row locking'
);

-- ----------------------------------------------------------------------------
-- 2. Seed Identity, Organizations, and Permanent Roots
-- ----------------------------------------------------------------------------
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14890000-0000-4000-8000-000000000001', 'conn_test_tenant',
  'Connection Test Tenant', 'active', pg_catalog.clock_timestamp(),
  '94890000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values
  ('24890000-0000-4000-8000-000000000001', '14890000-0000-4000-8000-000000000001',
   'conn_org_a', 'Connection Org A', 'active', pg_catalog.clock_timestamp(),
   '94890000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1),
  ('24890000-0000-4000-8000-000000000002', '14890000-0000-4000-8000-000000000001',
   'conn_org_b', 'Connection Org B', 'active', pg_catalog.clock_timestamp(),
   '94890000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '44890000-0000-4000-8000-000000000001', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '94890000-0000-4000-0000-000000000001',
  'a4890000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '54890000-0000-4000-8000-000000000001',
    '24890000-0000-4000-8000-000000000001',
    '44890000-0000-4000-8000-000000000001', 'Conn Admin Account A',
    'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '94890000-0000-4000-8000-000000000001',
    'a4890000-0000-4000-8000-000000000002', 1
  ),
  (
    '54890000-0000-4000-8000-000000000002',
    '24890000-0000-4000-8000-000000000002',
    '44890000-0000-4000-8000-000000000001', 'Conn Admin Account B',
    'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '94890000-0000-4000-8000-000000000001',
    'a4890000-0000-4000-8000-000000000004', 1
  );

select vortex_access.initialize_organization_access_version(
  '24890000-0000-4000-8000-000000000001',
  '94890000-0000-4000-8000-000000000001',
  'a4890000-0000-4000-8000-000000000003'
);

select vortex_access.initialize_organization_access_version(
  '24890000-0000-4000-8000-000000000002',
  '94890000-0000-4000-8000-000000000001',
  'a4890000-0000-4000-8000-000000000005'
);

-- Seed real permanent roots in vortex_definition.roots
-- Application root in Org A
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '34890000-0000-4000-8000-000000000001',
  '24890000-0000-4000-8000-000000000001',
  'application', 'test.app.a', pg_catalog.clock_timestamp(),
  '94890000-0000-4000-8000-000000000001'
);

-- Application root in Org B (for cross-org negative test)
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '34890000-0000-4000-8000-000000000002',
  '24890000-0000-4000-8000-000000000002',
  'application', 'test.app.b', pg_catalog.clock_timestamp(),
  '94890000-0000-4000-8000-000000000001'
);

-- Module root in Org A (for non-application negative test)
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '34890000-0000-4000-8000-000000000003',
  '24890000-0000-4000-8000-000000000001',
  'module', 'test.mod.a', pg_catalog.clock_timestamp(),
  '94890000-0000-4000-8000-000000000001'
);

-- ----------------------------------------------------------------------------
-- 3. Mutator Hardening Tests
-- ----------------------------------------------------------------------------

-- Establish administrative context for Org A
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'tenantId', '14890000-0000-4000-8000-000000000001',
  'organizationId', '24890000-0000-4000-8000-000000000001',
  'applicationRootId', '34890000-0000-4000-8000-000000000001',
  'identityId', '44890000-0000-4000-8000-000000000001',
  'organizationAccountId', '54890000-0000-4000-8000-000000000001',
  'callerKind', 'human',
  'identityAuthorityId', '94890000-0000-4000-8000-000000000002',
  'sessionId', 'a4890000-0000-4000-8000-000000000010',
  'correlationId', 'a4890000-0000-4000-8000-000000000011',
  'accessVersion', 1,
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'authenticationStrength', 'single_factor'
));

set local role vortex_runtime;

-- Positive registration: starts in legal state 'pending', outcome 'unknown', revision 1
select lives_ok(
  $$select vortex_connection.register_connection_instance_internal(
    '64890000-0000-4000-8000-000000000001',
    '24890000-0000-4000-8000-000000000001',
    '74890000-0000-4000-8000-000000000001',
    '1.0.0',
    'cold_archive_s3',
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    '84890000-0000-4000-8000-000000000001'
  )$$,
  'register_connection_instance_internal registers row in legal initial state'
);

-- Verify stored initial state is pending / unknown / revision 1
reset role;
select results_eq(
  $$select state, last_health_outcome, revision
    from vortex_connection.connection_instances
    where connection_instance_id = '64890000-0000-4000-8000-000000000001'$$,
  $$values ('pending'::text, 'unknown'::text, 1::bigint)$$,
  'initial state is strictly pending / unknown with revision 1'
);
set local role vortex_runtime;

-- Context organization mismatch check: registration for Org B under Org A context fails
select throws_ok(
  $$select vortex_connection.register_connection_instance_internal(
    '64890000-0000-4000-8000-000000000002',
    '24890000-0000-4000-8000-000000000002',
    '74890000-0000-4000-8000-000000000001',
    '1.0.0',
    'cold_archive_s3',
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    '84890000-0000-4000-8000-000000000001'
  )$$,
  '42501'::char(5),
  'Connection operation organization does not match request context organization',
  'registration refuses organization mismatch with active context'
);

-- Rejection of nil activity ID
select throws_ok(
  $$select vortex_connection.register_connection_instance_internal(
    '64890000-0000-4000-8000-000000000003',
    '24890000-0000-4000-8000-000000000001',
    '74890000-0000-4000-8000-000000000001',
    '1.0.0',
    'another_dest',
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    '00000000-0000-0000-0000-000000000000'
  )$$,
  '22023'::char(5),
  'Connection registration requires non-nil administrator activity ID',
  'registration refuses nil administrator activity ID'
);

-- Canonical human administration rejects a stale Access version.
reset role;
delete from vortex_context.request_contexts
where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'tenantId', '14890000-0000-4000-8000-000000000001',
  'organizationId', '24890000-0000-4000-8000-000000000001',
  'applicationRootId', '34890000-0000-4000-8000-000000000001',
  'identityId', '44890000-0000-4000-8000-000000000001',
  'organizationAccountId', '54890000-0000-4000-8000-000000000001',
  'callerKind', 'human',
  'identityAuthorityId', '94890000-0000-4000-8000-000000000002',
  'sessionId', 'a4890000-0000-4000-8000-000000000012',
  'correlationId', 'a4890000-0000-4000-8000-000000000013',
  'accessVersion', 99,
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'authenticationStrength', 'single_factor'
));
set local role vortex_runtime;
select throws_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000010'
  )$$,
  '42501'::char(5),
  'Request access version is stale or unavailable',
  'human administration refuses a stale organisation Access version'
);

-- Canonical human administration rejects a fabricated organisation-local account.
reset role;
delete from vortex_context.request_contexts
where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'tenantId', '14890000-0000-4000-8000-000000000001',
  'organizationId', '24890000-0000-4000-8000-000000000001',
  'applicationRootId', '34890000-0000-4000-8000-000000000001',
  'identityId', '44890000-0000-4000-8000-000000000001',
  'organizationAccountId', '54890000-0000-4000-8000-000000000099',
  'callerKind', 'human',
  'identityAuthorityId', '94890000-0000-4000-8000-000000000002',
  'sessionId', 'a4890000-0000-4000-8000-000000000014',
  'correlationId', 'a4890000-0000-4000-8000-000000000015',
  'accessVersion', 1,
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'authenticationStrength', 'single_factor'
));
set local role vortex_runtime;
select throws_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000011'
  )$$,
  '42501'::char(5),
  'Organisation-account context is inactive or unavailable',
  'human administration refuses a fabricated organisation account'
);

-- Restore the real current Org A account and Access version.
reset role;
delete from vortex_context.request_contexts
where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'tenantId', '14890000-0000-4000-8000-000000000001',
  'organizationId', '24890000-0000-4000-8000-000000000001',
  'applicationRootId', '34890000-0000-4000-8000-000000000001',
  'identityId', '44890000-0000-4000-8000-000000000001',
  'organizationAccountId', '54890000-0000-4000-8000-000000000001',
  'callerKind', 'human',
  'identityAuthorityId', '94890000-0000-4000-8000-000000000002',
  'sessionId', 'a4890000-0000-4000-8000-000000000016',
  'correlationId', 'a4890000-0000-4000-8000-000000000017',
  'accessVersion', 1,
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'authenticationStrength', 'single_factor'
));
set local role vortex_runtime;

-- Application Grant Tests
-- 1. Positive grant: real application root in same organisation
select lives_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000020'
  )$$,
  'grant_connection_application_internal grants access to valid same-org application root'
);

reset role;
select results_eq(
  $$select activity_id, actor_kind, actor_id, action, subject_ids, source, outcome
    from vortex_activity.organization_activity_entries
    where organization_id = '24890000-0000-4000-8000-000000000001'
      and activity_id = '84890000-0000-4000-8000-000000000020'$$,
  $$values (
    '84890000-0000-4000-8000-000000000020'::uuid,
    'organization_account'::text,
    '54890000-0000-4000-8000-000000000001'::uuid,
    'connection_application_granted'::text,
    array[
      '34890000-0000-4000-8000-000000000001'::uuid,
      '64890000-0000-4000-8000-000000000001'::uuid
    ],
    'connection'::text,
    'completed'::text
  )$$,
  'grant transition persists exact administrator Activity evidence'
);
set local role vortex_runtime;

select throws_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000021'
  )$$,
  '23514'::char(5),
  'Connection application grant already exists',
  'grant refuses a duplicate transition instead of recording fictional Activity'
);

-- 2. Negative grant: application root in Org B (different organization)
select throws_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000002',
    '84890000-0000-4000-8000-000000000001'
  )$$,
  '23514'::char(5),
  'Referenced application root organization does not match connection organization',
  'grant refuses application root belonging to a different organization'
);

-- 3. Negative grant: root with kind = 'module' (not an application)
select throws_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000003',
    '84890000-0000-4000-8000-000000000001'
  )$$,
  '23514'::char(5),
  'Referenced root must be of kind application',
  'grant refuses root of kind module'
);

-- 4. Negative grant: non-existent root
select throws_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000099',
    '84890000-0000-4000-8000-000000000001'
  )$$,
  '23503'::char(5),
  'Referenced application root does not exist',
  'grant refuses nonexistent application root'
);

-- ----------------------------------------------------------------------------
-- 4. State Transitions & Health Checks
-- ----------------------------------------------------------------------------

-- Initial state is pending; readiness resolver must refuse
reset role;
set local role vortex_request;

select is(
  (
    select (readiness ->> 'outcome')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      1,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'refused',
  'resolver refuses pending connection instance'
);

reset role;
set local role vortex_runtime;

-- Stale revision update rejection: expected revision 99 fails with P0002
select throws_ok(
  $$select vortex_connection.record_connection_health_check_internal(
    '64890000-0000-4000-8000-000000000001',
    99,
    'healthy',
    '84890000-0000-4000-8000-000000000001'
  )$$,
  'P0002'::char(5),
  'Connection instance health update failed: revision mismatch or not found',
  'health check update rejects revision mismatch'
);

-- Transition: pending + healthy -> active with revision 2
select is(
  (
    select vortex_connection.record_connection_health_check_internal(
      '64890000-0000-4000-8000-000000000001',
      1,
      'healthy',
      '84890000-0000-4000-8000-000000000001'
    )
  ),
  2::bigint,
  'pending connection transitions to active with revision 2 on healthy check'
);

-- ----------------------------------------------------------------------------
-- 5. Authoritative Readiness Check (Positive and Negatives)
-- ----------------------------------------------------------------------------
reset role;
set local role vortex_request;

-- Positive readiness: active, healthy, matching app, revision 2, valid fingerprint
select is(
  (
    select (readiness ->> 'outcome')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      2,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'ready',
  'resolver returns ready for active, healthy, granted connection instance'
);

-- Stale revision check: expected revision 1 (stored is 2)
select is(
  (
    select (readiness ->> 'reasonCode')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      1,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'stale_revision',
  'resolver refuses stale revision'
);

-- Stale fingerprint check
select is(
  (
    select (readiness ->> 'reasonCode')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      2,
      '0000000000000000000000000000000000000000000000000000000000000000'
    ) as readiness
  ),
  'stale_fingerprint',
  'resolver refuses stale destination fingerprint'
);

-- Destination key mismatch
select is(
  (
    select (readiness ->> 'reasonCode')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'wrong_dest_key',
      2,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'destination_mismatch',
  'resolver refuses mismatched destination key'
);

-- Ungranted application root
select is(
  (
    select (readiness ->> 'reasonCode')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000002',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      2,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'grant_unauthorized',
  'resolver refuses ungranted application root'
);

-- Organization mismatch
select is(
  (
    select (readiness ->> 'reasonCode')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000002',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      2,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'organization_mismatch',
  'resolver refuses organization mismatch'
);

-- Grant revocation removes authorization and records exact immutable Activity evidence.
reset role;
set local role vortex_runtime;
select lives_ok(
  $$select vortex_connection.revoke_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000022'
  )$$,
  'grant revocation succeeds for the exact existing application grant'
);

reset role;
select results_eq(
  $$select activity_id, actor_kind, actor_id, action, subject_ids, source, outcome
    from vortex_activity.organization_activity_entries
    where organization_id = '24890000-0000-4000-8000-000000000001'
      and activity_id = '84890000-0000-4000-8000-000000000022'$$,
  $$values (
    '84890000-0000-4000-8000-000000000022'::uuid,
    'organization_account'::text,
    '54890000-0000-4000-8000-000000000001'::uuid,
    'connection_application_revoked'::text,
    array[
      '34890000-0000-4000-8000-000000000001'::uuid,
      '64890000-0000-4000-8000-000000000001'::uuid
    ],
    'connection'::text,
    'completed'::text
  )$$,
  'grant revocation persists exact administrator Activity evidence'
);

set local role vortex_request;
select is(
  (
    select readiness ->> 'reasonCode'
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      2,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'grant_unauthorized',
  'readiness refuses immediately after exact grant revocation'
);

reset role;
set local role vortex_runtime;
select throws_ok(
  $$select vortex_connection.revoke_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000024'
  )$$,
  'P0002'::char(5),
  'Connection application grant not found',
  'grant revocation refuses a missing source grant'
);

select lives_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000001',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000023'
  )$$,
  'grant can be restored through a new evidenced transition'
);

-- ----------------------------------------------------------------------------
-- 6. Terminal Revocation & Governed Reauthorization Tests
-- ----------------------------------------------------------------------------
reset role;
set local role vortex_runtime;

-- Revoke instance: transitions to 'revoked', revision 3
select is(
  (
    select vortex_connection.revoke_connection_instance_internal(
      '64890000-0000-4000-8000-000000000001',
      2,
      '84890000-0000-4000-8000-000000000002'
    )
  ),
  3::bigint,
  'revoke_connection_instance_internal revokes instance and advances revision to 3'
);

-- Resolver immediately rejects revoked instance
reset role;
set local role vortex_request;

select is(
  (
    select (readiness ->> 'reasonCode')
    from vortex_connection.resolve_connection_instance_readiness(
      '24890000-0000-4000-8000-000000000001',
      '34890000-0000-4000-8000-000000000001',
      '64890000-0000-4000-8000-000000000001',
      'cold_archive_s3',
      3,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    ) as readiness
  ),
  'connection_not_active',
  'resolver refuses revoked connection instance'
);

-- Terminal revocation rule: health check CANNOT resurrect revoked instance
reset role;
set local role vortex_runtime;

select throws_ok(
  $$select vortex_connection.record_connection_health_check_internal(
    '64890000-0000-4000-8000-000000000001',
    3,
    'healthy',
    '84890000-0000-4000-8000-000000000002'
  )$$,
  '42501'::char(5),
  'Connection instance is revoked; revocation is terminal and cannot transition via health check',
  'health check cannot transition revoked instance'
);

-- Governed reauthorization: resets state to pending, outcome to unknown, revision 4
select is(
  (
    select vortex_connection.reauthorize_connection_instance_internal(
      '64890000-0000-4000-8000-000000000001',
      3,
      '84890000-0000-4000-8000-000000000003',
      'b2c3d4e5f6a10718293a4b5c6d7e8f90b2c3d4e5f6a10718293a4b5c6d7e8f90'
    )
  ),
  4::bigint,
  'governed reauthorization resets revoked instance to pending with new revision 4'
);

-- Reauthorized instance is pending and requires health check
select is(
  (
    select vortex_connection.record_connection_health_check_internal(
      '64890000-0000-4000-8000-000000000001',
      4,
      'healthy',
      '84890000-0000-4000-8000-000000000003'
    )
  ),
  5::bigint,
  'reauthorized instance becomes active only after successful health check with revision 5'
);

-- Exercise the separately governed system administration path and every illegal source state.
reset role;
delete from vortex_context.request_contexts
where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'tenantId', '14890000-0000-4000-8000-000000000001',
  'organizationId', '24890000-0000-4000-8000-000000000001',
  'applicationRootId', '34890000-0000-4000-8000-000000000001',
  'callerKind', 'system',
  'sessionId', 'a4890000-0000-4000-8000-000000000030',
  'correlationId', 'a4890000-0000-4000-8000-000000000031',
  'systemActorId', '94890000-0000-4000-8000-000000000001',
  'accessVersion', 1,
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'authenticationStrength', 'service'
));
set local role vortex_runtime;

select lives_ok(
  $$select vortex_connection.register_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004',
    '24890000-0000-4000-8000-000000000001',
    '74890000-0000-4000-8000-000000000001',
    '1.0.0',
    'system_state_probe',
    'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    '84890000-0000-4000-8000-000000000030'
  )$$,
  'governed system context can register a pending connection'
);

select lives_ok(
  $$select vortex_connection.grant_connection_application_internal(
    '64890000-0000-4000-8000-000000000004',
    '34890000-0000-4000-8000-000000000001',
    '84890000-0000-4000-8000-000000000031'
  )$$,
  'governed system context can grant an application with Activity evidence'
);

select throws_ok(
  $$select vortex_connection.reauthorize_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 1,
    '84890000-0000-4000-8000-000000000032'
  )$$,
  '23514'::char(5),
  'Connection reauthorization requires revoked source state',
  'reauthorization refuses pending source state'
);

select is(
  vortex_connection.record_connection_health_check_internal(
    '64890000-0000-4000-8000-000000000004', 1, 'healthy',
    '84890000-0000-4000-8000-000000000033'
  ),
  2::bigint,
  'system probe transitions pending to active'
);

select throws_ok(
  $$select vortex_connection.reauthorize_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 2,
    '84890000-0000-4000-8000-000000000034'
  )$$,
  '23514'::char(5),
  'Connection reauthorization requires revoked source state',
  'reauthorization refuses active source state'
);

select is(
  vortex_connection.record_connection_health_check_internal(
    '64890000-0000-4000-8000-000000000004', 2, 'unhealthy',
    '84890000-0000-4000-8000-000000000035'
  ),
  3::bigint,
  'system probe transitions active to unhealthy'
);

select throws_ok(
  $$select vortex_connection.reauthorize_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 3,
    '84890000-0000-4000-8000-000000000036'
  )$$,
  '23514'::char(5),
  'Connection reauthorization requires revoked source state',
  'reauthorization refuses unhealthy source state'
);

select is(
  vortex_connection.revoke_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 3,
    '84890000-0000-4000-8000-000000000037'
  ),
  4::bigint,
  'revocation accepts a non-revoked legal source state'
);

select throws_ok(
  $$select vortex_connection.revoke_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 4,
    '84890000-0000-4000-8000-000000000038'
  )$$,
  '23514'::char(5),
  'Connection revocation requires a non-revoked source state',
  'revocation refuses already-revoked source state'
);

select is(
  vortex_connection.reauthorize_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 4,
    '84890000-0000-4000-8000-000000000039'
  ),
  5::bigint,
  'reauthorization accepts only the revoked source state'
);

select throws_ok(
  $$select vortex_connection.reauthorize_connection_instance_internal(
    '64890000-0000-4000-8000-000000000004', 5,
    '84890000-0000-4000-8000-000000000040'
  )$$,
  '23514'::char(5),
  'Connection reauthorization requires revoked source state',
  'reauthorization refuses the resulting pending state'
);

reset role;
select results_eq(
  $$select actor_kind, actor_id, action
    from vortex_activity.organization_activity_entries
    where organization_id = '24890000-0000-4000-8000-000000000001'
      and activity_id = '84890000-0000-4000-8000-000000000031'$$,
  $$values (
    'system'::text,
    '94890000-0000-4000-8000-000000000001'::uuid,
    'connection_application_granted'::text
  )$$,
  'system grant Activity retains the exact governed system actor'
);

-- ----------------------------------------------------------------------------
-- 7. Active Connection Evidence Reader Tests
-- ----------------------------------------------------------------------------
reset role;
set local role vortex_request;

select results_eq(
  $$select destination_key, revision, state, last_health_outcome
    from vortex_connection.read_active_connection_evidence('64890000-0000-4000-8000-000000000001')$$,
  $$values ('cold_archive_s3'::text, 5::bigint, 'active'::text, 'healthy'::text)$$,
  'evidence reader returns active healthy evidence row'
);

-- RLS Isolation: Org B request context cannot see Org A connection instances
reset role;
delete from vortex_context.request_contexts
where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'tenantId', '14890000-0000-4000-8000-000000000001',
  'organizationId', '24890000-0000-4000-8000-000000000002',
  'applicationRootId', '34890000-0000-4000-8000-000000000002',
  'identityId', '44890000-0000-4000-8000-000000000001',
  'organizationAccountId', '54890000-0000-4000-8000-000000000002',
  'callerKind', 'human',
  'identityAuthorityId', '94890000-0000-4000-8000-000000000002',
  'sessionId', 'a4890000-0000-4000-8000-000000000020',
  'correlationId', 'a4890000-0000-4000-8000-000000000021',
  'accessVersion', 1,
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'authenticationStrength', 'single_factor'
));

set local role vortex_request;

select ok(
  not exists (
    select 1
    from vortex_connection.connection_instances
    where connection_instance_id = '64890000-0000-4000-8000-000000000001'
  ),
  'FORCE RLS prevents Org B from viewing Org A connection instance'
);

select ok(
  not exists (
    select 1
    from vortex_connection.connection_application_grants
    where connection_instance_id = '64890000-0000-4000-8000-000000000001'
  ),
  'FORCE RLS prevents Org B from viewing Org A application grants'
);

select is(
  (
    select count(*)
    from vortex_connection.read_active_connection_evidence('64890000-0000-4000-8000-000000000001')
  ),
  0::bigint,
  'evidence reader returns zero rows across organization boundary'
);

reset role;

select * from finish();

rollback;
