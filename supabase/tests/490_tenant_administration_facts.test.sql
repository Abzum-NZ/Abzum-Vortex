\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_identity', 'postgres', true, false
);

select has_table(
  'vortex_identity', 'tenant_administrator_assignments',
  'tenant structural-administrator assignments retain private current facts'
);
select has_table(
  'vortex_identity', 'accepted_administration_receipts',
  'accepted administration receipts retain only protected-operation evidence'
);
select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_identity.tenant_administrator_assignments'::regclass
  ) and (
    select relrowsecurity and relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_identity.accepted_administration_receipts'::regclass
  ),
  'both #30 fact tables are forced-RLS private storage'
);

select ok(
  not pg_catalog.has_table_privilege(
    candidate.role_name, 'vortex_identity.tenant_administrator_assignments',
    'SELECT,INSERT,UPDATE,DELETE'
  ) and not pg_catalog.has_table_privilege(
    candidate.role_name, 'vortex_identity.accepted_administration_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  candidate.role_name || ' has no raw tenant-administration fact-table access'
)
  from (values
    ('public'::name), ('anon'::name), ('authenticated'::name),
    ('service_role'::name), ('vortex_runtime'::name), ('vortex_request'::name)
  ) as candidate(role_name);
select ok(
  not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.tenant_structural_capability_set_is_canonical(text[])', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    candidate.role_name,
    'vortex_identity.subject_revisions_are_valid(uuid[],bigint[])', 'EXECUTE'
  ),
  candidate.role_name || ' cannot directly call a #30 storage invariant helper'
)
  from (values
    ('public'::name), ('anon'::name), ('authenticated'::name),
    ('service_role'::name), ('vortex_runtime'::name), ('vortex_request'::name)
  ) as candidate(role_name);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14900000-0000-4000-8000-000000000001', 'tenant_administration',
  'Tenant administration', 'active', '2026-09-13T00:00:00Z'::timestamptz,
  '94900000-0000-4000-8000-000000000001', '2026-09-13T00:00:00Z'::timestamptz, 1
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '44900000-0000-4000-8000-000000000001', 'active',
  '2026-09-13T00:00:00Z'::timestamptz, '2026-09-13T00:00:00Z'::timestamptz,
  '94900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id
) values (
  '34900000-0000-4000-8000-000000000001',
  '14900000-0000-4000-8000-000000000001',
  '44900000-0000-4000-8000-000000000001',
  array['platform.tenant.administrators.manage', 'platform.tenant.organizations.create'],
  '2026-09-13T00:00:00Z'::timestamptz, null, 1,
  '2026-09-12T00:00:00Z'::timestamptz,
  '94900000-0000-4000-8000-000000000001',
  'a4900000-0000-4000-8000-000000000002',
  '2026-09-12T00:00:00Z'::timestamptz,
  '94900000-0000-4000-8000-000000000001',
  'a4900000-0000-4000-8000-000000000002'
);
select is(
  (select pg_catalog.array_to_string(capability_keys, '|')
   from vortex_identity.tenant_administrator_assignments
   where assignment_id = '34900000-0000-4000-8000-000000000001'),
  'platform.tenant.administrators.manage|platform.tenant.organizations.create',
  'the private assignment retains only canonical structural capabilities'
);
select throws_ok(
  $$insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at, revision,
    granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
    changed_by_actor_id, change_correlation_id
  ) values (
    '34900000-0000-4000-8000-000000000002',
    '14900000-0000-4000-8000-000000000001',
    '44900000-0000-4000-8000-000000000001',
    array['platform.tenant.organizations.create', 'platform.tenant.administrators.manage'],
    '2026-09-13T00:00:00Z'::timestamptz, 1,
    '2026-09-12T00:00:00Z'::timestamptz,
    '94900000-0000-4000-8000-000000000001',
    'a4900000-0000-4000-8000-000000000002',
    '2026-09-12T00:00:00Z'::timestamptz,
    '94900000-0000-4000-8000-000000000001',
    'a4900000-0000-4000-8000-000000000002'
  )$$,
  '23514'::char(5), null::text,
  'the table rejects a noncanonical capability ordering'
);
select throws_ok(
  $$insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at, revision,
    granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
    changed_by_actor_id, change_correlation_id, revoked_at
  ) values (
    '34900000-0000-4000-8000-000000000003',
    '14900000-0000-4000-8000-000000000001',
    '44900000-0000-4000-8000-000000000001',
    array['platform.tenant.organizations.create'],
    '2026-09-13T00:00:00Z'::timestamptz, 1,
    '2026-09-12T00:00:00Z'::timestamptz,
    '94900000-0000-4000-8000-000000000001',
    'a4900000-0000-4000-8000-000000000002',
    '2026-09-12T00:00:00Z'::timestamptz,
    '94900000-0000-4000-8000-000000000001',
    'a4900000-0000-4000-8000-000000000002',
    '2026-09-14T00:00:00Z'::timestamptz
  )$$,
  '23514'::char(5), null::text,
  'the table rejects incomplete revocation evidence'
);

