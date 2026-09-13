\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

select ok(
  (
    select owner_role.rolname = 'postgres'
      and procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid = 'vortex_identity.create_tenant_organization(uuid,uuid,text,uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text)'::regprocedure
  ),
  'tenant organisation creation is a postgres-owned empty-search-path SECURITY DEFINER boundary'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.create_tenant_organization(uuid,uuid,text,uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'the restricted runtime may invoke organisation creation'
);
select ok(
  not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.create_tenant_organization(uuid,uuid,text,uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  candidate.role_name || ' cannot directly invoke organisation creation'
)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) as candidate(role_name);

create temporary table creation_tenant on commit drop as
select * from vortex_identity.provision_tenant(
  'c5400000-0000-4000-8000-000000000001',
  '95400000-0000-4000-8000-000000000001',
  'd5400000-0000-4000-8000-000000000001',
  'sha256:' || pg_catalog.repeat('1', 64),
  'creation_tenant', 'Creation tenant', 'creation_root', 'Creation root',
  '45400000-0000-4000-8000-000000000001',
  '45400000-0000-4000-8000-000000000002',
  'Root steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('45400000-0000-4000-8000-000000000003', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95400000-0000-4000-8000-000000000001',
    'a5400000-0000-4000-8000-000000000003', 1),
  ('45400000-0000-4000-8000-000000000004', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95400000-0000-4000-8000-000000000001',
    'a5400000-0000-4000-8000-000000000004', 1);

create temporary table created_root on commit drop as
select * from vortex_identity.create_tenant_organization(
  '45400000-0000-4000-8000-000000000001',
  'd5400000-0000-4000-8000-000000000010',
  'sha256:' || pg_catalog.repeat('a', 64),
  (select tenant_id from creation_tenant), null,
  'created_root', 'Created root',
  '45400000-0000-4000-8000-000000000001',
  'Creator as steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'long', 'always'
);
select is((select outcome || '|' || organization_revision || '|' ||
    organization_account_revision || '|' || access_version from created_root),
  'accepted|1|1|3',
  'an authorised administrator can explicitly nominate themselves for a complete root organisation');
select is(
  (select parent_organization_id::text from vortex_identity.organizations
    where organization_id = (select organization_id from created_root)),
  null::text,
  'an explicit null parent creates another root without imposing a single-root policy'
);
select is(
  (select language || '|' || time_zone || '|' || currency || '|' || date_format || '|' || number_format
    from vortex_identity.organization_runtime_settings
    where organization_id = (select organization_id from created_root)),
  'en-NZ|Pacific/Auckland|NZD|long|always',
  'creation applies all five explicit #430 runtime settings'
);
select ok(
  vortex_access.organization_has_permanent_steward(
    (select organization_id from created_root), pg_catalog.clock_timestamp()
  ),
  'creation reuses the delivered permanent-steward composition'
);

create temporary table created_child on commit drop as
select * from vortex_identity.create_tenant_organization(
  '45400000-0000-4000-8000-000000000001',
  'd5400000-0000-4000-8000-000000000011',
  'sha256:' || pg_catalog.repeat('b', 64),
  (select tenant_id from creation_tenant),
  (select root_organization_id from creation_tenant),
  'created_child', 'Created child',
  '45400000-0000-4000-8000-000000000003',
  'Different steward', 'en-AU', 'Australia/Sydney',
  'en-AU', 'Australia/Sydney', 'AUD', 'short', 'auto'
);
select is(
  (select parent_organization_id from vortex_identity.organizations
    where organization_id = (select organization_id from created_child)),
  (select root_organization_id from creation_tenant),
  'creation accepts an active same-tenant parent'
);
select is(
  (select identity_id from vortex_identity.organization_accounts
    where organization_account_id = (select organization_account_id from created_child)),
  '45400000-0000-4000-8000-000000000003'::uuid,
  'only the explicitly nominated existing projection receives the steward account'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id = (select organization_id from created_child)
      and identity_id = '45400000-0000-4000-8000-000000000001'),
  0::bigint,
  'a different nominee means the creating administrator receives no local membership'
);

