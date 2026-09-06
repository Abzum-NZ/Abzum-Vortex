\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'coordinate_organization_role_activation_change',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'uuid', 'bigint', 'bigint',
    'text', 'uuid', 'bigint', 'uuid', 'bigint', 'uuid', 'uuid'
  ],
  'Access exposes one private individual role-activation composition'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', routine.prosecdef,
      'volatility', routine.provolatile,
      'configuration', routine.proconfig
    )
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_roles as owner_role on owner_role.oid = routine.proowner
    where routine.oid =
      'vortex_access.coordinate_organization_role_activation_change(text,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text,uuid,bigint,uuid,bigint,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the activation coordinator is owner-held, volatile, invoker-security and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_role_activation_change(text,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text,uuid,bigint,uuid,bigint,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private activation coordinator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.validate_organization_role_activation_insert()',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private activation validator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 1, 600, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000001',
      'a4000000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_role_activation_change',
  'an actual request-role call cannot invoke role activation'
);
reset role;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'unknown',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', null,
      null, null, null, null, null, null, null, null, null,
      '94000000-0000-4000-8000-000000000001',
      'a4000000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-activation change input is invalid',
  'unknown activation operations refuse before organization lookup'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 1, 0, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000001',
      'a4000000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role activation input is invalid',
  'activation requires a positive safe requested duration'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 1, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1,
      '64000000-0000-4000-8000-000000000010', 1,
      '94000000-0000-4000-8000-000000000001',
      'a4000000-0000-4000-8000-000000000040'
    )
  $$,
  '22023'::char(5),
  'Organization role activation input is invalid',
  'direct activation refuses extraneous Group membership evidence'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14000000-0000-4000-8000-000000000001', 'role_activation',
  'Role activation', 'active', pg_catalog.statement_timestamp(),
  '94000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '24000000-0000-4000-8000-000000000001',
    '14000000-0000-4000-8000-000000000001', 'role_activation_one',
    'Role activation one', 'active', pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '24000000-0000-4000-8000-000000000002',
    '14000000-0000-4000-8000-000000000001', 'role_activation_two',
    'Role activation two', 'active', pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '44000000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000002', 1
  ),
  (
    '44000000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000003', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '54000000-0000-4000-8000-000000000001',
    '24000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001', 'Activation person', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000004', 1
  ),
  (
    '54000000-0000-4000-8000-000000000002',
    '24000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000002', 'Suspended person', 'suspended',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000005', 1
  ),
  (
    '54000000-0000-4000-8000-000000000003',
    '24000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000001', 'Activation person elsewhere',
    'active', pg_catalog.statement_timestamp(), null,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000006', 1
  );

select initialized.*
from vortex_identity.organizations as organization
cross join lateral vortex_access.initialize_organization_access_version(
  organization.organization_id,
  '94000000-0000-4000-8000-000000000001',
  pg_catalog.gen_random_uuid()
) as initialized
where organization.organization_id in (
  '24000000-0000-4000-8000-000000000001'::uuid,
  '24000000-0000-4000-8000-000000000002'::uuid
);

select * from vortex_access.initialize_platform_permission_catalogue(
  '24000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000007'
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
where entry.organization_id = '24000000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '34000000-0000-4000-8000-000000000001', 'activation_group',
  'Activation Group', 'active', 1,
  '94000000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  '94000000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4000000-0000-4000-8000-000000000008'
);

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000010',
  '34000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000001', 1,
  pg_catalog.statement_timestamp() - interval '1 hour',
  pg_catalog.statement_timestamp() + interval '30 minutes', 'live',
  '94000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '1 hour',
  'a4000000-0000-4000-8000-000000000009',
  '94000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '1 hour',
  'a4000000-0000-4000-8000-000000000009'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 'custom',
  'activation_role', 1, '94000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001',
  '75000000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('7', 64), 3600, true,
  'multi_factor', 600, true,
  '94000000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4000000-0000-4000-8000-000000000010'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select
  '24000000-0000-4000-8000-000000000001'::uuid,
  '74000000-0000-4000-8000-000000000001'::uuid,
  1, 1, 'custom', null, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  entry.registration_revision, registration.permission_catalogue_fingerprint,
  continuity.continuity_revision, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
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
where entry.organization_id = '24000000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform'
order by entry.permission_id
limit 1;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 1, 'custom',
  'active', 'privileged', 'activation_required', 1, 1,
  '75000000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('7', 64), 'activation_role',
  'Activation role', 'Role activation fixture.',
  '94000000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4000000-0000-4000-8000-000000000011'
);

