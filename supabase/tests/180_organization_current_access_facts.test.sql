\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_table(
  'vortex_access', 'organization_groups',
  'Access stores current Groups without inventing a directory service'
);
select has_table(
  'vortex_access', 'organization_group_memberships',
  'Access stores current Group membership facts'
);
select has_table(
  'vortex_access', 'organization_role_assignments',
  'Access stores current standing and eligible role assignments'
);
select has_table(
  'vortex_access', 'organization_role_activations',
  'Access stores finite account activation evidence'
);
select has_table(
  'vortex_access', 'organization_delegation_authorities',
  'Access stores current delegation authority facts'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_class
    where oid in (
      'vortex_access.organization_groups'::regclass,
      'vortex_access.organization_group_memberships'::regclass,
      'vortex_access.organization_role_assignments'::regclass,
      'vortex_access.organization_role_activations'::regclass,
      'vortex_access.organization_delegation_authorities'::regclass
    )
      and relrowsecurity
      and relforcerowsecurity
  ),
  5,
  'all current Access fact relations enable and force row security'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'vortex_access'
      and tablename in (
        'organization_groups',
        'organization_group_memberships',
        'organization_role_assignments',
        'organization_role_activations',
        'organization_delegation_authorities'
      )
  ),
  0,
  'current fact storage has no public row policy'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name), ('service_role'::name),
        ('vortex_runtime'::name), ('vortex_request'::name)
    ) as denied(role_name)
    cross join (
      values
        ('vortex_access.organization_groups'::regclass),
        ('vortex_access.organization_group_memberships'::regclass),
        ('vortex_access.organization_role_assignments'::regclass),
        ('vortex_access.organization_role_activations'::regclass),
        ('vortex_access.organization_delegation_authorities'::regclass)
    ) as relation(relation_id)
    where pg_catalog.has_table_privilege(
      denied.role_name, relation.relation_id::oid, 'SELECT,INSERT,UPDATE,DELETE'
    )
  ),
  0,
  'PUBLIC, browser, service, runtime and request roles hold no fact-table privilege'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_access.organization_role_activations'::regclass
      and contype = 'f'
      and pg_catalog.pg_get_constraintdef(oid) like '%role_assignment_revision%'
  ),
  0,
  'activation evidence does not pin a mutable assignment revision through a foreign key'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_access.organization_role_activations'::regclass
      and contype = 'f'
      and pg_catalog.pg_get_constraintdef(oid) like '%membership_revision%'
  ),
  0,
  'activation evidence does not block later membership changes'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11800000-0000-4000-8000-000000000001', 'current_access_facts',
  'Current Access facts', 'active', pg_catalog.statement_timestamp(),
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '11800000-0000-4000-8000-000000000001', 'current_access_one',
    'Current Access one', 'active', pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21800000-0000-4000-8000-000000000002',
    '11800000-0000-4000-8000-000000000001', 'current_access_two',
    'Current Access two', 'active', pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '41800000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    '71800000-0000-4000-8000-000000000001', 1
  ),
  (
    '41800000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    '71800000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '51800000-0000-4000-8000-000000000001',
    '21800000-0000-4000-8000-000000000001',
    '41800000-0000-4000-8000-000000000001', 'Current person one', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    '71800000-0000-4000-8000-000000000003', 1
  ),
  (
    '51800000-0000-4000-8000-000000000002',
    '21800000-0000-4000-8000-000000000002',
    '41800000-0000-4000-8000-000000000001', 'Current person one elsewhere', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    '71800000-0000-4000-8000-000000000004', 1
  ),
  (
    '51800000-0000-4000-8000-000000000003',
    '21800000-0000-4000-8000-000000000001',
    '41800000-0000-4000-8000-000000000002', 'Current person two', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    '71800000-0000-4000-8000-000000000063', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21800000-0000-4000-8000-000000000001',
  '91800000-0000-4000-8000-000000000001',
  '71800000-0000-4000-8000-000000000005'
);
select * from vortex_access.initialize_organization_access_version(
  '21800000-0000-4000-8000-000000000002',
  '91800000-0000-4000-8000-000000000001',
  '71800000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21800000-0000-4000-8000-000000000001',
  '91800000-0000-4000-8000-000000000001',
  '71800000-0000-4000-8000-000000000007'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21800000-0000-4000-8000-000000000002',
  '91800000-0000-4000-8000-000000000001',
  '71800000-0000-4000-8000-000000000008'
);

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  'available', 1, entry.meaning_fingerprint, entry.registration_revision,
  pg_catalog.statement_timestamp()
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registrations as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id in (
    '21800000-0000-4000-8000-000000000001'::uuid,
    '21800000-0000-4000-8000-000000000002'::uuid
  )
  and entry.registration_kind = 'platform';

insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state, revision,
  source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001', 'application',
  '37800000-0000-4000-8000-000000000001', 'active', 1,
  'example.current_access', '1.0.0', 1, '2.17.0',
  'sha256:' || pg_catalog.repeat('a', 64),
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('c', 64),
  'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.statement_timestamp(),
  '91800000-0000-4000-8000-000000000001',
  '71800000-0000-4000-8000-000000000097'
);

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision, state,
  operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001', 'application',
  '37800000-0000-4000-8000-000000000001', 1, 'active', 'register',
  'example.current_access', '1.0.0', 1, '2.17.0',
  'sha256:' || pg_catalog.repeat('a', 64),
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('c', 64),
  'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.statement_timestamp(),
  '91800000-0000-4000-8000-000000000001',
  '71800000-0000-4000-8000-000000000097'
);

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint
) values
  (
    '21800000-0000-4000-8000-000000000001', 'application',
    '37800000-0000-4000-8000-000000000001', 1,
    '37800000-0000-4000-8000-000000000001', 'application',
    '37800000-0000-4000-8000-000000000001',
    '39800000-0000-4000-8000-000000000001', 'example.current_access.read',
    'View current access', 'View generic current access fixture data.', null,
    'read', null, false, 'application', 'example.current_access',
    '37800000-0000-4000-8000-000000000001', '1.0.0', 1, '2.17.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64), null,
    'sha256:' || pg_catalog.repeat('e', 64)
  ),
  (
    '21800000-0000-4000-8000-000000000001', 'application',
    '37800000-0000-4000-8000-000000000001', 1,
    '37800000-0000-4000-8000-000000000001', 'module',
    '38800000-0000-4000-8000-000000000001',
    '39800000-0000-4000-8000-000000000002', 'example.shared_records.read',
    'View shared records', 'View generic module-owned fixture data.', null,
    'read', null, false, 'module', 'example.shared_records',
    '38800000-0000-4000-8000-000000000001', '1.0.0', 1, '2.17.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat('f', 64)
  );

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '37800000-0000-4000-8000-000000000001', 'application',
    '37800000-0000-4000-8000-000000000001',
    '39800000-0000-4000-8000-000000000001', 'application',
    '37800000-0000-4000-8000-000000000001', 'available', 1,
    'sha256:' || pg_catalog.repeat('e', 64), 1,
    pg_catalog.statement_timestamp()
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '37800000-0000-4000-8000-000000000001', 'module',
    '38800000-0000-4000-8000-000000000001',
    '39800000-0000-4000-8000-000000000002', 'application',
    '37800000-0000-4000-8000-000000000001', 'available', 1,
    'sha256:' || pg_catalog.repeat('f', 64), 1,
    pg_catalog.statement_timestamp()
  );

