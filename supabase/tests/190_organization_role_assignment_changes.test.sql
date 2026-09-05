\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'coordinate_organization_role_assignment_change',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'bigint', 'text', 'uuid',
    'uuid', 'text', 'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid'
  ],
  'Access exposes one private role-assignment composition'
);

select volatility_is(
  'vortex_access', 'coordinate_organization_role_assignment_change',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'bigint', 'text', 'uuid',
    'uuid', 'text', 'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid'
  ], 'volatile',
  'the role-assignment composition performs one atomic fact and Access change'
);

select is(
  (
    select prosecdef
    from pg_catalog.pg_proc
    where oid = 'vortex_access.coordinate_organization_role_assignment_change(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure
  ),
  false,
  'the owner-only composition remains security invoker'
);

select is(
  (
    select proconfig
    from pg_catalog.pg_proc
    where oid = 'vortex_access.coordinate_organization_role_assignment_change(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure
  ),
  array['search_path=""'],
  'the owner-only composition has an empty fixed search path'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('vortex_runtime'::name), ('vortex_request'::name)
    ) as denied(role_name)
    where pg_catalog.has_function_privilege(
      denied.role_name,
      'vortex_access.coordinate_organization_role_assignment_change(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure,
      'EXECUTE'
    )
  ),
  0,
  'PUBLIC, browser, service, runtime and request roles cannot invoke assignment changes'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('vortex_runtime'::name), ('vortex_request'::name)
    ) as denied(role_name)
    where pg_catalog.has_table_privilege(
      denied.role_name,
      'vortex_access.organization_role_assignments'::regclass,
      'SELECT,INSERT,UPDATE,DELETE'
    )
  ),
  0,
  'the assignment table remains private after adding the composition'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values
  (
    '11900000-0000-4000-8000-000000000001', 'assignment_changes',
    'Assignment changes', 'active', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '11900000-0000-4000-8000-000000000002', 'inactive_assignment_tenant',
    'Inactive assignment tenant', 'active', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '21900000-0000-4000-8000-000000000001',
    '11900000-0000-4000-8000-000000000001', 'assignment_changes_one',
    'Assignment changes one', 'active', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '21900000-0000-4000-8000-000000000002',
    '11900000-0000-4000-8000-000000000001', 'assignment_changes_two',
    'Assignment changes two', 'active', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '21900000-0000-4000-8000-000000000003',
    '11900000-0000-4000-8000-000000000001', 'inactive_assignment_org',
    'Inactive assignment organization', 'active', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '21900000-0000-4000-8000-000000000004',
    '11900000-0000-4000-8000-000000000002', 'assignment_in_inactive_tenant',
    'Assignment in inactive tenant', 'active', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '41900000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000001', 1
  ),
  (
    '41900000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '51900000-0000-4000-8000-000000000001',
    '21900000-0000-4000-8000-000000000001',
    '41900000-0000-4000-8000-000000000001', 'Assignment person', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000003', 1
  ),
  (
    '51900000-0000-4000-8000-000000000002',
    '21900000-0000-4000-8000-000000000002',
    '41900000-0000-4000-8000-000000000001', 'Assignment person elsewhere', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000004', 1
  ),
  (
    '51900000-0000-4000-8000-000000000003',
    '21900000-0000-4000-8000-000000000001',
    '41900000-0000-4000-8000-000000000002', 'Inactive assignment person', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000005', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21900000-0000-4000-8000-000000000001',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_organization_access_version(
  '21900000-0000-4000-8000-000000000002',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000007'
);
select * from vortex_access.initialize_organization_access_version(
  '21900000-0000-4000-8000-000000000003',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000008'
);
select * from vortex_access.initialize_organization_access_version(
  '21900000-0000-4000-8000-000000000004',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000009'
);

select * from vortex_access.initialize_platform_permission_catalogue(
  '21900000-0000-4000-8000-000000000001',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000010'
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
where entry.organization_id = '21900000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '21900000-0000-4000-8000-000000000001',
    '31900000-0000-4000-8000-000000000001', 'review_group', 'Review Group',
    'active', 1, '91900000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '91900000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '71900000-0000-4000-8000-000000000011'
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '31900000-0000-4000-8000-000000000002', 'inactive_group', 'Inactive Group',
    'active', 1, '91900000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '91900000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '71900000-0000-4000-8000-000000000012'
  ),
  (
    '21900000-0000-4000-8000-000000000002',
    '31900000-0000-4000-8000-000000000001', 'foreign_review_group',
    'Foreign Review Group', 'active', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000013'
  ),
  (
    '21900000-0000-4000-8000-000000000002',
    '31900000-0000-4000-8000-000000000009', 'foreign_only_group',
    'Foreign only Group', 'active', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000130'
  );

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision, state,
  operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '21900000-0000-4000-8000-000000000001', 'application',
  '37900000-0000-4000-8000-000000000001', 1, 'active', 'register',
  'example.assignment_changes', '1.0.0', 1, '2.18.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.statement_timestamp(),
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000014'
);
insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state, revision,
  source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '21900000-0000-4000-8000-000000000001', 'application',
  '37900000-0000-4000-8000-000000000001', 'active', 1,
  'example.assignment_changes', '1.0.0', 1, '2.18.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.statement_timestamp(),
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000014'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000001', 'custom', 'standing_reader', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000002', 'custom', 'eligible_reader', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000003', 'custom', 'retired_reader', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  );

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000004', 'application', 'pending_reader',
    '37900000-0000-4000-8000-000000000001',
    '62900000-0000-4000-8000-000000000004', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000005', 'application', 'unavailable_reader',
    '37900000-0000-4000-8000-000000000001',
    '62900000-0000-4000-8000-000000000005', 1,
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  );

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '21900000-0000-4000-8000-000000000001',
  '61900000-0000-4000-8000-000000000002',
  '62900000-0000-4000-8000-000000000002', 1,
  'sha256:' || pg_catalog.repeat('5', 64), 3600, false, 'none', null, false,
  '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  '71900000-0000-4000-8000-000000000015'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select '21900000-0000-4000-8000-000000000001'::uuid, target.role_id,
  1, 1, 'custom', null, entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.registration_kind, entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, continuity.continuity_revision,
  entry.meaning_fingerprint
