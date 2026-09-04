\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access',
  'postgres',
  true,
  false
);

select has_table(
  'vortex_access',
  'organization_access_versions',
  'Access owns one private organisation-version relation'
);
select columns_are(
  'vortex_access',
  'organization_access_versions',
  array[
    'organization_id', 'current_version', 'changed_at', 'changed_by',
    'change_correlation_id', 'change_reason'
  ],
  'the version relation stores only current state and last-change evidence'
);
select has_pk(
  'vortex_access',
  'organization_access_versions',
  'one version row exists per organisation'
);
select has_fk(
  'vortex_access',
  'organization_access_versions',
  'an Access version references its permanent organisation identity'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_access.organization_access_versions'::regclass
  ),
  'the private relation enables and forces row security'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'vortex_access'
      and tablename = 'organization_access_versions'
  ),
  0,
  'no direct row policy exposes Access-version storage'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_runtime',
    'vortex_access.organization_access_versions',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'trusted runtime has no direct Access table privilege'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.current_organization_access_version(uuid,uuid)',
    'EXECUTE'
  ),
  'trusted runtime may perform only the narrow current-version read'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.accept_organization_invitation(text,uuid,text,text,uuid)',
    'EXECUTE'
  ),
  'trusted runtime may perform composed invitation acceptance'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.increment_organization_access_version(uuid,uuid,uuid,text)',
    'EXECUTE'
  ),
  'trusted runtime has no generic increment authority'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.change_organization_account_state(uuid,bigint,text)',
    'EXECUTE'
  ),
  'request code cannot reach account administration before permission composition'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc
    where oid in (
      'vortex_access.initialize_organization_access_version(uuid,uuid,uuid)'::regprocedure,
      'vortex_access.current_organization_access_version(uuid,uuid)'::regprocedure,
      'vortex_access.increment_organization_access_version(uuid,uuid,uuid,text)'::regprocedure,
      'vortex_access.accept_organization_invitation(text,uuid,text,text,uuid)'::regprocedure,
      'vortex_access.change_organization_account_state(uuid,bigint,text)'::regprocedure
    )
      and prosecdef
      and proconfig @> array['search_path=""']
  ),
  5,
  'every Access operation is security definer with an empty search path'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values
  (
    '11000000-0000-4000-8000-000000000100', 'access_tenant_one', 'Access tenant one',
    'active', pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '11000000-0000-4000-8000-000000000101', 'access_tenant_two', 'Access tenant two',
    'active', pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '21000000-0000-4000-8000-000000000100', '11000000-0000-4000-8000-000000000100',
    null, 'access_org_one', 'Access organisation one', 'active',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21000000-0000-4000-8000-000000000101', '11000000-0000-4000-8000-000000000101',
    null, 'access_org_two', 'Access organisation two', 'active',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21000000-0000-4000-8000-000000000102', '11000000-0000-4000-8000-000000000100',
    null, 'access_org_inactive', 'Access organisation inactive', 'suspended',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21000000-0000-4000-8000-000000000103', '11000000-0000-4000-8000-000000000100',
    null, 'access_org_missing', 'Access organisation missing version', 'active',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
    pg_catalog.statement_timestamp(), 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000100',
  '91000000-0000-4000-8000-000000000100',
  '71000000-0000-4000-8000-000000000100'
);
select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000100',
  '91000000-0000-4000-8000-000000000101',
  '71000000-0000-4000-8000-000000000101'
);
insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by,
  change_correlation_id, change_reason
) values (
  '21000000-0000-4000-8000-000000000101', 9007199254740991,
  pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000100',
  '71000000-0000-4000-8000-000000000102', 'organization_initialized'
);
select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000102',
  '91000000-0000-4000-8000-000000000100',
  '71000000-0000-4000-8000-000000000103'
);

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000100'
  ),
  1::bigint,
  'initialisation starts at one and exact replay is idempotent'
);

set local role vortex_runtime;
create temporary table exact_version_read on commit drop as
select * from vortex_access.current_organization_access_version(
  '11000000-0000-4000-8000-000000000100',
  '21000000-0000-4000-8000-000000000100'
);
reset role;
select results_eq(
  'select organization_id, current_version from exact_version_read',
  $$values ('21000000-0000-4000-8000-000000000100'::uuid, 1::bigint)$$,
  'the pre-context read returns only one exact current version'
);
select throws_ok(
  $$
    set local role vortex_runtime;
    select * from vortex_access.current_organization_access_version(
      '11000000-0000-4000-8000-000000000101',
      '21000000-0000-4000-8000-000000000100'
    )
  $$,
  '42501'::char(5),
  null,
  'a cross-tenant pair is refused without revealing another scope'
);
reset role;
select throws_ok(
  $$
    set local role vortex_runtime;
    select * from vortex_access.current_organization_access_version(
      '11000000-0000-4000-8000-000000000100',
      '21000000-0000-4000-8000-000000000102'
    )
  $$,
  '42501'::char(5),
  null,
  'an inactive organisation is unavailable to the pre-context read'
);
reset role;

