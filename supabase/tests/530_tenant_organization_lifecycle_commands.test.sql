\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

select ok(
  (select pg_catalog.bool_and(owner_role.rolname = 'postgres'
      and procedure.prosecdef
      and procedure.proconfig @> array['search_path=""'])
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure.proowner
    where procedure.oid in (
      'vortex_identity.suspend_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'::regprocedure,
      'vortex_identity.reactivate_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'::regprocedure,
      'vortex_identity.archive_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'::regprocedure
    )),
  'all three lifecycle commands are postgres-owned empty-search-path SECURITY DEFINER boundaries'
);

select ok(pg_catalog.has_function_privilege('vortex_runtime', signature, 'EXECUTE'),
  'runtime can call protected ' || signature)
from (values
  ('vortex_identity.suspend_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'),
  ('vortex_identity.reactivate_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'),
  ('vortex_identity.archive_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)')
) as functions(signature);
select ok(not pg_catalog.has_function_privilege(candidate.role_name, signature, 'EXECUTE'),
  candidate.role_name || ' cannot call protected ' || signature)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) as candidate(role_name)
cross join (values
  ('vortex_identity.suspend_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'),
  ('vortex_identity.reactivate_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)'),
  ('vortex_identity.archive_tenant_organization(uuid,uuid,text,uuid,uuid,bigint)')
) as functions(signature);

create temporary table lifecycle_one on commit drop as
select * from vortex_identity.provision_tenant(
  'c5300000-0000-4000-8000-000000000001',
  '95300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000001',
  'sha256:' || pg_catalog.repeat('1', 64),
  'lifecycle_one', 'Lifecycle one', 'lifecycle_one_root',
  'Lifecycle one root',
  '45300000-0000-4000-8000-000000000001',
  '45300000-0000-4000-8000-000000000002',
  'First steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

create temporary table lifecycle_one_original on commit drop as
select organization.*, version.current_version as access_version,
  (select pg_catalog.count(*) from vortex_identity.organization_accounts as account
    where account.organization_id = organization.organization_id) as account_count,
  (select pg_catalog.count(*) from vortex_access.organization_roles as role
    where role.organization_id = organization.organization_id) as role_count,
  (select pg_catalog.count(*) from vortex_identity.organization_runtime_settings as settings
    where settings.organization_id = organization.organization_id) as settings_count
from vortex_identity.organizations as organization
join vortex_access.organization_access_versions as version
  on version.organization_id = organization.organization_id
where organization.organization_id = (select root_organization_id from lifecycle_one);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '45300000-0000-4000-8000-000000000003', 'active',
  pg_catalog.clock_timestamp() - interval '1 hour',
  pg_catalog.clock_timestamp() - interval '1 hour',
  '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000003', 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '25300000-0000-4000-8000-000000000003',
  (select tenant_id from lifecycle_one),
  (select root_organization_id from lifecycle_one),
  'independent_child', 'Independent child', 'active',
  pg_catalog.clock_timestamp() - interval '1 hour',
  '95300000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() - interval '1 hour', 1
);
select * from vortex_access.initialize_organization_access_version(
  '25300000-0000-4000-8000-000000000003',
  '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000004'
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '55300000-0000-4000-8000-000000000003',
  '25300000-0000-4000-8000-000000000003',
  '45300000-0000-4000-8000-000000000003', 'Child member', 'active',
  pg_catalog.clock_timestamp() - interval '1 hour',
  pg_catalog.clock_timestamp() - interval '1 hour',
  pg_catalog.clock_timestamp() - interval '1 hour',
  '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000005', 1
);

create temporary table suspended_one on commit drop as
select * from vortex_identity.suspend_tenant_organization(
  '45300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000011',
  'sha256:' || pg_catalog.repeat('a', 64),
  (select tenant_id from lifecycle_one),
  (select root_organization_id from lifecycle_one), 1
);
select is((select outcome || '|' || revision from suspended_one),
  'accepted|2', 'active organisation is suspended at exactly the next revision');