insert into vortex_identity.accepted_administration_receipts (
  receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
  command_fingerprint, subject_ids, subject_revisions, accepted_at
) values (
  '64900000-0000-4000-8000-000000000001',
  '94900000-0000-4000-8000-000000000001',
  '14900000-0000-4000-8000-000000000001',
  'platform.tenant.administrators.grant',
  'b4900000-0000-4000-8000-000000000001',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  array['34900000-0000-4000-8000-000000000001'::uuid], array[1::bigint],
  '2026-09-13T00:00:00Z'::timestamptz
);
select throws_ok(
  $$insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    '64900000-0000-4000-8000-000000000002',
    '94900000-0000-4000-8000-000000000001',
    '14900000-0000-4000-8000-000000000001',
    'platform.tenant.administrators.grant',
    'b4900000-0000-4000-8000-000000000001',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    array['34900000-0000-4000-8000-000000000001'::uuid], array[1::bigint],
    '2026-09-13T00:00:00Z'::timestamptz
  )$$,
  '23505'::char(5), null::text,
  'an exact administration replay key has one accepted receipt'
);
select throws_ok(
  $$insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    '64900000-0000-4000-8000-000000000004',
    '94900000-0000-4000-8000-000000000001',
    '14900000-0000-4000-8000-000000000001',
    'platform.tenant.administrators.grant',
    'b4900000-0000-4000-8000-000000000004',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    array['34900000-0000-4000-8000-000000000001'::uuid], array[null::bigint],
    '2026-09-13T00:00:00Z'::timestamptz
  )$$,
  '23514'::char(5), null::text,
  'a receipt rejects a null result revision'
);
insert into vortex_identity.accepted_administration_receipts (
  receipt_id, actor_id, cluster_id, operation_key, duplicate_key,
  command_fingerprint, subject_ids, subject_revisions, accepted_at
) values (
  '64900000-0000-4000-8000-000000000005',
  '94900000-0000-4000-8000-000000000001',
  'c4900000-0000-4000-8000-000000000005',
  'platform.cluster.identity.suspend',
  'b4900000-0000-4000-8000-000000000005',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  array['34900000-0000-4000-8000-000000000001'::uuid], array[1::bigint],
  '2026-09-13T00:00:00Z'::timestamptz
);
select throws_ok(
  $$insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, cluster_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    '64900000-0000-4000-8000-000000000006',
    '94900000-0000-4000-8000-000000000001',
    'c4900000-0000-4000-8000-000000000005',
    'platform.cluster.identity.suspend',
    'b4900000-0000-4000-8000-000000000005',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    array['34900000-0000-4000-8000-000000000001'::uuid], array[1::bigint],
    '2026-09-13T00:00:00Z'::timestamptz
  )$$,
  '23505'::char(5), null::text,
  'an exact cluster-scope replay key has one accepted receipt'
);
select throws_ok(
  $$insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, cluster_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    '64900000-0000-4000-8000-000000000003',
    '94900000-0000-4000-8000-000000000001',
    '14900000-0000-4000-8000-000000000001',
    'c4900000-0000-4000-8000-000000000001',
    'platform.tenant.administrators.grant',
    'b4900000-0000-4000-8000-000000000003',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    array['34900000-0000-4000-8000-000000000001'::uuid], array[1::bigint],
    '2026-09-13T00:00:00Z'::timestamptz
  )$$,
  '23514'::char(5), null::text,
  'a receipt has exactly one trusted tenant or cluster scope'
);

select * from finish();

rollback;
