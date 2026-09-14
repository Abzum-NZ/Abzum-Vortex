\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

create function pg_temp.install_private_grant_context(
  p_identity_id uuid, p_account_id uuid, p_correlation_id uuid
) returns void language plpgsql volatile set search_path = '' as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24150000-0000-4000-8000-000000000001';
  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '84150000-0000-4000-8000-000000000001',
    'tenantId', '14150000-0000-4000-8000-000000000001',
    'organizationId', '24150000-0000-4000-8000-000000000001',
    'organizationAccountId', p_account_id,
    'identityId', p_identity_id,
    'sessionId', '64150000-0000-4000-8000-000000000001',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at, 'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version, 'correlationId', p_correlation_id
  ));
end
$function$;

select has_function(
  'vortex_access', 'coordinate_private_organization_group_membership_change',
  array['text','uuid','bigint','uuid','uuid','timestamptz','timestamptz','uuid','text','uuid'],
  'private membership composition exists'
);
select has_function(
  'vortex_access', 'coordinate_private_organization_role_assignment_grant',
  array['uuid','uuid','bigint','text','uuid','uuid','text','timestamptz','timestamptz','text','uuid'],
  'private assignment-grant composition exists'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_private_organization_group_membership_change(text,uuid,bigint,uuid,uuid,timestamptz,timestamptz,uuid,text,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_private_organization_role_assignment_grant(uuid,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,text,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot invoke private grant composition'
)
from (values ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')) as caller(role_name)
order by caller.role_name collate "C";

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok($test$
  select * from vortex_access.coordinate_private_organization_group_membership_change(
    'add_membership','7a150000-0000-4000-8000-000000000099',null,
    '78150000-0000-4000-8000-000000000099',
    '54150000-0000-4000-8000-000000000099',pg_catalog.clock_timestamp(),
    null,null,'workflow','aa150000-0000-4000-8000-000000000099')
$test$,'42501'::char(5),
  'permission denied for function coordinate_private_organization_group_membership_change',
  'request role is directly refused by private membership composition');
select throws_ok($test$
  select * from vortex_access.coordinate_private_organization_role_assignment_grant(
    '7b150000-0000-4000-8000-000000000099',
    '74150000-0000-4000-8000-000000000099',1,'organization_account',
    '54150000-0000-4000-8000-000000000099',null,'standing',
    pg_catalog.clock_timestamp(),null,'workflow',
    'ab150000-0000-4000-8000-000000000099')
$test$,'42501'::char(5),
  'permission denied for function coordinate_private_organization_role_assignment_grant',
  'request role is directly refused by private assignment composition');
reset role;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14150000-0000-4000-8000-000000000001', 'private_grant',
  'Private grant', 'active', pg_catalog.clock_timestamp(),
  '94150000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
('24150000-0000-4000-8000-000000000001','14150000-0000-4000-8000-000000000001',
 'private_grant','Private grant','active',pg_catalog.clock_timestamp(),
 '94150000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp(),1),
('24150000-0000-4000-8000-000000000002','14150000-0000-4000-8000-000000000001',
 'private_foreign','Private foreign','active',pg_catalog.clock_timestamp(),
 '94150000-0000-4000-8000-000000000001',pg_catalog.clock_timestamp(),1);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
('44150000-0000-4000-8000-000000000001','active',pg_catalog.clock_timestamp(),
 pg_catalog.clock_timestamp(),'94150000-0000-4000-8000-000000000001',
 'a4150000-0000-4000-8000-000000000001',1),
('44150000-0000-4000-8000-000000000002','active',pg_catalog.clock_timestamp(),
 pg_catalog.clock_timestamp(),'94150000-0000-4000-8000-000000000001',
 'a4150000-0000-4000-8000-000000000002',1),
('44150000-0000-4000-8000-000000000003','active',pg_catalog.clock_timestamp(),
 pg_catalog.clock_timestamp(),'94150000-0000-4000-8000-000000000001',
 'a4150000-0000-4000-8000-000000000003',1);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
('54150000-0000-4000-8000-000000000001','24150000-0000-4000-8000-000000000001',
 '44150000-0000-4000-8000-000000000001','Administrator','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '94150000-0000-4000-8000-000000000001','a4150000-0000-4000-8000-000000000004',1),
('54150000-0000-4000-8000-000000000002','24150000-0000-4000-8000-000000000001',
 '44150000-0000-4000-8000-000000000002','Beneficiary','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '94150000-0000-4000-8000-000000000001','a4150000-0000-4000-8000-000000000005',1),
('54150000-0000-4000-8000-000000000003','24150000-0000-4000-8000-000000000001',
 '44150000-0000-4000-8000-000000000003','No authority','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '94150000-0000-4000-8000-000000000001','a4150000-0000-4000-8000-000000000006',1);

select * from vortex_access.initialize_organization_access_version(
  '24150000-0000-4000-8000-000000000001','94150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000007');
select * from vortex_access.initialize_platform_permission_catalogue(
  '24150000-0000-4000-8000-000000000001','94150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000008');
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, entry.application_root_id, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, 'available', 1, entry.meaning_fingerprint,
  entry.registration_revision, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24150000-0000-4000-8000-000000000001';

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '24150000-0000-4000-8000-000000000001','54150000-0000-4000-8000-000000000001',
  '74150000-0000-4000-8000-000000000001','private_grant_steward','Private grant steward',
  'Permanent steward for private composition proof.',
  '75150000-0000-4000-8000-000000000001','76150000-0000-4000-8000-000000000001',
  '94150000-0000-4000-8000-000000000001','a4150000-0000-4000-8000-000000000009'
);
select * from vortex_access.coordinate_organization_group_change(
  'create_group','24150000-0000-4000-8000-000000000001',
  '78150000-0000-4000-8000-000000000001',null,'private_grant_group',
  'Private grant group','54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000010'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant','24150000-0000-4000-8000-000000000001',
  '79150000-0000-4000-8000-000000000001',null,
  '74150000-0000-4000-8000-000000000001',1,'group',null,
  '78150000-0000-4000-8000-000000000001','standing',
  pg_catalog.clock_timestamp() - interval '1 minute',null,
  '54150000-0000-4000-8000-000000000001','a4150000-0000-4000-8000-000000000011'
);

select pg_temp.install_private_grant_context(
  '44150000-0000-4000-8000-000000000001',
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000012');

select lives_ok($test$
  select * from vortex_access.coordinate_private_organization_group_membership_change(
    'add_membership','7a150000-0000-4000-8000-000000000001',null,
    '78150000-0000-4000-8000-000000000001',
    '54150000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() - interval '1 minute',null,null,
    'workflow','aa150000-0000-4000-8000-000000000001')
$test$, 'catalogue-delegated administrator adds a membership with Group authority');
select is((select state from vortex_access.organization_group_memberships
  where membership_id='7a150000-0000-4000-8000-000000000001'),'live',
  'membership change is stored');
select is((select count(*)::bigint from vortex_activity.organization_activity_entries
  where activity_id='aa150000-0000-4000-8000-000000000001'),1::bigint,
  'membership composition appends exactly one Activity entry');

select pg_temp.install_private_grant_context(
  '44150000-0000-4000-8000-000000000001',
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000013');
select lives_ok($test$
  select * from vortex_access.coordinate_private_organization_role_assignment_grant(
    '7b150000-0000-4000-8000-000000000001',
    '74150000-0000-4000-8000-000000000001',1,'organization_account',
    '54150000-0000-4000-8000-000000000002',null,'standing',
    pg_catalog.clock_timestamp() - interval '1 minute',null,
    'interface','ab150000-0000-4000-8000-000000000001')
$test$, 'catalogue-delegated administrator grants the exact current role scope');
select is((select count(*)::bigint from vortex_access.organization_role_assignments
  where role_assignment_id='7b150000-0000-4000-8000-000000000001'),1::bigint,
  'assignment grant is stored once');
select is((select count(*)::bigint from vortex_activity.organization_activity_entries
  where activity_id='ab150000-0000-4000-8000-000000000001'),1::bigint,
  'assignment composition appends exactly one Activity entry');
select is((select source from vortex_activity.organization_activity_entries
  where activity_id='ab150000-0000-4000-8000-000000000001'),'interface',
  'assignment composition preserves its trusted non-web Activity source');

select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership','24150000-0000-4000-8000-000000000001',
  '7a150000-0000-4000-8000-000000000001',1,null,null,null,null,null,
  '54150000-0000-4000-8000-000000000001','a4150000-0000-4000-8000-000000000016'
);
select pg_temp.install_private_grant_context(
  '44150000-0000-4000-8000-000000000001',
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000017');
select lives_ok($test$
  select * from vortex_access.coordinate_private_organization_group_membership_change(
    'restore_membership','7a150000-0000-4000-8000-000000000001',2,
    null,null,null,null,null,'workflow',
    'aa150000-0000-4000-8000-000000000003')
$test$, 'private composition restores a revoked membership under current Group scope');
select is((select revision from vortex_access.organization_group_memberships
  where membership_id='7a150000-0000-4000-8000-000000000001'),3::bigint,
  'restoration preserves the existing membership identity and revision contract');

select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership','24150000-0000-4000-8000-000000000001',
  '7a150000-0000-4000-8000-000000000002',null,
  '78150000-0000-4000-8000-000000000001',
  '54150000-0000-4000-8000-000000000003',
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.clock_timestamp() + interval '100 milliseconds',null,
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000018'
);
select pg_catalog.pg_sleep(0.2);
select pg_temp.install_private_grant_context(
  '44150000-0000-4000-8000-000000000001',
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000019');
select lives_ok($test$
  select * from vortex_access.coordinate_private_organization_group_membership_change(
    'renew_membership','7a150000-0000-4000-8000-000000000002',1,
    null,null,pg_catalog.clock_timestamp() - interval '1 minute',null,
    '7a150000-0000-4000-8000-000000000003','workflow',
    'aa150000-0000-4000-8000-000000000004')
$test$, 'private composition renews an expired membership under current Group scope');
select is((select state from vortex_access.organization_group_memberships
  where membership_id='7a150000-0000-4000-8000-000000000002'),'revoked',
  'renewal closes the exact predecessor');
select is((select state from vortex_access.organization_group_memberships
  where membership_id='7a150000-0000-4000-8000-000000000003'),'live',
  'renewal creates the distinct successor');

-- This actor has the fixed assignments.manage permission but only a bounded
-- delegation for that one permission. It cannot grant the steward Role's
-- larger exact current scope.
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant','24150000-0000-4000-8000-000000000001',
  '79150000-0000-4000-8000-000000000002',null,
  '74150000-0000-4000-8000-000000000001',1,'organization_account',
  '54150000-0000-4000-8000-000000000003',null,'standing',
  pg_catalog.clock_timestamp() - interval '1 minute',null,
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000021'
);
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','24150000-0000-4000-8000-000000000001',
  '76150000-0000-4000-8000-000000000002',null,'organization_account',
  '54150000-0000-4000-8000-000000000003',null,'bounded',
  (select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'kind','exact','ownerKind',permission.owner_kind,
    'ownerId',permission.owner_id,'permissionId',permission.permission_id,
    'acceptedRegistrationRevision',permission.accepted_registration_revision,
    'catalogueFingerprint',permission.catalogue_fingerprint,
    'continuityRevision',permission.continuity_revision,
    'meaningFingerprint',permission.meaning_fingerprint
  ))
  from vortex_access.organization_role_permission_entries as permission
  where permission.organization_id='24150000-0000-4000-8000-000000000001'
    and permission.role_id='74150000-0000-4000-8000-000000000001'
    and permission.role_revision=1
    and permission.permission_id='156d01f3-8f80-45fb-8fc8-b31c47dbb1df'),
  'sha256:' || pg_catalog.repeat('e',64),
  pg_catalog.clock_timestamp() - interval '1 minute',null,
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000022'
);

select pg_temp.install_private_grant_context(
  '44150000-0000-4000-8000-000000000003',
  '54150000-0000-4000-8000-000000000003',
  'a4150000-0000-4000-8000-000000000014');
select throws_ok($test$
  select * from vortex_access.coordinate_private_organization_role_assignment_grant(
    '7b150000-0000-4000-8000-000000000002',
    '74150000-0000-4000-8000-000000000001',1,'organization_account',
    '54150000-0000-4000-8000-000000000002',null,'standing',
    pg_catalog.clock_timestamp() - interval '1 minute',null,'workflow',
    'ab150000-0000-4000-8000-000000000002')
$test$,'42501','Private Organization role-assignment grant is unavailable',
  'fixed management with partial delegation cannot grant the larger role scope');
select is((select count(*)::bigint from vortex_access.organization_role_assignments
  where role_assignment_id='7b150000-0000-4000-8000-000000000002'),0::bigint,
  'refused assignment leaves no mutation');
select is((select count(*)::bigint from vortex_activity.organization_activity_entries
  where activity_id='ab150000-0000-4000-8000-000000000002'),0::bigint,
  'refused assignment leaves no Activity');

select pg_temp.install_private_grant_context(
  '44150000-0000-4000-8000-000000000001',
  '54150000-0000-4000-8000-000000000001',
  'a4150000-0000-4000-8000-000000000020');
select throws_ok($test$
  select * from vortex_access.coordinate_private_organization_group_membership_change(
    'restore_membership','7a150000-0000-4000-8000-000000000001',99,
    null,null,null,null,null,'workflow',
    'aa150000-0000-4000-8000-000000000002')
$test$,'40001','Private Organization Group membership change is stale or unavailable',
  'stale membership evidence is refused before effects');
select throws_ok($test$
  select * from vortex_access.coordinate_private_organization_role_assignment_grant(
    '7b150000-0000-4000-8000-000000000003',
    '74150000-0000-4000-8000-000000000001',99,'organization_account',
    '54150000-0000-4000-8000-000000000002',null,'standing',
    pg_catalog.clock_timestamp(),null,'workflow',
    'ab150000-0000-4000-8000-000000000003')
$test$,'40001','Private Organization role-assignment grant is stale or unavailable',
  'stale role source is refused before effects');

create temporary table private_grant_version_before on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '24150000-0000-4000-8000-000000000001';
select throws_ok($test$
  select * from vortex_access.coordinate_private_organization_role_assignment_grant(
    '7b150000-0000-4000-8000-000000000004',
    '74150000-0000-4000-8000-000000000001',1,'organization_account',
    '54150000-0000-4000-8000-000000000002',null,'standing',
    pg_catalog.clock_timestamp(),null,'workflow',
    'aa150000-0000-4000-8000-000000000001')
$test$,'22023','Activity identity already records different evidence',
  'Activity identity collision rolls back the composed assignment grant');
select is((select count(*)::bigint from vortex_access.organization_role_assignments
  where role_assignment_id='7b150000-0000-4000-8000-000000000004'),0::bigint,
  'Activity collision leaves no assignment');
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id='24150000-0000-4000-8000-000000000001'),
  (select current_version from private_grant_version_before),
  'Activity collision rolls back the Access version change');

select * from finish();
rollback;