select is((select state || '|' || revision from vortex_identity.organizations
    where organization_id = '25300000-0000-4000-8000-000000000003'),
  'active|1', 'parent suspension does not cascade to its active child');
select is((select organization_id::text from vortex_access.resolve_human_organization_scope(
    '45300000-0000-4000-8000-000000000003',
    '25300000-0000-4000-8000-000000000003')),
  '25300000-0000-4000-8000-000000000003',
  'an independently active child remains enterable under its own account context');
select is((select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id = (select root_organization_id from lifecycle_one)
      and identity_id = '45300000-0000-4000-8000-000000000001'),
  0::bigint, 'the lifecycle authority needs no target-organisation account');

create temporary table reactivated_one on commit drop as
select * from vortex_identity.reactivate_tenant_organization(
  '45300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000012',
  'sha256:' || pg_catalog.repeat('b', 64),
  (select tenant_id from lifecycle_one),
  (select root_organization_id from lifecycle_one), 2
);
select is((select outcome || '|' || revision from reactivated_one),
  'accepted|3', 'a suspended organisation with current stewardship is reactivated');

create temporary table replayed_suspend on commit drop as
select * from vortex_identity.suspend_tenant_organization(
  '45300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000011',
  'sha256:' || pg_catalog.repeat('a', 64),
  (select tenant_id from lifecycle_one),
  (select root_organization_id from lifecycle_one), 1
);
select is((select outcome || '|' || revision from replayed_suspend),
  'replayed|2', 'exact replay returns its original result before current state and revision checks');
select is((select correlation_id from replayed_suspend),
  (select correlation_id from suspended_one), 'exact replay preserves the original correlation');
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
    '45300000-0000-4000-8000-000000000001',
    'd5300000-0000-4000-8000-000000000011',
    'sha256:' || pg_catalog.repeat('c', 64),
    (select tenant_id from lifecycle_one),
    (select root_organization_id from lifecycle_one)
  ), 'V3001'::char(5), null::text,
  'a changed payload under an accepted duplicate conflicts');
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.reactivate_tenant_organization(%L,%L,%L,%L,%L,3)',
    '45300000-0000-4000-8000-000000000001',
    'd5300000-0000-4000-8000-000000000013',
    'sha256:' || pg_catalog.repeat('d', 64),
    (select tenant_id from lifecycle_one),
    (select root_organization_id from lifecycle_one)
  ), 'V3101'::char(5), null::text,
  'same-state reactivation is refused without a receipt');

select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.archive_tenant_organization(%L,%L,%L,%L,%L,3)',
    '45300000-0000-4000-8000-000000000001',
    'd5300000-0000-4000-8000-000000000014',
    'sha256:' || pg_catalog.repeat('e', 64),
    (select tenant_id from lifecycle_one),
    (select root_organization_id from lifecycle_one)
  ), 'V3101'::char(5), null::text,
  'archive refuses an active direct child');
update vortex_identity.organizations
set state = 'suspended', state_changed_at = pg_catalog.clock_timestamp(), revision = 2
where organization_id = '25300000-0000-4000-8000-000000000003';
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.archive_tenant_organization(%L,%L,%L,%L,%L,3)',
    '45300000-0000-4000-8000-000000000001',
    'd5300000-0000-4000-8000-000000000015',
    'sha256:' || pg_catalog.repeat('f', 64),
    (select tenant_id from lifecycle_one),
    (select root_organization_id from lifecycle_one)
  ), 'V3101'::char(5), null::text,
  'archive also refuses a suspended direct child');
update vortex_identity.organizations
set state = 'archived', state_changed_at = pg_catalog.clock_timestamp(), revision = 3
where organization_id = '25300000-0000-4000-8000-000000000003';