from (
  values
    ('61900000-0000-4000-8000-000000000001'::uuid),
    ('61900000-0000-4000-8000-000000000002'::uuid),
    ('61900000-0000-4000-8000-000000000003'::uuid)
) as target(role_id)
cross join lateral (
  select catalogue.*
  from vortex_access.permission_catalogue_entries as catalogue
  where catalogue.organization_id = '21900000-0000-4000-8000-000000000001'
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
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000001', 1, 'custom', 'active',
    'privileged', 'standing', 1, 1, null, null, null,
    'standing_reader', 'Standing reader', 'Standing assignment fixture.',
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000016'
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000002', 1, 'custom', 'active',
    'privileged', 'activation_required', 1, 1,
    '62900000-0000-4000-8000-000000000002', 1,
    'sha256:' || pg_catalog.repeat('5', 64),
    'eligible_reader', 'Eligible reader', 'Eligible assignment fixture.',
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000017'
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000003', 1, 'custom', 'retired',
    'privileged', 'standing', 1, 1, null, null, null,
    'retired_reader', 'Retired reader', 'Retired assignment fixture.',
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000018'
  );

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  source_definition_key, source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000004', 1, 'application',
    '37900000-0000-4000-8000-000000000001', 'acceptance_required',
    'standard', 'standing', 1, 1, 'pending_reader', 'Pending reader',
    'Pending assignment fixture.', 'example.assignment_changes', 1, '1.0.0',
    '2.18.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('3', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('7', 64),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000019'
  ),
  (
    '21900000-0000-4000-8000-000000000001',
    '61900000-0000-4000-8000-000000000005', 1, 'application',
    '37900000-0000-4000-8000-000000000001', 'unavailable',
    'standard', 'standing', 1, 1, 'unavailable_reader', 'Unavailable reader',
    'Unavailable assignment fixture.', 'example.assignment_changes', 1, '1.0.0',
    '2.18.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('8', 64),
    'sha256:' || pg_catalog.repeat('3', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('9', 64),
    '91900000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '71900000-0000-4000-8000-000000000020'
  );

set constraints all immediate;
set constraints all deferred;

create temporary table assignment_change_baseline as
select current_version
from vortex_access.organization_access_versions
where organization_id = '21900000-0000-4000-8000-000000000001';

create temporary table assignment_change_results as
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000001', null,
  '61900000-0000-4000-8000-000000000001', 1,
  'organization_account', '51900000-0000-4000-8000-000000000001', null,
  'standing', pg_catalog.clock_timestamp() - interval '1 minute', null,
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000021'
);

