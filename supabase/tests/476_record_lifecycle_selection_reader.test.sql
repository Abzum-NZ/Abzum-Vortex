\ir helpers/definition-release-writer.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #408 Slice 1: pgTAP tests for the lifecycle candidate selection reader.
--
-- Exercises:
--   1. System context enforcement: requires callerKind = 'system' and service auth.
--   2. Human context rejection: callerKind = 'human' fails closed with 42501.
--   3. All retained lifecycle states (active, soft_deleted, removal_pending) returned.
--   4. Results ordered by created_at ascending; oldest first.
--   5. Revision and timestamp projection accuracy.
--   6. Contained versus organisation-shared scope; application context required.
--   7. Cross-organisation isolation: org two system context sees no org one records.
--   8. Malformed storage identity (nil UUID, null, nonexistent).
--   9. Tenant-organization binding validation.
--  10. Role-based access: vortex_request can call, vortex_runtime cannot.
--
-- Fixture shape:
--   Organisation 1: Module M1 → Application A1
--     S1 = organization_shared, ownership none, one text field
--     C1 = application_contained, ownership organization_account, one text field
--   Organisation 2: Module M2 → Application A2
--     S2 = organization_shared, ownership none, one text field
-- ============================================================================

-- Fixed UUIDs.
\set tenant '14760000-0000-4000-8000-000000000001'
\set org_one '24760000-0000-4000-8000-000000000001'
\set org_two '24760000-0000-4000-8000-000000000002'
\set actor '94760000-0000-4000-8000-000000000001'

\set module_one '44760000-0000-4000-8000-000000000001'
\set module_two '44760000-0000-4000-8000-000000000002'
\set app_one '34760000-0000-4000-8000-000000000001'
\set app_two '34760000-0000-4000-8000-000000000002'

\set type_s1 'd4760000-0000-4000-8000-000000000001'
\set type_c1 'd4760000-0000-4000-8000-000000000002'
\set type_s2 'd4760000-0000-4000-8000-000000000011'
\set storage_s1 'b4760000-0000-4000-8000-000000000001'
\set storage_c1 'b4760000-0000-4000-8000-000000000002'
\set storage_s2 'b4760000-0000-4000-8000-000000000011'

\set f_text 'f4760000-0000-4000-8000-000000000001'

\set rec_s1_active 'e4760000-0000-4000-8000-000000000001'
\set rec_s1_deleted 'e4760000-0000-4000-8000-000000000002'
\set rec_s1_pending 'e4760000-0000-4000-8000-000000000003'
\set rec_c1_a 'e4760000-0000-4000-8000-000000000004'
\set rec_s2_a 'e4760000-0000-4000-8000-000000000011'

-- ============================================================================
-- Foundation bootstrap.
-- ============================================================================
insert into vortex_identity.tenants (tenant_id, name, state)
values (:'tenant', 'Test Tenant 476', 'active');

insert into vortex_identity.organizations (organization_id, tenant_id, name, state)
values (:'org_one', :'tenant', 'Org One 476', 'active'),
       (:'org_two', :'tenant', 'Org Two 476', 'active');

insert into vortex_identity.identity_authorities (
  identity_authority_id, kind, claims_audience, state
) values (:'actor', 'managed', 'https://test.476.localhost', 'active');

insert into vortex_identity.identities (identity_id, identity_authority_id, external_id, state)
values (:'actor', :'actor', 'actor-476', 'active');

insert into vortex_identity.organization_accounts (
  organization_id, organization_account_id, identity_id, state
) values
  (:'org_one', :'actor', :'actor', 'active'),
  (:'org_two', :'actor', :'actor', 'active');

insert into vortex_access.organization_access_versions (organization_id, current_version)
values (:'org_one', 1), (:'org_two', 1);

-- Definition roots.
insert into vortex_definition.roots (root_id, source_kind, state, name, created_by)
values (:'module_one', 'module', 'active', 'module-one-476', :'actor'),
       (:'module_two', 'module', 'active', 'module-two-476', :'actor'),
       (:'app_one', 'application', 'active', 'app-one-476', :'actor'),
       (:'app_two', 'application', 'active', 'app-two-476', :'actor');

-- ============================================================================
-- Module releases.
-- ============================================================================
create function pg_temp.lsr_field(p_field_id uuid)
returns jsonb language sql immutable set search_path = '' as $fn$
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field_id,
    'key', 'k_' || pg_catalog.replace(pg_catalog.lower(p_field_id::text), '-', ''),
    'type', 'text',
    'required', false, 'unique', false, 'filterable', false, 'sortable', false,
    'settings', pg_catalog.jsonb_build_object('maxLength', 200)
  )