create temporary table archived_one on commit drop as
select * from vortex_identity.archive_tenant_organization(
  '45300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000016',
  'sha256:' || pg_catalog.repeat('0', 64),
  (select tenant_id from lifecycle_one),
  (select root_organization_id from lifecycle_one), 3
);
select is((select outcome || '|' || revision from archived_one),
  'accepted|4', 'archive accepts an unresolved-child-free active organisation');
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,4)',
    '45300000-0000-4000-8000-000000000001',
    'd5300000-0000-4000-8000-000000000017',
    'sha256:' || pg_catalog.repeat('1', 64),
    (select tenant_id from lifecycle_one),
    (select root_organization_id from lifecycle_one)
  ), 'V3101'::char(5), null::text, 'archive is terminal for suspension');
select throws_ok(
  pg_catalog.format(
    'select * from vortex_identity.reactivate_tenant_organization(%L,%L,%L,%L,%L,4)',
    '45300000-0000-4000-8000-000000000001',
    'd5300000-0000-4000-8000-000000000018',
    'sha256:' || pg_catalog.repeat('2', 64),
    (select tenant_id from lifecycle_one),
    (select root_organization_id from lifecycle_one)
  ), 'V3101'::char(5), null::text, 'archive is terminal for reactivation');

select is(
  (select row(organization_id, tenant_id, parent_organization_id, short_name,
      display_name, created_at, created_by)::text
    from vortex_identity.organizations
    where organization_id = (select root_organization_id from lifecycle_one)),
  (select row(organization_id, tenant_id, parent_organization_id, short_name,
      display_name, created_at, created_by)::text from lifecycle_one_original),
  'lifecycle changes preserve organisation identity, names, hierarchy and creation evidence');
select is((select current_version from vortex_access.organization_access_versions
    where organization_id = (select root_organization_id from lifecycle_one)),
  (select access_version from lifecycle_one_original),
  'lifecycle changes do not change the organisation Access version');
select is((select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id = (select root_organization_id from lifecycle_one)),
  (select account_count from lifecycle_one_original),
  'lifecycle changes do not change organisation accounts');
select is((select pg_catalog.count(*) from vortex_access.organization_roles
    where organization_id = (select root_organization_id from lifecycle_one)),
  (select role_count from lifecycle_one_original),
  'lifecycle changes do not change organisation roles');
select is((select pg_catalog.count(*) from vortex_identity.organization_runtime_settings
    where organization_id = (select root_organization_id from lifecycle_one)),
  (select settings_count from lifecycle_one_original),
  'lifecycle changes do not change runtime settings');