-- A separate valid standing role proves activation rejects the role policy,
-- rather than depending on a malformed fixture.
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002', 'custom',
  'standing_role', 1, '94000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select organization_id,
  '74000000-0000-4000-8000-000000000002'::uuid,
  1, entry_ordinal, role_kind, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
from vortex_access.organization_role_permission_entries
where organization_id = '24000000-0000-4000-8000-000000000001'
  and role_id = '74000000-0000-4000-8000-000000000001'
  and role_revision = 1;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000002', 1, 'custom',
  'active', 'privileged', 'standing', 1, 1, null, null, null,
  'standing_role', 'Standing role', 'Standing role fixture.',
  '94000000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4000000-0000-4000-8000-000000000016'
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
    '24000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000001', 'organization_account',
    '54000000-0000-4000-8000-000000000001', null, 'eligible', 1,
    pg_catalog.statement_timestamp() - interval '1 hour',
    pg_catalog.statement_timestamp() + interval '2 hours', 'live',
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    'a4000000-0000-4000-8000-000000000012',
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    'a4000000-0000-4000-8000-000000000012'
  ),
  (
    '24000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000002',
    '74000000-0000-4000-8000-000000000001', 'group', null,
    '34000000-0000-4000-8000-000000000001', 'eligible', 1,
    pg_catalog.statement_timestamp() - interval '1 hour',
    pg_catalog.statement_timestamp() + interval '90 minutes', 'live',
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    'a4000000-0000-4000-8000-000000000013',
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    'a4000000-0000-4000-8000-000000000013'
  ),
  (
    '24000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000003',
    '74000000-0000-4000-8000-000000000001', 'organization_account',
    '54000000-0000-4000-8000-000000000001', null, 'eligible', 1,
    pg_catalog.statement_timestamp() - interval '1 hour',
    pg_catalog.statement_timestamp() + interval '20 minutes', 'live',
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    'a4000000-0000-4000-8000-000000000015',
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp() - interval '1 hour',
    'a4000000-0000-4000-8000-000000000015'
  );

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select organization_id, role_id, 2, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
from vortex_access.organization_role_permission_entries
where organization_id = '24000000-0000-4000-8000-000000000001'
  and role_id = '74000000-0000-4000-8000-000000000001'
  and role_revision = 1;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 2, 'custom',
  'active', 'privileged', 'activation_required', 1, 1,
  '75000000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('7', 64), 'activation_role',
  'Activation role', 'Role activation fixture.',
  '94000000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4000000-0000-4000-8000-000000000014'
);

update vortex_access.organization_roles
set live_revision = 2
where organization_id = '24000000-0000-4000-8000-000000000001'
  and role_id = '74000000-0000-4000-8000-000000000001';

set constraints all immediate;
set constraints all deferred;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000095', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000002', 1, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000038'
    )
  $$,
  '40001'::char(5), null,
  'a standing role cannot create an activation window'
);

set constraints all immediate;
set constraints all deferred;
savepoint empty_retained_authority;
alter table vortex_access.organization_role_permission_entries
  disable trigger organization_role_permission_entries_immutable;
delete from vortex_access.organization_role_permission_entries
where organization_id = '24000000-0000-4000-8000-000000000001'
  and role_id = '74000000-0000-4000-8000-000000000001'
  and role_revision = 2;
alter table vortex_access.organization_role_permission_entries
  enable trigger organization_role_permission_entries_immutable;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000096', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000039'
    )
  $$,
  '40001'::char(5), null,
  'a current role with no retained accepted authority cannot activate'
);

rollback to savepoint empty_retained_authority;

create temporary table direct_activation on commit drop as
select *
from vortex_access.coordinate_organization_role_activation_change(
  'activate_role',
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001', null,
  '54000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 2, 600, 'direct',
  '84000000-0000-4000-8000-000000000001', 1, null, null,
  '94000000-0000-4000-8000-000000000002',
  'a4000000-0000-4000-8000-000000000020'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, operation, activation ->> 'roleActivationId',
      activation #>> '{eligibilitySource,kind}', activation ->> 'state',
      activation ->> 'revision', access_version, correlation_id
    )
    from direct_activation
  ),
  'changed|activate_role|64000000-0000-4000-8000-000000000001|direct|live|1|3|a4000000-0000-4000-8000-000000000020',
  'direct activation returns one exact account-bound revision-one fact and Access increment'
);