set constraints all immediate;
set constraints all deferred;

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '31800000-0000-4000-8000-000000000001', 'review_group',
    'Review Group', 'active', 1,
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000010'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '31800000-0000-4000-8000-000000000002', 'retirement_fixture',
    'Retirement fixture', 'active', 1,
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000011'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '31800000-0000-4000-8000-000000000003', 'scheduled_members',
    'Scheduled members', 'active', 1,
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000060'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '31800000-0000-4000-8000-000000000004', 'expiry_group',
    'Expiry Group', 'active', 1,
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000064'
  ),
  (
    '21800000-0000-4000-8000-000000000002',
    '31800000-0000-4000-8000-000000000001', 'foreign_review_group',
    'Foreign review Group', 'active', 1,
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000012'
  );

select throws_ok(
  $$
    update vortex_access.organization_groups
    set group_key = 'renamed_group', revision = 2,
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000013'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and group_id = '31800000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5), null,
  'a Group key is permanent even while its display metadata may evolve'
);

update vortex_access.organization_groups
set state = 'retired', revision = 2,
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000014'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and group_id = '31800000-0000-4000-8000-000000000002';

select throws_ok(
  $$
    update vortex_access.organization_groups
    set label = 'Restored Group', revision = 3,
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000015'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and group_id = '31800000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5), null,
  'Group retirement is terminal'
);

select throws_ok(
  $$
    insert into vortex_access.organization_group_memberships (
      organization_id, membership_id, group_id, organization_account_id,
      revision, starts_at, expires_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '32800000-0000-4000-8000-000000000099',
      '31800000-0000-4000-8000-000000000001',
      '51800000-0000-4000-8000-000000000002', 1,
      pg_catalog.statement_timestamp(), null, 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000016',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000017'
    )
  $$,
  '23514'::char(5), null,
  'Group membership requires same-organization account and Group sources'
);

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '32800000-0000-4000-8000-000000000001',
    '31800000-0000-4000-8000-000000000001',
    '51800000-0000-4000-8000-000000000001', 1,
    pg_catalog.statement_timestamp() - interval '1 hour', null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000018',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000019'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '32800000-0000-4000-8000-000000000002',
    '31800000-0000-4000-8000-000000000003',
    '51800000-0000-4000-8000-000000000001', 1,
    pg_catalog.statement_timestamp() + interval '1 hour',
    pg_catalog.statement_timestamp() + interval '2 hours', 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000020',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000021'
  );

select throws_ok(
  $$
    insert into vortex_access.organization_group_memberships (
      organization_id, membership_id, group_id, organization_account_id,
      revision, starts_at, expires_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '32800000-0000-4000-8000-000000000003',
      '31800000-0000-4000-8000-000000000001',
      '51800000-0000-4000-8000-000000000001', 1,
      pg_catalog.statement_timestamp(), null, 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000061',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000062'
    )
  $$,
  '23505'::char(5), null,
  'only one live membership exists for one Group and account'
);

update vortex_access.organization_group_memberships
set state = 'revoked', revision = 2,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000022',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000023'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and membership_id = '32800000-0000-4000-8000-000000000001';

update vortex_access.organization_group_memberships
set state = 'live', revision = 3,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000024',
  revoked_by = null, revoked_at = null, revocation_correlation_id = null
where organization_id = '21800000-0000-4000-8000-000000000001'
  and membership_id = '32800000-0000-4000-8000-000000000001';

select is(
  (
    select revision || ':' || state
    from vortex_access.organization_group_memberships
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and membership_id = '32800000-0000-4000-8000-000000000001'
  ),
  '3:live',
  'an authorized permanent membership restoration retains identity and grant provenance'
);

select throws_ok(
  $$
    update vortex_access.organization_group_memberships
    set state = 'revoked', revision = 4,
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000025',
      revoked_by = '91800000-0000-4000-8000-000000000001',
      revoked_at = changed_at - interval '1 microsecond',
      revocation_correlation_id = '71800000-0000-4000-8000-000000000026'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and membership_id = '32800000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5), null,
  'membership revocation evidence cannot predate prior membership evidence'
);

-- A controlled historic fixture proves that natural expiry cannot be renewed by
-- restoring the old identity. Production insertion still rejects this shape.
alter table vortex_access.organization_group_memberships
  disable trigger organization_group_memberships_validate_insert;
insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001',
  '32800000-0000-4000-8000-000000000004',
  '31800000-0000-4000-8000-000000000004',
  '51800000-0000-4000-8000-000000000003', 1,
  pg_catalog.statement_timestamp() - interval '2 hours',
  pg_catalog.statement_timestamp() - interval '1 hour', 'live',
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 hours',
  '71800000-0000-4000-8000-000000000065',
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 hours',
  '71800000-0000-4000-8000-000000000066'
);
alter table vortex_access.organization_group_memberships
  enable trigger organization_group_memberships_validate_insert;

update vortex_access.organization_group_memberships
set state = 'revoked', revision = 2,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000067',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000068'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and membership_id = '32800000-0000-4000-8000-000000000004';

select throws_ok(
  $$
    update vortex_access.organization_group_memberships
    set state = 'live', revision = 3,
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000069',
      revoked_by = null, revoked_at = null, revocation_correlation_id = null
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and membership_id = '32800000-0000-4000-8000-000000000004'
  $$,
  '23514'::char(5), null,
  'an expired membership cannot be restored under its old identity'
);

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001',
  '32800000-0000-4000-8000-000000000005',
  '31800000-0000-4000-8000-000000000004',
  '51800000-0000-4000-8000-000000000003', 1,
  pg_catalog.statement_timestamp(), null, 'live',
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '71800000-0000-4000-8000-000000000070',
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '71800000-0000-4000-8000-000000000071'
);

select results_eq(
  $$
    select membership_id, state
    from vortex_access.organization_group_memberships
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and group_id = '31800000-0000-4000-8000-000000000004'
      and organization_account_id = '51800000-0000-4000-8000-000000000003'
    order by membership_id
  $$,
  $$ values
    ('32800000-0000-4000-8000-000000000004'::uuid, 'revoked'::text),
    ('32800000-0000-4000-8000-000000000005'::uuid, 'live'::text)
  $$,
  'natural expiry renewal uses a new membership identity and retains its predecessor'
);