insert into assignment_change_results
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000002', null,
  '61900000-0000-4000-8000-000000000001', 1,
  'group', null, '31900000-0000-4000-8000-000000000001',
  'standing', pg_catalog.clock_timestamp() + interval '1 hour',
  pg_catalog.clock_timestamp() + interval '2 hours',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000022'
);

insert into assignment_change_results
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000003', null,
  '61900000-0000-4000-8000-000000000002', 1,
  'organization_account', '51900000-0000-4000-8000-000000000001', null,
  'eligible', pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.clock_timestamp() + interval '2 hours',
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000023'
);

insert into assignment_change_results
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000004', null,
  '61900000-0000-4000-8000-000000000002', 1,
  'group', null, '31900000-0000-4000-8000-000000000001',
  'eligible', pg_catalog.clock_timestamp() - interval '1 minute', null,
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000024'
);

select is(
  (select pg_catalog.count(*)::integer from assignment_change_results), 4,
  'all direct and Group standing and eligible grants return one changed fact'
);

select results_eq(
  $$
    select assignee_kind, assignment_kind, state, revision
    from assignment_change_results
    order by role_assignment_id
  $$,
  $$ values
    ('organization_account'::text, 'standing'::text, 'live'::text, 1::bigint),
    ('group'::text, 'standing'::text, 'live'::text, 1::bigint),
    ('organization_account'::text, 'eligible'::text, 'live'::text, 1::bigint),
    ('group'::text, 'eligible'::text, 'live'::text, 1::bigint)
  $$,
  'the grant matrix preserves explicit holder and assignment kinds'
);

select is(
  (
    select current_version from vortex_access.organization_access_versions
    where organization_id = '21900000-0000-4000-8000-000000000001'
  ),
  (select current_version + 4 from assignment_change_baseline),
  'four successful grants increment Access exactly four times'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from assignment_change_results
    where outcome = 'changed'
      and granted_by_actor_id = '91900000-0000-4000-8000-000000000001'
      and changed_by_actor_id = granted_by_actor_id
      and changed_at = granted_at
      and change_correlation_id = correlation_id
      and grant_correlation_id = correlation_id
      and revoked_at is null
  ),
  4,
  'grants derive complete original and current evidence from one database operation'
);

-- Independent assignment identities for the same holder and role remain separate.
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000005', null,
  '61900000-0000-4000-8000-000000000001', 1,
  'organization_account', '51900000-0000-4000-8000-000000000001', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '91900000-0000-4000-8000-000000000001',
  '71900000-0000-4000-8000-000000000025'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_assignments
    where organization_id = '21900000-0000-4000-8000-000000000001'
      and role_id = '61900000-0000-4000-8000-000000000001'
      and organization_account_id = '51900000-0000-4000-8000-000000000001'
  ),
  2,
  'independent assignment identities are not merged'
);

create temporary table refusal_version as
select version.current_version,
  (
    select pg_catalog.count(*)::bigint
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = version.organization_id
  ) as assignment_count
from vortex_access.organization_access_versions as version
where version.organization_id = '21900000-0000-4000-8000-000000000001';

