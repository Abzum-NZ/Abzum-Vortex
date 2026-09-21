begin;
select plan(46);

set local search_path = pg_catalog, extensions, public;

-- Grant usage on schema extensions to vortex_request inside this rolled-back transaction
-- so pgTAP assertions can be evaluated when switching roles.
grant usage on schema extensions to vortex_request;

-- ============================================================================
-- Section 1: Schema and Object Existence
-- ============================================================================

select has_schema('vortex_workflow', 'vortex_workflow schema exists');
select has_table('vortex_workflow', 'workflow_roots', 'workflow_roots table exists');
select has_table('vortex_workflow', 'workflow_revisions', 'workflow_revisions table exists');
select has_table('vortex_workflow', 'workflow_application_authorizations', 'workflow_application_authorizations table exists');

select has_function(
  'vortex_workflow',
  'check_workflow_registration_readiness',
  array['uuid', 'bigint', 'uuid', 'uuid', 'text', 'text'],
  'vortex_workflow.check_workflow_registration_readiness function exists'
);

select has_function(
  'vortex_workflow',
  'read_registered_workflow_evidence',
  array['uuid', 'uuid'],
  'vortex_workflow.read_registered_workflow_evidence function exists'
);

-- ============================================================================
-- Section 2: Row Level Security (RLS) Enforcement
-- ============================================================================

select ok(
  (
    select c.relrowsecurity and c.relforcerowsecurity
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'vortex_workflow' and c.relname = 'workflow_roots'
  ),
  'workflow_roots has RLS enabled and forced'
);

select ok(
  (
    select c.relrowsecurity and c.relforcerowsecurity
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'vortex_workflow' and c.relname = 'workflow_revisions'
  ),
  'workflow_revisions has RLS enabled and forced'
);

select ok(
  (
    select c.relrowsecurity and c.relforcerowsecurity
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'vortex_workflow' and c.relname = 'workflow_application_authorizations'
  ),
  'workflow_application_authorizations has RLS enabled and forced'
);

-- ============================================================================
-- Section 3: Role Privileges and Direct Table Denials
-- ============================================================================

select ok(
  pg_catalog.has_function_privilege('vortex_request', 'vortex_workflow.check_workflow_registration_readiness(uuid,bigint,uuid,uuid,text,text)', 'EXECUTE'),
  'vortex_request has EXECUTE on check_workflow_registration_readiness'
);

select ok(
  not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_workflow.check_workflow_registration_readiness(uuid,bigint,uuid,uuid,text,text)', 'EXECUTE'),
  'vortex_runtime has NO EXECUTE on check_workflow_registration_readiness'
);

select ok(
  not pg_catalog.has_function_privilege('public', 'vortex_workflow.check_workflow_registration_readiness(uuid,bigint,uuid,uuid,text,text)', 'EXECUTE'),
  'public has NO EXECUTE on check_workflow_registration_readiness'
);

select ok(
  pg_catalog.has_function_privilege('vortex_request', 'vortex_workflow.read_registered_workflow_evidence(uuid,uuid)', 'EXECUTE'),
  'vortex_request has EXECUTE on read_registered_workflow_evidence'
);

select ok(
  not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_workflow.read_registered_workflow_evidence(uuid,uuid)', 'EXECUTE'),
  'vortex_runtime has NO EXECUTE on read_registered_workflow_evidence'
);

select ok(
  not pg_catalog.has_function_privilege('public', 'vortex_workflow.read_registered_workflow_evidence(uuid,uuid)', 'EXECUTE'),
  'public has NO EXECUTE on read_registered_workflow_evidence'
);

select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_workflow.workflow_roots', 'SELECT'),
  'vortex_request cannot directly SELECT from workflow_roots'
);

select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_workflow.workflow_revisions', 'SELECT'),
  'vortex_request cannot directly SELECT from workflow_revisions'
);

select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_workflow.workflow_application_authorizations', 'SELECT'),
  'vortex_request cannot directly SELECT from workflow_application_authorizations'
);

select ok(
  not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_workflow.workflow_roots', 'SELECT'),
  'vortex_runtime cannot directly SELECT from workflow_roots'
);

select ok(
  not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_workflow.workflow_revisions', 'SELECT'),
  'vortex_runtime cannot directly SELECT from workflow_revisions'
);