create temporary table incremented_version on commit drop as
select * from vortex_access.increment_organization_access_version(
  '21000000-0000-4000-8000-000000000100',
  '91000000-0000-4000-8000-000000000100',
  '71000000-0000-4000-8000-000000000104',
  'role_assignment_changed'
);
select is((select current_version from incremented_version), 2::bigint, 'one increment adds one');
select is(
  (select change_reason from incremented_version),
  'role_assignment_changed',
  'the increment stores one closed reason'
);
select throws_ok(
  $$
    select * from vortex_access.increment_organization_access_version(
      '21000000-0000-4000-8000-000000000100',
      '91000000-0000-4000-8000-000000000100',
      '71000000-0000-4000-8000-000000000105',
      'organization_initialized'
    )
  $$,
  '22023'::char(5),
  null,
  'the generic increment cannot falsify organisation initialisation'
);
select throws_ok(
  $$
    update vortex_access.organization_access_versions
    set current_version = current_version + 2
    where organization_id = '21000000-0000-4000-8000-000000000100'
  $$,
  '23514'::char(5),
  null,
  'direct updates cannot skip a version'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000100'
  ),
  2::bigint,
  'refused mutations preserve the current version'
);

select throws_ok(
  $$
    select * from vortex_access.increment_organization_access_version(
      '21000000-0000-4000-8000-000000000101',
      '91000000-0000-4000-8000-000000000100',
      '71000000-0000-4000-8000-000000000107',
      'application_access_changed'
    )
  $$,
  '22003'::char(5),
  null,
  'safe-integer exhaustion is refused before mutation'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '41000000-0000-4000-8000-000000000100', 'active', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000100',
    '71000000-0000-4000-8000-000000000108', 1
  ),
  (
    '41000000-0000-4000-8000-000000000101', 'active', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000109', 1
  ),
  (
    '41000000-0000-4000-8000-000000000102', 'active', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000102',
    '71000000-0000-4000-8000-000000000115', 1
  );
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '51000000-0000-4000-8000-000000000100', '21000000-0000-4000-8000-000000000100',
    '41000000-0000-4000-8000-000000000100', 'Administrator', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000100',
    '71000000-0000-4000-8000-000000000110', 1
  ),
  (
    '51000000-0000-4000-8000-000000000101', '21000000-0000-4000-8000-000000000100',
    '41000000-0000-4000-8000-000000000101', 'Member', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000101',
    '71000000-0000-4000-8000-000000000111', 1
  ),
  (
    '51000000-0000-4000-8000-000000000103', '21000000-0000-4000-8000-000000000103',
    '41000000-0000-4000-8000-000000000100', 'Inviter', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000100',
    '71000000-0000-4000-8000-000000000112', 1
  ),
  (
    '51000000-0000-4000-8000-000000000104', '21000000-0000-4000-8000-000000000103',
    '41000000-0000-4000-8000-000000000102', 'Missing-version member', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000102',
    '71000000-0000-4000-8000-000000000116', 1
  ),
  (
    '51000000-0000-4000-8000-000000000105', '21000000-0000-4000-8000-000000000101',
    '41000000-0000-4000-8000-000000000100', 'Overflow administrator', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000100',
    '71000000-0000-4000-8000-000000000117', 1
  ),
  (
    '51000000-0000-4000-8000-000000000106', '21000000-0000-4000-8000-000000000101',
    '41000000-0000-4000-8000-000000000102', 'Overflow member', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '41000000-0000-4000-8000-000000000102',
    '71000000-0000-4000-8000-000000000118', 1
  );

