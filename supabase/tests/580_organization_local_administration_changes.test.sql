\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_request;
select no_plan();

select has_function('vortex_access', 'suspend_organization_account_for_administration',
  array['uuid','uuid','bigint'], 'account suspension has one fixed protected entry');
select has_function('vortex_access', 'reactivate_organization_account_for_administration',
  array['uuid','uuid','bigint'], 'account reactivation has one fixed protected entry');
select has_function('vortex_access', 'close_organization_account_for_administration',
  array['uuid','uuid','bigint'], 'account closure has one fixed protected entry');
select has_function('vortex_access', 'create_organization_invitation_for_administration',
  array['uuid','text','text','timestamp with time zone'],
  'no-intent invitation creation has one fixed protected entry');
select has_function('vortex_access', 'revoke_organization_invitation_for_administration',
  array['uuid','uuid','bigint'], 'invitation revocation has one fixed protected entry');

select ok(pg_catalog.has_function_privilege('vortex_request', signature, 'execute'),
  'request role can call ' || signature)
from (values
  ('vortex_access.suspend_organization_account_for_administration(uuid,uuid,bigint)'),
  ('vortex_access.reactivate_organization_account_for_administration(uuid,uuid,bigint)'),
  ('vortex_access.close_organization_account_for_administration(uuid,uuid,bigint)'),
  ('vortex_access.create_organization_invitation_for_administration(uuid,text,text,timestamp with time zone)'),
  ('vortex_access.revoke_organization_invitation_for_administration(uuid,uuid,bigint)')
) protected(signature);

select ok(not pg_catalog.has_function_privilege(candidate.role_name, signature, 'execute'),
  candidate.role_name || ' cannot call ' || signature)
from (values ('public'::name),('anon'::name),('authenticated'::name),
  ('service_role'::name),('vortex_runtime'::name),('vortex_record_owner'::name)) candidate(role_name)
cross join (values
  ('vortex_access.suspend_organization_account_for_administration(uuid,uuid,bigint)'),
  ('vortex_access.reactivate_organization_account_for_administration(uuid,uuid,bigint)'),
  ('vortex_access.close_organization_account_for_administration(uuid,uuid,bigint)'),
  ('vortex_access.create_organization_invitation_for_administration(uuid,text,text,timestamp with time zone)'),
  ('vortex_access.revoke_organization_invitation_for_administration(uuid,uuid,bigint)')
) protected(signature);

select ok(not pg_catalog.has_function_privilege('vortex_request', signature, 'execute'),
  'request role cannot bypass the protected entry through ' || signature)
from (values
  ('vortex_access.organization_accounts_administration_change_scope()'),
  ('vortex_access.organization_invitations_administration_change_scope()'),
  ('vortex_access.change_organization_account_state(uuid,bigint,text)'),
  ('vortex_identity.change_organization_account_state(uuid,bigint,text)'),
  ('vortex_identity.create_organization_invitation(text,text,timestamp with time zone)'),
  ('vortex_identity.revoke_organization_invitation(uuid,bigint)')
) private_helper(signature);

select ok(not pg_catalog.has_table_privilege('vortex_request', table_name,
  'select,insert,update,delete'), 'request role has no raw access to ' || table_name)
from (values ('vortex_identity.organization_accounts'),
  ('vortex_identity.organization_invitations'),
  ('vortex_identity.accepted_administration_receipts')) private_table(table_name);

insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,
  created_at,created_by,state_changed_at,revision) values
('15800000-0000-4000-8000-000000000001','slice_six','Slice six','active',
 pg_catalog.clock_timestamp(),'95800000-0000-4000-8000-000000000001',
 pg_catalog.clock_timestamp(),1);
insert into vortex_identity.organizations(organization_id,tenant_id,short_name,
  display_name,state,created_at,created_by,state_changed_at,revision) values
('25800000-0000-4000-8000-000000000001','15800000-0000-4000-8000-000000000001',
 'slice_six','Slice six','active',pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp(),1),