create temporary table lifecycle_two on commit drop as
select * from vortex_identity.provision_tenant(
  'c5300000-0000-4000-8000-000000000002',
  '95300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000002',
  'sha256:' || pg_catalog.repeat('2', 64),
  'lifecycle_two', 'Lifecycle two', 'lifecycle_two_root',
  'Lifecycle two root',
  '45300000-0000-4000-8000-000000000011',
  '45300000-0000-4000-8000-000000000012',
  'Second steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('45300000-0000-4000-8000-000000000021', 'active', now()-interval '1 hour', now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000021', 1),
  ('45300000-0000-4000-8000-000000000022', 'active', now()-interval '2 hours', now()-interval '2 hours', '95300000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000022', 1),
  ('45300000-0000-4000-8000-000000000023', 'active', now()-interval '1 hour', now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000023', 1),
  ('45300000-0000-4000-8000-000000000024', 'active', now()-interval '1 hour', now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000024', 1),
  ('45300000-0000-4000-8000-000000000025', 'suspended', now()-interval '1 hour', now()-interval '1 minute', '95300000-0000-4000-8000-000000000001', 'a5300000-0000-4000-8000-000000000025', 2);
insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id, revoked_by_actor_id, revoked_at,
  revocation_correlation_id
) values
  ('35300000-0000-4000-8000-000000000021', (select tenant_id from lifecycle_two), '45300000-0000-4000-8000-000000000021', array['platform.tenant.organizations.rename'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000021', now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000021', null, null, null),
  ('35300000-0000-4000-8000-000000000022', (select tenant_id from lifecycle_two), '45300000-0000-4000-8000-000000000022', array['platform.tenant.organizations.lifecycle'], now()-interval '2 hours', now()-interval '1 hour', 1, now()-interval '2 hours', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000022', now()-interval '2 hours', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000022', null, null, null),
  ('35300000-0000-4000-8000-000000000023', (select tenant_id from lifecycle_two), '45300000-0000-4000-8000-000000000023', array['platform.tenant.organizations.lifecycle'], now()+interval '1 hour', null, 1, now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000023', now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000023', null, null, null),
  ('35300000-0000-4000-8000-000000000024', (select tenant_id from lifecycle_two), '45300000-0000-4000-8000-000000000024', array['platform.tenant.organizations.lifecycle'], now()-interval '1 hour', null, 2, now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000024', now()-interval '1 minute', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000025', '95300000-0000-4000-8000-000000000001', now()-interval '1 minute', 'b5300000-0000-4000-8000-000000000025'),
  ('35300000-0000-4000-8000-000000000025', (select tenant_id from lifecycle_two), '45300000-0000-4000-8000-000000000025', array['platform.tenant.organizations.lifecycle'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000026', now()-interval '1 hour', '95300000-0000-4000-8000-000000000001', 'b5300000-0000-4000-8000-000000000026', null, null, null);

select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000021', 'd5300000-0000-4000-8000-000000000021',
  'sha256:' || pg_catalog.repeat('3',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3101', null,
  'a different structural capability cannot authorize lifecycle');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000022', 'd5300000-0000-4000-8000-000000000022',
  'sha256:' || pg_catalog.repeat('4',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3101', null,
  'expired lifecycle authority is refused');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000023', 'd5300000-0000-4000-8000-000000000023',
  'sha256:' || pg_catalog.repeat('5',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3101', null,
  'scheduled lifecycle authority is refused');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000024', 'd5300000-0000-4000-8000-000000000024',
  'sha256:' || pg_catalog.repeat('6',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3101', null,
  'revoked lifecycle authority is refused');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000025', 'd5300000-0000-4000-8000-000000000025',
  'sha256:' || pg_catalog.repeat('7',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3101', null,
  'an inactive cluster-local identity projection is refused');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,2)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000026',
  'sha256:' || pg_catalog.repeat('8',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3102', null,
  'a stale organization revision is refused');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000027',
  'sha256:' || pg_catalog.repeat('9',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_one)), 'V3101', null,
  'a foreign target is refused without revealing it');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000028',
  'sha256:' || pg_catalog.repeat('a',64), (select tenant_id from lifecycle_two),
  '25300000-0000-4000-8000-000000000099'), 'V3101', null,
  'a missing target has the same safe refusal');

update vortex_identity.tenants set state = 'suspended',
  state_changed_at = pg_catalog.clock_timestamp(), revision = revision + 1
where tenant_id = (select tenant_id from lifecycle_two);
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000029',
  'sha256:' || pg_catalog.repeat('b',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3101', null,
  'an inactive selected tenant is refused');
update vortex_identity.tenants set state = 'active',
  state_changed_at = pg_catalog.clock_timestamp(), revision = revision + 1
where tenant_id = (select tenant_id from lifecycle_two);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  ('25300000-0000-4000-8000-000000000031', (select tenant_id from lifecycle_two),
    'missing_requirement', 'Missing requirement', 'suspended', now()-interval '1 hour',
    '95300000-0000-4000-8000-000000000001', now()-interval '1 hour', 1),
  ('25300000-0000-4000-8000-000000000032', (select tenant_id from lifecycle_two),
    'exhausted_revision', 'Exhausted revision', 'active', now()-interval '1 hour',
    '95300000-0000-4000-8000-000000000001', now()-interval '1 hour', 9007199254740991);