select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'tenantId', '11000000-0000-4000-8000-000000000100',
    'organizationId', '21000000-0000-4000-8000-000000000100',
    'sessionId', '61000000-0000-4000-8000-000000000100',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', 2,
    'correlationId', '71000000-0000-4000-8000-000000000113',
    'identityId', '41000000-0000-4000-8000-000000000100',
    'organizationAccountId', '51000000-0000-4000-8000-000000000100',
    'authenticationStrength', 'single_factor'
  )
);
create temporary table suspended_account on commit drop as
select * from vortex_access.change_organization_account_state(
  '51000000-0000-4000-8000-000000000101',
  1,
  'suspended'
);
select is((select state from suspended_account), 'suspended', 'account suspension succeeds');
select is(
  (select access_version from suspended_account),
  3::bigint,
  'account suspension and Access invalidation commit together'
);
select throws_ok(
  $$
    select * from vortex_access.change_organization_account_state(
      '51000000-0000-4000-8000-000000000101',
      2,
      'suspended'
    )
  $$,
  '40001'::char(5),
  null,
  'a current-revision request to repeat the same state is refused'
);
select throws_ok(
  $$
    select * from vortex_access.change_organization_account_state(
      '51000000-0000-4000-8000-000000000101',
      1,
      'closed'
    )
  $$,
  '40001'::char(5),
  null,
  'a stale account revision refuses the composed operation'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000100'
  ),
  3::bigint,
  'a refused account transition leaves the version unchanged'
);
create temporary table reactivated_account on commit drop as
select * from vortex_access.change_organization_account_state(
  '51000000-0000-4000-8000-000000000101',
  2,
  'active'
);
select is((select state from reactivated_account), 'active', 'account reactivation succeeds');
select is(
  (select access_version from reactivated_account),
  4::bigint,
  'account reactivation and Access invalidation commit together'
);
create temporary table closed_account on commit drop as
select * from vortex_access.change_organization_account_state(
  '51000000-0000-4000-8000-000000000101',
  3,
  'closed'
);
select is((select state from closed_account), 'closed', 'account closure succeeds');
select is(
  (select access_version from closed_account),
  5::bigint,
  'account closure and Access invalidation commit together'
);

select pg_catalog.set_config('vortex.request_context', '', true);
select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'tenantId', '11000000-0000-4000-8000-000000000100',
    'organizationId', '21000000-0000-4000-8000-000000000103',
    'sessionId', '61000000-0000-4000-8000-000000000103',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', 1,
    'correlationId', '71000000-0000-4000-8000-000000000119',
    'identityId', '41000000-0000-4000-8000-000000000100',
    'organizationAccountId', '51000000-0000-4000-8000-000000000103',
    'authenticationStrength', 'single_factor'
  )
);
select throws_ok(
  $$
    select * from vortex_access.change_organization_account_state(
      '51000000-0000-4000-8000-000000000104',
      1,
      'suspended'
    )
  $$,
  '40001'::char(5),
  null,
  'missing Access-version storage rolls back account administration'
);
select results_eq(
  $$
    select state, revision
    from vortex_identity.organization_accounts
    where organization_account_id = '51000000-0000-4000-8000-000000000104'
  $$,
  $$values ('active'::text, 1::bigint)$$,
  'missing version storage leaves account state and revision unchanged'
);

select pg_catalog.set_config('vortex.request_context', '', true);
select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'tenantId', '11000000-0000-4000-8000-000000000101',
    'organizationId', '21000000-0000-4000-8000-000000000101',
    'sessionId', '61000000-0000-4000-8000-000000000101',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', 9007199254740991,
    'correlationId', '71000000-0000-4000-8000-000000000120',
    'identityId', '41000000-0000-4000-8000-000000000100',
    'organizationAccountId', '51000000-0000-4000-8000-000000000105',
    'authenticationStrength', 'single_factor'
  )
);
select throws_ok(
  $$
    select * from vortex_access.change_organization_account_state(
      '51000000-0000-4000-8000-000000000106',
      1,
      'suspended'
    )
  $$,
  '22003'::char(5),
  null,
  'Access-version exhaustion rolls back account administration'
);
select results_eq(
  $$
    select state, revision
    from vortex_identity.organization_accounts
    where organization_account_id = '51000000-0000-4000-8000-000000000106'
  $$,
  $$values ('active'::text, 1::bigint)$$,
  'version exhaustion leaves account state and revision unchanged'
);

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at,
  changed_at, revision
) values (
  '81000000-0000-4000-8000-000000000103',
  '21000000-0000-4000-8000-000000000103',
  'rollback@example.test',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '51000000-0000-4000-8000-000000000103',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.statement_timestamp(), 1
);
select throws_ok(
  $$
    set local role vortex_runtime;
    select * from vortex_access.accept_organization_invitation(
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '41000000-0000-4000-8000-000000000101',
      'rollback@example.test',
      'Rollback member',
      '71000000-0000-4000-8000-000000000114'
    )
  $$,
  '40001'::char(5),
  null,
  'missing Access-version storage rolls back invitation acceptance'
);
reset role;
select is(
  (
    select count(*)::integer
    from vortex_identity.organization_accounts
    where organization_id = '21000000-0000-4000-8000-000000000103'
      and identity_id = '41000000-0000-4000-8000-000000000101'
  ),
  0,
  'failed Access composition creates no organisation account'
);
select is(
  (
    select accepted_at
    from vortex_identity.organization_invitations
    where invitation_id = '81000000-0000-4000-8000-000000000103'
  ),
  null::timestamptz,
  'failed Access composition leaves the invitation unaccepted'
);

select * from finish();

rollback;
