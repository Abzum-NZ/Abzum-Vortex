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

-- Reach the function ACL in this rolled-back test transaction so the proof
-- distinguishes EXECUTE refusal from the schema's independent USAGE refusal.
grant usage on schema extensions, vortex_identity to vortex_request;
set local role vortex_request;
select throws_ok(
  $$select * from vortex_identity.provision_tenant(
    'c5000000-0000-4000-8000-000000000099',
    '95000000-0000-4000-8000-000000000099',
    'd5000000-0000-4000-8000-000000000099',
    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'denied_tenant', 'Denied tenant', 'denied_root', 'Denied root',
    '45000000-0000-4000-8000-000000000098',
    '45000000-0000-4000-8000-000000000099',
    'Denied steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  )$$,
  '42501'::char(5),
  'permission denied for function provision_tenant',
  'an actual request-role call cannot invoke configured provisioning'
);
reset role;

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

select ok(
  (
    select pg_catalog.bool_and(owner_role.rolname = 'postgres'
      and procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""'])
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid in (
      'vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid)'::regprocedure,
      'vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid)'::regprocedure
    )
  ),
  'both adoption operations are postgres-owned empty-search-path SECURITY DEFINER boundaries'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid)', 'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'only the restricted server composition role receives both adoption entry points'
);
select ok(
  not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  candidate.role_name || ' cannot directly invoke either adoption operation'
)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) as candidate(role_name);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '15000000-0000-4000-8000-000000000010', 'legacy_tenant',
  'Legacy tenant', 'active', pg_catalog.clock_timestamp(),
  '95000000-0000-4000-8000-000000000010', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  '25000000-0000-4000-8000-000000000010',
  '15000000-0000-4000-8000-000000000010', 'legacy_root', 'Legacy root',
  'active', pg_catalog.clock_timestamp(),
  '95000000-0000-4000-8000-000000000010', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('45000000-0000-4000-8000-000000000010', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95000000-0000-4000-8000-000000000010',
    'a5000000-0000-4000-8000-000000000010', 1),
  ('45000000-0000-4000-8000-000000000011', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95000000-0000-4000-8000-000000000010',
    'a5000000-0000-4000-8000-000000000011', 1);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '55000000-0000-4000-8000-000000000010',
  '25000000-0000-4000-8000-000000000010',
  '45000000-0000-4000-8000-000000000011', 'Legacy steward', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '95000000-0000-4000-8000-000000000010',
  'a5000000-0000-4000-8000-000000000012', 1
);

select throws_ok(
  $$select * from vortex_identity.adopt_tenant(
    '95000000-0000-4000-8000-000000000010',
    'd5000000-0000-4000-8000-000000000010',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '15000000-0000-4000-8000-000000000010',
    '45000000-0000-4000-8000-000000000010'
  )$$,
  'V3002'::char(5), null::text,
  'tenant readiness refuses while a live organisation lacks supported stewardship'
);
select is(
  (select pg_catalog.count(*)
    from vortex_identity.tenant_administrator_assignments
    where tenant_id = '15000000-0000-4000-8000-000000000010'),
  0::bigint,
  'the refused tenant adoption leaves no partial assignment'
);

create temporary table adopted_organization on commit drop as
select * from vortex_identity.adopt_organization(
  '95000000-0000-4000-8000-000000000010',
  'd5000000-0000-4000-8000-000000000011',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '15000000-0000-4000-8000-000000000010',
  '25000000-0000-4000-8000-000000000010',
  '45000000-0000-4000-8000-000000000011',
  '55000000-0000-4000-8000-000000000010'
);
select is((select outcome from adopted_organization), 'accepted',
  'the configured operator explicitly adopts the nominated live organisation account');
select is((select access_version from adopted_organization), 3::bigint,
  'organisation adoption reuses baseline, platform catalogue and stewardship changes');
select is(
  (select pg_catalog.count(*) from vortex_access.organization_stewardship_requirements
    where organization_id = '25000000-0000-4000-8000-000000000010'
      and original_organization_account_id = '55000000-0000-4000-8000-000000000010'),
  1::bigint,
  'organisation adoption records only the delivered #33 stewardship requirement'
);

create temporary table replayed_organization on commit drop as
select * from vortex_identity.adopt_organization(
  '95000000-0000-4000-8000-000000000010',
  'd5000000-0000-4000-8000-000000000011',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '15000000-0000-4000-8000-000000000010',
  '25000000-0000-4000-8000-000000000010',
  '45000000-0000-4000-8000-000000000011',
  '55000000-0000-4000-8000-000000000010'
);
select is((select outcome from replayed_organization), 'replayed',
  'exact organisation adoption retry returns the accepted receipt');
select is((select correlation_id from replayed_organization),
  (select correlation_id from adopted_organization),
  'organisation adoption replay returns the original server evidence');