-- Build one standing role and one activation-required role from an immutable
-- platform permission. These are storage fixtures, not writer APIs.
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000001', 'custom', 'standing_reader', 1,
    '91800000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000002', 'custom', 'eligible_reader', 1,
    '91800000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  );

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001',
  '61800000-0000-4000-8000-000000000002',
  '62800000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('7', 64), 3600, true,
  'multi_factor', 600, true,
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '71800000-0000-4000-8000-000000000027'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select
  '21800000-0000-4000-8000-000000000001'::uuid,
  target.role_id, 1, 1, 'custom', null, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  entry.registration_revision, registration.permission_catalogue_fingerprint,
  continuity.continuity_revision, entry.meaning_fingerprint
from (
  values
    ('61800000-0000-4000-8000-000000000001'::uuid),
    ('61800000-0000-4000-8000-000000000002'::uuid)
) as target(role_id)
cross join lateral (
  select catalogue.*
  from vortex_access.permission_catalogue_entries as catalogue
  where catalogue.organization_id = '21800000-0000-4000-8000-000000000001'
    and catalogue.registration_kind = 'platform'
    and catalogue.permission_id = '687d5649-62ee-43dd-b684-b8af3a5394c1'
  order by catalogue.registration_revision desc
  limit 1
) as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
join vortex_access.permission_continuities as continuity
  on continuity.organization_id = entry.organization_id
  and continuity.application_root_id is not distinct from entry.application_root_id
  and continuity.owner_kind = entry.owner_kind
  and continuity.owner_id = entry.owner_id
  and continuity.permission_id = entry.permission_id;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000001', 1, 'custom', 'active',
    'privileged', 'standing', 1, 1, null, null, null,
    'standing_reader', 'Standing reader', 'Standing current fact fixture.',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000028'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000002', 1, 'custom', 'active',
    'privileged', 'activation_required', 1, 1,
    '62800000-0000-4000-8000-000000000001', 1,
    'sha256:' || pg_catalog.repeat('7', 64),
    'eligible_reader', 'Eligible reader', 'Eligible current fact fixture.',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000029'
  );

set constraints all immediate;
set constraints all deferred;

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '63800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000001', 'organization_account',
    '51800000-0000-4000-8000-000000000001', null, 'standing', 1,
    pg_catalog.statement_timestamp() - interval '1 hour', null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000030',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000031'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '63800000-0000-4000-8000-000000000002',
    '61800000-0000-4000-8000-000000000002', 'organization_account',
    '51800000-0000-4000-8000-000000000001', null, 'eligible', 1,
    pg_catalog.statement_timestamp() - interval '1 hour',
    pg_catalog.statement_timestamp() + interval '2 hours', 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000032',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000033'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '63800000-0000-4000-8000-000000000003',
    '61800000-0000-4000-8000-000000000002', 'group', null,
    '31800000-0000-4000-8000-000000000001', 'eligible', 1,
    pg_catalog.statement_timestamp() - interval '1 hour',
    pg_catalog.statement_timestamp() + interval '2 hours', 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000034',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000035'
  );

select throws_ok(
  $$
    insert into vortex_access.organization_role_assignments (
      organization_id, role_assignment_id, role_id, assignee_kind,
      organization_account_id, group_id, assignment_kind, revision,
      starts_at, state, granted_by, granted_at, grant_correlation_id,
      changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '63800000-0000-4000-8000-000000000099',
      '61800000-0000-4000-8000-000000000001', 'organization_account',
      '51800000-0000-4000-8000-000000000001', null, 'eligible', 1,
      pg_catalog.statement_timestamp(), 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000036',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000037'
    )
  $$,
  '23514'::char(5), null,
  'assignment kind must agree with the current role policy'
);

select throws_ok(
  $$
    update vortex_access.organization_role_assignments
    set role_id = '61800000-0000-4000-8000-000000000001', revision = 2,
      state = 'revoked', revoked_by = '91800000-0000-4000-8000-000000000001',
      revoked_at = pg_catalog.statement_timestamp(),
      revocation_correlation_id = '71800000-0000-4000-8000-000000000038',
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000039'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_assignment_id = '63800000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5), null,
  'assignment revocation cannot alter its fixed role, assignee, kind or window'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select organization_id, '63800000-0000-4000-8000-000000000004'::uuid,
  role_id, assignee_kind, organization_account_id, group_id,
  assignment_kind, revision, starts_at, expires_at, state, granted_by,
  granted_at, '71800000-0000-4000-8000-000000000108'::uuid,
  changed_by, changed_at, '71800000-0000-4000-8000-000000000109'::uuid
from vortex_access.organization_role_assignments
where organization_id = '21800000-0000-4000-8000-000000000001'
  and role_assignment_id = '63800000-0000-4000-8000-000000000001';

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_assignments
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_id = '61800000-0000-4000-8000-000000000001'
      and organization_account_id = '51800000-0000-4000-8000-000000000001'
      and assignment_kind = 'standing'
  ),
  2,
  'independent assignment identities for one holder and role are not merged'
);

insert into vortex_access.organization_role_activations (
  organization_id, role_activation_id, organization_account_id, role_id,
  revision, historical_role_revision, authority_continuity_revision,
  policy_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  eligibility_source_kind, role_assignment_id, role_assignment_revision,
  membership_id, membership_revision, state, activated_by, activated_at,
  expires_at, activation_correlation_id, changed_by, changed_at,
  change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '64800000-0000-4000-8000-000000000001',
    '51800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000002', 1, 1, 1, 1,
    '62800000-0000-4000-8000-000000000001', 1,
    'sha256:' || pg_catalog.repeat('7', 64), 'direct',
    '63800000-0000-4000-8000-000000000002', 1, null, null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '30 minutes',
    '71800000-0000-4000-8000-000000000040',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000041'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '64800000-0000-4000-8000-000000000002',
    '51800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000002', 1, 1, 1, 1,
    '62800000-0000-4000-8000-000000000001', 1,
    'sha256:' || pg_catalog.repeat('7', 64), 'group',
    '63800000-0000-4000-8000-000000000003', 1,
    '32800000-0000-4000-8000-000000000001', 3, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp() + interval '30 minutes',
    '71800000-0000-4000-8000-000000000042',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000043'
  );

