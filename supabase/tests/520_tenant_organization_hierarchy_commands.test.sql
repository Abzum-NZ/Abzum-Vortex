\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

select ok(pg_catalog.has_function_privilege('vortex_runtime', signature, 'EXECUTE'),
  'runtime can call protected ' || signature)
from (values
  ('vortex_identity.rename_tenant_organization(uuid,uuid,text,uuid,uuid,bigint,text)'),
  ('vortex_identity.reparent_tenant_organization(uuid,uuid,text,uuid,uuid,bigint,uuid)')
) functions(signature);
select ok(not pg_catalog.has_function_privilege(candidate.role_name, signature, 'EXECUTE'),
  candidate.role_name || ' cannot call protected ' || signature)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) candidate(role_name)
cross join (values
  ('vortex_identity.rename_tenant_organization(uuid,uuid,text,uuid,uuid,bigint,text)'),
  ('vortex_identity.reparent_tenant_organization(uuid,uuid,text,uuid,uuid,bigint,uuid)')
) functions(signature);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values
  ('15400000-0000-4000-8000-000000000001', 'hierarchy_one', 'Hierarchy One', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('15400000-0000-4000-8000-000000000002', 'hierarchy_two', 'Hierarchy Two', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('15400000-0000-4000-8000-000000000003', 'hierarchy_inactive', 'Hierarchy Inactive', 'suspended', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 hour', 2);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('45400000-0000-4000-8000-000000000001', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000001', 1),
  ('45400000-0000-4000-8000-000000000002', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000002', 1),
  ('45400000-0000-4000-8000-000000000003', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000003', 1),
  ('45400000-0000-4000-8000-000000000004', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000004', 1),
  ('45400000-0000-4000-8000-000000000005', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000005', 1),
  ('45400000-0000-4000-8000-000000000006', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000006', 1),
  ('45400000-0000-4000-8000-000000000007', 'suspended', now()-interval '1 day', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000007', 2),
  ('45400000-0000-4000-8000-000000000008', 'active', now()-interval '1 day', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000008', 1);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  ('25400000-0000-4000-8000-000000000001', '15400000-0000-4000-8000-000000000001', null, 'root_one', 'Root One', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000002', '15400000-0000-4000-8000-000000000001', null, 'root_two', 'Root Two', 'suspended', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000003', '15400000-0000-4000-8000-000000000001', '25400000-0000-4000-8000-000000000001', 'child', 'Child', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000004', '15400000-0000-4000-8000-000000000001', '25400000-0000-4000-8000-000000000003', 'grandchild', 'Grandchild', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000005', '15400000-0000-4000-8000-000000000001', null, 'archived', 'Archived', 'archived', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 hour', 2),
  ('25400000-0000-4000-8000-000000000006', '15400000-0000-4000-8000-000000000001', null, 'rename_target', 'Rename Target', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000007', '15400000-0000-4000-8000-000000000001', null, 'reparent_target', 'Reparent Target', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000008', '15400000-0000-4000-8000-000000000002', null, 'foreign_root', 'Foreign Root', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1),
  ('25400000-0000-4000-8000-000000000009', '15400000-0000-4000-8000-000000000003', null, 'inactive_root', 'Inactive Root', 'active', now()-interval '1 day', '95400000-0000-4000-8000-000000000001', now()-interval '1 day', 1);

insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by, change_correlation_id, change_reason
) values (
  '25400000-0000-4000-8000-000000000003', 7, now()-interval '1 day',
  '95400000-0000-4000-8000-000000000001', 'a5400000-0000-4000-8000-000000000009',
  'organization_initialized'
);

insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id
) values
  ('35400000-0000-4000-8000-000000000001', '15400000-0000-4000-8000-000000000001', '45400000-0000-4000-8000-000000000001', array['platform.tenant.organizations.rename','platform.tenant.organizations.reparent'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000001', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000001'),
  ('35400000-0000-4000-8000-000000000002', '15400000-0000-4000-8000-000000000001', '45400000-0000-4000-8000-000000000002', array['platform.tenant.organizations.rename'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000002', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000002'),
  ('35400000-0000-4000-8000-000000000003', '15400000-0000-4000-8000-000000000001', '45400000-0000-4000-8000-000000000003', array['platform.tenant.organizations.reparent'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000003', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000003'),
  ('35400000-0000-4000-8000-000000000005', '15400000-0000-4000-8000-000000000001', '45400000-0000-4000-8000-000000000005', array['platform.tenant.organizations.rename'], now()-interval '2 hours', now()-interval '1 hour', 1, now()-interval '2 hours', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000005', now()-interval '2 hours', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000005'),
  ('35400000-0000-4000-8000-000000000006', '15400000-0000-4000-8000-000000000001', '45400000-0000-4000-8000-000000000006', array['platform.tenant.organizations.rename'], now()+interval '1 hour', null, 1, now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000006', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000006'),
  ('35400000-0000-4000-8000-000000000007', '15400000-0000-4000-8000-000000000001', '45400000-0000-4000-8000-000000000007', array['platform.tenant.organizations.rename'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000007', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000007'),
  ('35400000-0000-4000-8000-000000000008', '15400000-0000-4000-8000-000000000003', '45400000-0000-4000-8000-000000000008', array['platform.tenant.organizations.rename'], now()-interval '1 hour', null, 1, now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000008', now()-interval '1 hour', '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000008');
insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id, revoked_at, revoked_by_actor_id,
  revocation_correlation_id
) values (
  '35400000-0000-4000-8000-000000000004', '15400000-0000-4000-8000-000000000001',
  '45400000-0000-4000-8000-000000000004', array['platform.tenant.organizations.rename'],
  now()-interval '2 hours', null, 2, now()-interval '2 hours',
  '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000004',
  now()-interval '1 hour', '95400000-0000-4000-8000-000000000001',
  'b5400000-0000-4000-8000-000000000014', now()-interval '1 hour',
  '95400000-0000-4000-8000-000000000001', 'b5400000-0000-4000-8000-000000000014'
);

create temporary table original_child_invariants on commit drop as
select organization_id, tenant_id, short_name, state, created_at, created_by, state_changed_at
from vortex_identity.organizations
where organization_id='25400000-0000-4000-8000-000000000003';

select is((select count(*) from vortex_identity.organization_accounts
  where identity_id='45400000-0000-4000-8000-000000000001'), 0::bigint,
  'the authorized tenant administrator has no local organization account');

select is((select outcome||'|'||revision from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000001','sha256:1111111111111111111111111111111111111111111111111111111111111111',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',1,'Renamed Child')),
  'accepted|2','rename changes the display name at the next organization revision');
select is((select outcome||'|'||revision from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000002','sha256:2222222222222222222222222222222222222222222222222222222222222222',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',2,'25400000-0000-4000-8000-000000000002')),
  'accepted|3','reparent accepts a suspended same-tenant parent');
select is((select outcome||'|'||revision from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000002','sha256:2222222222222222222222222222222222222222222222222222222222222222',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',2,'25400000-0000-4000-8000-000000000002')),
  'replayed|3','an exact reparent retry returns the accepted result without mutation');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000002','sha256:3333333333333333333333333333333333333333333333333333333333333333',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',2,null)$$,
  'V3001',null,'a changed reparent payload conflicts with the accepted duplicate key');
select is((select outcome||'|'||revision from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000003','sha256:4444444444444444444444444444444444444444444444444444444444444444',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',3,null)),
  'accepted|4','reparent can make the organization a tenant root');
select is((select parent_organization_id from vortex_identity.organizations
  where organization_id='25400000-0000-4000-8000-000000000004'),
  '25400000-0000-4000-8000-000000000003'::uuid,
  'the descendant retains its existing link and moves with the subtree');

select is((select outcome from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000002','c5400000-0000-4000-8000-000000000004','sha256:5555555555555555555555555555555555555555555555555555555555555555',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000006',1,'Rename Capability')),
  'accepted','the exact rename capability authorizes rename');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000002','c5400000-0000-4000-8000-000000000005','sha256:6666666666666666666666666666666666666666666666666666666666666666',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000006',2,null)$$,
  'V3101',null,'rename authority does not authorize reparent');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000003','c5400000-0000-4000-8000-000000000006','sha256:7777777777777777777777777777777777777777777777777777777777777777',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000007',1,'Wrong Capability')$$,
  'V3101',null,'reparent authority does not authorize rename');
