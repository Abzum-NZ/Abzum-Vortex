\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  'the restricted runtime may invoke the exact suspend command'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.reactivate_cluster_identity(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  'the restricted runtime may invoke the exact reactivate command'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.close_cluster_identity(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  'the restricted runtime may invoke the exact close command'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  'the shared implementation remains private from the runtime'
);
select ok(
  not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.suspend_cluster_identity(uuid,uuid,uuid,text,uuid,bigint)',
    'EXECUTE'
  ),
  candidate.role_name || ' cannot directly invoke configured identity lifecycle'
)
from (values ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_request'::name)) as candidate(role_name);

create temporary table lifecycle_scope on commit drop as
select * from vortex_identity.provision_tenant(
  'c5500000-0000-4000-8000-000000000001',
  '95500000-0000-4000-8000-000000000001',
  'd5500000-0000-4000-8000-000000000001',
  'sha256:' || pg_catalog.repeat('1', 64),
  'identity_lifecycle', 'Identity lifecycle', 'lifecycle_root', 'Lifecycle root',
  '45500000-0000-4000-8000-000000000001',
  '45500000-0000-4000-8000-000000000002',
  'Organisation steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

create temporary table lifecycle_scope_two on commit drop as
select * from vortex_identity.provision_tenant(
  'c5500000-0000-4000-8000-000000000001',
  '95500000-0000-4000-8000-000000000001',
  'd5500000-0000-4000-8000-000000000002',
  'sha256:' || pg_catalog.repeat('2', 64),
  'identity_lifecycle_two', 'Identity lifecycle two', 'lifecycle_root_two',
  'Lifecycle root two',
  '45500000-0000-4000-8000-000000000005',
  '45500000-0000-4000-8000-000000000002',
  'Organisation steward', 'en-NZ', 'Pacific/Auckland',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('45500000-0000-4000-8000-000000000003', 'active', now(), now(),
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000003', 1),
  ('45500000-0000-4000-8000-000000000004', 'active', now(), now(),
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000004', 1),
  ('45500000-0000-4000-8000-000000000006', 'active', now(), now(),
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000006', 9007199254740991);

create temporary table first_suspend on commit drop as
select * from vortex_identity.suspend_cluster_identity(
  'c5500000-0000-4000-8000-000000000001',
  '95500000-0000-4000-8000-000000000001',
  'd5500000-0000-4000-8000-000000000010',
  'sha256:' || pg_catalog.repeat('a', 64),
  '45500000-0000-4000-8000-000000000003', 1
);
select is((select outcome || '|' || revision from first_suspend), 'accepted|2',
  'an unscoped active projection can be suspended once');
select is(
  (select state || '|' || revision from vortex_identity.identity_projections
    where identity_id = '45500000-0000-4000-8000-000000000003'),
  'suspended|2',
  'suspension changes only the target lifecycle facts and revision'
);

create temporary table reactivated on commit drop as
select * from vortex_identity.reactivate_cluster_identity(
  'c5500000-0000-4000-8000-000000000001',
  '95500000-0000-4000-8000-000000000001',
  'd5500000-0000-4000-8000-000000000011',
  'sha256:' || pg_catalog.repeat('b', 64),
  '45500000-0000-4000-8000-000000000003', 2
);
select is((select outcome || '|' || revision from reactivated), 'accepted|3',
  'a suspended projection can be reactivated');

create temporary table replayed_suspend on commit drop as
select * from vortex_identity.suspend_cluster_identity(
  'c5500000-0000-4000-8000-000000000001',
  '95500000-0000-4000-8000-000000000001',
  'd5500000-0000-4000-8000-000000000010',
  'sha256:' || pg_catalog.repeat('a', 64),
  '45500000-0000-4000-8000-000000000003', 1
);
select is((select outcome || '|' || revision from replayed_suspend), 'replayed|2',
  'an exact replay returns its original accepted revision');
select is(
  (select state || '|' || revision from vortex_identity.identity_projections
    where identity_id = '45500000-0000-4000-8000-000000000003'),
  'active|3',
  'an old replay never restores its historical state'
);
select throws_ok(
  $$select * from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000010',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '45500000-0000-4000-8000-000000000003', 1
  )$$,
  'V3001'::char(5), 'Administration duplicate conflicts',
  'a changed command cannot reuse an accepted duplicate key'
);

create temporary table closed_projection on commit drop as
select * from vortex_identity.close_cluster_identity(
  'c5500000-0000-4000-8000-000000000001',
  '95500000-0000-4000-8000-000000000001',
  'd5500000-0000-4000-8000-000000000012',
  'sha256:' || pg_catalog.repeat('d', 64),
  '45500000-0000-4000-8000-000000000003', 3
);
select is((select outcome || '|' || revision from closed_projection), 'accepted|4',
  'an active projection can be closed terminally');
select throws_ok(
  $$select * from vortex_identity.reactivate_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000013',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '45500000-0000-4000-8000-000000000003', 4
  )$$,
  'V3003'::char(5), 'Administration scope is unavailable',
  'a closed projection cannot be reactivated'
);
select throws_ok(
  $$select * from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000014',
    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '45500000-0000-4000-8000-000000000004', 2
  )$$,
  'V3102'::char(5), 'Identity projection revision is stale',
  'a stale expected revision refuses without mutation'
);
select throws_ok(
  $$select * from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000015',
    'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '45500000-0000-4000-8000-000000000006', 9007199254740991
  )$$,
  'V3102'::char(5), 'Identity projection revision is stale',
  'an exhausted projection revision refuses safely'
);

-- Scheduled, expired, revoked and time-limited assignments exist but cannot
-- replace the provisioned permanent tenant manager.
insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id, revoked_at, revoked_by_actor_id,
  revocation_correlation_id
) values
  ('35500000-0000-4000-8000-000000000001', (select tenant_id from lifecycle_scope),
    '45500000-0000-4000-8000-000000000004',
    array['platform.tenant.administrators.manage'], now() + interval '1 day', null,
    1, now(), '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000011', now(),
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000011', null, null, null),
  ('35500000-0000-4000-8000-000000000002', (select tenant_id from lifecycle_scope),
    '45500000-0000-4000-8000-000000000004',
    array['platform.tenant.administrators.manage'], now() - interval '2 days',
    now() - interval '1 day', 1, now() - interval '2 days',
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000012', now() - interval '2 days',
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000012', null, null, null),
  ('35500000-0000-4000-8000-000000000003', (select tenant_id from lifecycle_scope),
    '45500000-0000-4000-8000-000000000004',
    array['platform.tenant.administrators.manage'], now() - interval '2 days', null,
    1, now() - interval '2 days', '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000013', now() - interval '1 day',
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000014', now() - interval '1 day',
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000014'),
  ('35500000-0000-4000-8000-000000000004', (select tenant_id from lifecycle_scope),
    '45500000-0000-4000-8000-000000000004',
    array['platform.tenant.administrators.manage'], now() - interval '1 day',
    now() + interval '1 day', 1, now() - interval '1 day',
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000015', now() - interval '1 day',
    '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000015', null, null, null);

-- A future-skewed audit timestamp remains compatible with the projection
-- trigger, but must never advance the authority eligibility clock. The only
-- candidate replacement starts one day from now and is therefore ineligible.
update vortex_identity.identity_projections
set state_changed_at = now() + interval '2 days',
  revision = 2
where identity_id = '45500000-0000-4000-8000-000000000001';

select throws_ok(
  $$select * from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000020',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    '45500000-0000-4000-8000-000000000001', 2
  )$$,
  'V3002'::char(5), 'Permanent tenant manager is required',
  'non-permanent tenant assignments cannot replace the final manager'
);
select is(
  (select state || '|' || revision from vortex_identity.identity_projections
    where identity_id = '45500000-0000-4000-8000-000000000001'),
  'active|2',
  'a failed multi-scope lifecycle command rolls the projection back'
);
select is(
  (select pg_catalog.count(*)
    from vortex_identity.accepted_administration_receipts
    where actor_id = '95500000-0000-4000-8000-000000000001'
      and cluster_id = 'c5500000-0000-4000-8000-000000000001'
      and operation_key = 'suspend_cluster_identity'
      and duplicate_key = 'd5500000-0000-4000-8000-000000000020'),
  0::bigint,
  'future audit time cannot accept a scheduled replacement or write a receipt'
);

insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id
) values (
  '35500000-0000-4000-8000-000000000005', (select tenant_id from lifecycle_scope),
  '45500000-0000-4000-8000-000000000004',
  array['platform.tenant.administrators.manage'], now() - interval '1 day', null,
  1, now() - interval '1 day', '95500000-0000-4000-8000-000000000001',
  'a5500000-0000-4000-8000-000000000016', now() - interval '1 day',
  '95500000-0000-4000-8000-000000000001',
  'a5500000-0000-4000-8000-000000000016'
);
select is(
  (select outcome from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000021',
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    '45500000-0000-4000-8000-000000000001', 2
  )),
  'accepted',
  'a qualifying permanent replacement permits the tenant manager transition'
);

select throws_ok(
  $$select * from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000022',
    'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    '45500000-0000-4000-8000-000000000002', 1
  )$$,
  'V3002'::char(5), 'Permanent organisation steward is required',
  'a multi-tenant final steward cannot be suspended from either adopted organisation'
);
select is(
  (select state || '|' || revision from vortex_identity.identity_projections
    where identity_id = '45500000-0000-4000-8000-000000000002'),
  'active|1',
  'failure in any affected organisation rolls the multi-scope transition back entirely'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '45500000-0000-4000-8000-000000000007', 'active', now(), now(),
  '95500000-0000-4000-8000-000000000001',
  'a5500000-0000-4000-8000-000000000020', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('65500000-0000-4000-8000-000000000001',
    (select root_organization_id from lifecycle_scope),
    '45500000-0000-4000-8000-000000000007', 'Replacement steward', 'active',
    now(), now(), now(), '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000021', 1),
  ('65500000-0000-4000-8000-000000000002',
    (select root_organization_id from lifecycle_scope_two),
    '45500000-0000-4000-8000-000000000007', 'Replacement steward', 'active',
    now(), now(), now(), '95500000-0000-4000-8000-000000000001',
    'a5500000-0000-4000-8000-000000000022', 1);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision, starts_at,
  expires_at, state, granted_by, granted_at, grant_correlation_id, changed_by,
  changed_at, change_correlation_id
)
select requirement.organization_id,
  case when requirement.organization_id = (select root_organization_id from lifecycle_scope)
    then '75500000-0000-4000-8000-000000000001'::uuid
    else '75500000-0000-4000-8000-000000000002'::uuid end,
  requirement.original_role_id, 'organization_account',
  case when requirement.organization_id = (select root_organization_id from lifecycle_scope)
    then '65500000-0000-4000-8000-000000000001'::uuid
    else '65500000-0000-4000-8000-000000000002'::uuid end,
  null, 'standing', 1, now(), null, 'live',
  '95500000-0000-4000-8000-000000000001', now(),
  'a5500000-0000-4000-8000-000000000023',
  '95500000-0000-4000-8000-000000000001', now(),
  'a5500000-0000-4000-8000-000000000023'