select * from vortex_access.initialize_organization_access_version(
  '25300000-0000-4000-8000-000000000031',
  '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000031');
select * from vortex_access.initialize_organization_access_version(
  '25300000-0000-4000-8000-000000000032',
  '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000032');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.reactivate_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000031',
  'sha256:' || pg_catalog.repeat('c',64), (select tenant_id from lifecycle_two),
  '25300000-0000-4000-8000-000000000031'), 'V3101', null,
  'reactivation requires an existing stewardship requirement row');
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,9007199254740991)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000032',
  'sha256:' || pg_catalog.repeat('d',64), (select tenant_id from lifecycle_two),
  '25300000-0000-4000-8000-000000000032'), 'V3102', null,
  'an exhausted organization revision is refused without overflow');

create function pg_temp.refuse_lifecycle_receipt()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.duplicate_key = 'd5300000-0000-4000-8000-000000000033'::uuid then
    raise exception using errcode = 'V3999', message = 'Test receipt refusal';
  end if;
  return new;
end
$function$;
create trigger refuse_lifecycle_receipt
before insert on vortex_identity.accepted_administration_receipts
for each row execute function pg_temp.refuse_lifecycle_receipt();
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.suspend_tenant_organization(%L,%L,%L,%L,%L,1)',
  '45300000-0000-4000-8000-000000000011', 'd5300000-0000-4000-8000-000000000033',
  'sha256:' || pg_catalog.repeat('e',64), (select tenant_id from lifecycle_two),
  (select root_organization_id from lifecycle_two)), 'V3999', null,
  'a failed receipt write rolls the lifecycle change back atomically');
drop trigger refuse_lifecycle_receipt on vortex_identity.accepted_administration_receipts;
select is((select state || '|' || revision from vortex_identity.organizations
    where organization_id = (select root_organization_id from lifecycle_two)),
  'active|1', 'failed lifecycle transaction leaves target state and revision unchanged');
select is((select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where duplicate_key = 'd5300000-0000-4000-8000-000000000033'), 0::bigint,
  'failed lifecycle transaction leaves no accepted receipt');

create temporary table lifecycle_three on commit drop as
select * from vortex_identity.provision_tenant(
  'c5300000-0000-4000-8000-000000000003',
  '95300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000003',
  'sha256:' || pg_catalog.repeat('3', 64),
  'lifecycle_three', 'Lifecycle three', 'lifecycle_three_root',
  'Lifecycle three root',
  '45300000-0000-4000-8000-000000000041',
  '45300000-0000-4000-8000-000000000042',
  'Original steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);
select * from vortex_identity.suspend_tenant_organization(
  '45300000-0000-4000-8000-000000000041',
  'd5300000-0000-4000-8000-000000000041',
  'sha256:' || pg_catalog.repeat('f', 64),
  (select tenant_id from lifecycle_three),
  (select root_organization_id from lifecycle_three), 1
);
update vortex_identity.identity_projections
set state = 'suspended', state_changed_at = pg_catalog.clock_timestamp(),
  state_changed_by = '95300000-0000-4000-8000-000000000001',
  state_change_correlation_id = 'a5300000-0000-4000-8000-000000000042',
  revision = revision + 1
where identity_id = '45300000-0000-4000-8000-000000000042';
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.reactivate_tenant_organization(%L,%L,%L,%L,%L,2)',
  '45300000-0000-4000-8000-000000000041', 'd5300000-0000-4000-8000-000000000042',
  'sha256:' || pg_catalog.repeat('0',64), (select tenant_id from lifecycle_three),
  (select root_organization_id from lifecycle_three)), 'V3101', null,
  'reactivation refuses a present but nonqualifying stewardship requirement');

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '45300000-0000-4000-8000-000000000043', 'active', now()-interval '1 hour',
  now()-interval '1 hour', '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000043', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '55300000-0000-4000-8000-000000000043',
  (select root_organization_id from lifecycle_three),
  '45300000-0000-4000-8000-000000000043', 'Replacement steward', 'active',
  now()-interval '1 hour', now()-interval '1 hour', now()-interval '1 hour',
  '95300000-0000-4000-8000-000000000001',
  'a5300000-0000-4000-8000-000000000044', 1
);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision, starts_at,
  expires_at, state, granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id
)
select requirement.organization_id,
  '75300000-0000-4000-8000-000000000043', requirement.original_role_id,
  'organization_account', '55300000-0000-4000-8000-000000000043', null,
  'standing', 1, now()-interval '1 hour', null, 'live',
  '95300000-0000-4000-8000-000000000001', now()-interval '1 hour',
  'a5300000-0000-4000-8000-000000000045',
  '95300000-0000-4000-8000-000000000001', now()-interval '1 hour',
  'a5300000-0000-4000-8000-000000000045'
