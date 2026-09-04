\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select has_function(
  'vortex_identity',
  'list_organization_launcher',
  array['uuid'],
  'Identity exposes one safe launcher read'
);
select has_function(
  'vortex_access',
  'resolve_human_organization_scope',
  array['uuid', 'uuid'],
  'Access exposes one atomic human-scope resolver'
);
select has_function(
  'vortex_access',
  'validated_human_request_context',
  array[]::text[],
  'Access exposes one request-role freshness validator'
);
select has_function(
  'vortex_context',
  'identity_authority_id',
  array['boolean'],
  'request context exposes the trusted Identity Authority'
);

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request may use the Access schema for its exact validator'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_access_versions', 'SELECT,INSERT,UPDATE,DELETE'
  ),
  'request has no Access table privilege'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_identity.list_organization_launcher(uuid)', 'EXECUTE'
  ),
  'runtime may call only the safe Identity launcher'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_identity.list_organization_accounts(uuid)', 'EXECUTE'
  ),
  'runtime cannot call the rich legacy account list'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_identity.resolve_active_organization_account(uuid,uuid)', 'EXECUTE'
  ),
  'Identity exact-scope helper remains owner-only'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_access.resolve_human_organization_scope(uuid,uuid)', 'EXECUTE'
  ),
  'runtime may call the atomic Access resolver'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_access.resolve_human_organization_scope(uuid,uuid)', 'EXECUTE'
  ),
  'request cannot resolve or replace its own authority'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_access.validated_human_request_context()', 'EXECUTE'
  ),
  'request may perform only the exact freshness validation'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values
  (
    '12000000-0000-4000-8000-000000000001', 'launcher_one', 'Same tenant', 'active',
    pg_catalog.statement_timestamp(), '92000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '12000000-0000-4000-8000-000000000002', 'launcher_two', 'Same tenant', 'active',
    pg_catalog.statement_timestamp(), '92000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '12000000-0000-4000-8000-000000000003', 'launcher_inactive', 'Unavailable tenant', 'suspended',
    pg_catalog.statement_timestamp(), '92000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '22000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001', 'north', 'Same organisation', 'active',
    pg_catalog.statement_timestamp(), '92000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22000000-0000-4000-8000-000000000002',
    '12000000-0000-4000-8000-000000000002', 'south', 'Same organisation', 'active',
    pg_catalog.statement_timestamp(), '92000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22000000-0000-4000-8000-000000000003',
    '12000000-0000-4000-8000-000000000003', 'inactive', 'Unavailable organisation', 'suspended',
    pg_catalog.statement_timestamp(), '92000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '42000000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '42000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001', 1
  ),
  (
    '42000000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '42000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '52000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001', 'Same person', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '42000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000003', 1
  ),
  (
    '52000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001', 'Same person', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '42000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000004', 1
  ),
  (
    '52000000-0000-4000-8000-000000000003',
    '22000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000001', 'Unavailable person', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '42000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000005', 1
  ),
  (
    '52000000-0000-4000-8000-000000000004',
    '22000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000002', 'Other person', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '42000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000006', 1
  );

insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by,
  change_correlation_id, change_reason
) values
  (
    '22000000-0000-4000-8000-000000000001', 3,
    pg_catalog.statement_timestamp(), '52000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000007', 'organization_account_activated'
  ),
  (
    '22000000-0000-4000-8000-000000000002', 4,
    pg_catalog.statement_timestamp(), '52000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000008', 'organization_account_activated'
  ),
  (
    '22000000-0000-4000-8000-000000000003', 1,
    pg_catalog.statement_timestamp(), '52000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000009', 'organization_initialized'
  )
on conflict (organization_id) do update
set current_version = excluded.current_version,
    changed_at = excluded.changed_at,
    changed_by = excluded.changed_by,
    change_correlation_id = excluded.change_correlation_id,
    change_reason = excluded.change_reason;

select results_eq(
  $$
    select organization_id, tenant_display_name, organization_display_name, account_display_name
    from vortex_identity.list_organization_launcher(
      '42000000-0000-4000-8000-000000000001'
    )
  $$,
  $$values
    (
      '22000000-0000-4000-8000-000000000001'::uuid,
      'Same tenant'::text, 'Same organisation'::text, 'Same person'::text
    ),
    (
      '22000000-0000-4000-8000-000000000002'::uuid,
      'Same tenant'::text, 'Same organisation'::text, 'Same person'::text
    )
  $$,
  'launcher is deterministic and omits inactive tenant scope'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.list_organization_launcher(
      '42000000-0000-4000-8000-000000000099'
    )
  ),
  0,
  'unknown identity receives a safe empty launcher'
);

grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;

select results_eq(
  $$
    select tenant_id, organization_id, organization_account_id, access_version
    from vortex_access.resolve_human_organization_scope(
      '42000000-0000-4000-8000-000000000001',
      '22000000-0000-4000-8000-000000000001'
    )
  $$,
  $$values (
    '12000000-0000-4000-8000-000000000001'::uuid,
    '22000000-0000-4000-8000-000000000001'::uuid,
    '52000000-0000-4000-8000-000000000001'::uuid,
    3::bigint
  )$$,
  'Access resolves one exact active account and live version'
);
select throws_ok(
  $$select * from vortex_access.resolve_human_organization_scope(
    '42000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000003'
  )$$,
  '42501'::char(5),
  'Organisation selection is unavailable',
  'inactive scope is unavailable'
);
select throws_ok(
  $$select * from vortex_access.resolve_human_organization_scope(
    '42000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000002'
  )$$,
  '42501'::char(5),
  'Organisation selection is unavailable',
  'foreign scope is indistinguishable from unavailable scope'
);
select throws_ok(
  $$select * from vortex_access.resolve_human_organization_scope(
    '42000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000099'
  )$$,
  '42501'::char(5),
  'Organisation selection is unavailable',
  'unknown scope is indistinguishable from unavailable scope'
);

select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '82000000-0000-4000-8000-000000000001',
  'tenantId', '12000000-0000-4000-8000-000000000001',
  'organizationId', '22000000-0000-4000-8000-000000000001',
  'organizationAccountId', '52000000-0000-4000-8000-000000000001',
  'identityId', '42000000-0000-4000-8000-000000000001',
  'sessionId', '62000000-0000-4000-8000-000000000001',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 3,
  'correlationId', '72000000-0000-4000-8000-000000000010'
));
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select lives_ok(
  $$select vortex_access.validated_human_request_context()$$,
  'request validates the still-active account and Access version'
);
select is(
  vortex_context.identity_authority_id(true),
  '82000000-0000-4000-8000-000000000001'::uuid,
  'request sees the server-installed Identity Authority'
);

reset role;
update vortex_access.organization_access_versions
set current_version = 4,
    changed_at = pg_catalog.statement_timestamp(),
    changed_by = '52000000-0000-4000-8000-000000000001',
    change_correlation_id = '72000000-0000-4000-8000-000000000011',
    change_reason = 'role_assignment_changed'
where organization_id = '22000000-0000-4000-8000-000000000001';
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select vortex_access.validated_human_request_context()$$,
  '42501'::char(5),
  'Request access version is stale or unavailable',
  'stale Access version fails closed'
);

reset role;
select * from finish();

rollback;