select is((select outcome from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000003','c5400000-0000-4000-8000-000000000007','sha256:8888888888888888888888888888888888888888888888888888888888888888',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000007',1,'25400000-0000-4000-8000-000000000002')),
  'accepted','the exact reparent capability authorizes reparent');

select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000004','c5400000-0000-4000-8000-000000000008','sha256:9999999999999999999999999999999999999999999999999999999999999999',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000001',1,'Revoked')$$,
  'V3101',null,'revoked authority is refused');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000005','c5400000-0000-4000-8000-000000000009','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000001',1,'Expired')$$,
  'V3101',null,'expired authority is refused');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000006','c5400000-0000-4000-8000-000000000010','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000001',1,'Scheduled')$$,
  'V3101',null,'scheduled authority is refused');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000007','c5400000-0000-4000-8000-000000000011','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000001',1,'Inactive Identity')$$,
  'V3101',null,'an inactive identity projection is refused');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000008','c5400000-0000-4000-8000-000000000012','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '15400000-0000-4000-8000-000000000003','25400000-0000-4000-8000-000000000009',1,'Inactive Tenant')$$,
  'V3101',null,'an inactive selected tenant is refused');

select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000013','sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',3,'Stale')$$,
  'V3102',null,'a stale organization revision is refused');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000014','sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000008',1,'Foreign Target')$$,
  'V3101',null,'a foreign target is refused without revealing it');
