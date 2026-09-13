\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

select ok(not pg_catalog.has_function_privilege(candidate.role_name,
  'vortex_identity.require_current_tenant_capability(uuid,uuid,text,timestamp with time zone)', 'EXECUTE'),
  candidate.role_name || ' cannot call the private tenant-authority resolver')
from (values ('public'::name),('anon'::name),('authenticated'::name),('service_role'::name),('vortex_request'::name)) candidate(role_name);
select ok(pg_catalog.has_function_privilege('vortex_runtime', signature, 'EXECUTE'),
  'runtime can call protected ' || signature)
from (values
 ('vortex_identity.list_tenant_launcher(uuid,integer,uuid)'),
 ('vortex_identity.list_tenant_hierarchy(uuid,uuid,integer,uuid)'),
 ('vortex_identity.read_tenant_organization(uuid,uuid,uuid)'),
 ('vortex_identity.list_tenant_administrator_assignments(uuid,uuid,integer,uuid)'),
 ('vortex_identity.grant_tenant_administrator(uuid,uuid,text,uuid,uuid,jsonb,timestamp with time zone,timestamp with time zone)'),
 ('vortex_identity.change_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint,jsonb,timestamp with time zone,timestamp with time zone)'),
 ('vortex_identity.revoke_tenant_administrator(uuid,uuid,text,uuid,uuid,bigint)')
) functions(signature);

insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision) values
 ('15300000-0000-4000-8000-000000000001','governance_one','Governance One','active',now()-interval '1 day','95300000-0000-4000-8000-000000000001',now()-interval '1 day',1),
 ('15300000-0000-4000-8000-000000000002','governance_two','Governance Two','active',now()-interval '1 day','95300000-0000-4000-8000-000000000001',now()-interval '1 day',1);
insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
 ('45300000-0000-4000-8000-000000000001','active',now()-interval '1 day',now()-interval '1 day','95300000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000001',1),
 ('45300000-0000-4000-8000-000000000002','active',now()-interval '1 day',now()-interval '1 day','95300000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000002',1);
insert into vortex_identity.organizations(organization_id,tenant_id,parent_organization_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision) values
 ('25300000-0000-4000-8000-000000000001','15300000-0000-4000-8000-000000000001',null,'root','Root','active',now()-interval '1 day','95300000-0000-4000-8000-000000000001',now()-interval '1 day',1),
 ('25300000-0000-4000-8000-000000000002','15300000-0000-4000-8000-000000000001','25300000-0000-4000-8000-000000000001','child','Child','suspended',now()-interval '1 day','95300000-0000-4000-8000-000000000001',now()-interval '1 day',2);
insert into vortex_access.organization_access_versions(organization_id,current_version,changed_at,changed_by,change_correlation_id,change_reason)
 values('25300000-0000-4000-8000-000000000001',7,now()-interval '1 day','95300000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000003','organization_initialized');
insert into vortex_identity.tenant_administrator_assignments(assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id)
values('35300000-0000-4000-8000-000000000001','15300000-0000-4000-8000-000000000001','45300000-0000-4000-8000-000000000001',
 array['platform.tenant.administrators.manage','platform.tenant.administrators.read','platform.tenant.hierarchy.read'],now()-interval '1 hour',null,1,now()-interval '1 hour','95300000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000004',now()-interval '1 hour','95300000-0000-4000-8000-000000000001','a5300000-0000-4000-8000-000000000004');

select is((select count(*) from vortex_identity.list_tenant_launcher('45300000-0000-4000-8000-000000000001',2,null)),1::bigint,'launcher exposes only active effective tenant contexts');
select throws_ok($$select * from vortex_identity.list_tenant_launcher(null,2,null)$$,'22023',null,'a null identity is an invalid request, never ambient authority');
select is((select count(*) from vortex_identity.list_tenant_hierarchy('45300000-0000-4000-8000-000000000001','15300000-0000-4000-8000-000000000001',1,null)),1::bigint,'hierarchy read is bounded');
select is((select state from vortex_identity.read_tenant_organization('45300000-0000-4000-8000-000000000001','15300000-0000-4000-8000-000000000001','25300000-0000-4000-8000-000000000002')),'suspended','exact organization read returns the selected same-tenant structural row');
select is((select outcome from vortex_identity.list_tenant_administrator_assignments('45300000-0000-4000-8000-000000000001','15300000-0000-4000-8000-000000000001',10,null)),'active','assignment outcome is derived at read time');
select throws_ok($$select * from vortex_identity.list_tenant_hierarchy('45300000-0000-4000-8000-000000000001','15300000-0000-4000-8000-000000000002',10,null)$$,'V3101',null,'a foreign or unauthorized tenant is one safe refusal');