('25800000-0000-4000-8000-000000000002','15800000-0000-4000-8000-000000000001',
 'foreign_six','Foreign six','active',pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp(),1);

insert into vortex_identity.identity_projections(identity_id,state,created_at,
  state_changed_at,state_changed_by,state_change_correlation_id,revision)
select identity_id,'active',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
  '95800000-0000-4000-8000-000000000001',correlation_id,1
from (values
 ('45800000-0000-4000-8000-000000000001'::uuid,'a5800000-0000-4000-8000-000000000001'::uuid),
 ('45800000-0000-4000-8000-000000000002'::uuid,'a5800000-0000-4000-8000-000000000002'::uuid),
 ('45800000-0000-4000-8000-000000000003'::uuid,'a5800000-0000-4000-8000-000000000003'::uuid),
 ('45800000-0000-4000-8000-000000000004'::uuid,'a5800000-0000-4000-8000-000000000004'::uuid),
 ('45800000-0000-4000-8000-000000000005'::uuid,'a5800000-0000-4000-8000-000000000005'::uuid),
 ('45800000-0000-4000-8000-000000000006'::uuid,'a5800000-0000-4000-8000-000000000006'::uuid)
) fixture(identity_id,correlation_id);

insert into vortex_identity.organization_accounts(organization_account_id,
  organization_id,identity_id,display_name,state,activated_at,changed_at,
  state_changed_at,state_changed_by,state_change_correlation_id,revision) values
('55800000-0000-4000-8000-000000000001','25800000-0000-4000-8000-000000000001',
 '45800000-0000-4000-8000-000000000001','Steward','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000011',1),
('55800000-0000-4000-8000-000000000002','25800000-0000-4000-8000-000000000001',
 '45800000-0000-4000-8000-000000000002','Target','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000012',1),
('55800000-0000-4000-8000-000000000003','25800000-0000-4000-8000-000000000001',
 '45800000-0000-4000-8000-000000000003','Member only','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000013',1),
('55800000-0000-4000-8000-000000000004','25800000-0000-4000-8000-000000000001',
 '45800000-0000-4000-8000-000000000004','Accounts only','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000014',1),
('55800000-0000-4000-8000-000000000005','25800000-0000-4000-8000-000000000001',
 '45800000-0000-4000-8000-000000000005','Invitations only','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000015',1),
 ('55800000-0000-4000-8000-000000000006','25800000-0000-4000-8000-000000000002',
  '45800000-0000-4000-8000-000000000006','Foreign target','active',
  pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
  '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000016',1);

select * from vortex_access.initialize_organization_access_version(
  '25800000-0000-4000-8000-000000000001','95800000-0000-4000-8000-000000000001',
  'a5800000-0000-4000-8000-000000000021');
select * from vortex_access.initialize_platform_permission_catalogue(
  '25800000-0000-4000-8000-000000000001','95800000-0000-4000-8000-000000000001',
  'a5800000-0000-4000-8000-000000000022');
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '25800000-0000-4000-8000-000000000001','55800000-0000-4000-8000-000000000001',
  '65800000-0000-4000-8000-000000000001','organization_steward','Organisation steward',
  'Permanent minimum organisation administration.',
  '75800000-0000-4000-8000-000000000001','85800000-0000-4000-8000-000000000001',
  '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000023');

create function pg_temp.seed_manage_role(p_role_id uuid,p_key text,p_account_id uuid,
  p_assignment_id uuid,p_permission_id uuid) returns void
