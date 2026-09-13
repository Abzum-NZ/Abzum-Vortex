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
    where procedure_row.oid = 'vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text)'::regprocedure
  ),
  'tenant provisioning is a postgres-owned empty-search-path SECURITY DEFINER boundary'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'the restricted server runtime may invoke the configured provisioning boundary'
);
select ok(
  not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  candidate.role_name || ' cannot directly invoke tenant provisioning'
)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) as candidate(role_name);

create temporary table first_provision on commit drop as
select * from vortex_identity.provision_tenant(
  'c5000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001',
  'sha256:' || pg_catalog.repeat('a', 64),
  'provisioned_tenant', 'Provisioned tenant', 'root_organization',
  'Root organisation',
  '45000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000002',
  'Organisation steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

select is((select outcome from first_provision), 'accepted',
  'the first configured command is accepted');
select is((select access_version from first_provision), 3::bigint,
  'baseline registration and existing stewardship composition produce the expected Access version');
select is(
  (select pg_catalog.count(*) from vortex_identity.tenant_administrator_assignments
    where tenant_id = (select tenant_id from first_provision)),
  1::bigint,
  'provisioning creates one separately scoped permanent tenant assignment'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id = (select root_organization_id from first_provision)
      and identity_id = '45000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the explicit organisation steward receives the only organisation account'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id = (select root_organization_id from first_provision)
      and identity_id = '45000000-0000-4000-8000-000000000001'),
  0::bigint,
  'tenant stewardship does not implicitly create organisation membership'
);
select is(
  (select currency || '|' || revision from vortex_identity.organization_runtime_settings
    where organization_id = (select root_organization_id from first_provision)),
  'NZD|1',
  'provisioning calls the #430 settings initializer in the same transaction'
);
select ok(
  vortex_access.organization_has_permanent_steward(
    (select root_organization_id from first_provision), pg_catalog.clock_timestamp()
  ),
  'provisioning reuses the delivered permanent organisation-stewardship composition'
);

create temporary table replayed_provision on commit drop as
select * from vortex_identity.provision_tenant(
  'c5000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001',
  'sha256:' || pg_catalog.repeat('a', 64),
  'provisioned_tenant', 'Provisioned tenant', 'root_organization',
  'Root organisation',
  '45000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000002',
  'Organisation steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);
select is((select outcome from replayed_provision), 'replayed',
  'the exact duplicate returns a replay result');
select is((select correlation_id from replayed_provision),
  (select correlation_id from first_provision),
  'the replay returns the original server correlation');
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where cluster_id = 'c5000000-0000-4000-8000-000000000001'
      and operation_key = 'provision_tenant'),
  1::bigint,
  'the exact replay creates no second receipt'
);
select throws_ok(
  $$select * from vortex_identity.provision_tenant(
    'c5000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001',
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'provisioned_tenant', 'Provisioned tenant changed', 'root_organization',
    'Root organisation',
    '45000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000002',
    'Organisation steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  )$$,
  'V3001'::char(5), null::text,
  'a changed payload under the accepted duplicate key conflicts safely'
);

select * from finish();
rollback;