select is((select outcome||'|'||revision from vortex_identity.grant_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000001','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 '15300000-0000-4000-8000-000000000001','45300000-0000-4000-8000-000000000002','["platform.tenant.hierarchy.read"]',now()-interval '1 minute',null)),'accepted|1','current manager grants a canonical subset at revision one');
select is((select outcome||'|'||revision from vortex_identity.grant_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000001','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 '15300000-0000-4000-8000-000000000001','45300000-0000-4000-8000-000000000002','["platform.tenant.hierarchy.read"]',now()-interval '1 minute',null)),'replayed|1','an exact duplicate replays revision one without mutation');
create temporary table original_tenant_grant_provenance on commit drop as
select assignment_id, granted_at, granted_by_actor_id, grant_correlation_id
from vortex_identity.tenant_administrator_assignments
where tenant_id='15300000-0000-4000-8000-000000000001'
  and identity_id='45300000-0000-4000-8000-000000000002';
select throws_ok($$select * from vortex_identity.grant_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000002','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
 '15300000-0000-4000-8000-000000000001','45300000-0000-4000-8000-000000000002','["platform.tenant.organizations.create"]',now()-interval '1 minute',null)$$,'V3101',null,'a manager cannot grant a capability outside their current effective set');
select is((select outcome||'|'||revision from vortex_identity.change_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000004','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
 '15300000-0000-4000-8000-000000000001',(select assignment_id from original_tenant_grant_provenance),1,
 '["platform.tenant.administrators.read"]',now()-interval '1 minute',null)),'accepted|2','an authorized assignment change produces revision two');
select is((select outcome||'|'||revision from vortex_identity.change_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000004','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
 '15300000-0000-4000-8000-000000000001',(select assignment_id from original_tenant_grant_provenance),1,
 '["platform.tenant.administrators.read"]',now()-interval '1 minute',null)),'replayed|2','an exact assignment change retry replays revision two');
select throws_ok($$select * from vortex_identity.change_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000004','sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
 '15300000-0000-4000-8000-000000000001',(select assignment_id from original_tenant_grant_provenance),1,
 '["platform.tenant.hierarchy.read"]',now()-interval '1 minute',null)$$,'V3001',null,'a changed assignment payload conflicts with the accepted duplicate key');
select throws_ok($$select * from vortex_identity.change_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000005','sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
 '15300000-0000-4000-8000-000000000001','35300000-0000-4000-8000-000000000001',1,
 '["platform.tenant.administrators.read"]',now()-interval '1 minute',null)$$,'V3103',null,'a change cannot remove the final qualifying permanent manager');
select throws_ok($$select * from vortex_identity.revoke_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000003','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
 '15300000-0000-4000-8000-000000000001','35300000-0000-4000-8000-000000000001',1)$$,'V3103',null,'the last qualifying permanent manager cannot be revoked');
select is((select outcome||'|'||revision from vortex_identity.revoke_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000006','sha256:6666666666666666666666666666666666666666666666666666666666666666',
 '15300000-0000-4000-8000-000000000001',(select assignment_id from original_tenant_grant_provenance),2)),'accepted|3','an authorized revocation produces revision three');
select is((select outcome||'|'||revision from vortex_identity.revoke_tenant_administrator(
 '45300000-0000-4000-8000-000000000001','b5300000-0000-4000-8000-000000000006','sha256:6666666666666666666666666666666666666666666666666666666666666666',
 '15300000-0000-4000-8000-000000000001',(select assignment_id from original_tenant_grant_provenance),2)),'replayed|3','an exact revocation retry replays revision three');
select is((select revision from vortex_identity.tenant_administrator_assignments where assignment_id=(select assignment_id from original_tenant_grant_provenance)),3::bigint,'the stored assignment retains the resulting revision');
select ok((select revoked_at is not null and revoked_at=changed_at
  and revoked_by_actor_id=changed_by_actor_id
  and revocation_correlation_id=change_correlation_id
  from vortex_identity.tenant_administrator_assignments
  where assignment_id=(select assignment_id from original_tenant_grant_provenance)),
  'revocation writes complete matching current-change evidence');
select is((select row(assignment.granted_at,assignment.granted_by_actor_id,assignment.grant_correlation_id)::text
  from vortex_identity.tenant_administrator_assignments assignment
  where assignment.assignment_id=(select assignment_id from original_tenant_grant_provenance)),
  (select row(original.granted_at,original.granted_by_actor_id,original.grant_correlation_id)::text
   from original_tenant_grant_provenance original),
  'change and revocation preserve original grant provenance');
select is((select current_version from vortex_access.organization_access_versions where organization_id='25300000-0000-4000-8000-000000000001'),7::bigint,'tenant grant, change and revoke do not increment organization Access version');
select is((select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='15300000-0000-4000-8000-000000000001'),3::bigint,'each accepted grant, change and revoke stores exactly one receipt while replay and refusals store none');

select * from finish();
rollback;