select throws_ok(
  $$
    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision, activation_policy_fingerprint,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      state, activated_by, activated_at, expires_at,
      activation_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '64800000-0000-4000-8000-000000000099',
      '51800000-0000-4000-8000-000000000001',
      '61800000-0000-4000-8000-000000000002', 1, 1, 1, 1,
      '62800000-0000-4000-8000-000000000001', 1,
      'sha256:' || pg_catalog.repeat('7', 64), 'direct',
      '63800000-0000-4000-8000-000000000002', 0, 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '30 minutes',
      '71800000-0000-4000-8000-000000000044',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000045'
    )
  $$,
  '23514'::char(5), null,
  'activation requires exact current eligible assignment revision evidence'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision, activation_policy_fingerprint,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      state, activated_by, activated_at, expires_at,
      activation_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '64800000-0000-4000-8000-000000000098',
      '51800000-0000-4000-8000-000000000001',
      '61800000-0000-4000-8000-000000000002', 1, 1, 1, 1,
      '62800000-0000-4000-8000-000000000001', 1,
      'sha256:' || pg_catalog.repeat('7', 64), 'direct',
      '63800000-0000-4000-8000-000000000002', 1, 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp() - interval '1 second',
      pg_catalog.statement_timestamp() + interval '30 minutes',
      '71800000-0000-4000-8000-000000000046',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000047'
    )
  $$,
  '23514'::char(5), null,
  'new activation evidence cannot be backdated'
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001',
  '61800000-0000-4000-8000-000000000002',
  '62800000-0000-4000-8000-000000000001', 2,
  'sha256:' || pg_catalog.repeat('8', 64), 14400, true,
  'multi_factor', 600, true,
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '71800000-0000-4000-8000-000000000104'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select organization_id, role_id, 2, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
from vortex_access.organization_role_permission_entries
where organization_id = '21800000-0000-4000-8000-000000000001'
  and role_id = '61800000-0000-4000-8000-000000000002'
  and role_revision = 1;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000001',
  '61800000-0000-4000-8000-000000000002', 2, 'custom', 'active',
  'privileged', 'activation_required', 2, 1,
  '62800000-0000-4000-8000-000000000001', 2,
  'sha256:' || pg_catalog.repeat('8', 64),
  'eligible_reader', 'Eligible reader', 'Later compatible policy fixture.',
  '91800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '71800000-0000-4000-8000-000000000105'
);

update vortex_access.organization_roles
set live_revision = 2
where organization_id = '21800000-0000-4000-8000-000000000001'
  and role_id = '61800000-0000-4000-8000-000000000002';

set constraints all immediate;
set constraints all deferred;

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_assignments
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_id = '61800000-0000-4000-8000-000000000002'
      and state = 'live'
  ),
  2,
  'a later role-policy revision does not foreign-key-block existing assignment facts'
);

create function pg_temp.insert_direct_activation(
  p_activation_id uuid,
  p_historical_role_revision bigint,
  p_authority_continuity_revision bigint,
  p_policy_continuity_revision bigint,
  p_activation_policy_revision bigint,
  p_activation_policy_fingerprint text,
  p_assignment_revision bigint,
  p_duration_seconds integer
)
returns void
language sql
set search_path = ''
as $function$
  insert into vortex_access.organization_role_activations (
    organization_id, role_activation_id, organization_account_id, role_id,
    revision, historical_role_revision, authority_continuity_revision,
    policy_continuity_revision, activation_policy_id,
    activation_policy_revision, activation_policy_fingerprint,
    eligibility_source_kind, role_assignment_id, role_assignment_revision,
    state, activated_by, activated_at, expires_at,
    activation_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    '21800000-0000-4000-8000-000000000001', p_activation_id,
    '51800000-0000-4000-8000-000000000001',
    '61800000-0000-4000-8000-000000000002', 1,
    p_historical_role_revision, p_authority_continuity_revision,
    p_policy_continuity_revision,
    '62800000-0000-4000-8000-000000000001',
    p_activation_policy_revision, p_activation_policy_fingerprint, 'direct',
    '63800000-0000-4000-8000-000000000002', p_assignment_revision, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
      + pg_catalog.make_interval(secs => p_duration_seconds),
    '71800000-0000-4000-8000-000000000106',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000107'
  )
$function$;

select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000090', 2, 2, 2, 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1800
  ) $$,
  '23514'::char(5), null,
  'activation refuses the wrong current authority continuity revision'
);
select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000091', 2, 1, 1, 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1800
  ) $$,
  '23514'::char(5), null,
  'activation refuses the wrong current policy continuity revision'
);
select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000092', 2, 1, 2, 1,
    'sha256:' || pg_catalog.repeat('7', 64), 1, 1800
  ) $$,
  '23514'::char(5), null,
  'activation refuses a historical rather than current policy reference'
);
select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000093', 2, 1, 2, 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1, 14401
  ) $$,
  '23514'::char(5), null,
  'activation refuses a duration beyond the exact current policy cap'
);
select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000094', 2, 1, 2, 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1, 10800
  ) $$,
  '23514'::char(5), null,
  'activation expiry cannot exceed its exact eligible assignment window'
);
select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000095', 2, 1, 2, 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1, -1
  ) $$,
  '23514'::char(5), null,
  'a newly inserted activation cannot already be expired'
);

-- Controlled corruption isolates the activation guard that requires retained
-- authority on the exact current role revision.
alter table vortex_access.organization_role_permission_entries
  disable trigger organization_role_permission_entries_immutable;
delete from vortex_access.organization_role_permission_entries
where organization_id = '21800000-0000-4000-8000-000000000001'
  and role_id = '61800000-0000-4000-8000-000000000002'
  and role_revision = 2;
alter table vortex_access.organization_role_permission_entries
  enable trigger organization_role_permission_entries_immutable;

select throws_ok(
  $$ select pg_temp.insert_direct_activation(
    '64800000-0000-4000-8000-000000000096', 2, 1, 2, 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1800
  ) $$,
  '23514'::char(5), null,
  'activation refuses a current role revision with no retained permission authority'
);

update vortex_access.organization_role_assignments
set state = 'revoked', revision = 2,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000048',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000049'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and role_assignment_id = '63800000-0000-4000-8000-000000000002';