$fn$;

select pg_temp.append_writer_release(:'module_one', 1, jsonb_build_object(
  'name', 'Module 476 test', 'description', 'Lifecycle selection reader test module.',
  'dependencies', '[]'::jsonb,
  'recordTypes', jsonb_build_array(
    jsonb_build_object(
      'recordTypeId', :'type_s1',
      'key', 'shared_476',
      'singularLabel', 'Shared', 'pluralLabel', 'Shared records',
      'titleFieldId', :'f_text',
      'storageContractId', :'storage_s1',
      'storageScope', 'organization_shared',
      'ownershipMode', 'none',
      'fields', jsonb_build_array(pg_temp.lsr_field(:'f_text')),
      'relationships', '[]'::jsonb,
      'standardActions', jsonb_build_array('create', 'read', 'update', 'delete'),
      'customActionIds', '[]'::jsonb
    ),
    jsonb_build_object(
      'recordTypeId', :'type_c1',
      'key', 'contained_476',
      'singularLabel', 'Contained', 'pluralLabel', 'Contained records',
      'titleFieldId', :'f_text',
      'storageContractId', :'storage_c1',
      'storageScope', 'application_contained',
      'ownershipMode', 'organization_account',
      'fields', jsonb_build_array(pg_temp.lsr_field(:'f_text')),
      'relationships', '[]'::jsonb,
      'standardActions', jsonb_build_array('create', 'read', 'update', 'delete'),
      'customActionIds', '[]'::jsonb
    )
  ),
  'permissions', '[]'::jsonb,
  'sharingConditions', '[]'::jsonb
));

select pg_temp.append_writer_release(:'module_two', 1, jsonb_build_object(
  'name', 'Module 476b test', 'description', 'Lifecycle selection reader test module two.',
  'dependencies', '[]'::jsonb,
  'recordTypes', jsonb_build_array(
    jsonb_build_object(
      'recordTypeId', :'type_s2',
      'key', 'shared_476b',
      'singularLabel', 'Shared B', 'pluralLabel', 'Shared B records',
      'titleFieldId', :'f_text',
      'storageContractId', :'storage_s2',
      'storageScope', 'organization_shared',
      'ownershipMode', 'none',
      'fields', jsonb_build_array(pg_temp.lsr_field(:'f_text')),
      'relationships', '[]'::jsonb,
      'standardActions', jsonb_build_array('create', 'read', 'update', 'delete'),
      'customActionIds', '[]'::jsonb
    )
  ),
  'permissions', '[]'::jsonb,
  'sharingConditions', '[]'::jsonb
));

select pg_temp.append_writer_release(:'app_one', 1, jsonb_build_object(
  'name', 'App 476 test', 'description', 'Lifecycle selection reader test app.',
  'dependencies', '[]'::jsonb,
  'permissions', '[]'::jsonb,
  'moduleDependencies', jsonb_build_array(
    jsonb_build_object('moduleRootId', :'module_one', 'moduleReleaseRevision', 1)
  )
));

select pg_temp.append_writer_release(:'app_two', 1, jsonb_build_object(
  'name', 'App 476b test', 'description', 'Lifecycle selection reader test app two.',
  'dependencies', '[]'::jsonb,
  'permissions', '[]'::jsonb,
  'moduleDependencies', jsonb_build_array(
    jsonb_build_object('moduleRootId', :'module_two', 'moduleReleaseRevision', 1)
  )
));

-- Provision and activate storage.
set local role vortex_module_owner;
select vortex_module.provision_module_installation_storage(:'module_one', 1, :'org_one');
select vortex_module.provision_module_installation_storage(:'module_two', 1, :'org_two');
select vortex_module.activate_application_installation(:'app_one', 1, :'org_one');
select vortex_module.activate_application_installation(:'app_two', 1, :'org_two');
reset role;

-- ============================================================================
-- Insert test records under vortex_record_adapter with active scope policies.
-- ============================================================================

-- Context: org one system context (shared scope, no application root).
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'system',
  'tenantId', :'tenant',
  'organizationId', :'org_one',
  'systemActorId', :'actor',
  'authenticationStrength', 'service',
  'sessionId', '94760000-0000-4000-8000-ffffffffffff',
  'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessVersion', 1,
  'correlationId', '94760000-0000-4000-8000-ffffffffffff'
));

set local role vortex_record_adapter;