select throws_ok($$select * from vortex_identity.rename_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000015','sha256:0101010101010101010101010101010101010101010101010101010101010101',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000099',1,'Missing Target')$$,
  'V3101',null,'a missing target has the same safe refusal');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000016','sha256:0202020202020202020202020202020202020202020202020202020202020202',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',4,'25400000-0000-4000-8000-000000000003')$$,
  'V3101',null,'self-parenting is refused');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000017','sha256:0303030303030303030303030303030303030303030303030303030303030303',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',4,'25400000-0000-4000-8000-000000000004')$$,
  '23514',null,'a descendant destination is refused by the existing cycle constraint');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000018','sha256:0404040404040404040404040404040404040404040404040404040404040404',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',4,'25400000-0000-4000-8000-000000000008')$$,
  'V3101',null,'a foreign parent is refused like a missing parent');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000019','sha256:0505050505050505050505050505050505050505050505050505050505050505',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',4,'25400000-0000-4000-8000-000000000099')$$,
  'V3101',null,'a missing parent is refused');
select throws_ok($$select * from vortex_identity.reparent_tenant_organization(
  '45400000-0000-4000-8000-000000000001','c5400000-0000-4000-8000-000000000020','sha256:0606060606060606060606060606060606060606060606060606060606060606',
  '15400000-0000-4000-8000-000000000001','25400000-0000-4000-8000-000000000003',4,'25400000-0000-4000-8000-000000000005')$$,
  'V3101',null,'the existing unresolved-child lifecycle rule refuses an archived parent');

select is((select row(organization_id,tenant_id,short_name,state,created_at,created_by,state_changed_at)::text
  from vortex_identity.organizations where organization_id='25400000-0000-4000-8000-000000000003'),
  (select row(organization_id,tenant_id,short_name,state,created_at,created_by,state_changed_at)::text
   from original_child_invariants),
  'accepted commands preserve permanent identity, tenant, short name, lifecycle and lifecycle evidence');
select is((select row(parent_organization_id,display_name,revision)::text
  from vortex_identity.organizations where organization_id='25400000-0000-4000-8000-000000000003'),
  row(null::uuid,'Renamed Child',4::bigint)::text,
  'only the requested display name and parent link change at successive revisions');
select is((select current_version from vortex_access.organization_access_versions
  where organization_id='25400000-0000-4000-8000-000000000003'), 7::bigint,
  'rename and reparent do not change the organization Access version');
select is((select count(*) from vortex_identity.organization_accounts
  where identity_id='45400000-0000-4000-8000-000000000001'), 0::bigint,
  'rename and reparent do not create local access');
select is((select count(*) from vortex_access.organization_roles
  where organization_id='25400000-0000-4000-8000-000000000003'), 0::bigint,
  'rename and reparent do not create or change local roles');
select is((select count(*) from vortex_access.organization_role_assignments
  where organization_id='25400000-0000-4000-8000-000000000003'), 0::bigint,
  'rename and reparent do not create local role assignments');
select is((select count(*) from vortex_identity.accepted_administration_receipts
  where tenant_id='15400000-0000-4000-8000-000000000001'
    and operation_key in ('rename_tenant_organization','reparent_tenant_organization')),
  5::bigint,'only the five accepted mutations create receipts; replay and refusals create none');

select * from finish();
rollback;