select is(
  (
    select role_assignment_revision
    from vortex_access.organization_role_activations
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_activation_id = '64800000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'later assignment revocation does not rewrite or foreign-key-block activation evidence'
);

update vortex_access.organization_group_memberships
set state = 'revoked', revision = 4,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000072',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000073'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and membership_id = '32800000-0000-4000-8000-000000000001';

select is(
  (
    select membership_revision
    from vortex_access.organization_role_activations
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_activation_id = '64800000-0000-4000-8000-000000000002'
  ),
  3::bigint,
  'later membership revocation leaves the old Group activation pinned to its source revision'
);

update vortex_access.organization_group_memberships
set state = 'live', revision = 5,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000092',
  revoked_by = null, revoked_at = null, revocation_correlation_id = null
where organization_id = '21800000-0000-4000-8000-000000000001'
  and membership_id = '32800000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    insert into vortex_access.organization_role_activations (
      organization_id, role_activation_id, organization_account_id, role_id,
      revision, historical_role_revision, authority_continuity_revision,
      policy_continuity_revision, activation_policy_id,
      activation_policy_revision, activation_policy_fingerprint,
      eligibility_source_kind, role_assignment_id, role_assignment_revision,
      membership_id, membership_revision, state, activated_by, activated_at,
      expires_at, activation_correlation_id, changed_by, changed_at,
      change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '64800000-0000-4000-8000-000000000097',
      '51800000-0000-4000-8000-000000000003',
      '61800000-0000-4000-8000-000000000002', 1, 1, 1, 1,
      '62800000-0000-4000-8000-000000000001', 1,
      'sha256:' || pg_catalog.repeat('7', 64), 'group',
      '63800000-0000-4000-8000-000000000003', 1,
      '32800000-0000-4000-8000-000000000001', 5, 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp() + interval '30 minutes',
      '71800000-0000-4000-8000-000000000074',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000075'
    )
  $$,
  '23514'::char(5), null,
  'Group activation requires the exact member account rather than the whole Group'
);

-- One helper produces the exact catalogue-backed JSON tuple shape used by
-- bounded delegations. Its ordering is the normative identity ordering.
create function pg_temp.current_platform_permissions(p_organization_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'ownerKind', entry.owner_kind,
      'ownerId', entry.owner_id,
      'permissionId', entry.permission_id,
      'acceptedRegistrationRevision', entry.registration_revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', entry.meaning_fingerprint
    ) order by entry.application_root_id asc nulls last,
      entry.owner_kind collate "C", entry.owner_id, entry.permission_id
  )
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registrations as current_registration
    on current_registration.organization_id = entry.organization_id
    and current_registration.registration_kind = entry.registration_kind
    and current_registration.registration_owner_id = entry.registration_owner_id
    and current_registration.revision = entry.registration_revision
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
    and registration.state = 'active'
    and continuity.state = 'available'
$function$;

create function pg_temp.current_application_permissions(p_organization_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', entry.application_root_id,
      'ownerKind', entry.owner_kind,
      'ownerId', entry.owner_id,
      'permissionId', entry.permission_id,
      'acceptedRegistrationRevision', entry.registration_revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', entry.meaning_fingerprint
    ) order by entry.application_root_id asc nulls last,
      entry.owner_kind collate "C", entry.owner_id, entry.permission_id
  )
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registrations as current_registration
    on current_registration.organization_id = entry.organization_id
    and current_registration.registration_kind = entry.registration_kind
    and current_registration.registration_owner_id = entry.registration_owner_id
    and current_registration.revision = entry.registration_revision
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and registration.state = 'active'
    and continuity.state = 'available'
$function$;

select is(
  pg_catalog.jsonb_array_length(
    pg_temp.current_platform_permissions(
      '21800000-0000-4000-8000-000000000001'
    )
  ),
  13,
  'the generated bounded-scope fixture covers the complete fixed platform catalogue'
);

insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state,
  granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '65800000-0000-4000-8000-000000000001', 'organization_account',
    '51800000-0000-4000-8000-000000000001', null, 'bounded',
    pg_temp.current_platform_permissions(
      '21800000-0000-4000-8000-000000000001'
    ),
    'sha256:' || pg_catalog.repeat('8', 64), 1,
    pg_catalog.statement_timestamp() - interval '1 hour', null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000076',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '71800000-0000-4000-8000-000000000077'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '65800000-0000-4000-8000-000000000002', 'group', null,
    '31800000-0000-4000-8000-000000000003', 'organization_catalogue',
    null, null, 1, pg_catalog.statement_timestamp() + interval '1 hour',
    null, 'live', '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000078',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000079'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '65800000-0000-4000-8000-000000000003', 'organization_account',
    '51800000-0000-4000-8000-000000000003', null, 'bounded',
    pg_catalog.jsonb_build_array(
      pg_temp.current_platform_permissions(
        '21800000-0000-4000-8000-000000000001'
      ) -> 0
    ),
    'sha256:' || pg_catalog.repeat('9', 64), 1,
    pg_catalog.statement_timestamp(), null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000080',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000081'
  );

insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state,
  granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id
) values
  (
    '21800000-0000-4000-8000-000000000001',
    '65800000-0000-4000-8000-000000000004', 'organization_account',
    '51800000-0000-4000-8000-000000000001', null, 'bounded',
    pg_temp.current_application_permissions(
      '21800000-0000-4000-8000-000000000001'
    ),
    'sha256:' || pg_catalog.repeat('4', 64), 1,
    pg_catalog.statement_timestamp(), null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000098',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000099'
  ),
  (
    '21800000-0000-4000-8000-000000000001',
    '65800000-0000-4000-8000-000000000005', 'organization_account',
    '51800000-0000-4000-8000-000000000001', null, 'bounded',
    pg_temp.current_application_permissions(
      '21800000-0000-4000-8000-000000000001'
    ),
    'sha256:' || pg_catalog.repeat('5', 64), 1,
    pg_catalog.statement_timestamp(), null, 'live',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000100',
    '91800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '71800000-0000-4000-8000-000000000101'
  );

select results_eq(
  $$
    select delegation_authority_id,
      pg_catalog.jsonb_array_length(bounded_permissions)
    from vortex_access.organization_delegation_authorities
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and delegation_authority_id in (
        '65800000-0000-4000-8000-000000000004',
        '65800000-0000-4000-8000-000000000005'
      )
    order by delegation_authority_id
  $$,
  $$ values
    ('65800000-0000-4000-8000-000000000004'::uuid, 2),
    ('65800000-0000-4000-8000-000000000005'::uuid, 2)
  $$,
  'independent delegation identities for one holder and scope remain independent facts'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.jsonb_array_elements(
      pg_temp.current_application_permissions(
        '21800000-0000-4000-8000-000000000001'
      )
    ) as permission(value)
    where permission.value ->> 'ownerKind' in ('application', 'module')
      and permission.value ->> 'applicationRootId' =
        '37800000-0000-4000-8000-000000000001'
  ),
  2,
  'bounded scope accepts application-owned and bound-module authority in one application context'
);

select throws_ok(
  $$
    insert into vortex_access.organization_delegation_authorities (
      organization_id, delegation_authority_id, holder_kind,
      organization_account_id, scope_kind, bounded_permissions,
      scope_fingerprint, revision, starts_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000002',
      '65800000-0000-4000-8000-000000000093', 'organization_account',
      '51800000-0000-4000-8000-000000000002', 'bounded',
      pg_temp.current_application_permissions(
        '21800000-0000-4000-8000-000000000001'
      ),
      'sha256:' || pg_catalog.repeat('6', 64), 1,
      pg_catalog.statement_timestamp(), 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000102',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000103'
    )
  $$,
  '23514'::char(5), null,
  'bounded application authority cannot cross organization scope'
);

