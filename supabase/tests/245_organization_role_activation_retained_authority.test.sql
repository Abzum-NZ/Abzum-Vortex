\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14500000-0000-4000-8000-000000000001', 'retained_activation',
  'Retained activation', 'active', pg_catalog.statement_timestamp(),
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '24500000-0000-4000-8000-000000000001',
  '14500000-0000-4000-8000-000000000001', 'retained_activation',
  'Retained activation', 'active', pg_catalog.statement_timestamp(),
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '44500000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '54500000-0000-4000-8000-000000000001',
  '24500000-0000-4000-8000-000000000001',
  '44500000-0000-4000-8000-000000000001', 'Retained authority person',
  'active', pg_catalog.statement_timestamp(), null,
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000002', 1
);

select * from vortex_access.initialize_organization_access_version(
  '24500000-0000-4000-8000-000000000001',
  '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000003'
);

-- Revision one is the exact source accepted by the local supplied role. The
-- current registration later adds a second permission, which remains pending.
insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision, state,
  operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values
  (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.retained_activation', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64),
    pg_catalog.transaction_timestamp() - interval '2 minutes',
    '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000004'
  ),
  (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 2, 'active', 'update',
    'example.retained_activation', '1.1.0', 2, '1.0.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('7', 64),
    'sha256:' || pg_catalog.repeat('8', 64),
    pg_catalog.transaction_timestamp() - interval '1 minute',
    '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000005'
  ),
  (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 3, 'active', 'update',
    'example.retained_activation', '1.2.0', 3, '1.0.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('f', 64),
    'sha256:' || pg_catalog.repeat('0', 64),
    pg_catalog.transaction_timestamp(),
    '94500000-0000-4000-8000-000000000001',
    'a4500000-0000-4000-8000-000000000013'
  );

insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state, revision,
  source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001', 'active', 1,
  'example.retained_activation', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64),
  pg_catalog.transaction_timestamp() - interval '2 minutes',
  '94500000-0000-4000-8000-000000000001',
  'a4500000-0000-4000-8000-000000000004'
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
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 1,
    '34500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001',
    '41500000-0000-4000-8000-000000000001', 'example.records.read',
    'Read records', 'Read application records.', null, 'read', null, false,
    'application', 'example.retained_activation',
    '34500000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat('a', 64)
  ),
  (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 2,
    '34500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001',
    '41500000-0000-4000-8000-000000000001', 'example.records.read',
    'Read records', 'Read application records.', null, 'read', null, false,
    'application', 'example.retained_activation',
    '34500000-0000-4000-8000-000000000001', '1.1.0', 2, '1.0.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64), null,
    'sha256:' || pg_catalog.repeat('a', 64)
  ),
  (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 2,
    '34500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001',
    '41500000-0000-4000-8000-000000000002', 'example.records.update',
    'Update records', 'Update application records.', null, 'update', null, false,
    'application', 'example.retained_activation',
    '34500000-0000-4000-8000-000000000001', '1.1.0', 2, '1.0.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64), null,
    'sha256:' || pg_catalog.repeat('b', 64)
  ),
  (
    '24500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 3,
    '34500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001',
    '41500000-0000-4000-8000-000000000002', 'example.records.update',
    'Update records', 'Update application records.', null, 'update', null, false,
    'application', 'example.retained_activation',
    '34500000-0000-4000-8000-000000000001', '1.2.0', 3, '1.0.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64), null,
    'sha256:' || pg_catalog.repeat('b', 64)
  );

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values
  (
    '24500000-0000-4000-8000-000000000001',
    '34500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001',
    '41500000-0000-4000-8000-000000000001', 'application',
    '34500000-0000-4000-8000-000000000001', 'available', 1,
    'sha256:' || pg_catalog.repeat('a', 64), 1,
    pg_catalog.statement_timestamp()
  );

