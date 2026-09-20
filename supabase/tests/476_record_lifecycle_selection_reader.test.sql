\ir helpers/definition-release-writer.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #408 Slice 1: pgTAP tests for the lifecycle candidate selection reader.
--
-- Exercises:
--   1. Catalogue and policy assertions on vortex_identity.organizations and the reader.
--   2. Semantic adapter-role proof: direct SELECT under org-one context sees org one
--      and cannot see org two (0 ambient visibility into whole table).
--   3. System context enforcement: requires callerKind = 'system' and service auth.
--   4. Human context rejection: callerKind = 'human' fails closed with 42501.
--   5. Non-service system authentication rejection (fails closed at initialization).
--   6. Missing system actor rejection (fails closed at initialization).
--   7. Mismatched tenant/organization context fails closed with 23503.
--   8. All three retained lifecycle states (active, soft_deleted, removal_pending) returned.
--   9. Results ordered by created_at ascending; oldest first.
--  10. Revision and timestamp projection accuracy.
--  11. Contained scope requires applicationRootId; correct app sees record.
--  12. Same-table wrong-app isolation: app two on the same contained table sees 0 rows.
--  13. Cross-organisation isolation: org two system context sees 0 rows from org one storage.
--  14. Org two sees its own records from its own storage.
--  15. Malformed storage identity (nil UUID, null, nonexistent).
--  16. Role-based access: vortex_request can execute, vortex_runtime cannot.
--
-- Fixture shape:
--   Organisation 1:
--     Module M1 declares:
--       S1 = organization_shared, ownership none, one text field
--       C1 = application_contained, ownership organization_account, one text field
--     Application A1 binds M1
--     Application A2 binds M1 (same module, same physical table, different application root)
--   Organisation 2:
--     Module M2 declares:
--       S2 = organization_shared, ownership none, one text field
--     Application A3 binds M2
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
\set app_three '34760000-0000-4000-8000-000000000003'

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
-- Foundation bootstrap with valid schema columns.
-- ============================================================================
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  :'tenant', 'test_tenant_476', 'Test Tenant 476', 'active',
  pg_catalog.clock_timestamp(), :'actor', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (:'org_one', :'tenant', 'test_org_one_476', 'Test Org One 476', 'active',
    pg_catalog.clock_timestamp(), :'actor', pg_catalog.clock_timestamp(), 1),
  (:'org_two', :'tenant', 'test_org_two_476', 'Test Org Two 476', 'active',
    pg_catalog.clock_timestamp(), :'actor', pg_catalog.clock_timestamp(), 1);

select * from vortex_access.initialize_organization_access_version(
  :'org_one', :'actor', 'c4760000-0000-4000-8000-000000000001'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  :'org_one', :'actor', 'c4760000-0000-4000-8000-000000000002'
);
select * from vortex_access.initialize_organization_access_version(
  :'org_two', :'actor', 'c4760000-0000-4000-8000-000000000003'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  :'org_two', :'actor', 'c4760000-0000-4000-8000-000000000004'
);

select * from vortex_identity.ensure_identity_projection(
  '54760000-0000-4000-8000-0000000000a1', 'c4760000-0000-4000-8000-000000000011'
);
select * from vortex_identity.ensure_identity_projection(
  '54760000-0000-4000-8000-0000000000a2', 'c4760000-0000-4000-8000-000000000012'
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('64760000-0000-4000-8000-0000000000a1', :'org_one',
    '54760000-0000-4000-8000-0000000000a1', 'Administrator one', 'active',
    pg_catalog.clock_timestamp() - interval '1 minute', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), :'actor', 'c4760000-0000-4000-8000-000000000021', 1),
  ('64760000-0000-4000-8000-0000000000a2', :'org_two',
    '54760000-0000-4000-8000-0000000000a2', 'Administrator two', 'active',
    pg_catalog.clock_timestamp() - interval '1 minute', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), :'actor', 'c4760000-0000-4000-8000-000000000022', 1);