select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_application_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 1,
          '{applicationRootId}',
          '"37800000-0000-4000-8000-000000000099"'::jsonb
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'bound-module authority cannot substitute another application context'
);

select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_application_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{ownerId}', '"37800000-0000-4000-8000-000000000099"'::jsonb
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'application-owned authority requires owner and application roots to match'
);

select throws_ok(
  $$
    insert into vortex_access.organization_delegation_authorities (
      organization_id, delegation_authority_id, holder_kind,
      organization_account_id, scope_kind, bounded_permissions,
      scope_fingerprint, revision, starts_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '65800000-0000-4000-8000-000000000090', 'organization_account',
      '51800000-0000-4000-8000-000000000001', 'bounded', null,
      'sha256:' || pg_catalog.repeat('a', 64), 1,
      pg_catalog.statement_timestamp(), 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000082',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000083'
    )
  $$,
  '23514'::char(5), null,
  'bounded storage refuses a SQL-null permission set'
);

select throws_ok(
  $$
    insert into vortex_access.organization_delegation_authorities (
      organization_id, delegation_authority_id, holder_kind,
      organization_account_id, scope_kind, bounded_permissions,
      scope_fingerprint, revision, starts_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    ) values (
      '21800000-0000-4000-8000-000000000001',
      '65800000-0000-4000-8000-000000000091', 'organization_account',
      '51800000-0000-4000-8000-000000000001', 'bounded',
      pg_temp.current_platform_permissions(
        '21800000-0000-4000-8000-000000000001'
      ), null, 1, pg_catalog.statement_timestamp(), 'live',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000093',
      '91800000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000094'
    )
  $$,
  '23514'::char(5), null,
  'bounded storage refuses a SQL-null scope fingerprint'
);

select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001', 'null'::jsonb
    )
  $$,
  '23514'::char(5), null,
  'bounded scope refuses JSON null'
);
select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001', '42'::jsonb
    )
  $$,
  '23514'::char(5), null,
  'bounded scope refuses a JSON scalar'
);
select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        (pg_temp.current_platform_permissions(
          '21800000-0000-4000-8000-000000000001'
        ) -> 0) - 'kind'
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples refuse missing keys'
);
select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        (pg_temp.current_platform_permissions(
          '21800000-0000-4000-8000-000000000001'
        ) -> 0) || '{"unexpected":true}'::jsonb
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples refuse unknown keys'
);

select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{continuityRevision}', 'null'::jsonb
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples refuse JSON-null values'
);
select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{continuityRevision}', '"1"'::jsonb
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples refuse numeric strings'
);
select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{continuityRevision}', '1.5'::jsonb
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples refuse fractional revisions'
);
select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{continuityRevision}', '9007199254740992'::jsonb
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples refuse revisions outside the JavaScript-safe range'
);

select lives_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{continuityRevision}', '1.0'::jsonb
        )
      )
    )
  $$,
  'an integral JSON numeric spelling binds to the exact continuity revision'
);

select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      pg_catalog.jsonb_build_array(
        pg_temp.current_platform_permissions(
          '21800000-0000-4000-8000-000000000001'
        ) -> 0,
        pg_catalog.jsonb_set(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          ) -> 0,
          '{ownerId}',
          pg_catalog.to_jsonb(pg_catalog.upper(
            pg_temp.current_platform_permissions(
              '21800000-0000-4000-8000-000000000001'
            ) -> 0 ->> 'ownerId'
          ))
        )
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuple uniqueness uses normalized UUID identity'
);

select throws_ok(
  $$
    select vortex_access.validate_organization_delegation_bounded_permissions(
      '21800000-0000-4000-8000-000000000001',
      (
        select pg_catalog.jsonb_agg(candidate.value order by candidate.ordinality desc)
        from pg_catalog.jsonb_array_elements(
          pg_temp.current_platform_permissions(
            '21800000-0000-4000-8000-000000000001'
          )
        ) with ordinality as candidate(value, ordinality)
      )
    )
  $$,
  '23514'::char(5), null,
  'bounded tuples require canonical identity order'
);

select throws_ok(
  $$
    update vortex_access.organization_delegation_authorities
    set state = 'revoked', revision = 2,
      bounded_permissions = pg_temp.current_platform_permissions(
        '21800000-0000-4000-8000-000000000001'
      ),
      scope_fingerprint = 'sha256:' || pg_catalog.repeat('a', 64),
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000084',
      revoked_by = '91800000-0000-4000-8000-000000000001',
      revoked_at = pg_catalog.statement_timestamp(),
      revocation_correlation_id = '71800000-0000-4000-8000-000000000085'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and delegation_authority_id = '65800000-0000-4000-8000-000000000003'
  $$,
  '23514'::char(5), null,
  'delegation revocation cannot be combined with scope expansion'
);

update vortex_access.organization_delegation_authorities
set bounded_permissions = pg_catalog.jsonb_build_array(
    pg_temp.current_platform_permissions(
      '21800000-0000-4000-8000-000000000001'
    ) -> 0,
    pg_temp.current_platform_permissions(
      '21800000-0000-4000-8000-000000000001'
    ) -> 1
  ),
  scope_fingerprint = 'sha256:' || pg_catalog.repeat('a', 64),
  revision = 2,
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000086'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and delegation_authority_id = '65800000-0000-4000-8000-000000000003';

select is(
  pg_catalog.jsonb_array_length(
    (
      select bounded_permissions
      from vortex_access.organization_delegation_authorities
      where organization_id = '21800000-0000-4000-8000-000000000001'
        and delegation_authority_id = '65800000-0000-4000-8000-000000000003'
    )
  ),
  2,
  'a live delegation replaces its whole exact bounded scope atomically'
);

-- Deliberately make one continuity stale after the delegation was accepted.
-- This proves storage can always revoke authority without requiring stale
-- permission evidence to become current again.
alter table vortex_access.permission_continuities
  disable trigger permission_continuities_protect_change;
alter table vortex_access.permission_continuities
  disable trigger permission_continuities_evidence;
update vortex_access.permission_continuities
set state = 'unavailable', continuity_revision = continuity_revision + 1,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21800000-0000-4000-8000-000000000001'
  and application_root_id is null
  and owner_kind = 'platform'
  and owner_id = (
    pg_temp.current_platform_permissions(
      '21800000-0000-4000-8000-000000000001'
    ) -> 0 ->> 'ownerId'
  )::uuid
  and permission_id = (
    pg_temp.current_platform_permissions(
      '21800000-0000-4000-8000-000000000001'
    ) -> 0 ->> 'permissionId'
  )::uuid;
alter table vortex_access.permission_continuities
  enable trigger permission_continuities_evidence;