insert into vortex_access.application_role_template_continuities (
  organization_id, application_root_id, source_role_id, state,
  continuity_revision, source_template_fingerprint,
  last_processed_registration_revision, changed_at
) values (
  '24500000-0000-4000-8000-000000000001',
  '34500000-0000-4000-8000-000000000001',
  '52500000-0000-4000-8000-000000000001', 'available', 1,
  'sha256:' || pg_catalog.repeat('9', 64), 1,
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '24500000-0000-4000-8000-000000000001',
  '74500000-0000-4000-8000-000000000001', 'application',
  'retained_reader', '34500000-0000-4000-8000-000000000001',
  '52500000-0000-4000-8000-000000000001', 1,
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision,
  policy_fingerprint, maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001',
  '74500000-0000-4000-8000-000000000001',
  '75500000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('d', 64), 600, false, 'none', null, false,
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a4500000-0000-4000-8000-000000000006'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
) values (
  '24500000-0000-4000-8000-000000000001',
  '74500000-0000-4000-8000-000000000001', 1, 1, 'application',
  '34500000-0000-4000-8000-000000000001',
  '34500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001',
  '41500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 1,
  'sha256:' || pg_catalog.repeat('a', 64)
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001',
  '74500000-0000-4000-8000-000000000001', 1, 'application',
  '34500000-0000-4000-8000-000000000001', 'active', 'standard',
  'activation_required', 1, 1,
  '75500000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('d', 64), 'retained_reader',
  'Retained reader', 'Application role awaiting an additive review.',
  'example.retained_activation', 1, '1.0.0', '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('9', 64),
  'sha256:' || pg_catalog.repeat('3', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('e', 64),
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a4500000-0000-4000-8000-000000000007'
);

set constraints all immediate;
set constraints all deferred;

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24500000-0000-4000-8000-000000000001',
  '84500000-0000-4000-8000-000000000001',
  '74500000-0000-4000-8000-000000000001', 'organization_account',
  '54500000-0000-4000-8000-000000000001', null, 'eligible', 1,
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.statement_timestamp() + interval '1 hour', 'live',
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '1 minute',
  'a4500000-0000-4000-8000-000000000008',
  '94500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '1 minute',
  'a4500000-0000-4000-8000-000000000008'
);

-- Apply the current additive application update before deriving the pending
-- supplied-role successor. The original eligible assignment already exists.
update vortex_access.permission_registrations
set revision = 2,
  source_version = '1.1.0',
  source_revision = 2,
  source_content_fingerprint = 'sha256:' || pg_catalog.repeat('5', 64),
  source_resolution_fingerprint = 'sha256:' || pg_catalog.repeat('6', 64),
  permission_catalogue_fingerprint = 'sha256:' || pg_catalog.repeat('7', 64),
  candidate_fingerprint = 'sha256:' || pg_catalog.repeat('8', 64),
  changed_at = pg_catalog.transaction_timestamp() - interval '1 minute',
  change_correlation_id = 'a4500000-0000-4000-8000-000000000005'
where organization_id = '24500000-0000-4000-8000-000000000001'
  and registration_kind = 'application'
  and registration_owner_id = '34500000-0000-4000-8000-000000000001';

update vortex_access.permission_continuities
set last_processed_registration_revision = 2,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '24500000-0000-4000-8000-000000000001'
  and application_root_id = '34500000-0000-4000-8000-000000000001'
  and owner_kind = 'application'
  and owner_id = '34500000-0000-4000-8000-000000000001'
  and permission_id = '41500000-0000-4000-8000-000000000001';

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values (
  '24500000-0000-4000-8000-000000000001',
  '34500000-0000-4000-8000-000000000001', 'application',
  '34500000-0000-4000-8000-000000000001',
  '41500000-0000-4000-8000-000000000002', 'application',
  '34500000-0000-4000-8000-000000000001', 'available', 1,
  'sha256:' || pg_catalog.repeat('b', 64), 2,
  pg_catalog.statement_timestamp()
);

update vortex_access.application_role_template_continuities
set source_template_fingerprint = 'sha256:' || pg_catalog.repeat('c', 64),
  last_processed_registration_revision = 2,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '24500000-0000-4000-8000-000000000001'
  and application_root_id = '34500000-0000-4000-8000-000000000001'
  and source_role_id = '52500000-0000-4000-8000-000000000001';

-- The pending successor retains only the previously accepted read permission.
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select organization_id, role_id, 2, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
from vortex_access.organization_role_permission_entries
where organization_id = '24500000-0000-4000-8000-000000000001'
  and role_id = '74500000-0000-4000-8000-000000000001'
  and role_revision = 1;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
)
select organization_id, role_id, 2, role_kind, application_root_id,
  'acceptance_required', privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  activation_policy_id, activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint,
  '94500000-0000-4000-8000-000000000001'::uuid,
  pg_catalog.statement_timestamp(),
  'a4500000-0000-4000-8000-000000000009'::uuid