language plpgsql volatile set search_path='' as $function$
declare operation_at timestamptz:=pg_catalog.clock_timestamp();
begin
  insert into vortex_access.organization_roles(organization_id,role_id,role_kind,
    role_key,live_revision,created_by,created_at) values
  ('25800000-0000-4000-8000-000000000001',p_role_id,'custom',p_key,1,
   '95800000-0000-4000-8000-000000000001',operation_at);
  insert into vortex_access.organization_role_permission_entries(
    organization_id,role_id,role_revision,entry_ordinal,role_kind,
    role_application_root_id,application_root_id,owner_kind,owner_id,permission_id,
    registration_kind,registration_owner_id,accepted_registration_revision,
    catalogue_fingerprint,continuity_revision,meaning_fingerprint)
  select entry.organization_id,p_role_id,1,1,'custom',null,entry.application_root_id,
    entry.owner_kind,entry.owner_id,entry.permission_id,entry.registration_kind,
    entry.registration_owner_id,entry.registration_revision,
    registration.permission_catalogue_fingerprint,continuity.continuity_revision,
    entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries entry
  join vortex_access.permission_registration_revisions registration
    on registration.organization_id=entry.organization_id
    and registration.registration_kind=entry.registration_kind
    and registration.registration_owner_id is not distinct from entry.registration_owner_id
    and registration.revision=entry.registration_revision
  join vortex_access.permission_continuities continuity
    on continuity.organization_id=entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind=entry.owner_kind and continuity.owner_id=entry.owner_id
    and continuity.permission_id=entry.permission_id
  where entry.organization_id='25800000-0000-4000-8000-000000000001'
    and entry.permission_id=p_permission_id;
  insert into vortex_access.organization_role_revisions(organization_id,role_id,
    revision,role_kind,lifecycle,privilege_classification,assignment_policy,
    policy_continuity_revision,authority_continuity_revision,role_key,label,
    description,changed_by,changed_at,change_correlation_id) values
  ('25800000-0000-4000-8000-000000000001',p_role_id,1,'custom','active',
   'privileged','standing',1,1,p_key,'Exact manage role','Slice 6 exact permission.',
   '95800000-0000-4000-8000-000000000001',operation_at,p_role_id);
  insert into vortex_access.organization_role_assignments(organization_id,
    role_assignment_id,role_id,assignee_kind,organization_account_id,assignment_kind,
    revision,starts_at,state,granted_by,granted_at,grant_correlation_id,changed_by,
    changed_at,change_correlation_id) values
  ('25800000-0000-4000-8000-000000000001',p_assignment_id,p_role_id,
   'organization_account',p_account_id,'standing',1,operation_at-interval '1 minute',
   'live','95800000-0000-4000-8000-000000000001',operation_at,p_assignment_id,
   '95800000-0000-4000-8000-000000000001',operation_at,p_assignment_id);
end $function$;
select pg_temp.seed_manage_role('65800000-0000-4000-8000-000000000004','accounts_only',
 '55800000-0000-4000-8000-000000000004','75800000-0000-4000-8000-000000000004',
 '630a980c-0ff5-40b1-a329-7326a2122395');
select pg_temp.seed_manage_role('65800000-0000-4000-8000-000000000005','invitations_only',
 '55800000-0000-4000-8000-000000000005','75800000-0000-4000-8000-000000000005',
 'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb');

insert into vortex_identity.tenant_administrator_assignments(assignment_id,tenant_id,
  identity_id,capability_keys,starts_at,revision,granted_at,granted_by_actor_id,
  grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id) values
('b5800000-0000-4000-8000-000000000003','15800000-0000-4000-8000-000000000001',
 '45800000-0000-4000-8000-000000000003',array['platform.tenant.hierarchy.read'],
 pg_catalog.clock_timestamp()-interval '1 minute',1,pg_catalog.clock_timestamp(),
 '95800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000031',
 pg_catalog.clock_timestamp(),'95800000-0000-4000-8000-000000000001',
 'a5800000-0000-4000-8000-000000000031');

insert into vortex_identity.organization_invitations(invitation_id,organization_id,
  invited_email,token_fingerprint,invited_by_organization_account_id,created_at,
  invited_at,expires_at,revoked_at,revoked_by_organization_account_id,accepted_at,
  accepted_organization_account_id,changed_at,revision) values