alter table vortex_access.permission_continuities
  enable trigger permission_continuities_protect_change;

select throws_ok(
  $$
    insert into vortex_access.organization_delegation_authorities (
      organization_id, delegation_authority_id, holder_kind,
      organization_account_id, scope_kind, bounded_permissions,
      scope_fingerprint, revision, starts_at, state, granted_by, granted_at,
      grant_correlation_id, changed_by, changed_at, change_correlation_id
    )
    select organization_id, '65800000-0000-4000-8000-000000000092'::uuid,
      holder_kind, organization_account_id, scope_kind, bounded_permissions,
      'sha256:' || pg_catalog.repeat('b', 64), 1,
      pg_catalog.statement_timestamp(), 'live',
      '91800000-0000-4000-8000-000000000001'::uuid,
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000095'::uuid,
      '91800000-0000-4000-8000-000000000001'::uuid,
      pg_catalog.statement_timestamp(),
      '71800000-0000-4000-8000-000000000096'::uuid
    from vortex_access.organization_delegation_authorities
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and delegation_authority_id = '65800000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5), null,
  'new bounded delegation rejects stale continuity evidence'
);

update vortex_access.organization_groups
set state = 'retired', revision = 2,
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000087'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and group_id = '31800000-0000-4000-8000-000000000003';

update vortex_access.organization_delegation_authorities
set state = 'revoked', revision = 2,
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000088',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000089'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and delegation_authority_id = '65800000-0000-4000-8000-000000000002';

update vortex_access.organization_delegation_authorities
set state = 'revoked', revision = 2,
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000090',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000091'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and delegation_authority_id = '65800000-0000-4000-8000-000000000001';

select results_eq(
  $$
    select delegation_authority_id, state, revision
    from vortex_access.organization_delegation_authorities
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and delegation_authority_id in (
        '65800000-0000-4000-8000-000000000001',
        '65800000-0000-4000-8000-000000000002'
      )
    order by delegation_authority_id
  $$,
  $$ values
    ('65800000-0000-4000-8000-000000000001'::uuid, 'revoked'::text, 2::bigint),
    ('65800000-0000-4000-8000-000000000002'::uuid, 'revoked'::text, 2::bigint)
  $$,
  'stale continuity or holder state never prevents unchanged-scope revocation'
);

select results_eq(
  $$
    select group_id, group_key, state, revision
    from vortex_access.read_organization_group(
      '21800000-0000-4000-8000-000000000001',
      '31800000-0000-4000-8000-000000000001'
    )
  $$,
  $$ values (
    '31800000-0000-4000-8000-000000000001'::uuid,
    'review_group'::text, 'active'::text, 1::bigint
  ) $$,
  'the owner Group reader returns the exact current row'
);

select is_empty(
  $$
    select *
    from vortex_access.read_organization_group(
      '21800000-0000-4000-8000-000000000002',
      '31800000-0000-4000-8000-000000000003'
    )
  $$,
  'foreign and unknown Group identities both return no row'
);

select results_eq(
  $$
    select effective_state
    from vortex_access.read_organization_group_membership(
      '21800000-0000-4000-8000-000000000001',
      '32800000-0000-4000-8000-000000000002'
    )
  $$,
  $$ values ('scheduled'::text) $$,
  'membership reader reports database-time scheduled state only'
);

select results_eq(
  $$
    select assignment_kind, effective_state
    from vortex_access.read_organization_role_assignment(
      '21800000-0000-4000-8000-000000000001',
      '63800000-0000-4000-8000-000000000001'
    )
  $$,
  $$ values ('standing'::text, 'active'::text) $$,
  'assignment reader reports timing and kind without deciding permission'
);

select results_eq(
  $$
    select role_assignment_revision, temporal_state
    from vortex_access.read_organization_role_activation(
      '21800000-0000-4000-8000-000000000001',
      '64800000-0000-4000-8000-000000000001'
    )
  $$,
  $$ values (1::bigint, 'active'::text) $$,
  'activation reader retains historical source revision and returns timing only'
);

select results_eq(
  $$
    select scope ->> 'kind', effective_state
    from vortex_access.read_organization_delegation_authority(
      '21800000-0000-4000-8000-000000000001',
      '65800000-0000-4000-8000-000000000002'
    )
  $$,
  $$ values ('organization_catalogue'::text, 'revoked'::text) $$,
  'delegation reader assembles the closed public scope and timing state'
);