from vortex_access.organization_role_revisions
where organization_id = '24500000-0000-4000-8000-000000000001'
  and role_id = '74500000-0000-4000-8000-000000000001'
  and revision = 1;

update vortex_access.organization_roles
set live_revision = 2
where organization_id = '24500000-0000-4000-8000-000000000001'
  and role_id = '74500000-0000-4000-8000-000000000001';

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select revision.lifecycle, revision.accepted_registration_revision,
      registration.revision as current_registration_revision,
      pg_catalog.count(distinct retained.permission_id)::bigint as retained_count,
      pg_catalog.count(distinct available.permission_id)::bigint as available_count
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.permission_registrations as registration
      on registration.organization_id = role.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = role.application_root_id
    left join vortex_access.organization_role_permission_entries as retained
      on retained.organization_id = revision.organization_id
      and retained.role_id = revision.role_id
      and retained.role_revision = revision.revision
    left join vortex_access.permission_catalogue_entries as available
      on available.organization_id = registration.organization_id
      and available.registration_kind = registration.registration_kind
      and available.registration_owner_id = registration.registration_owner_id
      and available.registration_revision = registration.revision
    where role.organization_id = '24500000-0000-4000-8000-000000000001'
      and role.role_id = '74500000-0000-4000-8000-000000000001'
    group by revision.lifecycle, revision.accepted_registration_revision,
      registration.revision
  $$,
  $$ values ('acceptance_required'::text, 1::bigint, 2::bigint, 1::bigint, 2::bigint) $$,
  'pending supplied role retains one approved permission while the added permission remains unaccepted'
);

create temporary table retained_activation on commit drop as
select *
from vortex_access.coordinate_organization_role_activation_change(
  'activate_role',
  '24500000-0000-4000-8000-000000000001',
  '64500000-0000-4000-8000-000000000001', null,
  '54500000-0000-4000-8000-000000000001',
  '74500000-0000-4000-8000-000000000001', 2, 300, 'direct',
  '84500000-0000-4000-8000-000000000001', 1, null, null,
  '94500000-0000-4000-8000-000000000002',
  'a4500000-0000-4000-8000-000000000010'
);

select results_eq(
  $$
    select outcome, operation,
      (activation ->> 'historicalRoleRevision')::bigint,
      (activation ->> 'authorityContinuityRevision')::bigint,
      activation #>> '{eligibilitySource,kind}', access_version
    from retained_activation
  $$,
  $$ values ('changed'::text, 'activate_role'::text, 2::bigint, 1::bigint, 'direct'::text, 2::bigint) $$,
  'a pending supplied role can activate its nonempty retained authority'
);

select results_eq(
  $$
    select pg_catalog.array_agg(catalogue.permission_key order by catalogue.permission_key)
    from retained_activation as activated
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id =
        (activated.activation ->> 'organizationId')::uuid
      and permission.role_id = (activated.activation ->> 'roleId')::uuid
      and permission.role_revision =
        (activated.activation ->> 'historicalRoleRevision')::bigint
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = permission.organization_id
      and catalogue.registration_kind = permission.registration_kind
      and catalogue.registration_owner_id = permission.registration_owner_id
      and catalogue.registration_revision = permission.accepted_registration_revision
      and catalogue.owner_kind = permission.owner_kind
      and catalogue.owner_id = permission.owner_id
      and catalogue.permission_id = permission.permission_id
  $$,
  $$ values (array['example.records.read']::text[]) $$,
  'the activation binds only the retained role entry and not the pending added permission'
);

-- A later current application update removes the formerly retained permission
-- while leaving the unaccepted addition available. Its derived pending role is
-- therefore valid with no retained entries.
update vortex_access.permission_registrations
set revision = 3,
  source_version = '1.2.0',
  source_revision = 3,
  permission_catalogue_fingerprint = 'sha256:' || pg_catalog.repeat('f', 64),
  candidate_fingerprint = 'sha256:' || pg_catalog.repeat('0', 64),
  changed_at = pg_catalog.transaction_timestamp(),
  change_correlation_id = 'a4500000-0000-4000-8000-000000000013'