from vortex_access.organization_stewardship_requirements as requirement
where requirement.organization_id in (
  (select root_organization_id from lifecycle_scope),
  (select root_organization_id from lifecycle_scope_two)
);
insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
  granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
)
select requirement.organization_id,
  case when requirement.organization_id = (select root_organization_id from lifecycle_scope)
    then '85500000-0000-4000-8000-000000000001'::uuid
    else '85500000-0000-4000-8000-000000000002'::uuid end,
  'organization_account',
  case when requirement.organization_id = (select root_organization_id from lifecycle_scope)
    then '65500000-0000-4000-8000-000000000001'::uuid
    else '65500000-0000-4000-8000-000000000002'::uuid end,
  null, 'organization_catalogue', null, null, 1, now(), null, 'live',
  '95500000-0000-4000-8000-000000000001', now(),
  'a5500000-0000-4000-8000-000000000024',
  '95500000-0000-4000-8000-000000000001', now(),
  'a5500000-0000-4000-8000-000000000024'
from vortex_access.organization_stewardship_requirements as requirement
where requirement.organization_id in (
  (select root_organization_id from lifecycle_scope),
  (select root_organization_id from lifecycle_scope_two)
);
select is(
  (select outcome from vortex_identity.suspend_cluster_identity(
    'c5500000-0000-4000-8000-000000000001',
    '95500000-0000-4000-8000-000000000001',
    'd5500000-0000-4000-8000-000000000023',
    'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    '45500000-0000-4000-8000-000000000002', 1
  )),
  'accepted',
  'qualifying permanent replacements in every affected organisation permit the transition'
);
select is(
  (select current_version::text from vortex_access.organization_access_versions
    where organization_id = (select root_organization_id from lifecycle_scope)),
  '3',
  'projection lifecycle never changes the organisation Access version'
);
select is(
  (select pg_catalog.count(*) from vortex_identity.accepted_administration_receipts
    where cluster_id = 'c5500000-0000-4000-8000-000000000001'
      and operation_key in ('suspend_cluster_identity',
        'reactivate_cluster_identity', 'close_cluster_identity')),
  5::bigint,
  'only the five accepted lifecycle transitions wrote receipts'
);

select * from finish();
rollback;