from vortex_access.organization_stewardship_requirements as requirement
where requirement.organization_id = (select root_organization_id from lifecycle_three);
insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
  granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
) values (
  (select root_organization_id from lifecycle_three),
  '85300000-0000-4000-8000-000000000043', 'organization_account',
  '55300000-0000-4000-8000-000000000043', null,
  'organization_catalogue', null, null, 1, now()-interval '1 hour', null,
  'live', '95300000-0000-4000-8000-000000000001', now()-interval '1 hour',
  'a5300000-0000-4000-8000-000000000046',
  '95300000-0000-4000-8000-000000000001', now()-interval '1 hour',
  'a5300000-0000-4000-8000-000000000046'
);
select ok(vortex_access.organization_has_permanent_steward(
    (select root_organization_id from lifecycle_three), pg_catalog.clock_timestamp()),
  'a current qualifying replacement steward satisfies the delivered predicate');
select is((select outcome || '|' || revision
    from vortex_identity.reactivate_tenant_organization(
      '45300000-0000-4000-8000-000000000041',
      'd5300000-0000-4000-8000-000000000043',
      'sha256:' || pg_catalog.repeat('1',64),
      (select tenant_id from lifecycle_three),
      (select root_organization_id from lifecycle_three), 2)),
  'accepted|3', 'a qualifying replacement steward permits reactivation');
select is((select row(management_application_root_id, management_role_id,
      management_required_role_revision)::text
    from vortex_access.organization_stewardship_requirements
    where organization_id = (select root_organization_id from lifecycle_three)),
  row(null::uuid, null::uuid, null::bigint)::text,
  'reactivation does not invent a missing management-application binding');

select is((select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where tenant_id = (select tenant_id from lifecycle_one)
      and operation_key in ('suspend_tenant_organization',
        'reactivate_tenant_organization', 'archive_tenant_organization')),
  3::bigint, 'only the three accepted first transitions create lifecycle receipts');

update vortex_identity.tenant_administrator_assignments
set revoked_by_actor_id = '95300000-0000-4000-8000-000000000001',
  revoked_at = revoked.at,
  revocation_correlation_id = 'b5300000-0000-4000-8000-000000000099',
  revision = revision + 1,
  changed_at = revoked.at,
  changed_by_actor_id = '95300000-0000-4000-8000-000000000001',
  change_correlation_id = 'b5300000-0000-4000-8000-000000000099'
from (select pg_catalog.clock_timestamp() as at) as revoked
where assignment_id = (select tenant_administrator_assignment_id from lifecycle_one);
select throws_ok(pg_catalog.format(
  'select * from vortex_identity.archive_tenant_organization(%L,%L,%L,%L,%L,3)',
  '45300000-0000-4000-8000-000000000001',
  'd5300000-0000-4000-8000-000000000016',
  'sha256:' || pg_catalog.repeat('0',64),
  (select tenant_id from lifecycle_one),
  (select root_organization_id from lifecycle_one)), 'V3101', null,
  'an accepted replay still rechecks current tenant authority first');

select * from finish();
rollback;