select is(
  (
    select extract(epoch from (
      (activation ->> 'expiresAt')::timestamptz -
      (activation ->> 'activatedAt')::timestamptz
    ))::bigint
    from direct_activation
  ),
  600::bigint,
  'requested duration caps a direct activation before timestamp arithmetic'
);

select is(
  (
    select pg_catalog.to_jsonb(stored.*) - array['activated_at', 'expires_at', 'changed_at']
    from vortex_access.organization_role_activations as stored
    where stored.organization_id = '24000000-0000-4000-8000-000000000001'
      and stored.role_activation_id = '64000000-0000-4000-8000-000000000001'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'organization_id', (activation ->> 'organizationId')::uuid,
      'role_activation_id', (activation ->> 'roleActivationId')::uuid,
      'organization_account_id', (activation ->> 'organizationAccountId')::uuid,
      'role_id', (activation ->> 'roleId')::uuid,
      'revision', (activation ->> 'revision')::bigint,
      'historical_role_revision', (activation ->> 'historicalRoleRevision')::bigint,
      'authority_continuity_revision', (activation ->> 'authorityContinuityRevision')::bigint,
      'policy_continuity_revision', (activation ->> 'policyContinuityRevision')::bigint,
      'activation_policy_id', (activation #>> '{activationPolicy,activationPolicyId}')::uuid,
      'activation_policy_revision', (activation #>> '{activationPolicy,revision}')::bigint,
      'activation_policy_fingerprint', activation #>> '{activationPolicy,fingerprint}',
      'eligibility_source_kind', activation #>> '{eligibilitySource,kind}',
      'role_assignment_id', (activation #>> '{eligibilitySource,eligibilityAssignment,roleAssignmentId}')::uuid,
      'role_assignment_revision', (activation #>> '{eligibilitySource,eligibilityAssignment,revision}')::bigint,
      'membership_id', null, 'membership_revision', null,
      'state', activation ->> 'state',
      'activated_by', (activation ->> 'activatedByActorId')::uuid,
      'activation_correlation_id', (activation ->> 'activationCorrelationId')::uuid,
      'changed_by', (activation ->> 'changedByActorId')::uuid,
      'change_correlation_id', (activation ->> 'changeCorrelationId')::uuid,
      'revoked_by', null, 'revoked_at', null,
      'revocation_correlation_id', null
    )
    from direct_activation
  ),
  'activation returns the complete exact stored role, policy, authority and source evidence'
);

create temporary table policy_capped_activation on commit drop as
select *
from vortex_access.coordinate_organization_role_activation_change(
  'activate_role',
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000002', null,
  '54000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 2, 7200, 'direct',
  '84000000-0000-4000-8000-000000000001', 1, null, null,
  '94000000-0000-4000-8000-000000000003',
  'a4000000-0000-4000-8000-000000000021'
);

select is(
  (
    select extract(epoch from (
      (activation ->> 'expiresAt')::timestamptz -
      (activation ->> 'activatedAt')::timestamptz
    ))::bigint
    from policy_capped_activation
  ),
  3600::bigint,
  'the immutable policy maximum independently caps activation duration'
);

savepoint assignment_expiry_cap;

create temporary table assignment_capped_activation on commit drop as
select *
from vortex_access.coordinate_organization_role_activation_change(
  'activate_role',
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000006', null,
  '54000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 2, 7200, 'direct',
  '84000000-0000-4000-8000-000000000003', 1, null, null,
  '94000000-0000-4000-8000-000000000003',
  'a4000000-0000-4000-8000-000000000035'
);

select is(
  (
    select (activation ->> 'expiresAt')::timestamptz
    from assignment_capped_activation
  ),
  (
    select expires_at
    from vortex_access.organization_role_assignments
    where organization_id = '24000000-0000-4000-8000-000000000001'
      and role_assignment_id = '84000000-0000-4000-8000-000000000003'
  ),
  'the finite eligible-assignment window independently caps activation expiry'
);

rollback to savepoint assignment_expiry_cap;

create temporary table group_activation on commit drop as
select *
from vortex_access.coordinate_organization_role_activation_change(
  'activate_role',
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000003', null,
  '54000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 2, 7200, 'group',
  '84000000-0000-4000-8000-000000000002', 1,
  '64000000-0000-4000-8000-000000000010', 1,
  '94000000-0000-4000-8000-000000000004',
  'a4000000-0000-4000-8000-000000000022'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', activation ->> 'organizationAccountId',
      activation #>> '{eligibilitySource,kind}',
      activation #>> '{eligibilitySource,originatingMembership,membershipId}',
      ((activation ->> 'expiresAt')::timestamptz = membership.expires_at)
    )
    from group_activation
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id =
        (activation ->> 'organizationId')::uuid
      and membership.membership_id =
        (activation #>> '{eligibilitySource,originatingMembership,membershipId}')::uuid
  ),
  '54000000-0000-4000-8000-000000000001|group|64000000-0000-4000-8000-000000000010|t',
  'Group eligibility activates only the named member and caps at membership expiry'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_activations
    where organization_id = '24000000-0000-4000-8000-000000000001'
      and organization_account_id = '54000000-0000-4000-8000-000000000001'
      and role_id = '74000000-0000-4000-8000-000000000001'
      and state = 'live'
  ),
  3,
  'independent valid activation identities coexist for one account and role'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000023'
    )
  $$,
  '40001'::char(5),
  'Organization role activation is stale or unavailable',
  'duplicate activation identity refuses without replacing an existing window'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000090', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 1, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000024'
    )
  $$,
  '40001'::char(5), null,
  'stale reviewed role revision refuses activation'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000094', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 2, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000036'
    )
  $$,
  '40001'::char(5), null,
  'stale eligible-assignment revision refuses activation'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000091', null,
      '54000000-0000-4000-8000-000000000003',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000025'
    )
  $$,
  '40001'::char(5), null,
  'foreign organization account cannot become an activation beneficiary'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000092', null,
      '54000000-0000-4000-8000-000000000002',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'direct',
      '84000000-0000-4000-8000-000000000001', 1, null, null,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000026'
    )
  $$,
  '40001'::char(5), null,
  'inactive beneficiary account refuses activation'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000093', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'group',
      '84000000-0000-4000-8000-000000000002', 1,
      '64000000-0000-4000-8000-000000000010', 2,
      '94000000-0000-4000-8000-000000000005',
      'a4000000-0000-4000-8000-000000000027'
    )
  $$,
  '40001'::char(5), null,
  'stale originating membership revision refuses Group activation'
);