select ok(
  not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_workflow.workflow_application_authorizations', 'SELECT'),
  'vortex_runtime cannot directly SELECT from workflow_application_authorizations'
);

select ok(
  not pg_catalog.has_function_privilege('vortex_request', 'vortex_workflow.record_workflow_root_internal(uuid,uuid,text,text,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_workflow.record_workflow_root_internal(uuid,uuid,text,text,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_workflow.record_workflow_revision_internal(uuid,bigint,text,text[],uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_workflow.record_workflow_revision_internal(uuid,bigint,text,text[],uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_request', 'vortex_workflow.activate_workflow_revision_internal(uuid,bigint,uuid,uuid)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_workflow.activate_workflow_revision_internal(uuid,bigint,uuid,uuid)', 'EXECUTE'),
  'internal lifecycle mutators are denied to vortex_request and vortex_runtime'
);

-- ============================================================================
-- Section 4: Fixture Setup and Monotonic Lifecycle Mutations
-- ============================================================================

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14770000-0000-4000-8000-000000000001', 'wf_test_tenant',
  'Workflow test tenant', 'active', pg_catalog.statement_timestamp(),
  '94770000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '24770000-0000-4000-8000-000000000001',
    '14770000-0000-4000-8000-000000000001', null, 'wf_test_org_one',
    'Workflow test org one', 'active', pg_catalog.statement_timestamp(),
    '94770000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '24770000-0000-4000-8000-000000000002',
    '14770000-0000-4000-8000-000000000001', null, 'wf_test_org_two',
    'Workflow test org two', 'active', pg_catalog.statement_timestamp(),
    '94770000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  );

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34770000-0000-4000-8000-000000000001',
    '24770000-0000-4000-8000-000000000001', 'application',
    'vortex.workflow_test.app_one', pg_catalog.statement_timestamp(),
    '94770000-0000-4000-8000-000000000001'
  ),
  (
    '34770000-0000-4000-8000-000000000002',
    '24770000-0000-4000-8000-000000000001', 'application',
    'vortex.workflow_test.app_two', pg_catalog.statement_timestamp(),
    '94770000-0000-4000-8000-000000000001'
  );

-- Record workflow root
select vortex_workflow.record_workflow_root_internal(
  '44770000-0000-4000-8000-000000000001',
  '24770000-0000-4000-8000-000000000001',
  'test.archive.pipeline_one',
  'Test archive pipeline',
  '94770000-0000-4000-8000-000000000001'
);

-- Workflow root immutability test
select throws_ok(
  $$update vortex_workflow.workflow_roots
    set organization_id = '24770000-0000-4000-8000-000000000002'
    where workflow_id = '44770000-0000-4000-8000-000000000001'$$,
  '23514',
  'Workflow root identity, organization, key and creation evidence are permanent',
  'workflow_roots identity and organization are immutable'
);

-- Register revision 1
select vortex_workflow.record_workflow_revision_internal(
  '44770000-0000-4000-8000-000000000001',
  1,
  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  array['cold_archive_s3', 'compliance_vault_1'],
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000001'
);

-- Monotonic registration check: re-registering revision 1 fails strictly
select throws_ok(
  $$select vortex_workflow.record_workflow_revision_internal(
    '44770000-0000-4000-8000-000000000001',
    1,
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    array['cold_archive_s3'],
    '94770000-0000-4000-8000-000000000001',
    'c4770000-0000-4000-8000-000000000002'
  )$$,
  '23514',
  'New workflow revision must be strictly greater than existing revisions',
  'workflow revision registration enforces strictly monotonic ordering'
);

-- Monotonic registration check: revision 0 fails check constraint
select throws_ok(
  $$select vortex_workflow.record_workflow_revision_internal(
    '44770000-0000-4000-8000-000000000001',
    0,
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    array['cold_archive_s3'],
    '94770000-0000-4000-8000-000000000001',
    'c4770000-0000-4000-8000-000000000003'
  )$$,
  '23514',
  null,
  'non-positive revision fails check constraint'
);

-- Prepare, verify, and activate revision 1
select vortex_workflow.mark_workflow_revision_prepared_internal(
  '44770000-0000-4000-8000-000000000001',
  1,
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000004'
);