('35800000-0000-4000-8000-000000000001','25800000-0000-4000-8000-000000000001',
 'expired@example.test','sha256:'||pg_catalog.repeat('1',64),
 '55800000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp()-interval '2 hour',
 pg_catalog.clock_timestamp()-interval '2 hour',pg_catalog.clock_timestamp()-interval '1 hour',
 null,null,null,null,pg_catalog.clock_timestamp()-interval '2 hour',1),
('35800000-0000-4000-8000-000000000002','25800000-0000-4000-8000-000000000001',
 'accepted@example.test','sha256:'||pg_catalog.repeat('2',64),
 '55800000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp()-interval '2 hour',
 pg_catalog.clock_timestamp()-interval '2 hour',pg_catalog.clock_timestamp()+interval '1 hour',
 null,null,pg_catalog.clock_timestamp()-interval '1 hour',
 '55800000-0000-4000-8000-000000000002',pg_catalog.clock_timestamp()-interval '1 hour',2),
('35800000-0000-4000-8000-000000000003','25800000-0000-4000-8000-000000000001',
 'revoked@example.test','sha256:'||pg_catalog.repeat('3',64),
 '55800000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp()-interval '2 hour',
 pg_catalog.clock_timestamp()-interval '2 hour',pg_catalog.clock_timestamp()+interval '1 hour',
 pg_catalog.clock_timestamp()-interval '1 hour','55800000-0000-4000-8000-000000000001',
 null,null,pg_catalog.clock_timestamp()-interval '1 hour',2),
 ('35800000-0000-4000-8000-000000000004','25800000-0000-4000-8000-000000000002',
  'foreign@example.test','sha256:'||pg_catalog.repeat('4',64),
  '55800000-0000-4000-8000-000000000006',pg_catalog.clock_timestamp()-interval '2 hour',
  pg_catalog.clock_timestamp()-interval '2 hour',pg_catalog.clock_timestamp()+interval '1 hour',
  null,null,null,null,pg_catalog.clock_timestamp()-interval '2 hour',1);

create function pg_temp.install_context(p_identity_id uuid,p_account_id uuid,p_correlation_id uuid)
returns void language plpgsql volatile set search_path='' as $function$
declare operation_at timestamptz:=pg_catalog.clock_timestamp(); resolved_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  select version.current_version into strict resolved_version
  from vortex_access.organization_access_versions as version
  where version.organization_id='25800000-0000-4000-8000-000000000001';
  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','b5800000-0000-4000-8000-000000000001',
    'tenantId','15800000-0000-4000-8000-000000000001',
    'organizationId','25800000-0000-4000-8000-000000000001',
    'organizationAccountId',p_account_id,'identityId',p_identity_id,
    'sessionId','c5800000-0000-4000-8000-000000000001',
    'authenticationStrength','single_factor','issuedAt',operation_at,
    'expiresAt',operation_at+interval '1 hour','accessVersion',resolved_version,
    'correlationId',p_correlation_id));
end $function$;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000101');
set local role vortex_request;
select is((select outcome||'|'||operation||'|'||revision
 from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000002',1)),
 'accepted|suspend_organization_account|2',
 'accounts.manage suspends an active local account');
reset role;
select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000102');
set local role vortex_request;
select is((select outcome||'|'||revision
 from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000002',1)),
 'replayed|2','exact account replay returns original evidence');
select throws_ok($$select * from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000002',2)$$,'V3001',
 'Administration duplicate conflicts','changed account duplicate conflicts');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000103');
set local role vortex_request;
select is((select outcome||'|'||revision from
 vortex_access.reactivate_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000002',
 '55800000-0000-4000-8000-000000000002',2)),
 'accepted|3','suspended account reactivation succeeds');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000104');
set local role vortex_request;
select is((select outcome||'|'||revision
 from vortex_access.close_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000003',
 '55800000-0000-4000-8000-000000000002',3)),
 'accepted|4','active account closure succeeds');