-- 1. Active record with revision 5.
insert into record_data.rt_b4760000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id,
  lifecycle_state, concurrency_number,
  created_at, created_by, updated_at, updated_by
) values (
  :'org_one', :'module_one', :'type_s1', :'storage_s1',
  :'rec_s1_active', null, 1, null, null,
  'active', 5,
  '2026-08-01T10:00:00Z'::timestamptz, :'actor',
  '2026-08-15T12:00:00Z'::timestamptz, :'actor'
);

-- 2. Soft-deleted record with revision 2.
insert into record_data.rt_b4760000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id,
  lifecycle_state, concurrency_number,
  created_at, created_by, updated_at, updated_by,
  deleted_at, deleted_by
) values (
  :'org_one', :'module_one', :'type_s1', :'storage_s1',
  :'rec_s1_deleted', null, 1, null, null,
  'soft_deleted', 2,
  '2026-09-15T14:30:00Z'::timestamptz, :'actor',
  '2026-09-16T00:00:00Z'::timestamptz, :'actor',
  '2026-09-16T00:00:00Z'::timestamptz, :'actor'
);

-- 3. removal_pending record with revision 10 (retained state: must be returned).
insert into record_data.rt_b4760000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id,
  lifecycle_state, concurrency_number,
  created_at, created_by, updated_at, updated_by,
  deleted_at, deleted_by
) values (
  :'org_one', :'module_one', :'type_s1', :'storage_s1',
  :'rec_s1_pending', null, 1, null, null,
  'removal_pending', 10,
  '2026-09-18T00:00:00Z'::timestamptz, :'actor',
  '2026-09-18T00:00:00Z'::timestamptz, :'actor',
  '2026-09-18T00:00:00Z'::timestamptz, :'actor'
);

reset role;
set local role vortex_request;

-- ============================================================================
-- 1. All three retained lifecycle states (active, soft_deleted, removal_pending)
--    are returned.
-- ============================================================================
select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_s1')),
  3,
  'Shared scope: returns all 3 retained states (active, soft_deleted, removal_pending)'
);

-- ============================================================================
-- 2. Results ordered by created_at ascending; oldest first.
-- ============================================================================
select is(
  (select record_id from vortex_record.read_lifecycle_candidate_records(:'storage_s1') limit 1),
  :'rec_s1_active'::uuid,
  'Shared scope: oldest record (by created_at) appears first'
);

-- ============================================================================
-- 3. Revision projection matches concurrency_number for all states.
-- ============================================================================
select is(
  (select record_revision from vortex_record.read_lifecycle_candidate_records(:'storage_s1')
   where record_id = :'rec_s1_active'),
  5::bigint,
  'Revision projection: active record revision = 5'
);

select is(
  (select record_revision from vortex_record.read_lifecycle_candidate_records(:'storage_s1')
   where record_id = :'rec_s1_deleted'),
  2::bigint,
  'Revision projection: soft_deleted record revision = 2'
);

select is(
  (select record_revision from vortex_record.read_lifecycle_candidate_records(:'storage_s1')
   where record_id = :'rec_s1_pending'),
  10::bigint,
  'Revision projection: removal_pending record revision = 10'
);

-- ============================================================================
-- 4. Timestamp projection.
-- ============================================================================
select is(
  (select created_at from vortex_record.read_lifecycle_candidate_records(:'storage_s1')
   where record_id = :'rec_s1_active'),
  '2026-08-01T10:00:00Z'::timestamptz,
  'Timestamp projection: active record created_at is correct'
);

-- ============================================================================
-- 5. Contained scope requires application root in context.
-- ============================================================================
-- Contained storage without application root fails closed.
select throws_ok(
  $$select * from vortex_record.read_lifecycle_candidate_records(
    'b4760000-0000-4000-8000-000000000002'::uuid
  )$$,
  '42501',
  'Lifecycle selection reader: application context is required for contained storage',
  'Contained storage without applicationRootId throws 42501'
);

-- Now re-initialize context WITH applicationRootId.
reset role;
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'system',
  'tenantId', :'tenant',
  'organizationId', :'org_one',
  'applicationRootId', :'app_one',
  'systemActorId', :'actor',
  'authenticationStrength', 'service',
  'sessionId', '94760000-0000-4000-8000-fffffffffffe',
  'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessVersion', 1,
  'correlationId', '94760000-0000-4000-8000-fffffffffffe'
));

-- Insert a contained record.
set local role vortex_record_adapter;
insert into record_data.rt_b4760000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id,
  lifecycle_state, concurrency_number,
  created_at, created_by, updated_at, updated_by
) values (
  :'org_one', :'module_one', :'type_c1', :'storage_c1',
  :'rec_c1_a', :'app_one', 1, :'actor', null,
  'active', 1,
  '2026-09-10T09:00:00Z'::timestamptz, :'actor',
  '2026-09-10T09:00:00Z'::timestamptz, :'actor'
);
reset role;
set local role vortex_request;