select * from vortex_access.revise_platform_permission_catalogue_metadata(
  :'org_one', 1, '1.0.0', '1.0.1', :'actor', 'c4760000-0000-4000-8000-000000000031'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  :'org_one', '64760000-0000-4000-8000-0000000000a1',
  '74760000-0000-4000-8000-000000000001', 'adapter_steward_one',
  'Adapter steward one', 'Permanent stewardship for the adapter fixture.',
  '74760000-0000-4000-8000-000000000002', '74760000-0000-4000-8000-000000000003',
  '54760000-0000-4000-8000-0000000000a1', 'c4760000-0000-4000-8000-000000000032'
);
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  :'org_one', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  :'actor', 'c4760000-0000-4000-8000-000000000033'
);
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  :'org_two', 1, '1.0.0', '1.0.1', :'actor', 'c4760000-0000-4000-8000-000000000041'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  :'org_two', '64760000-0000-4000-8000-0000000000a2',
  '74760000-0000-4000-8000-000000000011', 'adapter_steward_two',
  'Adapter steward two', 'Permanent stewardship for the adapter fixture.',
  '74760000-0000-4000-8000-000000000012', '74760000-0000-4000-8000-000000000013',
  '54760000-0000-4000-8000-0000000000a2', 'c4760000-0000-4000-8000-000000000042'
);
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  :'org_two', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  :'actor', 'c4760000-0000-4000-8000-000000000043'
);

-- Definition roots with valid schema columns.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (:'module_one', :'org_one', 'module', 'vortex.lifecycle_reader.module_one',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'app_one', :'org_one', 'application', 'vortex.lifecycle_reader.app_one',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'app_two', :'org_one', 'application', 'vortex.lifecycle_reader.app_two',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'module_two', :'org_two', 'module', 'vortex.lifecycle_reader.module_two',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'app_three', :'org_two', 'application', 'vortex.lifecycle_reader.app_three',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor');

-- ============================================================================
-- Module releases and Application releases via append_writer_release.
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

-- Module 1 (S1 shared, C1 contained).
select pg_temp.append_writer_release(
  :'module_one', '1.0.0', '[]'::jsonb,
  jsonb_build_object(
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
  )
);

-- App 1 and App 2 both bind Module 1 in Org One.
select pg_temp.append_writer_release(
  :'app_one', '1.0.0',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(:'module_one'::text, 1)),
  jsonb_build_object(
    'name', 'App 476 one', 'description', 'App one test.',
    'dependencies', '[]'::jsonb,
    'permissions', '[]'::jsonb
  )
);
select pg_temp.append_writer_release(
  :'app_two', '1.0.0',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(:'module_one'::text, 1)),
  jsonb_build_object(
    'name', 'App 476 two', 'description', 'App two test.',
    'dependencies', '[]'::jsonb,
    'permissions', '[]'::jsonb
  )
);

-- Module 2 and App 3 in Org Two.
select pg_temp.append_writer_release(
  :'module_two', '1.0.0', '[]'::jsonb,
  jsonb_build_object(
    'name', 'Module 476 two', 'description', 'Module two test.',
    'dependencies', '[]'::jsonb,
    'recordTypes', jsonb_build_array(
      jsonb_build_object(
        'recordTypeId', :'type_s2',
        'key', 'shared_476_two',
        'singularLabel', 'Shared two', 'pluralLabel', 'Shared two records',
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
  )
);
select pg_temp.append_writer_release(
  :'app_three', '1.0.0',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(:'module_two'::text, 1)),
  jsonb_build_object(
    'name', 'App 476 three', 'description', 'App three test.',
    'dependencies', '[]'::jsonb,
    'permissions', '[]'::jsonb
  )
);

-- ============================================================================
-- Canonical context helpers (derived from 475_record_adapters pattern).
-- Queries the live organization account identity and current access version.
-- ============================================================================
create function pg_temp.adapter_context(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_account_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid();

  select pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '94760000-0000-4000-8000-000000000001'::uuid,
    'tenantId', organization.tenant_id,
    'organizationId', p_organization_id,
    'organizationAccountId', p_account_id,
    'identityId', account.identity_id,
    'sessionId', 'c4760000-0000-4000-8000-0000000000f2'::uuid,
    'authenticationStrength', 'single_factor',
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '2 hours',
    'accessVersion', version.current_version,
    'correlationId', 'c4760000-0000-4000-8000-0000000000f3'::uuid,
    'accessTokenIssuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'primaryAuthenticatedAt', pg_catalog.clock_timestamp() - interval '1 minute'
  ) || case
    when p_application_root_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('applicationRootId', p_application_root_id)
  end
  into strict context_value
  from vortex_identity.organizations as organization
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.organization_account_id = p_account_id
  where organization.organization_id = p_organization_id;

  perform vortex_context.initialize(context_value);
end
$function$;

-- Helper for establishing system context in tests.
create function pg_temp.system_context(
  p_tenant_id uuid,
  p_org_id uuid,
  p_app_root_id uuid default null,
  p_system_actor_id uuid default '94760000-0000-4000-8000-000000000001'::uuid,
  p_auth_strength text default 'service'
)
returns void language plpgsql volatile set search_path = '' as $fn$
declare
  ctx jsonb;
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();

  select coalesce(
    (select version.current_version from vortex_access.organization_access_versions as version where version.organization_id = p_org_id),
    1::bigint
  ) into current_access_version;

  ctx := pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', p_tenant_id,
    'organizationId', p_org_id,
    'sessionId', 'c4760000-0000-4000-8000-0000000000e1'::uuid,
    'authenticationStrength', p_auth_strength,
    'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessVersion', current_access_version,
    'correlationId', 'c4760000-0000-4000-8000-0000000000e2'::uuid
  );
  if p_system_actor_id is not null then
    ctx := ctx || pg_catalog.jsonb_build_object('systemActorId', p_system_actor_id);
  end if;
  if p_app_root_id is not null then
    ctx := ctx || pg_catalog.jsonb_build_object('applicationRootId', p_app_root_id);
  end if;
  perform vortex_context.initialize(ctx);