reset role;
select is((select count(*) from vortex_identity.organization_accounts
 where organization_account_id='55800000-0000-4000-8000-000000000002'),1::bigint,
 'closure preserves the local account instead of deleting it');

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000105');
set local role vortex_request;
select is((select outcome||'|'||revision
 from vortex_access.reactivate_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000004',
 '55800000-0000-4000-8000-000000000002',4)),
 'accepted|5','a closed account can be reactivated');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000106');
set local role vortex_request;
select throws_ok($$select * from vortex_access.close_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000005','55800000-0000-4000-8000-000000000001',1)$$,
 '23514','An adopted organization requires a permanent steward',
 'the guarded writer protects the final permanent steward');
reset role;
select is((select state||'|'||revision from vortex_identity.organization_accounts
 where organization_account_id='55800000-0000-4000-8000-000000000001'),
 'active|1','final-steward refusal rolls back the account write');

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000107');
create temporary table invitation_access_before on commit drop as
select current_version from vortex_access.organization_access_versions
where organization_id='25800000-0000-4000-8000-000000000001';
set local role vortex_request;
create temporary table first_invitation on commit drop as
select * from vortex_access.create_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000006','new@example.test',
 'sha256:'||pg_catalog.repeat('6',64),'2099-01-01T00:00:00Z'::timestamptz);
select is((select outcome from first_invitation),'accepted','no-intent invitation creation succeeds');
select ok((select pg_catalog.to_jsonb(first_invitation) ?& array[
 'outcome','operation','organization_id','invitation_id','revision','correlation_id',
 'accepted_at','access_version'] and not pg_catalog.to_jsonb(first_invitation) ?| array[
 'secret','invitation_secret','token_fingerprint'] from first_invitation),
 'actual request-role creation result is minimal and contains no secret or fingerprint');
reset role;
select is((select count(*) from vortex_access.organization_invitation_access_intents intent
 join first_invitation created using(invitation_id)),0::bigint,
 'administrative invitation creation creates no access intent');
select is((select current_version from vortex_access.organization_access_versions
 where organization_id='25800000-0000-4000-8000-000000000001'),
 (select current_version from invitation_access_before),
 'invitation creation does not increment Access');

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000108');
set local role vortex_request;
select is((select outcome||'|'||invitation_id from
 vortex_access.create_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000006','new@example.test',
 'sha256:'||pg_catalog.repeat('9',64),'2099-01-01T00:00:00Z'::timestamptz)),
 'replayed|'||(select invitation_id::text from first_invitation),
 'creation replay returns the original target and ignores a fresh unrecoverable secret');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000109');
set local role vortex_request;
select is((select outcome||'|'||revision from
 vortex_access.revoke_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000007',
 (select invitation_id from first_invitation),1)),
 'accepted|2','pending invitation revocation succeeds');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000110');
set local role vortex_request;
select is((select outcome from
 vortex_access.revoke_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000008',
 '35800000-0000-4000-8000-000000000001',1)),
 'accepted','an expired pending invitation can be revoked');
select throws_ok($$select * from vortex_access.revoke_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000009','35800000-0000-4000-8000-000000000002',2)$$,
 '40001','Invitation is stale or unavailable','an accepted invitation cannot be revoked');
select throws_ok($$select * from vortex_access.revoke_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000010','35800000-0000-4000-8000-000000000003',2)$$,
 '40001','Invitation is stale or unavailable','an already revoked invitation cannot be revoked');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000004',
 '55800000-0000-4000-8000-000000000004','a5800000-0000-4000-8000-000000000111');
set local role vortex_request;
select throws_ok($$select * from vortex_access.create_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000011','cross@example.test',
 'sha256:'||pg_catalog.repeat('a',64),pg_catalog.clock_timestamp()+interval '1 day')$$,
 '42501','Organization invitation administration change is unavailable',
 'accounts.manage cannot substitute for invitations.manage');
reset role;
select pg_temp.install_context('45800000-0000-4000-8000-000000000005',
 '55800000-0000-4000-8000-000000000005','a5800000-0000-4000-8000-000000000112');