select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_c1')),
  1,
  'Contained scope: returns contained record under correct app root'
);

-- ============================================================================
-- 6. Cross-organisation isolation.
-- ============================================================================
reset role;
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'system',
  'tenantId', :'tenant',
  'organizationId', :'org_two',
  'systemActorId', :'actor',
  'authenticationStrength', 'service',
  'sessionId', '94760000-0000-4000-8000-fffffffffffd',
  'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessVersion', 1,
  'correlationId', '94760000-0000-4000-8000-fffffffffffd'
));
set local role vortex_request;

-- Org two cannot see org one's shared records.
select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_s1')),
  0,
  'Cross-org isolation: org two system context sees zero records from org one storage'
);

-- ============================================================================
-- 7. Org two sees its own records.
-- ============================================================================
reset role;
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'system',
  'tenantId', :'tenant',
  'organizationId', :'org_two',
  'systemActorId', :'actor',
  'authenticationStrength', 'service',
  'sessionId', '94760000-0000-4000-8000-fffffffffffc',
  'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessVersion', 1,
  'correlationId', '94760000-0000-4000-8000-fffffffffffc'
));
set local role vortex_record_adapter;
insert into record_data.rt_b4760000000040008000000000000011 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id,
  lifecycle_state, concurrency_number,
  created_at, created_by, updated_at, updated_by
) values (
  :'org_two', :'module_two', :'type_s2', :'storage_s2',
  :'rec_s2_a', null, 1, null, null,
  'active', 3,
  '2026-07-20T06:00:00Z'::timestamptz, :'actor',
  '2026-07-20T06:00:00Z'::timestamptz, :'actor'
);
reset role;
set local role vortex_request;

select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_s2')),
  1,
  'Org two: returns its own record from its own storage'
);

-- ============================================================================
-- 8. Human caller rejection: callerKind = 'human' throws 42501.
-- ============================================================================
reset role;
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'human',
  'tenantId', :'tenant',
  'organizationId', :'org_one',
  'organizationAccountId', :'actor',
  'identityId', :'actor',
  'identityAuthorityId', :'actor',
  'sessionId', '94760000-0000-4000-8000-fffffffffffa',
  'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessVersion', 1,
  'correlationId', '94760000-0000-4000-8000-fffffffffffa',
  'authenticationStrength', 'standard'
));
set local role vortex_request;

select throws_ok(
  format('select * from vortex_record.read_lifecycle_candidate_records(%L::uuid)', :'storage_s1'),
  '42501',
  'Lifecycle selection reader requires system context',
  'Human caller context is rejected with 42501'
);

-- ============================================================================
-- 9. Malformed / invalid storage contract parameter.
-- ============================================================================
-- Switch back to system context for parameter checks.
reset role;
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'system',
  'tenantId', :'tenant',
  'organizationId', :'org_one',
  'systemActorId', :'actor',
  'authenticationStrength', 'service',
  'sessionId', '94760000-0000-4000-8000-fffffffffff9',
  'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'accessVersion', 1,
  'correlationId', '94760000-0000-4000-8000-fffffffffff9'
));
set local role vortex_request;

select throws_ok(
  $$select * from vortex_record.read_lifecycle_candidate_records(
    '00000000-0000-0000-0000-000000000000'::uuid
  )$$,
  '22023',
  'Lifecycle selection reader: storage contract identifier is invalid',
  'Nil UUID storage contract is refused with 22023'
);

select throws_ok(
  $$select * from vortex_record.read_lifecycle_candidate_records(null)$$,
  '22023',
  'Lifecycle selection reader: storage contract identifier is invalid',
  'NULL storage contract is refused with 22023'
);

select throws_ok(
  $$select * from vortex_record.read_lifecycle_candidate_records(
    'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid
  )$$,
  '55000',
  'Lifecycle selection reader: storage contract is unavailable',
  'Nonexistent storage contract is refused with 55000'
);

-- ============================================================================
-- 10. Role-based access control.
-- ============================================================================
reset role;
set local role vortex_runtime;

select throws_ok(
  format('select * from vortex_record.read_lifecycle_candidate_records(%L::uuid)', :'storage_s2'),
  '42501',
  NULL,
  'vortex_runtime cannot call the lifecycle candidate reader'
);

reset role;

select * from finish();

rollback;