-- The validator now accepts a database-owned observation after statement start.
insert into vortex_access.organization_role_activations (
  organization_id, role_activation_id, organization_account_id, role_id,
  revision, historical_role_revision, authority_continuity_revision,
  policy_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  eligibility_source_kind, role_assignment_id, role_assignment_revision,
  state, activated_by, activated_at, expires_at,
  activation_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000004',
  '54000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 1, 2, 1, 1,
  '75000000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('7', 64), 'direct',
  '84000000-0000-4000-8000-000000000001', 1, 'live',
  '94000000-0000-4000-8000-000000000006', pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp() + interval '1 minute',
  'a4000000-0000-4000-8000-000000000028',
  '94000000-0000-4000-8000-000000000006', pg_catalog.clock_timestamp(),
  'a4000000-0000-4000-8000-000000000029'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_activations
    where role_activation_id = '64000000-0000-4000-8000-000000000004'
  ),
  1,
  'the corrected validator retains a post-statement-start activation observation'
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
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000005',
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 1, 2, 1, 1,
      '75000000-0000-4000-8000-000000000001', 1,
      'sha256:' || pg_catalog.repeat('7', 64), 'direct',
      '84000000-0000-4000-8000-000000000001', 1, 'live',
      '94000000-0000-4000-8000-000000000006',
      pg_catalog.statement_timestamp() - interval '1 second',
      pg_catalog.statement_timestamp() + interval '1 minute',
      'a4000000-0000-4000-8000-000000000030',
      '94000000-0000-4000-8000-000000000006',
      pg_catalog.statement_timestamp(),
      'a4000000-0000-4000-8000-000000000031'
    )
  $$,
  '23514'::char(5), null,
  'the corrected validator still refuses backdated raw activation'
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
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000007',
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 1, 2, 1, 1,
      '75000000-0000-4000-8000-000000000001', 1,
      'sha256:' || pg_catalog.repeat('7', 64), 'direct',
      '84000000-0000-4000-8000-000000000001', 1, 'live',
      '94000000-0000-4000-8000-000000000006',
      pg_catalog.statement_timestamp() + interval '1 hour',
      pg_catalog.statement_timestamp() + interval '2 hours',
      'a4000000-0000-4000-8000-000000000037',
      '94000000-0000-4000-8000-000000000006',
      pg_catalog.statement_timestamp() + interval '1 hour',
      'a4000000-0000-4000-8000-000000000037'
    )
  $$,
  '23514'::char(5), null,
  'the corrected validator refuses future raw activation evidence'
);