create temporary table foreign_refusal_version as
select current_version
from vortex_access.organization_access_versions
where organization_id = '21900000-0000-4000-8000-000000000002';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    null, '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000090', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000090') $$,
  '22023'::char(5), null, 'a null operation is refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'replace', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000089', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000089') $$,
  '22023'::char(5), null, 'unknown operations are refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '00000000-0000-0000-0000-000000000000',
    '63900000-0000-4000-8000-000000000088', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000088') $$,
  '22023'::char(5), null, 'nil organization identity is refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000087') $$,
  '22023'::char(5), null, 'nil assignment identity is refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000086', null,
    '00000000-0000-0000-0000-000000000000', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000086') $$,
  '22023'::char(5), null, 'nil role identity is refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000091', 1,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000091') $$,
  '22023'::char(5), null, 'grant refuses revoke-only expected assignment evidence'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000079', null,
    '61900000-0000-4000-8000-000000000001', null,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000079') $$,
  '22023'::char(5), null, 'grant requires expected role revision evidence'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000078', null,
    '61900000-0000-4000-8000-000000000001', 1,
    null, '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000078') $$,
  '22023'::char(5), null, 'grant requires an assignee discriminator'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000092', null,
    '61900000-0000-4000-8000-000000000001', 9007199254740992,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000092') $$,
  '22023'::char(5), null, 'unsafe expected role revisions are refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', 9007199254740992,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000085') $$,
  '22023'::char(5), null, 'unsafe expected assignment revisions are refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', null,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000077') $$,
  '22023'::char(5), null, 'revoke requires expected assignment revision evidence'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000076', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '00000000-0000-0000-0000-000000000000',
    '71900000-0000-4000-8000-000000000076') $$,
  '22023'::char(5), null, 'nil trusted actors are refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000075', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000') $$,
  '22023'::char(5), null, 'nil trusted correlations are refused before effects'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', 1,
    '61900000-0000-4000-8000-000000000001', null, null, null, null, null,
    null, null, '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000084') $$,
  '22023'::char(5), null, 'revocation refuses grant-only role evidence'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000093', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'group', '51900000-0000-4000-8000-000000000001',
    '31900000-0000-4000-8000-000000000001', 'standing',
    pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000093') $$,
  '22023'::char(5), null, 'mixed account and Group holder fields are refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000094', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() - interval '1 second',
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000094') $$,
  '22023'::char(5), null, 'a reversed grant window is refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000083', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', 'infinity'::timestamptz, null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000083') $$,
  '22023'::char(5), null, 'infinite grant starts are refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000082', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), 'infinity'::timestamptz,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000082') $$,
  '22023'::char(5), null, 'infinite grant expiry is refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000095', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() - interval '1 hour',
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000095') $$,
  '40001'::char(5), null, 'a newly expired grant is refused after locking'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000096', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'eligible', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000096') $$,
  '40001'::char(5), null, 'standing roles refuse eligible assignments'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000097', null,
    '61900000-0000-4000-8000-000000000004', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000097') $$,
  '40001'::char(5), null, 'acceptance-required roles refuse new assignments'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000098', null,
    '61900000-0000-4000-8000-000000000005', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000098') $$,
  '40001'::char(5), null, 'unavailable roles refuse new assignments'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000099', null,
    '61900000-0000-4000-8000-000000000003', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000099') $$,
  '40001'::char(5), null, 'retired roles refuse new assignments'
);

update vortex_identity.organization_accounts
set state = 'suspended', revision = 2,
  suspended_at = pg_catalog.statement_timestamp(),
  state_changed_at = pg_catalog.statement_timestamp(),
  changed_at = pg_catalog.statement_timestamp(),
  state_changed_by = '91900000-0000-4000-8000-000000000001',
  state_change_correlation_id = '71900000-0000-4000-8000-000000000100'
where organization_id = '21900000-0000-4000-8000-000000000001'
  and organization_account_id = '51900000-0000-4000-8000-000000000003';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000100', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000003', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000101') $$,
  '40001'::char(5), null, 'inactive accounts refuse new assignments'
);

update vortex_access.organization_groups
set state = 'retired', revision = 2,
  changed_at = pg_catalog.clock_timestamp(),
  change_correlation_id = '71900000-0000-4000-8000-000000000102'
where organization_id = '21900000-0000-4000-8000-000000000001'
  and group_id = '31900000-0000-4000-8000-000000000002';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000102', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'group', null, '31900000-0000-4000-8000-000000000002',
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000103') $$,
  '40001'::char(5), null, 'retired Groups refuse new assignments'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000103', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000002', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000104') $$,
  '40001'::char(5), null, 'same-identity accounts in another organization cannot be substituted'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000081', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '41900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000081') $$,
  '40001'::char(5), null, 'a global identity cannot substitute for an organization account'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000080', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'group', null, '31900000-0000-4000-8000-000000000009',
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000080') $$,
  '40001'::char(5), null, 'a Group in another organization cannot be substituted'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000002',
    '63900000-0000-4000-8000-000000000104', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000002', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000104') $$,
  '40001'::char(5), null,
  'a role belonging to another organization is indistinguishable from unavailable'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000105') $$,
  '23505'::char(5), null, 'a duplicate permanent assignment identity is refused'
);

select is(
  (
    select current_version from vortex_access.organization_access_versions
    where organization_id = '21900000-0000-4000-8000-000000000001'
  ),
  (select current_version from refusal_version),
  'all refused grants leave Access unchanged'
);