update vortex_identity.organizations
set state = 'suspended', state_changed_at = pg_catalog.clock_timestamp(), revision = revision + 1
where organization_id = (select root_organization_id from creation_tenant);
create temporary table under_suspended_parent on commit drop as
select * from vortex_identity.create_tenant_organization(
  '45400000-0000-4000-8000-000000000001',
  'd5400000-0000-4000-8000-000000000012',
  'sha256:' || pg_catalog.repeat('c', 64),
  (select tenant_id from creation_tenant),
  (select root_organization_id from creation_tenant),
  'suspended_parent_child', 'Suspended parent child',
  '45400000-0000-4000-8000-000000000004',
  'Another steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);
select is((select outcome from under_suspended_parent), 'accepted',
  'a suspended same-tenant parent remains structurally available for creation');

update vortex_identity.organization_accounts
set display_name = 'Changed after creation', changed_at = pg_catalog.clock_timestamp(), revision = 2
where organization_account_id = (select organization_account_id from created_child);
create temporary table replayed_child on commit drop as
select * from vortex_identity.create_tenant_organization(
  '45400000-0000-4000-8000-000000000001',
  'd5400000-0000-4000-8000-000000000011',
  'sha256:' || pg_catalog.repeat('b', 64),
  (select tenant_id from creation_tenant),
  (select root_organization_id from creation_tenant),
  'created_child', 'Created child',
  '45400000-0000-4000-8000-000000000003',
  'Different steward', 'en-AU', 'Australia/Sydney',
  'en-AU', 'Australia/Sydney', 'AUD', 'short', 'auto'
);
select is((select outcome || '|' || organization_account_revision from replayed_child),
  'replayed|1', 'exact replay returns original revisions after a later account change');
select is(
  (select display_name || '|' || revision from vortex_identity.organization_accounts
    where organization_account_id = (select organization_account_id from created_child)),
  'Changed after creation|2',
  'exact replay does not restore historical account or stewardship facts'
);
select is((select correlation_id from replayed_child),
  (select correlation_id from created_child),
  'exact replay preserves the original server correlation');
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000011',
    'sha256:' || pg_catalog.repeat('d', 64),
    (select tenant_id from creation_tenant),
    (select root_organization_id from creation_tenant),
    'created_child', 'Changed child',
    '45400000-0000-4000-8000-000000000003',
    'Different steward', 'en-AU', 'Australia/Sydney',
    'en-AU', 'Australia/Sydney', 'AUD', 'short', 'auto'
  ),
  'V3001'::char(5), null::text,
  'changed input under an accepted duplicate key conflicts'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,null,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000020',
    'sha256:' || pg_catalog.repeat('e', 64),
    (select tenant_id from creation_tenant),
    'missing_nominee', 'Missing nominee',
    '45400000-0000-4000-8000-000000000099',
    'Missing', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'creation refuses a missing steward projection'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.organizations
    where tenant_id = (select tenant_id from creation_tenant)
      and short_name = 'missing_nominee'),
  0::bigint,
  'a missing nominee refusal leaves no partial organisation'
);

insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at,
  expires_at, revision, granted_at, granted_by_actor_id,
  grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
) values (
  '65400000-0000-4000-8000-000000000004',
  (select tenant_id from creation_tenant),
  '45400000-0000-4000-8000-000000000004',
  array['platform.tenant.hierarchy.read'], pg_catalog.clock_timestamp(), null, 1,
  pg_catalog.clock_timestamp(), '95400000-0000-4000-8000-000000000001',
  'a5400000-0000-4000-8000-000000000040', pg_catalog.clock_timestamp(),
  '95400000-0000-4000-8000-000000000001',
  'a5400000-0000-4000-8000-000000000040'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,null,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000004',
    'd5400000-0000-4000-8000-000000000021',
    'sha256:' || pg_catalog.repeat('f', 64),
    (select tenant_id from creation_tenant),
    'wrong_capability', 'Wrong capability',
    '45400000-0000-4000-8000-000000000004',
    'Wrong capability', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'hierarchy read does not substitute for the exact creation capability'
);

create temporary table foreign_tenant on commit drop as
select * from vortex_identity.provision_tenant(
  'c5400000-0000-4000-8000-000000000002',
  '95400000-0000-4000-8000-000000000001',
  'd5400000-0000-4000-8000-000000000002',
  'sha256:' || pg_catalog.repeat('2', 64),
  'foreign_creation_tenant', 'Foreign tenant', 'foreign_creation_root', 'Foreign root',
  '45400000-0000-4000-8000-000000000001',
  '45400000-0000-4000-8000-000000000002',
  'Foreign steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000022',
    'sha256:' || pg_catalog.repeat('0', 64),
    (select tenant_id from creation_tenant),
    (select root_organization_id from foreign_tenant),
    'foreign_parent', 'Foreign parent',
    '45400000-0000-4000-8000-000000000003',
    'Different steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'a foreign parent is refused without revealing its existence'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000024',
    'sha256:' || pg_catalog.repeat('4', 64),
    (select tenant_id from creation_tenant),
    '25400000-0000-4000-8000-000000000099',
    'missing_parent', 'Missing parent',
    '45400000-0000-4000-8000-000000000003',
    'Different steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'a missing parent is refused safely'
);

update vortex_identity.organizations
set state = 'archived', state_changed_at = pg_catalog.clock_timestamp(), revision = revision + 1
where organization_id = (select organization_id from created_root);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000025',
    'sha256:' || pg_catalog.repeat('5', 64),
    (select tenant_id from creation_tenant),
    (select organization_id from created_root),
    'archived_parent', 'Archived parent',
    '45400000-0000-4000-8000-000000000003',
    'Different steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'an archived parent is refused safely'
);
update vortex_identity.organizations
set state = 'removal_pending', state_changed_at = pg_catalog.clock_timestamp(), revision = revision + 1
where organization_id = (select organization_id from created_root);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000026',
    'sha256:' || pg_catalog.repeat('6', 64),
    (select tenant_id from creation_tenant),
    (select organization_id from created_root),
    'removing_parent', 'Removing parent',
    '45400000-0000-4000-8000-000000000003',
    'Different steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'a removal-pending parent is refused safely'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.create_tenant_organization(%L,%L,%L,%L,null,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    '45400000-0000-4000-8000-000000000001',
    'd5400000-0000-4000-8000-000000000023',
    'sha256:' || pg_catalog.repeat('3', 64),
    (select tenant_id from creation_tenant),
    'created_child', 'Duplicate short name',
    '45400000-0000-4000-8000-000000000003',
    'Different steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  ),
  'V3101'::char(5), null::text,
  'a same-tenant duplicate short name is refused safely'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id not in (select organization_id from vortex_identity.organizations)),
  0::bigint,
  'a short-name conflict leaves no orphan account facts'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where tenant_id = (select tenant_id from creation_tenant)
      and operation_key = 'create_tenant_organization'),
  3::bigint,
  'only the three accepted creations have receipts'
);

select * from finish();
rollback;