select vortex_workflow.mark_workflow_revision_verified_internal(
  '44770000-0000-4000-8000-000000000001',
  1,
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000005'
);

select vortex_workflow.activate_workflow_revision_internal(
  '44770000-0000-4000-8000-000000000001',
  1,
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000006'
);

-- Register revision 2
select vortex_workflow.record_workflow_revision_internal(
  '44770000-0000-4000-8000-000000000001',
  2,
  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  array['cold_archive_s3', 'compliance_vault_1'],
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000007'
);

-- Prepare, verify, and activate revision 2 (supersedes revision 1)
select vortex_workflow.mark_workflow_revision_prepared_internal(
  '44770000-0000-4000-8000-000000000001',
  2,
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000008'
);

select vortex_workflow.mark_workflow_revision_verified_internal(
  '44770000-0000-4000-8000-000000000001',
  2,
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000009'
);

select vortex_workflow.activate_workflow_revision_internal(
  '44770000-0000-4000-8000-000000000001',
  2,
  '94770000-0000-4000-8000-000000000001',
  'c4770000-0000-4000-8000-000000000010'
);

-- Check revision 1 was superseded
select is(
  (select state from vortex_workflow.workflow_revisions where workflow_id = '44770000-0000-4000-8000-000000000001' and revision = 1),
  'superseded',
  'activating revision 2 supersedes revision 1'
);

-- Superseded immutability: cannot modify superseded row
select throws_ok(
  $$update vortex_workflow.workflow_revisions
    set state = 'active'
    where workflow_id = '44770000-0000-4000-8000-000000000001' and revision = 1$$,
  '23514',
  'Superseded workflow revisions are permanent and immutable',
  'superseded workflow revisions cannot transition back to active'
);

-- Monotonic activation check: attempting to activate revision 1 again fails
select throws_ok(
  $$select vortex_workflow.activate_workflow_revision_internal(
    '44770000-0000-4000-8000-000000000001',
    1,
    '94770000-0000-4000-8000-000000000001',
    'c4770000-0000-4000-8000-000000000011'
  )$$,
  '23514',
  'Activated revision must be strictly greater than all superseded revisions',
  'activating a superseded or lower revision is prohibited'
);

-- Authorize workflow for application root 1
select vortex_workflow.authorize_workflow_application_internal(
  '44770000-0000-4000-8000-000000000001',
  '34770000-0000-4000-8000-000000000001',
  '94770000-0000-4000-8000-000000000001'
);

-- ============================================================================
-- Section 5: Fail-Closed Context Validation Tests (as vortex_request)
-- ============================================================================

-- Helper to set request context
create function pg_temp.set_test_context(
  p_caller_kind text,
  p_org_id uuid,
  p_app_id uuid default null,
  p_auth_strength text default 'service'
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  req jsonb;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  req := pg_catalog.jsonb_build_object(
    'callerKind', p_caller_kind,
    'tenantId', '14770000-0000-4000-8000-000000000001'::uuid,
    'organizationId', p_org_id,
    'sessionId', '64770000-0000-4000-8000-000000000001'::uuid,
    'authenticationStrength', p_auth_strength,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', 'c4770000-0000-4000-8000-000000000099'::uuid
  );
  if p_caller_kind = 'system' then
    req := req || pg_catalog.jsonb_build_object('systemActorId', '94770000-0000-4000-8000-000000000001'::uuid);
  end if;
  if p_app_id is not null then
    req := req || pg_catalog.jsonb_build_object('applicationRootId', p_app_id);
  end if;
  perform vortex_context.initialize(req);
end
$function$;

-- Clear any context and switch to vortex_request
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

-- Context failure 1: absent context throws
select throws_ok(
  $$select vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  )$$,
  '55000',
  'Vortex request context is not established',
  'check_workflow_registration_readiness fails closed without established request context'
);
reset role;

-- Context failure 2: public callerKind throws 42501
select pg_temp.set_test_context('public', '24770000-0000-4000-8000-000000000001', null, 'anonymous');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$select vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  )$$,
  '42501',
  'Workflow registration readiness check requires human or system context',
  'check_workflow_registration_readiness fails closed on public callerKind'
);
reset role;