savepoint activation_revision_exhaustion;
set local session_replication_role = replica;
update vortex_access.organization_role_activations
set revision = 9007199254740991
where organization_id = '24000000-0000-4000-8000-000000000001'
  and role_activation_id = '64000000-0000-4000-8000-000000000002';
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'revoke_role_activation',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000002', 9007199254740991,
      null, null, null, null, null, null, null, null, null,
      '94000000-0000-4000-8000-000000000010',
      'a4000000-0000-4000-8000-000000000041'
    )
  $$,
  '22003'::char(5),
  'Organization role activation revision is exhausted',
  'activation revision exhaustion refuses without changing the fact'
);

select is(
  (
    select pg_catalog.concat_ws('|', state, revision)
    from vortex_access.organization_role_activations
    where organization_id = '24000000-0000-4000-8000-000000000001'
      and role_activation_id = '64000000-0000-4000-8000-000000000002'
  ),
  'live|9007199254740991',
  'activation revision exhaustion leaves its controlled predecessor intact'
);

rollback to savepoint activation_revision_exhaustion;

savepoint activation_access_exhaustion;
set local session_replication_role = replica;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '24000000-0000-4000-8000-000000000001';
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000008', null,
      '54000000-0000-4000-8000-000000000001',
      '74000000-0000-4000-8000-000000000001', 2, 60, 'direct',
      '84000000-0000-4000-8000-000000000003', 1, null, null,
      '94000000-0000-4000-8000-000000000010',
      'a4000000-0000-4000-8000-000000000042'
    )
  $$,
  '22003'::char(5),
  'Access version is exhausted',
  'Access exhaustion rolls back activation insertion'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_activations
    where organization_id = '24000000-0000-4000-8000-000000000001'
      and role_activation_id = '64000000-0000-4000-8000-000000000008'
  ),
  0,
  'Access exhaustion leaves no activation fact behind'
);

rollback to savepoint activation_access_exhaustion;

-- Revoke the direct source first. Reduction of the activation must remain possible.
select *
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke',
  '24000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null,
  '94000000-0000-4000-8000-000000000007',
  'a4000000-0000-4000-8000-000000000032'
);

create temporary table revoked_activation on commit drop as
select *
from vortex_access.coordinate_organization_role_activation_change(
  'revoke_role_activation',
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null, null,
  '94000000-0000-4000-8000-000000000008',
  'a4000000-0000-4000-8000-000000000033'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', activation ->> 'state', activation ->> 'revision',
      activation #>> '{eligibilitySource,eligibilityAssignment,roleAssignmentId}',
      activation ->> 'activatedByActorId', activation ->> 'revokedByActorId',
      access_version
    )
    from revoked_activation
  ),
  'revoked|2|84000000-0000-4000-8000-000000000001|94000000-0000-4000-8000-000000000002|94000000-0000-4000-8000-000000000008|7',
  'revocation after source loss preserves activation provenance and changes Access once'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_activations
    where organization_id = '24000000-0000-4000-8000-000000000001'
      and role_activation_id in (
        '64000000-0000-4000-8000-000000000002'::uuid,
        '64000000-0000-4000-8000-000000000003'::uuid
      )
      and state = 'live'
  ),
  2,
  'revoking one independent activation leaves the other source-bound windows intact'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'revoke_role_activation',
      '24000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', 1,
      null, null, null, null, null, null, null, null, null,
      '94000000-0000-4000-8000-000000000009',
      'a4000000-0000-4000-8000-000000000034'
    )
  $$,
  '40001'::char(5), null,
  'stale revocation cannot change a terminal activation twice'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', current_version, changed_by, change_correlation_id, change_reason
    )
    from vortex_access.organization_access_versions
    where organization_id = '24000000-0000-4000-8000-000000000001'
  ),
  '7|94000000-0000-4000-8000-000000000008|a4000000-0000-4000-8000-000000000033|role_activation_changed',
  'the successful activation change records the truthful Access reason and evidence'
);

set constraints all immediate;

select * from finish();

rollback;