where organization_id = '24500000-0000-4000-8000-000000000001'
  and registration_kind = 'application'
  and registration_owner_id = '34500000-0000-4000-8000-000000000001';

update vortex_access.permission_continuities
set state = 'unavailable',
  continuity_revision = 2,
  last_processed_registration_revision = 3,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '24500000-0000-4000-8000-000000000001'
  and application_root_id = '34500000-0000-4000-8000-000000000001'
  and owner_kind = 'application'
  and owner_id = '34500000-0000-4000-8000-000000000001'
  and permission_id = '41500000-0000-4000-8000-000000000001';

update vortex_access.permission_continuities
set last_processed_registration_revision = 3,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '24500000-0000-4000-8000-000000000001'
  and application_root_id = '34500000-0000-4000-8000-000000000001'
  and owner_kind = 'application'
  and owner_id = '34500000-0000-4000-8000-000000000001'
  and permission_id = '41500000-0000-4000-8000-000000000002';

update vortex_access.application_role_template_continuities
set last_processed_registration_revision = 3,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '24500000-0000-4000-8000-000000000001'
  and application_root_id = '34500000-0000-4000-8000-000000000001'
  and source_role_id = '52500000-0000-4000-8000-000000000001';

-- The empty successor preserves the authority period because it only narrows.
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
)
select organization_id, role_id, 3, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint,
  '94500000-0000-4000-8000-000000000001'::uuid,
  pg_catalog.statement_timestamp(),
  'a4500000-0000-4000-8000-000000000011'::uuid
from vortex_access.organization_role_revisions
where organization_id = '24500000-0000-4000-8000-000000000001'
  and role_id = '74500000-0000-4000-8000-000000000001'
  and revision = 2;

update vortex_access.organization_roles
set live_revision = 3
where organization_id = '24500000-0000-4000-8000-000000000001'
  and role_id = '74500000-0000-4000-8000-000000000001';

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select revision.lifecycle,
      pg_catalog.count(distinct retained.permission_id)::bigint as retained_count,
      pg_catalog.count(distinct available.permission_id)::bigint as available_count
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.permission_registrations as registration
      on registration.organization_id = role.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = role.application_root_id
    left join vortex_access.organization_role_permission_entries as retained
      on retained.organization_id = revision.organization_id
      and retained.role_id = revision.role_id
      and retained.role_revision = revision.revision
    left join vortex_access.permission_catalogue_entries as available
      on available.organization_id = registration.organization_id
      and available.registration_kind = registration.registration_kind
      and available.registration_owner_id = registration.registration_owner_id
      and available.registration_revision = registration.revision
    where role.organization_id = '24500000-0000-4000-8000-000000000001'
      and role.role_id = '74500000-0000-4000-8000-000000000001'
    group by revision.lifecycle
  $$,
  $$ values ('acceptance_required'::text, 0::bigint, 1::bigint) $$,
  'the later pending supplied role has no retained entry while unaccepted authority remains available'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_activation_change(
      'activate_role',
      '24500000-0000-4000-8000-000000000001',
      '64500000-0000-4000-8000-000000000002', null,
      '54500000-0000-4000-8000-000000000001',
      '74500000-0000-4000-8000-000000000001', 3, 300, 'direct',
      '84500000-0000-4000-8000-000000000001', 1, null, null,
      '94500000-0000-4000-8000-000000000002',
      'a4500000-0000-4000-8000-000000000012'
    )
  $$,
  '40001'::char(5),
  'Organization role activation role evidence is stale or unavailable',
  'an empty retained supplied-role revision cannot activate pending authority'
);

select results_eq(
  $$
    select current_version,
      pg_catalog.count(activation.role_activation_id)::bigint
    from vortex_access.organization_access_versions as version
    left join vortex_access.organization_role_activations as activation
      on activation.organization_id = version.organization_id
    where version.organization_id = '24500000-0000-4000-8000-000000000001'
    group by current_version
  $$,
  $$ values (2::bigint, 1::bigint) $$,
  'empty retained authority refusal creates no activation and no Access increment'
);

set constraints all immediate;

select * from finish();

rollback;