-- Context failure 3: caller context organization does not match requested organization
select pg_temp.set_test_context('system', '24770000-0000-4000-8000-000000000001');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$select vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000002',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  )$$,
  '42501',
  'Caller context organization does not match requested organization',
  'check_workflow_registration_readiness fails closed on organization mismatch with context'
);
reset role;

-- Context failure 4: context bound to application one calling check for application two throws 42501
select pg_temp.set_test_context('system', '24770000-0000-4000-8000-000000000001', '34770000-0000-4000-8000-000000000001');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$select vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000002',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  )$$,
  '42501',
  'Caller context application does not match requested application',
  'check_workflow_registration_readiness fails closed on application mismatch with context'
);
reset role;

-- ============================================================================
-- Section 6: Positive and Negative Readiness Evaluations (as vortex_request)
-- ============================================================================

select pg_temp.set_test_context('system', '24770000-0000-4000-8000-000000000001');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

-- Positive readiness check
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'outcome',
  'ready',
  'positive readiness returns outcome ready'
);

-- Negative: workflow not registered
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000999', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'archive_workflow_not_registered',
  'unregistered workflow returns archive_workflow_not_registered'
);

-- Negative: workflow belongs to different organization (tested with org two context)
reset role;
select pg_temp.set_test_context('system', '24770000-0000-4000-8000-000000000002');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000002',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'wrong_organization',
  'workflow from different organization returns wrong_organization'
);

reset role;
select pg_temp.set_test_context('system', '24770000-0000-4000-8000-000000000001');
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

-- Negative: missing application root
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    null,
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'archive_workflow_scope_mismatch',
  'null application root returns archive_workflow_scope_mismatch'
);

-- Negative: unauthorized application root
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000002',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'archive_workflow_scope_mismatch',
  'unauthorized application root returns archive_workflow_scope_mismatch'
);

-- Negative: superseded revision
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 1,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111'
  ) ->> 'reasonCode',
  'workflow_state_superseded',
  'superseded revision returns workflow_state_superseded'
);

-- Negative: non-existent revision
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 99,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'stale_revision',
  'non-existent revision returns stale_revision'
);

-- Negative: stale fingerprint
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:9999999999999999999999999999999999999999999999999999999999999999'
  ) ->> 'reasonCode',
  'stale_fingerprint',
  'mismatched expected fingerprint returns stale_fingerprint'
);

-- Negative: destination mismatch
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'unsupported-vault',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'destination_mismatch',
  'unsupported destination returns destination_mismatch'
);

-- Negative: invalid destination format
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '44770000-0000-4000-8000-000000000001', 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'INVALID_UPPERCASE',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'invalid_archive_destination',
  'invalid destination format returns invalid_archive_destination'
);

-- Negative: nil workflow UUID
select is(
  vortex_workflow.check_workflow_registration_readiness(
    '00000000-0000-0000-0000-000000000000'::uuid, 2,
    '24770000-0000-4000-8000-000000000001',
    '34770000-0000-4000-8000-000000000001',
    'cold_archive_s3',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  ) ->> 'reasonCode',
  'invalid_workflow_identity',
  'nil workflow UUID returns invalid_workflow_identity'
);

-- ============================================================================
-- Section 7: Evidence Reader Tests (as vortex_request)
-- ============================================================================

-- Evidence reader returns active revision with full metadata
select is(
  (
    select workflow_revision
    from vortex_workflow.read_registered_workflow_evidence(
      '24770000-0000-4000-8000-000000000001',
      '34770000-0000-4000-8000-000000000001'
    )
  ),
  2::bigint,
  'evidence reader returns active revision 2'
);

-- Evidence reader excludes superseded revision 1
select is(
  (
    select count(*)
    from vortex_workflow.read_registered_workflow_evidence('24770000-0000-4000-8000-000000000001')
    where workflow_revision = 1
  ),
  0::bigint,
  'evidence reader excludes superseded revision 1'
);

-- Evidence reader returns empty set for unauthorized application root 2
select is(
  (
    select count(*)
    from vortex_workflow.read_registered_workflow_evidence(
      '24770000-0000-4000-8000-000000000001',
      '34770000-0000-4000-8000-000000000002'
    )
  ),
  0::bigint,
  'evidence reader returns empty set for unauthorized application root'
);

reset role;

select * from finish();
rollback;