end
$fn$;

-- ============================================================================
-- Provision storage and activate installations with valid human context.
-- ============================================================================
-- Provision & activate App 1 and App 2 in Org One.
select pg_temp.adapter_context(:'org_one', null, '64760000-0000-4000-8000-0000000000a1');
set local role vortex_request;
select * from vortex_module.provision_module_installation_storage(:'app_one', 1, :'module_one', 1, null);
select * from vortex_module.provision_module_installation_storage(:'app_two', 1, :'module_one', 1, null);
select * from vortex_module.activate_application_installation(
  :'app_one', 1,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('moduleRootId', :'module_one', 'bindingRevision', 1))
);
select * from vortex_module.activate_application_installation(
  :'app_two', 1,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('moduleRootId', :'module_one', 'bindingRevision', 1))
);
reset role;

-- Provision & activate App 3 in Org Two (using Org Two's account and identity).
select pg_temp.adapter_context(:'org_two', null, '64760000-0000-4000-8000-0000000000a2');
set local role vortex_request;
select * from vortex_module.provision_module_installation_storage(:'app_three', 1, :'module_two', 1, null);
select * from vortex_module.activate_application_installation(
  :'app_three', 1,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('moduleRootId', :'module_two', 'bindingRevision', 1))
);
reset role;

-- ============================================================================
-- Section 1: Catalogue-level grant and policy assertions.
-- ============================================================================
select ok(
  pg_catalog.has_table_privilege('vortex_record_adapter', 'vortex_identity.organizations', 'SELECT'),
  'vortex_record_adapter has SELECT on vortex_identity.organizations'
);
select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_identity.organizations', 'SELECT'),
  'vortex_request has no direct SELECT on vortex_identity.organizations'
);
select ok(
  not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_identity.organizations', 'SELECT'),
  'vortex_runtime has no direct SELECT on vortex_identity.organizations'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_policy as policy
    where policy.polrelid = 'vortex_identity.organizations'::regclass
      and policy.polname = 'organizations_record_adapter_read'
  ),
  'vortex_identity.organizations has the scoped record adapter read policy'
);

select is(
  (
    select role_name.rolname
    from pg_catalog.pg_policy as policy
    cross join lateral pg_catalog.unnest(policy.polroles) as assigned(role_oid)
    join pg_catalog.pg_roles as role_name on role_name.oid = assigned.role_oid
    where policy.polrelid = 'vortex_identity.organizations'::regclass
      and policy.polname = 'organizations_record_adapter_read'
  ),
  'vortex_record_adapter',
  'organizations_record_adapter_read targets only vortex_record_adapter'
);

select is(
  (
    select policy.polcmd
    from pg_catalog.pg_policy as policy
    where policy.polrelid = 'vortex_identity.organizations'::regclass
      and policy.polname = 'organizations_record_adapter_read'
  ),
  'r',
  'organizations_record_adapter_read is a SELECT (r) policy'
);