set local role vortex_request;
select throws_ok($$select * from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000012','55800000-0000-4000-8000-000000000002',5)$$,
 '42501','Organization account administration change is unavailable',
 'invitations.manage cannot substitute for accounts.manage');
reset role;
select pg_temp.install_context('45800000-0000-4000-8000-000000000003',
 '55800000-0000-4000-8000-000000000003','a5800000-0000-4000-8000-000000000113');
set local role vortex_request;
select throws_ok($$select * from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000013','55800000-0000-4000-8000-000000000002',5)$$,
 '42501','Organization account administration change is unavailable',
 'membership and tenant administration do not substitute for local permission');
reset role;

select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000114');
set local role vortex_request;
select throws_ok($$select * from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000015','55800000-0000-4000-8000-000000000099',1)$$,
 '40001','Account suspension is stale or unavailable',
 'missing account target is safely unavailable to the authorised caller');
select throws_ok($$select * from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000016','55800000-0000-4000-8000-000000000006',1)$$,
 '40001','Account suspension is stale or unavailable',
 'foreign account target is safely unavailable to the authorised caller');
select throws_ok($$select * from vortex_access.revoke_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000017','35800000-0000-4000-8000-000000000099',1)$$,
 '40001','Invitation is stale or unavailable',
 'missing invitation target is safely unavailable to the authorised caller');
select throws_ok($$select * from vortex_access.revoke_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000018','35800000-0000-4000-8000-000000000004',1)$$,
 '40001','Invitation is stale or unavailable',
 'foreign invitation target is safely unavailable to the authorised caller');
reset role;
select is((select state||'|'||revision from vortex_identity.organization_accounts
 where organization_account_id='55800000-0000-4000-8000-000000000006'),
 'active|1','foreign account refusal leaves its target unchanged');
select ok((select revoked_at is null and revision=1 from vortex_identity.organization_invitations
 where invitation_id='35800000-0000-4000-8000-000000000004'),
 'foreign invitation refusal leaves its target unchanged');

select pg_temp.install_context('45800000-0000-4000-8000-000000000004',
 '55800000-0000-4000-8000-000000000004','a5800000-0000-4000-8000-000000000115');
set local role vortex_request;
select is((select outcome||'|'||revision from
 vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000019',
 '55800000-0000-4000-8000-000000000002',5)),
 'accepted|6','the original accounts.manage caller receives a receipt');
reset role;
select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000116');
set local role vortex_request;
select is((select outcome||'|'||revision from
 vortex_access.reactivate_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000020',
 '55800000-0000-4000-8000-000000000002',6)),
 'accepted|7','a later target change succeeds after the recorded account command');
reset role;
create temporary table replay_after_change_access_before on commit drop as
select current_version from vortex_access.organization_access_versions
where organization_id='25800000-0000-4000-8000-000000000001';
select pg_temp.install_context('45800000-0000-4000-8000-000000000004',
 '55800000-0000-4000-8000-000000000004','a5800000-0000-4000-8000-000000000117');
set local role vortex_request;
select is((select outcome||'|'||revision from
 vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000019',
 '55800000-0000-4000-8000-000000000002',5)),
 'replayed|6','accepted receipt replays after a later target change');
reset role;
select is((select state||'|'||revision from vortex_identity.organization_accounts
 where organization_account_id='55800000-0000-4000-8000-000000000002'),
 'active|7','later-state replay creates no new account effect');
select is((select current_version from vortex_access.organization_access_versions
 where organization_id='25800000-0000-4000-8000-000000000001'),
 (select current_version from replay_after_change_access_before),
 'later-state replay creates no new Access effect');
create temporary table accounts_authority_revocation on commit drop as
select * from vortex_access.coordinate_organization_role_assignment_change(
 'revoke','25800000-0000-4000-8000-000000000001',
 '75800000-0000-4000-8000-000000000004',1,
 null,null,null,null,null,null,null,null,
 '55800000-0000-4000-8000-000000000001',
 'a5800000-0000-4000-8000-000000000121');
select is((select state||'|'||revision from accounts_authority_revocation),
 'revoked|2','the original caller loses its accounts.manage authority');