select is(
  (
    select pg_catalog.count(*)::bigint
    from vortex_access.organization_role_assignments
    where organization_id = '21900000-0000-4000-8000-000000000001'
  ),
  (select assignment_count from refusal_version),
  'all refused grants leave the complete assignment set unchanged'
);

select is(
  (
    select current_version from vortex_access.organization_access_versions
    where organization_id = '21900000-0000-4000-8000-000000000002'
  ),
  (select current_version from foreign_refusal_version),
  'foreign-role refusal does not increment the other organization Access version'
);

-- Advance one role without changing its policy. The old reviewed revision must
-- still be refused rather than treated as equivalent current authority.
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
where organization_id = '21900000-0000-4000-8000-000000000001'
  and role_id = '61900000-0000-4000-8000-000000000001'
  and role_revision = 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '21900000-0000-4000-8000-000000000001',
  '61900000-0000-4000-8000-000000000001', 2, 'custom', 'active',
  'privileged', 'standing', 1, 1, 'standing_reader', 'Standing reader updated',
  'Same-mode revision requires fresh grant review.',
  '91900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  '71900000-0000-4000-8000-000000000106'
);
update vortex_access.organization_roles
set live_revision = 2
where organization_id = '21900000-0000-4000-8000-000000000001'
  and role_id = '61900000-0000-4000-8000-000000000001';
set constraints all immediate;
set constraints all deferred;

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000106', null,
    '61900000-0000-4000-8000-000000000001', 1,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000001',
    '71900000-0000-4000-8000-000000000107') $$,
  '40001'::char(5), null,
  'a same-policy role revision still makes the reviewed grant revision stale'
);

create temporary table grant_one_before as
select pg_catalog.to_jsonb(snapshot.*) as snapshot
from (
  select assignment.organization_id, assignment.role_assignment_id,
    assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.revision, assignment.starts_at,
    assignment.expires_at, assignment.state,
    assignment.granted_by as granted_by_actor_id, assignment.granted_at,
    assignment.grant_correlation_id,
    assignment.changed_by as changed_by_actor_id, assignment.changed_at,
    assignment.change_correlation_id,
    assignment.revoked_by as revoked_by_actor_id, assignment.revoked_at,
    assignment.revocation_correlation_id
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = '21900000-0000-4000-8000-000000000001'
    and assignment.role_assignment_id = '63900000-0000-4000-8000-000000000001'
) as snapshot;

create temporary table revoke_result as
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null,
  '91900000-0000-4000-8000-000000000002',
  '71900000-0000-4000-8000-000000000108'
);

select is(
  (
    select pg_catalog.to_jsonb(result.*) - array[
      'outcome', 'operation', 'revision', 'state', 'changed_by_actor_id',
      'changed_at', 'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
      'revocation_correlation_id', 'access_version', 'correlation_id'
    ]::text[]
    from revoke_result as result
  ),
  (
    select snapshot - array[
      'revision', 'state', 'changed_by_actor_id', 'changed_at',
      'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
      'revocation_correlation_id'
    ]::text[]
    from grant_one_before
  ),
  'revocation preserves the exact original role, holder, kind, window and grant provenance'
);

select is(
  (
    select revision || ':' || state || ':' ||
      (changed_by_actor_id = revoked_by_actor_id)::text || ':' ||
      (change_correlation_id = revocation_correlation_id)::text
    from revoke_result
  ),
  '2:revoked:true:true',
  'revocation advances once and derives coherent current and revocation evidence'
);

-- Retiring a Group after its assignment and advancing an eligible role do not
-- block terminal reduction. Natural expiry is timing-only and also cannot block it.
update vortex_access.organization_groups
set state = 'retired', revision = 2, changed_at = pg_catalog.clock_timestamp(),
  change_correlation_id = '71900000-0000-4000-8000-000000000109'
where organization_id = '21900000-0000-4000-8000-000000000001'
  and group_id = '31900000-0000-4000-8000-000000000001';

select lives_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000002', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000110') $$,
  'a scheduled Group assignment can be revoked after the Group retires'
);