select ok(
  pg_catalog.has_function_privilege('vortex_request', 'vortex_record.read_lifecycle_candidate_records(uuid)', 'EXECUTE'),
  'vortex_request can execute vortex_record.read_lifecycle_candidate_records'
);
select ok(
  not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_record.read_lifecycle_candidate_records(uuid)', 'EXECUTE'),
  'vortex_runtime cannot execute vortex_record.read_lifecycle_candidate_records'
);

-- ============================================================================
-- Section 2: Semantic RLS proof: direct SELECT under vortex_record_adapter.
-- Under an organization-one context, direct SELECT can see org one and cannot
-- see org two, confirming zero ambient visibility into the whole table.
-- ============================================================================
reset role;
select pg_temp.system_context(:'tenant', :'org_one');
set local role vortex_record_adapter;

select is(
  (select count(*)::integer from vortex_identity.organizations where organization_id = :'org_one'),
  1,
  'Direct adapter SELECT under org_one context sees organization one'
);

select is(
  (select count(*)::integer from vortex_identity.organizations where organization_id = :'org_two'),
  0,
  'Direct adapter SELECT under org_one context cannot see organization two'
);

select is(
  (select count(*)::integer from vortex_identity.organizations),
  1,
  'Direct adapter SELECT is strictly scoped to context organization (0 ambient visibility)'
);

reset role;

-- ============================================================================
-- Insert test records under vortex_record_adapter with scope policies active.
-- ============================================================================
-- 1-3. Organization-shared records in S1 (established with org context).
select pg_temp.system_context(:'tenant', :'org_one');
set local role vortex_record_adapter;

-- 1. Active record with revision 5 in S1.
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

-- 2. Soft-deleted record with revision 2 in S1.
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

-- 3. removal_pending record with revision 10 in S1.
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

-- 4. Contained record in C1 belonging to App 1:
-- Must establish app_one application context before contained row insertion.
select pg_temp.system_context(:'tenant', :'org_one', :'app_one');
set local role vortex_record_adapter;

insert into record_data.rt_b4760000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id,
  lifecycle_state, concurrency_number,
  created_at, created_by, updated_at, updated_by
) values (
  :'org_one', :'module_one', :'type_c1', :'storage_c1',
  :'rec_c1_a', :'app_one', 1, '64760000-0000-4000-8000-0000000000a1', null,
  'active', 1,
  '2026-09-10T09:00:00Z'::timestamptz, :'actor',
  '2026-09-10T09:00:00Z'::timestamptz, :'actor'
);
reset role;

-- 5. Record in Org Two storage S2.
select pg_temp.system_context(:'tenant', :'org_two');
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

-- ============================================================================
-- Section 3: Retained states, sorting, and projection under system context.
-- ============================================================================
select pg_temp.system_context(:'tenant', :'org_one');
set local role vortex_request;

-- Test 1: All 3 retained states are returned.
select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_s1')),
  3,
  'Shared scope: returns all 3 retained states (active, soft_deleted, removal_pending)'
);

-- Test 2: Results ordered by created_at ascending (oldest first).
select is(
  (select record_id from vortex_record.read_lifecycle_candidate_records(:'storage_s1') limit 1),
  :'rec_s1_active'::uuid,
  'Shared scope: oldest record (by created_at) appears first'
);

-- Test 3: Revision projection matches concurrency_number across states.
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

-- Test 4: Creation timestamp projection.
select is(
  (select created_at from vortex_record.read_lifecycle_candidate_records(:'storage_s1')
   where record_id = :'rec_s1_active'),
  '2026-08-01T10:00:00Z'::timestamptz,
  'Timestamp projection: active record created_at is correct'
);

-- ============================================================================
-- Section 4: Contained storage and same-table application isolation.
-- ============================================================================
-- Contained storage without application root fails closed.
select throws_ok(
  format('select * from vortex_record.read_lifecycle_candidate_records(%L::uuid)', :'storage_c1'),
  '42501',
  'Lifecycle selection reader: application context is required for contained storage',
  'Contained storage without applicationRootId throws 42501'
);

-- Query under App 1 system context: sees App 1's record.
reset role;
select pg_temp.system_context(:'tenant', :'org_one', :'app_one');
set local role vortex_request;