select pg_temp.install_context('45800000-0000-4000-8000-000000000004',
 '55800000-0000-4000-8000-000000000004','a5800000-0000-4000-8000-000000000118');
set local role vortex_request;
select throws_ok($$select * from vortex_access.suspend_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000019',
 '55800000-0000-4000-8000-000000000002',5)$$,
 '42501','Organization account administration change is unavailable',
 'a caller who lost authority cannot replay the original receipt');
reset role;
select is((select state||'|'||revision from vortex_identity.organization_accounts
 where organization_account_id='55800000-0000-4000-8000-000000000002'),
 'active|7','authority-loss refusal creates no new account effect');
select is((select count(*) from vortex_identity.accepted_administration_receipts
 where duplicate_key='d5800000-0000-4000-8000-000000000019'),1::bigint,
 'authority-loss refusal creates no second receipt');

create function pg_temp.refuse_receipt() returns trigger language plpgsql
 set search_path='' as $function$ begin
   if new.duplicate_key in ('d5800000-0000-4000-8000-000000000014',
                            'd5800000-0000-4000-8000-000000000021') then
     raise exception 'forced receipt refusal';
   end if; return new;
 end $function$;
create trigger refuse_slice_six_receipt before insert
on vortex_identity.accepted_administration_receipts for each row
execute function pg_temp.refuse_receipt();
select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000119');
set local role vortex_request;
select throws_ok($$select * from vortex_access.close_organization_account_for_administration(
 'd5800000-0000-4000-8000-000000000014','55800000-0000-4000-8000-000000000002',7)$$,
 'P0001','forced receipt refusal','receipt failure rolls back the owned account mutation');
reset role;
create temporary table invitation_failure_access_before on commit drop as
select current_version from vortex_access.organization_access_versions
where organization_id='25800000-0000-4000-8000-000000000001';
select pg_temp.install_context('45800000-0000-4000-8000-000000000001',
 '55800000-0000-4000-8000-000000000001','a5800000-0000-4000-8000-000000000120');
set local role vortex_request;
select throws_ok($$select * from vortex_access.create_organization_invitation_for_administration(
 'd5800000-0000-4000-8000-000000000021','receipt-failure@example.test',
 'sha256:'||pg_catalog.repeat('b',64),pg_catalog.clock_timestamp()+interval '1 day')$$,
 'P0001','forced receipt refusal','receipt failure rolls back the invitation writer');
reset role;
drop trigger refuse_slice_six_receipt on vortex_identity.accepted_administration_receipts;
select is((select state||'|'||revision from vortex_identity.organization_accounts
 where organization_account_id='55800000-0000-4000-8000-000000000002'),
 'active|7','receipt rollback leaves the target unchanged');
select is((select count(*) from vortex_identity.accepted_administration_receipts
 where duplicate_key='d5800000-0000-4000-8000-000000000014'),0::bigint,
 'receipt rollback stores no accepted evidence');
select is((select count(*) from vortex_identity.organization_invitations
 where invited_email='receipt-failure@example.test'),0::bigint,
 'invitation receipt rollback leaves no invitation mutation');
select is((select count(*) from vortex_identity.accepted_administration_receipts
 where duplicate_key='d5800000-0000-4000-8000-000000000021'),0::bigint,
 'invitation receipt rollback stores no accepted evidence');
select is((select current_version from vortex_access.organization_access_versions
 where organization_id='25800000-0000-4000-8000-000000000001'),
 (select current_version from invitation_failure_access_before),
 'invitation receipt rollback preserves Access');

select is((select count(*) from vortex_identity.accepted_administration_receipts
 where tenant_id='15800000-0000-4000-8000-000000000001'
 and operation_key in ('suspend_organization_account','reactivate_organization_account',
 'close_organization_account','create_organization_invitation',
 'revoke_organization_invitation')),9::bigint,
 'each successful first mutation stores one receipt and replay stores none');

select * from finish();
rollback;
