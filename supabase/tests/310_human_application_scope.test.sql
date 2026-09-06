\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_function(
  'vortex_access',
  'resolve_human_application_scope',
  array['uuid', 'uuid', 'uuid'],
  'Access exposes one exact application-bound human-scope resolver'
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.resolve_human_application_scope(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'runtime may resolve an application-bound human scope'
);

select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.resolve_human_application_scope(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'request cannot replace its application scope'
);

select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_access.resolve_human_application_scope(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'vortex_access.resolve_human_application_scope(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'vortex_access.resolve_human_application_scope(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.resolve_human_application_scope(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'Data API and public roles cannot resolve application scope'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values
  (
    '13100000-0000-4000-8000-000000000001', 'application_scope_one',
    'Application scope one', 'active', pg_catalog.statement_timestamp(),
    '93100000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '13100000-0000-4000-8000-000000000002', 'application_scope_two',
    'Application scope two', 'active', pg_catalog.statement_timestamp(),
    '93100000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23100000-0000-4000-8000-000000000001',
    '13100000-0000-4000-8000-000000000001', 'application_scope_one',
    'Application scope one', 'active', pg_catalog.statement_timestamp(),
    '93100000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '23100000-0000-4000-8000-000000000002',
    '13100000-0000-4000-8000-000000000002', 'application_scope_two',
    'Application scope two', 'active', pg_catalog.statement_timestamp(),
    '93100000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '43100000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '93100000-0000-4000-8000-000000000001',
  'a3100000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '53100000-0000-4000-8000-000000000001',
    '23100000-0000-4000-8000-000000000001',
    '43100000-0000-4000-8000-000000000001', 'Application account one',
    'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '93100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000002', 1
  ),
  (
    '53100000-0000-4000-8000-000000000002',
    '23100000-0000-4000-8000-000000000002',
    '43100000-0000-4000-8000-000000000001', 'Application account two',
    'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '93100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000003', 1
  );

insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by,
  change_correlation_id, change_reason
) values
  (
    '23100000-0000-4000-8000-000000000001', 3,
    pg_catalog.statement_timestamp(), '53100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000004', 'organization_account_activated'
  ),
  (
    '23100000-0000-4000-8000-000000000002', 4,
    pg_catalog.statement_timestamp(), '53100000-0000-4000-8000-000000000002',
    'a3100000-0000-4000-8000-000000000005', 'organization_account_activated'
  );

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values
  (
    '23100000-0000-4000-8000-000000000001', 'application',
    '33100000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.application_scope_one', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64),
    pg_catalog.statement_timestamp(), '93100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000006'
  ),
  (
    '23100000-0000-4000-8000-000000000002', 'application',
    '33100000-0000-4000-8000-000000000003', 1, 'active', 'register',
    'example.application_scope_foreign', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('c', 64),
    'sha256:' || pg_catalog.repeat('d', 64),
    pg_catalog.statement_timestamp(), '93100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000007'
  );

insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state,
  revision, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values
  (
    '23100000-0000-4000-8000-000000000001', 'application',
    '33100000-0000-4000-8000-000000000001', 'active', 1,
    'example.application_scope_one', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64),
    pg_catalog.statement_timestamp(), '93100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000006'
  ),
  (
    '23100000-0000-4000-8000-000000000002', 'application',
    '33100000-0000-4000-8000-000000000003', 'active', 1,
    'example.application_scope_foreign', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('c', 64),
    'sha256:' || pg_catalog.repeat('d', 64),
    pg_catalog.statement_timestamp(), '93100000-0000-4000-8000-000000000001',
    'a3100000-0000-4000-8000-000000000007'
  );

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint
) values
  (
    '23100000-0000-4000-8000-000000000001', 'application',
    '33100000-0000-4000-8000-000000000001', 1,
    '33100000-0000-4000-8000-000000000001', 'application',
    '33100000-0000-4000-8000-000000000001',
    '43100000-0000-4000-8000-000000000011',
    'example.application_scope_one.read', 'Read application scope',
    'Read the application-scope fixture.', null, 'read', null, false,
    'application', 'example.application_scope_one',
    '33100000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat('e', 64)
  ),
  (
    '23100000-0000-4000-8000-000000000002', 'application',
    '33100000-0000-4000-8000-000000000003', 1,
    '33100000-0000-4000-8000-000000000003', 'application',
    '33100000-0000-4000-8000-000000000003',
    '43100000-0000-4000-8000-000000000013',
    'example.application_scope_foreign.read', 'Read foreign application scope',
    'Read the foreign application-scope fixture.', null, 'read', null, false,
    'application', 'example.application_scope_foreign',
    '33100000-0000-4000-8000-000000000003', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64), null,
    'sha256:' || pg_catalog.repeat('f', 64)
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
  1, pg_catalog.statement_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id in (
    '23100000-0000-4000-8000-000000000001'::uuid,
    '23100000-0000-4000-8000-000000000002'::uuid
  )
  and entry.registration_kind = 'application';