create function pg_temp.sorted_json_keys(p_value jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.array_agg(key order by key)
  from pg_catalog.jsonb_object_keys(p_value) as member(key)
$function$;

create function pg_temp.sorted_text(p_value text[])
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.array_agg(value order by value)
  from pg_catalog.unnest(p_value) as member(value)
$function$;

select is(
  pg_temp.sorted_json_keys(pg_catalog.to_jsonb(reader_row)),
  pg_temp.sorted_text(array[
    'organization_id', 'group_id', 'group_key', 'label', 'state', 'revision',
    'created_by_actor_id', 'created_at', 'changed_by_actor_id', 'changed_at',
    'change_correlation_id'
  ]),
  'the SQL Group reader exposes exactly the typed binding columns'
)
from vortex_access.read_organization_group(
  '21800000-0000-4000-8000-000000000001',
  '31800000-0000-4000-8000-000000000001'
) as reader_row;

select is(
  pg_temp.sorted_json_keys(pg_catalog.to_jsonb(reader_row)),
  pg_temp.sorted_text(array[
    'organization_id', 'membership_id', 'group_id', 'organization_account_id',
    'revision', 'starts_at', 'expires_at', 'state', 'granted_by_actor_id',
    'granted_at', 'grant_correlation_id', 'changed_by_actor_id', 'changed_at',
    'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
    'revocation_correlation_id', 'effective_state'
  ]),
  'the SQL membership reader exposes exactly the typed binding columns'
)
from vortex_access.read_organization_group_membership(
  '21800000-0000-4000-8000-000000000001',
  '32800000-0000-4000-8000-000000000002'
) as reader_row;

select is(
  pg_temp.sorted_json_keys(pg_catalog.to_jsonb(reader_row)),
  pg_temp.sorted_text(array[
    'organization_id', 'role_assignment_id', 'role_id', 'assignee_kind',
    'organization_account_id', 'group_id', 'assignment_kind', 'revision',
    'starts_at', 'expires_at', 'state', 'granted_by_actor_id', 'granted_at',
    'grant_correlation_id', 'changed_by_actor_id', 'changed_at',
    'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
    'revocation_correlation_id', 'effective_state'
  ]),
  'the SQL assignment reader exposes exactly the typed binding columns'
)
from vortex_access.read_organization_role_assignment(
  '21800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000001'
) as reader_row;

select is(
  pg_temp.sorted_json_keys(pg_catalog.to_jsonb(reader_row)),
  pg_temp.sorted_text(array[
    'organization_id', 'role_activation_id', 'organization_account_id',
    'role_id', 'revision', 'historical_role_revision',
    'authority_continuity_revision', 'policy_continuity_revision',
    'activation_policy_id', 'activation_policy_revision',
    'activation_policy_fingerprint', 'eligibility_source_kind',
    'role_assignment_id', 'role_assignment_revision', 'membership_id',
    'membership_revision', 'state', 'activated_by_actor_id', 'activated_at',
    'expires_at', 'activation_correlation_id', 'changed_by_actor_id',
    'changed_at', 'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
    'revocation_correlation_id', 'temporal_state'
  ]),
  'the SQL activation reader exposes exactly the typed binding columns'
)
from vortex_access.read_organization_role_activation(
  '21800000-0000-4000-8000-000000000001',
  '64800000-0000-4000-8000-000000000001'
) as reader_row;

select is(
  pg_temp.sorted_json_keys(pg_catalog.to_jsonb(reader_row)),
  pg_temp.sorted_text(array[
    'organization_id', 'delegation_authority_id', 'holder_kind',
    'organization_account_id', 'group_id', 'scope', 'revision', 'starts_at',
    'expires_at', 'state', 'granted_by_actor_id', 'granted_at',
    'grant_correlation_id', 'changed_by_actor_id', 'changed_at',
    'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
    'revocation_correlation_id', 'effective_state'
  ]),
  'the SQL delegation reader exposes exactly the typed binding columns'
)
from vortex_access.read_organization_delegation_authority(
  '21800000-0000-4000-8000-000000000001',
  '65800000-0000-4000-8000-000000000002'
) as reader_row;

select throws_ok(
  $$
    update vortex_access.organization_group_memberships
    set granted_by = '91800000-0000-4000-8000-000000000099', revision = 2,
      state = 'revoked',
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000110',
      revoked_by = '91800000-0000-4000-8000-000000000001',
      revoked_at = pg_catalog.statement_timestamp(),
      revocation_correlation_id = '71800000-0000-4000-8000-000000000111'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and membership_id = '32800000-0000-4000-8000-000000000005'
  $$,
  '23514'::char(5), null,
  'membership transition cannot rewrite original grant provenance'
);

select throws_ok(
  $$
    update vortex_access.organization_delegation_authorities
    set organization_account_id = '51800000-0000-4000-8000-000000000003',
      revision = 3, changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000112'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and delegation_authority_id = '65800000-0000-4000-8000-000000000003'
  $$,
  '23514'::char(5), null,
  'delegation scope replacement cannot rewrite its permanent holder'
);

select throws_ok(
  $$
    update vortex_access.organization_role_assignments
    set revision = 3, changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000113',
      revoked_at = pg_catalog.statement_timestamp()
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_assignment_id = '63800000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5), null,
  'role assignment revocation is terminal'
);

update vortex_access.organization_role_activations
set state = 'revoked', revision = 2,
  changed_by = '91800000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '71800000-0000-4000-8000-000000000114',
  revoked_by = '91800000-0000-4000-8000-000000000001',
  revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '71800000-0000-4000-8000-000000000115'
where organization_id = '21800000-0000-4000-8000-000000000001'
  and role_activation_id = '64800000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    update vortex_access.organization_role_activations
    set revision = 3, changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000116',
      revoked_at = pg_catalog.statement_timestamp()
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and role_activation_id = '64800000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5), null,
  'role activation revocation is terminal'
);

select throws_ok(
  $$
    update vortex_access.organization_delegation_authorities
    set revision = 3, changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000117',
      revoked_at = pg_catalog.statement_timestamp()
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and delegation_authority_id = '65800000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5), null,
  'delegation revocation is terminal'
);

alter table vortex_access.organization_groups
  disable trigger organization_groups_protect_change;
update vortex_access.organization_groups
set revision = 9007199254740991
where organization_id = '21800000-0000-4000-8000-000000000001'
  and group_id = '31800000-0000-4000-8000-000000000004';
alter table vortex_access.organization_groups
  enable trigger organization_groups_protect_change;

select throws_ok(
  $$
    update vortex_access.organization_groups
    set label = 'Exhausted Group', revision = 9007199254740991,
      changed_at = pg_catalog.statement_timestamp(),
      change_correlation_id = '71800000-0000-4000-8000-000000000118'
    where organization_id = '21800000-0000-4000-8000-000000000001'
      and group_id = '31800000-0000-4000-8000-000000000004'
  $$,
  '22003'::char(5), null,
  'a JavaScript-safe maximum revision refuses another fact transition'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name), ('service_role'::name),
        ('vortex_runtime'::name), ('vortex_request'::name)
    ) as denied(role_name)
    cross join (
      values
        ('vortex_access.protect_organization_group()'::regprocedure),
        ('vortex_access.validate_organization_group_membership_insert()'::regprocedure),
        ('vortex_access.protect_organization_group_membership()'::regprocedure),
        ('vortex_access.validate_organization_role_assignment_insert()'::regprocedure),
        ('vortex_access.protect_organization_role_assignment()'::regprocedure),
        ('vortex_access.validate_organization_role_activation_insert()'::regprocedure),
        ('vortex_access.protect_organization_role_activation()'::regprocedure),
        ('vortex_access.validate_organization_delegation_bounded_permissions(uuid,jsonb)'::regprocedure),
        ('vortex_access.validate_organization_delegation_authority()'::regprocedure),
        ('vortex_access.protect_organization_delegation_authority()'::regprocedure),
        ('vortex_access.read_organization_group(uuid,uuid)'::regprocedure),
        ('vortex_access.read_organization_group_membership(uuid,uuid)'::regprocedure),
        ('vortex_access.read_organization_role_assignment(uuid,uuid)'::regprocedure),
        ('vortex_access.read_organization_role_activation(uuid,uuid)'::regprocedure),
        ('vortex_access.read_organization_delegation_authority(uuid,uuid)'::regprocedure)
    ) as operation(operation_id)
    where pg_catalog.has_function_privilege(
      denied.role_name, operation.operation_id::oid, 'EXECUTE'
    )
  ),
  0,
  'all fifteen current-fact helpers and readers deny PUBLIC and every external database role'
);

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request role can reach the Access schema, so invocation proves function denial'
);

-- Expose only pgTAP inside this rolled-back transaction; private Access
-- privileges remain unchanged.
grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$ select * from vortex_access.read_organization_group(
    '21800000-0000-4000-8000-000000000001',
    '31800000-0000-4000-8000-000000000001'
  ) $$,
  '42501'::char(5),
  'permission denied for function read_organization_group',
  'the actual request role cannot invoke an owner-only fact reader'
);
reset role;

select * from finish();
rollback;