select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_c1')),
  1,
  'Contained scope under app_one: returns app_one contained record'
);
select is(
  (select record_id from vortex_record.read_lifecycle_candidate_records(:'storage_c1') limit 1),
  :'rec_c1_a'::uuid,
  'Contained scope under app_one: correct record_id projected'
);

-- Query under App 2 system context: shares the SAME physical table, but sees 0 rows (wrong-app isolation).
reset role;
select pg_temp.system_context(:'tenant', :'org_one', :'app_two');
set local role vortex_request;

select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_c1')),
  0,
  'Same-table wrong-app isolation: app_two context sees 0 records in app_one contained table'
);

-- ============================================================================
-- Section 5: Cross-organisation isolation.
-- ============================================================================
reset role;
select pg_temp.system_context(:'tenant', :'org_two');
set local role vortex_request;

-- Org two system context sees zero records from org one's storage contract.
select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_s1')),
  0,
  'Cross-org isolation: org two system context sees 0 records from org one storage'
);

-- Org two sees its own records.
select is(
  (select count(*)::integer from vortex_record.read_lifecycle_candidate_records(:'storage_s2')),
  1,
  'Org two: returns its own record from its own storage'
);
select is(
  (select record_revision from vortex_record.read_lifecycle_candidate_records(:'storage_s2')
   where record_id = :'rec_s2_a'),
  3::bigint,
  'Org two: correct revision projected'
);

-- ============================================================================
-- Section 6: Security negatives (human, non-service auth, missing actor, mismatch).
-- ============================================================================
-- 1. Human caller rejection (built from live organization account and access version).
reset role;
select pg_temp.adapter_context(:'org_one', null, '64760000-0000-4000-8000-0000000000a1');
set local role vortex_request;

select throws_ok(
  format('select * from vortex_record.read_lifecycle_candidate_records(%L::uuid)', :'storage_s1'),
  '42501',
  'Lifecycle selection reader requires system context',
  'Human caller context is rejected with 42501'
);

-- 2. Non-service system authentication rejection.
reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
select throws_ok(
  $$select vortex_context.initialize(jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '14760000-0000-4000-8000-000000000001'::uuid,
    'organizationId', '24760000-0000-4000-8000-000000000001'::uuid,
    'systemActorId', '94760000-0000-4000-8000-000000000001'::uuid,
    'authenticationStrength', 'single_factor',
    'sessionId', 'c4760000-0000-4000-8000-0000000000e1'::uuid,
    'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessVersion', 1,
    'correlationId', 'c4760000-0000-4000-8000-0000000000e2'::uuid
  ))$$,
  '22023',
  'Vortex system context has an invalid actor',
  'Non-service system authentication rejected at context initialization'
);

-- 3. Missing system actor rejection.
reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
select throws_ok(
  $$select vortex_context.initialize(jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '14760000-0000-4000-8000-000000000001'::uuid,
    'organizationId', '24760000-0000-4000-8000-000000000001'::uuid,
    'authenticationStrength', 'service',
    'sessionId', 'c4760000-0000-4000-8000-0000000000e1'::uuid,
    'issuedAt', to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'accessVersion', 1,
    'correlationId', 'c4760000-0000-4000-8000-0000000000e2'::uuid
  ))$$,
  '22023',
  'Vortex system context has an invalid actor',
  'System context without systemActorId rejected at context initialization'
);

-- 4. Tenant/organization mismatch rejection: context has Org One with a foreign nonexistent tenant.
reset role;
select pg_temp.system_context('14760000-0000-4000-8000-ffffffffffff'::uuid, :'org_one');
set local role vortex_request;

select throws_ok(
  format('select * from vortex_record.read_lifecycle_candidate_records(%L::uuid)', :'storage_s1'),
  '23503',
  'Lifecycle selection reader: context organization does not exist in its tenant',
  'Mismatched tenant/organization context fails closed with 23503'
);

-- ============================================================================
-- Section 7: Malformed storage contract parameter.
-- ============================================================================
reset role;
select pg_temp.system_context(:'tenant', :'org_one');
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
-- Section 8: Role boundary rejection (vortex_runtime).
-- ============================================================================
reset role;
set local role vortex_runtime;

select throws_ok(
  format('select * from vortex_record.read_lifecycle_candidate_records(%L::uuid)', :'storage_s1'),
  '42501',
  NULL,
  'vortex_runtime cannot execute vortex_record.read_lifecycle_candidate_records'
);

reset role;

select * from finish();

rollback;