insert into vortex_access.application_role_template_continuities (
  organization_id, application_root_id, source_role_id, state,
  continuity_revision, source_template_fingerprint,
  last_processed_registration_revision, changed_at
) values
  (
    '23100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000001',
    '63100000-0000-4000-8000-000000000011', 'available', 1,
    'sha256:' || pg_catalog.repeat('5', 64), 1,
    pg_catalog.statement_timestamp()
  ),
  (
    '23100000-0000-4000-8000-000000000002',
    '33100000-0000-4000-8000-000000000003',
    '63100000-0000-4000-8000-000000000013', 'available', 1,
    'sha256:' || pg_catalog.repeat('6', 64), 1,
    pg_catalog.statement_timestamp()
  );

set constraints all immediate;
set constraints all deferred;

select ok(
  vortex_access.application_access_current_transition_is_complete(
    '23100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000001',
    1,
    'active'
  ),
  'selected application starts from one complete coordinated B2 state'
);

grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;

select results_eq(
  $$
    select tenant_id, organization_id, organization_account_id,
      application_root_id, access_version
    from vortex_access.resolve_human_application_scope(
      '43100000-0000-4000-8000-000000000001',
      '23100000-0000-4000-8000-000000000001',
      '33100000-0000-4000-8000-000000000001'
    )
  $$,
  $$values (
    '13100000-0000-4000-8000-000000000001'::uuid,
    '23100000-0000-4000-8000-000000000001'::uuid,
    '53100000-0000-4000-8000-000000000001'::uuid,
    '33100000-0000-4000-8000-000000000001'::uuid,
    3::bigint
  )$$,
  'runtime resolves the exact active application under its organization scope'
);

reset role;

select results_eq(
  $$
    select outcome, registration_state, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '23100000-0000-4000-8000-000000000001',
      '33100000-0000-4000-8000-000000000001',
      '93100000-0000-4000-8000-000000000001',
      'a3100000-0000-4000-8000-000000000008'
    )
  $$,
  $$values ('changed'::text, 'withdrawn'::text, 2::bigint, 4::bigint)$$,
  'the real coordinated writer withdraws the coherent selected application'
);

set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$select * from vortex_access.resolve_human_application_scope(
    '43100000-0000-4000-8000-000000000001',
    '23100000-0000-4000-8000-000000000001',
    null
  )$$,
  '22023'::char(5),
  'Application selection is invalid',
  'null application selection is invalid before scope resolution'
);

select throws_ok(
  $$select * from vortex_access.resolve_human_application_scope(
    '43100000-0000-4000-8000-000000000001',
    '23100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000001'
  )$$,
  '42501'::char(5),
  'Application selection is unavailable',
  'withdrawn application selection is unavailable'
);

select throws_ok(
  $$select * from vortex_access.resolve_human_application_scope(
    '43100000-0000-4000-8000-000000000001',
    '23100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000003'
  )$$,
  '42501'::char(5),
  'Application selection is unavailable',
  'another organization application is indistinguishable from unavailable'
);

select throws_ok(
  $$select * from vortex_access.resolve_human_application_scope(
    '43100000-0000-4000-8000-000000000001',
    '23100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000099'
  )$$,
  '42501'::char(5),
  'Application selection is unavailable',
  'unknown application is indistinguishable from unavailable'
);

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$select * from vortex_access.resolve_human_application_scope(
    '43100000-0000-4000-8000-000000000001',
    '23100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000001'
  )$$,
  '42501'::char(5),
  'permission denied for function resolve_human_application_scope',
  'request cannot resolve or replace its own application scope'
);

reset role;

select * from finish();

rollback;
