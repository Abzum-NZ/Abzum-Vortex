\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.reactivate_tenant(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  'the restricted server runtime may invoke both configured tenant transitions'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  'the exact shared composition remains private'
);
select ok(
  not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.suspend_tenant(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  candidate.role_name || ' cannot invoke configured tenant lifecycle'
)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) as candidate(role_name);

create temporary table lifecycle_tenant on commit drop as
select * from vortex_identity.provision_tenant(
  'c5600000-0000-4000-8000-000000000001',
  '95600000-0000-4000-8000-000000000001',
  'd5600000-0000-4000-8000-000000000001',
  'sha256:' || pg_catalog.repeat('1', 64),
  'tenant_lifecycle', 'Tenant lifecycle', 'tenant_lifecycle_root',
  'Tenant lifecycle root',
  '45600000-0000-4000-8000-000000000001',
  '45600000-0000-4000-8000-000000000002',
  'Organisation steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);
create temporary table unrelated_tenant on commit drop as
select * from vortex_identity.provision_tenant(
  'c5600000-0000-4000-8000-000000000001',
  '95600000-0000-4000-8000-000000000001',
  'd5600000-0000-4000-8000-000000000002',
  'sha256:' || pg_catalog.repeat('2', 64),
  'tenant_unrelated', 'Tenant unrelated', 'tenant_unrelated_root',
  'Tenant unrelated root',
  '45600000-0000-4000-8000-000000000003',
  '45600000-0000-4000-8000-000000000004',
  'Unrelated steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

create temporary table child_snapshot on commit drop as
select organization.state as organization_state,
  organization.revision as organization_revision,
  access.current_version as access_version,
  account.state as account_state,
  account.revision as account_revision,
  settings.revision as settings_revision
from lifecycle_tenant as fixture
join vortex_identity.organizations as organization
  on organization.organization_id = fixture.root_organization_id
join vortex_access.organization_access_versions as access
  on access.organization_id = organization.organization_id
join vortex_identity.organization_accounts as account
  on account.organization_account_id = fixture.organization_account_id
join vortex_identity.organization_runtime_settings as settings
  on settings.organization_id = organization.organization_id;

select is(
  (select pg_catalog.count(*) from vortex_identity.list_organization_launcher(
    '45600000-0000-4000-8000-000000000002'
  )), 1::bigint,
  'an otherwise-valid organisation is visible before tenant suspension'
);

create temporary table first_suspend on commit drop as
select * from vortex_identity.suspend_tenant(
  'c5600000-0000-4000-8000-000000000001',
  '95600000-0000-4000-8000-000000000001',
  'd5600000-0000-4000-8000-000000000010',
  'sha256:' || pg_catalog.repeat('a', 64),
  (select tenant_id from lifecycle_tenant), 1
);
select is((select outcome || '|' || revision from first_suspend), 'accepted|2',
  'an active tenant is suspended at the expected revision');
select is(
  (select state || '|' || revision from vortex_identity.tenants
    where tenant_id = (select tenant_id from lifecycle_tenant)),
  'suspended|2',
  'suspension changes the tenant lifecycle and revision'
);
select is(
  (select row(organization.state, organization.revision,
      access.current_version, account.state, account.revision, settings.revision)::text
    from lifecycle_tenant as fixture
    join vortex_identity.organizations as organization
      on organization.organization_id = fixture.root_organization_id
    join vortex_access.organization_access_versions as access
      on access.organization_id = organization.organization_id
    join vortex_identity.organization_accounts as account
      on account.organization_account_id = fixture.organization_account_id
    join vortex_identity.organization_runtime_settings as settings
      on settings.organization_id = organization.organization_id),
  (select row(organization_state, organization_revision, access_version,
    account_state, account_revision, settings_revision)::text from child_snapshot),
  'tenant suspension leaves organisation, account, settings and Access facts unchanged'
);
select is(
  (select state || '|' || revision from vortex_identity.tenants
    where tenant_id = (select tenant_id from unrelated_tenant)),
  'active|1',
  'tenant suspension leaves an unrelated tenant unchanged'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.list_organization_launcher(
    '45600000-0000-4000-8000-000000000002'
  )), 0::bigint,
  'the existing launcher refuses entry while the tenant is suspended'
);

create temporary table first_reactivate on commit drop as
select * from vortex_identity.reactivate_tenant(
  'c5600000-0000-4000-8000-000000000001',
  '95600000-0000-4000-8000-000000000001',
  'd5600000-0000-4000-8000-000000000011',
  'sha256:' || pg_catalog.repeat('b', 64),
  (select tenant_id from lifecycle_tenant), 2
);
select is((select outcome || '|' || revision from first_reactivate), 'accepted|3',
  'a stewardship-ready suspended tenant is reactivated');
select is(
  (select pg_catalog.count(*) from vortex_identity.list_organization_launcher(
    '45600000-0000-4000-8000-000000000002'
  )), 1::bigint,
  'reactivation restores only the otherwise-valid existing launcher entry'
);

create temporary table replayed_suspend on commit drop as
select * from vortex_identity.suspend_tenant(
  'c5600000-0000-4000-8000-000000000001',
  '95600000-0000-4000-8000-000000000001',
  'd5600000-0000-4000-8000-000000000010',
  'sha256:' || pg_catalog.repeat('a', 64),
  (select tenant_id from lifecycle_tenant), 1
);
select is((select outcome || '|' || revision from replayed_suspend), 'replayed|2',
  'an exact retry returns its original accepted result');
select is(
  (select state || '|' || revision from vortex_identity.tenants
    where tenant_id = (select tenant_id from lifecycle_tenant)),
  'active|3',
  'replaying an old suspension never restores its historical state'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.suspend_tenant(%L,%L,%L,%L,%L,1)',
    'c5600000-0000-4000-8000-000000000001',
    '95600000-0000-4000-8000-000000000001',
    'd5600000-0000-4000-8000-000000000010',
    'sha256:' || pg_catalog.repeat('c', 64),
    (select tenant_id from lifecycle_tenant)
  ),
  'V3001'::char(5), 'Administration duplicate conflicts',
  'a changed payload cannot reuse an accepted duplicate key'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.suspend_tenant(%L,%L,%L,%L,%L,2)',
    'c5600000-0000-4000-8000-000000000001',
    '95600000-0000-4000-8000-000000000001',
    'd5600000-0000-4000-8000-000000000012',
    'sha256:' || pg_catalog.repeat('d', 64),
    (select tenant_id from lifecycle_tenant)
  ),
  'V3102'::char(5), 'Tenant revision is stale',
  'a stale expected tenant revision is refused'
);
select throws_ok(
  $$select * from vortex_identity.suspend_tenant(
    'c5600000-0000-4000-8000-000000000001',
    '95600000-0000-4000-8000-000000000001',
    'd5600000-0000-4000-8000-000000000013',
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '15600000-0000-4000-8000-000000000099', 1
  )$$,
  'V3003'::char(5), 'Administration scope is unavailable',
  'a missing tenant is refused without revealing a different scope'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where cluster_id = 'c5600000-0000-4000-8000-000000000001'
      and operation_key in ('suspend_tenant', 'reactivate_tenant')),
  2::bigint,
  'only the two first successful tenant transitions write receipts'
);