select is(
  (select current_version from vortex_access.organization_access_versions
    where organization_id = '25000000-0000-4000-8000-000000000010'),
  3::bigint,
  'organisation adoption replay does not advance Access again'
);

create temporary table adopted_tenant on commit drop as
select * from vortex_identity.adopt_tenant(
  '95000000-0000-4000-8000-000000000010',
  'd5000000-0000-4000-8000-000000000010',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '15000000-0000-4000-8000-000000000010',
  '45000000-0000-4000-8000-000000000010'
);
select is((select outcome from adopted_tenant), 'accepted',
  'tenant adoption succeeds only after every live organisation is stewarded');
select ok(
  (select capability_keys @> array['platform.tenant.administrators.manage']
      and expires_at is null and revoked_at is null
    from vortex_identity.tenant_administrator_assignments
    where assignment_id = (select tenant_administrator_assignment_id from adopted_tenant)),
  'the explicit tenant nomination receives a permanent assignment-management capability'
);

create temporary table replayed_tenant on commit drop as
select * from vortex_identity.adopt_tenant(
  '95000000-0000-4000-8000-000000000010',
  'd5000000-0000-4000-8000-000000000010',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '15000000-0000-4000-8000-000000000010',
  '45000000-0000-4000-8000-000000000010'
);
select is((select outcome from replayed_tenant), 'replayed',
  'exact tenant adoption retry returns the accepted receipt');
select is((select correlation_id from replayed_tenant),
  (select correlation_id from adopted_tenant),
  'tenant adoption replay returns the original server evidence');

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '45000000-0000-4000-8000-000000000020', 'suspended',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '95000000-0000-4000-8000-000000000020',
  'a5000000-0000-4000-8000-000000000020', 1
);
select throws_ok(
  $$select * from vortex_identity.provision_tenant(
    'c5000000-0000-4000-8000-000000000020',
    '95000000-0000-4000-8000-000000000020',
    'd5000000-0000-4000-8000-000000000020',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'rollback_tenant', 'Rollback tenant', 'rollback_root', 'Rollback root',
    '45000000-0000-4000-8000-000000000020',
    '45000000-0000-4000-8000-000000000021',
    'Rollback steward', 'en-NZ', 'Pacific/Auckland',
    'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  )$$,
  'V3002'::char(5), null::text,
  'an inactive nominated projection refuses provisioning'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.tenants
    where short_name = 'rollback_tenant'),
  0::bigint,
  'a later stewardship refusal rolls back the earlier tenant mutation'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where cluster_id = 'c5000000-0000-4000-8000-000000000020'),
  0::bigint,
  'a refused provisioning transaction writes no accepted receipt'
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  '25000000-0000-4000-8000-000000000011',
  '15000000-0000-4000-8000-000000000010', 'invalid_evidence',
  'Invalid evidence organisation', 'active', pg_catalog.clock_timestamp(),
  '95000000-0000-4000-8000-000000000010', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '55000000-0000-4000-8000-000000000011',
  '25000000-0000-4000-8000-000000000011',
  '45000000-0000-4000-8000-000000000011', 'Invalid evidence steward',
  'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '95000000-0000-4000-8000-000000000010',
  'a5000000-0000-4000-8000-000000000013', 1
);
create function pg_temp.corrupt_configured_adoption_continuity()
returns trigger language plpgsql as $function$
begin
  if new.organization_id = '25000000-0000-4000-8000-000000000011' then
    new.meaning_fingerprint := 'sha256:' || pg_catalog.repeat('f', 64);
  end if;
  return new;
end
$function$;
create trigger corrupt_configured_adoption_continuity
before insert on vortex_access.permission_continuities
for each row execute function pg_temp.corrupt_configured_adoption_continuity();

select throws_ok(
  $$select * from vortex_identity.adopt_organization(
    '95000000-0000-4000-8000-000000000010',
    'd5000000-0000-4000-8000-000000000012',
    'sha256:abababababababababababababababababababababababababababababababab',
    '15000000-0000-4000-8000-000000000010',
    '25000000-0000-4000-8000-000000000011',
    '45000000-0000-4000-8000-000000000011',
    '55000000-0000-4000-8000-000000000011'
  )$$,
  '23514'::char(5),
  'An adopted organization requires a permanent steward',
  'invalid function-created evidence refuses before returning to runtime'
);
select is(
  (select pg_catalog.count(*) from vortex_access.organization_access_versions
    where organization_id = '25000000-0000-4000-8000-000000000011'),
  0::bigint,
  'invalid deferred evidence rolls back the full adoption composition'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where tenant_id = '15000000-0000-4000-8000-000000000010'
      and duplicate_key = 'd5000000-0000-4000-8000-000000000012'),
  0::bigint,
  'invalid deferred evidence writes no accepted administration receipt'
);
drop trigger corrupt_configured_adoption_continuity
  on vortex_access.permission_continuities;

select * from finish();
rollback;