-- Controlled current fact: the writer must revoke a naturally expired live row.
alter table vortex_access.organization_role_assignments
  disable trigger organization_role_assignments_validate_insert;
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '21900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000006',
  '61900000-0000-4000-8000-000000000002', 'organization_account',
  '51900000-0000-4000-8000-000000000001', null, 'eligible', 1,
  pg_catalog.clock_timestamp() - interval '2 hours',
  pg_catalog.clock_timestamp() - interval '1 hour', 'live',
  '91900000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() - interval '2 hours',
  '71900000-0000-4000-8000-000000000111',
  '91900000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp() - interval '2 hours',
  '71900000-0000-4000-8000-000000000112'
);
alter table vortex_access.organization_role_assignments
  enable trigger organization_role_assignments_validate_insert;

select lives_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000006', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000113') $$,
  'natural expiry does not prevent explicit revocation'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000114') $$,
  '40001'::char(5), null, 'a stale revocation retry is refused'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', 2,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000115') $$,
  '40001'::char(5), null, 'terminal assignment revocation cannot be repeated'
);

-- Inactive organization and tenant scope refuse before fact mutation.
update vortex_identity.organizations
set state = 'suspended', revision = 2,
  state_changed_at = pg_catalog.clock_timestamp()
where organization_id = '21900000-0000-4000-8000-000000000003';
update vortex_identity.tenants
set state = 'suspended', revision = 2,
  state_changed_at = pg_catalog.clock_timestamp()
where tenant_id = '11900000-0000-4000-8000-000000000002';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000003',
    '63900000-0000-4000-8000-000000000080', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000116') $$,
  '42501'::char(5), null, 'inactive organization scope is unavailable before assignment reads'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000004',
    '63900000-0000-4000-8000-000000000081', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000117') $$,
  '42501'::char(5), null, 'inactive tenant scope is unavailable before assignment reads'
);

-- Test-only corruption creates the two bounded exhaustion states. Each call is
-- a subtransaction under throws_ok, so its attempted fact change rolls back.
set constraints all immediate;
alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '21900000-0000-4000-8000-000000000001';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;

create temporary table access_exhaustion_assignment as
select pg_catalog.to_jsonb(assignment.*) as snapshot
from vortex_access.organization_role_assignments as assignment
where organization_id = '21900000-0000-4000-8000-000000000001'
  and role_assignment_id = '63900000-0000-4000-8000-000000000003';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000118', null,
    '61900000-0000-4000-8000-000000000001', 2,
    'organization_account', '51900000-0000-4000-8000-000000000001', null,
    'standing', pg_catalog.clock_timestamp(), null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000118') $$,
  '22003'::char(5), null, 'Access exhaustion rolls back a new grant'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_assignments
    where organization_id = '21900000-0000-4000-8000-000000000001'
      and role_assignment_id = '63900000-0000-4000-8000-000000000118'
  ),
  0,
  'Access exhaustion leaves no partial grant fact'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000003', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000118') $$,
  '22003'::char(5), null, 'Access exhaustion rolls back a revocation'
);
select is(
  (
    select pg_catalog.to_jsonb(assignment.*)
    from vortex_access.organization_role_assignments as assignment
    where organization_id = '21900000-0000-4000-8000-000000000001'
      and role_assignment_id = '63900000-0000-4000-8000-000000000003'
  ),
  (select snapshot from access_exhaustion_assignment),
  'Access exhaustion leaves the complete assignment unchanged'
);

alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 100
where organization_id = '21900000-0000-4000-8000-000000000001';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;

alter table vortex_access.organization_role_assignments
  disable trigger organization_role_assignments_protect_change;
update vortex_access.organization_role_assignments
set revision = 9007199254740991
where organization_id = '21900000-0000-4000-8000-000000000001'
  and role_assignment_id = '63900000-0000-4000-8000-000000000003';
alter table vortex_access.organization_role_assignments
  enable trigger organization_role_assignments_protect_change;

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000003', 9007199254740991,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000119') $$,
  '22003'::char(5), null, 'assignment revision exhaustion refuses terminal change'
);
select is(
  (
    select current_version from vortex_access.organization_access_versions
    where organization_id = '21900000-0000-4000-8000-000000000001'
  ),
  100::bigint,
  'assignment revision exhaustion does not increment Access'
);

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '21900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000004', 1,
    null, null, null, null, null, null, null, null,
    '91900000-0000-4000-8000-000000000002',
    '71900000-0000-4000-8000-000000000120') $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_role_assignment_change',
  'the actual request role cannot invoke the private assignment composition'
);
reset role;

select * from finish();

rollback;