-- A legacy tenant without adoption evidence remains recoverable. It is not
-- silently brought under a stewardship requirement by this lifecycle command.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '15600000-0000-4000-8000-000000000020', 'legacy_lifecycle',
  'Legacy lifecycle', 'suspended', now(),
  '95600000-0000-4000-8000-000000000001', now(), 1
);
select is(
  (select outcome from vortex_identity.reactivate_tenant(
    'c5600000-0000-4000-8000-000000000001',
    '95600000-0000-4000-8000-000000000001',
    'd5600000-0000-4000-8000-000000000020',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '15600000-0000-4000-8000-000000000020', 1
  )),
  'accepted',
  'a suspended legacy tenant without adoption evidence remains recoverable'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.tenant_administrator_assignments
    where tenant_id = '15600000-0000-4000-8000-000000000020'),
  0::bigint,
  'legacy reactivation does not manufacture tenant authority'
);

-- Existing adoption evidence activates the current permanent-manager gate.
-- Future audit metadata must not make a scheduled candidate effective early.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '15600000-0000-4000-8000-000000000030', 'scheduled_lifecycle',
  'Scheduled lifecycle', 'suspended', now(),
  '95600000-0000-4000-8000-000000000001', now() + interval '2 days', 2
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('45600000-0000-4000-8000-000000000030', 'active', now(), now(),
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000030', 1),
  ('45600000-0000-4000-8000-000000000031', 'suspended', now(), now(),
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000033', 1);
insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id, revoked_at, revoked_by_actor_id,
  revocation_correlation_id
) values
  ('35600000-0000-4000-8000-000000000030',
    '15600000-0000-4000-8000-000000000030',
    '45600000-0000-4000-8000-000000000030',
    array['platform.tenant.administrators.manage'], now() + interval '1 day', null,
    1, now(), '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000031', now(),
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000031', null, null, null),
  ('35600000-0000-4000-8000-000000000031',
    '15600000-0000-4000-8000-000000000030',
    '45600000-0000-4000-8000-000000000030',
    array['platform.tenant.administrators.manage'], now() - interval '2 days',
    now() - interval '1 day', 1, now() - interval '2 days',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000034', now() - interval '2 days',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000034', null, null, null),
  ('35600000-0000-4000-8000-000000000032',
    '15600000-0000-4000-8000-000000000030',
    '45600000-0000-4000-8000-000000000030',
    array['platform.tenant.administrators.manage'], now() - interval '2 days', null,
    1, now() - interval '2 days', '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000035', now() - interval '1 day',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000036', now() - interval '1 day',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000036'),
  ('35600000-0000-4000-8000-000000000033',
    '15600000-0000-4000-8000-000000000030',
    '45600000-0000-4000-8000-000000000030',
    array['platform.tenant.administrators.manage'], now() - interval '1 day',
    now() + interval '1 day', 1, now() - interval '1 day',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000037', now() - interval '1 day',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000037', null, null, null),
  ('35600000-0000-4000-8000-000000000034',
    '15600000-0000-4000-8000-000000000030',
    '45600000-0000-4000-8000-000000000031',
    array['platform.tenant.administrators.manage'], now() - interval '1 day', null,
    1, now() - interval '1 day', '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000038', now() - interval '1 day',
    '95600000-0000-4000-8000-000000000001',
    'a5600000-0000-4000-8000-000000000038', null, null, null);
insert into vortex_identity.accepted_administration_receipts (
  receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
  command_fingerprint, subject_ids, subject_revisions, accepted_at
) values (
  'a5600000-0000-4000-8000-000000000032',
  '95600000-0000-4000-8000-000000000001',
  '15600000-0000-4000-8000-000000000030', 'adopt_tenant',
  'd5600000-0000-4000-8000-000000000030',
  'sha256:' || pg_catalog.repeat('f', 64),
  array['15600000-0000-4000-8000-000000000030'::uuid], array[1::bigint], now()
);
select throws_ok(
  $$select * from vortex_identity.reactivate_tenant(
    'c5600000-0000-4000-8000-000000000001',
    '95600000-0000-4000-8000-000000000001',
    'd5600000-0000-4000-8000-000000000031',
    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '15600000-0000-4000-8000-000000000030', 2
  )$$,
  'V3002'::char(5), 'Permanent tenant manager is required',
  'future audit time cannot accelerate scheduled, expired, revoked, time-limited or inactive replacements'
);
select is(
  (select state || '|' || revision from vortex_identity.tenants
    where tenant_id = '15600000-0000-4000-8000-000000000030'),
  'suspended|2',
  'failed readiness leaves the tenant unchanged'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where cluster_id = 'c5600000-0000-4000-8000-000000000001'
      and duplicate_key = 'd5600000-0000-4000-8000-000000000031'),
  0::bigint,
  'failed readiness writes no accepted lifecycle receipt'
);

select * from finish();
rollback;
