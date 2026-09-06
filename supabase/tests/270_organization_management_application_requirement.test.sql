\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.create_management_scope(
  p_organization_id uuid,
  p_identity_id uuid,
  p_organization_account_id uuid,
  p_short_name text
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    p_organization_id, '12700000-0000-4000-8000-000000000001',
    p_short_name, p_short_name, 'active', operation_at,
    '92700000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_identity_id, 'active', operation_at, operation_at,
    '92700000-0000-4000-8000-000000000001', p_identity_id, 1
  );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_organization_account_id, p_organization_id, p_identity_id,
    p_short_name, 'active', operation_at - interval '1 minute',
    operation_at, operation_at,
    '92700000-0000-4000-8000-000000000001', p_organization_account_id, 1
  );

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id,
    '92700000-0000-4000-8000-000000000001',
    'a2700000-0000-4000-8000-000000000001'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id,
    '92700000-0000-4000-8000-000000000001',
    'a2700000-0000-4000-8000-000000000002'
  );
end
$function$;

create function pg_temp.seed_management_application(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid,
  p_source_role_id uuid,
  p_role_id uuid,
  p_permission_id uuid,
  p_assignment_id uuid,
  p_definition_key text,
  p_role_key text,
  p_fingerprint_character text
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, 1,
    'active', 'register', p_definition_key, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64), operation_at,
    '92700000-0000-4000-8000-000000000001',
    'a2700000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, 'active', 1,
    p_definition_key, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64), operation_at,
    '92700000-0000-4000-8000-000000000001',
    'a2700000-0000-4000-8000-000000000010'
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
  ) values (
    p_organization_id, 'application', p_application_root_id, 1,
    p_application_root_id, 'application', p_application_root_id,
    p_permission_id, p_definition_key || '.records.read', 'View records',
    'View records in the neutral management fixture.', null, 'read', null,
    false, 'application', p_definition_key, p_application_root_id,
    '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    'sha256:' || pg_catalog.repeat('1', 64), null,
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64)
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    p_organization_id, p_application_root_id, 'application',
    p_application_root_id, p_permission_id, 'application',
    p_application_root_id, 'available', 1,
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64), 1,
    operation_at
  );

  insert into vortex_access.application_role_template_continuities (
    organization_id, application_root_id, source_role_id, state,
    continuity_revision, source_template_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    p_organization_id, p_application_root_id, p_source_role_id, 'available',
    1, 'sha256:' || pg_catalog.repeat('4', 64), 1, operation_at
  );

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_role_id, 'application', p_role_key,
    p_application_root_id, p_source_role_id, 1,
    '92700000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  ) values (
    p_organization_id, p_role_id, 1, 1, 'application',
    p_application_root_id, p_application_root_id, 'application',
    p_application_root_id, p_permission_id, 'application',
    p_application_root_id, 1, 'sha256:' || pg_catalog.repeat('2', 64), 1,
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64)
  );

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description, source_definition_key,
    source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_role_id, 1, 'application', p_application_root_id,
    'active', 'standard', 'standing', 1, 1, p_role_key,
    'Management application role',
    'A neutral accepted standing application role.', p_definition_key,
    1, '1.0.0', '1.0.0',
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('4', 64),
    'sha256:' || pg_catalog.repeat('2', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('5', 64),
    '92700000-0000-4000-8000-000000000001', operation_at,
    'a2700000-0000-4000-8000-000000000011'
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_assignment_id, p_role_id, 'organization_account',
    p_organization_account_id, null, 'standing', 1,
    operation_at - interval '1 minute', null, 'live',
    '92700000-0000-4000-8000-000000000001', operation_at,
    'a2700000-0000-4000-8000-000000000012',
    '92700000-0000-4000-8000-000000000001', operation_at,
    'a2700000-0000-4000-8000-000000000012'
  );
end
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_column(
  'vortex_access', 'organization_stewardship_requirements',
  'management_application_root_id',
  'the stewardship requirement stores the exact management application root'
);
select has_column(
  'vortex_access', 'organization_stewardship_requirements',
  'management_role_id',
  'the stewardship requirement stores the exact management role'
);
select has_column(
  'vortex_access', 'organization_stewardship_requirements',
  'management_required_role_revision',
  'the stewardship requirement pins one immutable required role revision'
);
select has_function(
  'vortex_access',
  'coordinate_organization_management_application_requirement',
  array['text', 'uuid', 'bigint', 'uuid', 'uuid', 'bigint', 'uuid', 'uuid'],
  'Access exposes one private management-application requirement composition'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig
    )
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.coordinate_organization_management_application_requirement(text,uuid,bigint,uuid,uuid,bigint,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the D2 coordinator is owner-held, invoker-security and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_management_application_requirement(text,uuid,bigint,uuid,uuid,bigint,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private D2 coordinator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '12700000-0000-4000-8000-000000000001', 'management_requirement',
  'Management requirement', 'active', pg_catalog.statement_timestamp(),
  '92700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

select pg_temp.create_management_scope(
  '22700000-0000-4000-8000-000000000001',
  '42700000-0000-4000-8000-000000000001',
  '52700000-0000-4000-8000-000000000001',
  'management_requirement_one'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42700000-0000-4000-8000-000000000002', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '92700000-0000-4000-8000-000000000001',
  'a2700000-0000-4000-8000-000000000003', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '52700000-0000-4000-8000-000000000002',
  '22700000-0000-4000-8000-000000000001',
  '42700000-0000-4000-8000-000000000002', 'Separate account', 'active',
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '92700000-0000-4000-8000-000000000001',
  'a2700000-0000-4000-8000-000000000004', 1
);

create temporary table adoption_result on commit drop as
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '22700000-0000-4000-8000-000000000001',
  '52700000-0000-4000-8000-000000000001',
  '62700000-0000-4000-8000-000000000001',
  'organization_steward', 'Organisation steward',
  'Permanent minimum organisation administration.',
  '72700000-0000-4000-8000-000000000001',
  '82700000-0000-4000-8000-000000000001',
  '92700000-0000-4000-8000-000000000002',
  'a2700000-0000-4000-8000-000000000020'
);

select pg_temp.seed_management_application(
  '22700000-0000-4000-8000-000000000001',
  '52700000-0000-4000-8000-000000000001',
  '32700000-0000-4000-8000-000000000001',
  '42700000-0000-4000-8000-000000000101',
  '62700000-0000-4000-8000-000000000101',
  '42700000-0000-4000-8000-000000000201',
  '72700000-0000-4000-8000-000000000101',
  'example.management_one', 'management_one', 'a'
);
select pg_temp.seed_management_application(
  '22700000-0000-4000-8000-000000000001',
  '52700000-0000-4000-8000-000000000001',
  '32700000-0000-4000-8000-000000000002',
  '42700000-0000-4000-8000-000000000102',
  '62700000-0000-4000-8000-000000000102',
  '42700000-0000-4000-8000-000000000202',
  '72700000-0000-4000-8000-000000000102',
  'example.management_two', 'management_two', 'b'
);
select pg_temp.seed_management_application(
  '22700000-0000-4000-8000-000000000001',
  '52700000-0000-4000-8000-000000000002',
  '32700000-0000-4000-8000-000000000003',
  '42700000-0000-4000-8000-000000000103',
  '62700000-0000-4000-8000-000000000103',
  '42700000-0000-4000-8000-000000000203',
  '72700000-0000-4000-8000-000000000103',
  'example.management_three', 'management_three', 'c'
);

select pg_temp.create_management_scope(
  '22700000-0000-4000-8000-000000000002',
  '42700000-0000-4000-8000-000000000010',
  '52700000-0000-4000-8000-000000000010',
  'management_requirement_two'
);
select pg_temp.seed_management_application(
  '22700000-0000-4000-8000-000000000002',
  '52700000-0000-4000-8000-000000000010',
  '32700000-0000-4000-8000-000000000010',
  '42700000-0000-4000-8000-000000000110',
  '62700000-0000-4000-8000-000000000110',
  '42700000-0000-4000-8000-000000000210',
  '72700000-0000-4000-8000-000000000110',
  'example.management_foreign', 'management_foreign', 'd'
);

set constraints all immediate;
set constraints all deferred;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'replace_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 1,
      '32700000-0000-4000-8000-000000000001',
      '62700000-0000-4000-8000-000000000101', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000021'
    )
  $$,
  '40001'::char(5), null,
  'replacement refuses while the management requirement is not yet active'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'activate_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 1,
      '32700000-0000-4000-8000-000000000001',
      '62700000-0000-4000-8000-000000000101', 2,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000031'
    )
  $$,
  '40001'::char(5), null,
  'activation refuses a stale target role revision'
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'activate_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 1,
      '32700000-0000-4000-8000-000000000002',
      '62700000-0000-4000-8000-000000000101', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000032'
    )
  $$,
  '40001'::char(5), null,
  'activation refuses a role from the wrong application root'
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'activate_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 1,
      '32700000-0000-4000-8000-000000000010',
      '62700000-0000-4000-8000-000000000110', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000033'
    )
  $$,
  '40001'::char(5), null,
  'activation refuses a foreign-organization application role'
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'activate_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 1,
      '32700000-0000-4000-8000-000000000003',
      '62700000-0000-4000-8000-000000000103', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000034'
    )
  $$,
  '23514'::char(5), null,
  'an operating assignment on a different account cannot satisfy D2'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select assignment.organization_id,
  '72700000-0000-4000-8000-000000000104'::uuid,
  assignment.role_id, assignment.assignee_kind,
  '52700000-0000-4000-8000-000000000001'::uuid,
  assignment.group_id, assignment.assignment_kind, assignment.revision,
  assignment.starts_at, assignment.expires_at, assignment.state,
  assignment.granted_by, assignment.granted_at,
  'a2700000-0000-4000-8000-000000000035'::uuid,
  assignment.changed_by, assignment.changed_at,
  'a2700000-0000-4000-8000-000000000035'::uuid
from vortex_access.organization_role_assignments as assignment
where assignment.organization_id = '22700000-0000-4000-8000-000000000001'
  and assignment.role_assignment_id =
    '72700000-0000-4000-8000-000000000103';

create temporary table access_before_activation on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22700000-0000-4000-8000-000000000001';

create temporary table activation_result on commit drop as
select *
from vortex_access.coordinate_organization_management_application_requirement(
  'activate_management_application_requirement',
  '22700000-0000-4000-8000-000000000001', 1,
  '32700000-0000-4000-8000-000000000001',
  '62700000-0000-4000-8000-000000000101', 1,
  '92700000-0000-4000-8000-000000000003',
  'a2700000-0000-4000-8000-000000000022'
);

select is(
  (select outcome || '|' || operation from activation_result),
  'changed|activate_management_application_requirement',
  'activation reports one changed management-application requirement'
);
select is(
  (select access_version from activation_result),
  (select current_version + 1 from access_before_activation),
  'activation increments Access exactly once'
);
select is(
  (
    select requirement - array['adoptedAt', 'changedAt']
    from activation_result
  ),
  pg_catalog.jsonb_build_object(
    'organizationId', '22700000-0000-4000-8000-000000000001'::uuid,
    'revision', 2,
    'originalOrganizationAccountId',
      '52700000-0000-4000-8000-000000000001'::uuid,
    'originalRoleId', '62700000-0000-4000-8000-000000000001'::uuid,
    'originalRoleAssignmentId',
      '72700000-0000-4000-8000-000000000001'::uuid,
    'originalDelegationAuthorityId',
      '82700000-0000-4000-8000-000000000001'::uuid,
    'managementApplicationRootId',
      '32700000-0000-4000-8000-000000000001'::uuid,
    'managementRoleId', '62700000-0000-4000-8000-000000000101'::uuid,
    'requiredRoleRevision', 1,
    'adoptedByActorId', '92700000-0000-4000-8000-000000000002'::uuid,
    'adoptionCorrelationId', 'a2700000-0000-4000-8000-000000000020'::uuid,
    'changedByActorId', '92700000-0000-4000-8000-000000000003'::uuid,
    'changeCorrelationId', 'a2700000-0000-4000-8000-000000000022'::uuid
  ),
  'activation returns the complete D1 evidence and exact D2 binding'
);
select ok(
  vortex_access.organization_has_permanent_steward(
    '22700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp()
  ),
  'one same-account direct permanent operating assignment satisfies D2'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'activate_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 2,
      '32700000-0000-4000-8000-000000000001',
      '62700000-0000-4000-8000-000000000101', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000023'
    )
  $$,
  '40001'::char(5), null,
  'activation refuses once a management requirement is already active'
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'replace_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 1,
      '32700000-0000-4000-8000-000000000002',
      '62700000-0000-4000-8000-000000000102', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000024'
    )
  $$,
  '40001'::char(5), null,
  'replacement refuses a stale requirement revision'
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'replace_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 2,
      '32700000-0000-4000-8000-000000000001',
      '62700000-0000-4000-8000-000000000101', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000025'
    )
  $$,
  '40001'::char(5), null,
  'replacement refuses the exact unchanged binding'
);

-- An invalid partial management tuple is rejected by storage, independent of
-- the coordinator's closed operation state.
select throws_ok(
  $$
    update vortex_access.organization_stewardship_requirements
    set management_application_root_id =
        '32700000-0000-4000-8000-000000000002',
      management_role_id = '62700000-0000-4000-8000-000000000102',
      management_required_role_revision = null,
      revision = 3,
      changed_by = '92700000-0000-4000-8000-000000000003',
      changed_at = pg_catalog.clock_timestamp(),
      change_correlation_id = 'a2700000-0000-4000-8000-000000000026'
    where organization_id = '22700000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5), null,
  'storage refuses a partial management-application tuple'
);

create temporary table access_before_bound_withdraw on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22700000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '22700000-0000-4000-8000-000000000001',
      '32700000-0000-4000-8000-000000000001',
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000027'
    )
  $$,
  '23514'::char(5), null,
  'the actual B2 writer cannot withdraw the final bound management authority'
);
select is(
  (
    select registration.state || '|' || registration.revision::text || '|' ||
      version.current_version::text
    from vortex_access.permission_registrations as registration
    join vortex_access.organization_access_versions as version
      on version.organization_id = registration.organization_id
    where registration.organization_id =
      '22700000-0000-4000-8000-000000000001'
      and registration.registration_kind = 'application'
      and registration.registration_owner_id =
        '32700000-0000-4000-8000-000000000001'
  ),
  'active|1|' || (select current_version::text from access_before_bound_withdraw),
  'refused B2 withdrawal rolls back registration, role and Access changes'
);

-- Simulate a supported stale old binding before replacement. The new target,
-- rather than the unusable predecessor, is the final condition that matters.
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, source_definition_key,
  source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
)
select revision.organization_id, revision.role_id, 2, revision.role_kind,
  revision.application_root_id, 'unavailable',
  revision.privilege_classification, revision.assignment_policy,
  revision.policy_continuity_revision, revision.authority_continuity_revision,
  revision.role_key, revision.label, revision.description,
  revision.source_definition_key, revision.source_release_revision,
  revision.source_release_version, revision.source_validation_contract_version,
  revision.source_content_fingerprint, revision.source_resolution_fingerprint,
  revision.source_template_fingerprint, revision.source_catalogue_fingerprint,
  revision.accepted_registration_revision,
  revision.template_continuity_revision, revision.accepted_grant_fingerprint,
  '92700000-0000-4000-8000-000000000003'::uuid,
  pg_catalog.clock_timestamp(),
  'a2700000-0000-4000-8000-000000000036'::uuid
from vortex_access.organization_role_revisions as revision
where revision.organization_id = '22700000-0000-4000-8000-000000000001'
  and revision.role_id = '62700000-0000-4000-8000-000000000101'
  and revision.revision = 1;
update vortex_access.organization_roles
set live_revision = 2
where organization_id = '22700000-0000-4000-8000-000000000001'
  and role_id = '62700000-0000-4000-8000-000000000101';
set constraints all immediate;
set constraints all deferred;
select ok(
  not vortex_access.organization_has_permanent_steward(
    '22700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp()
  ),
  'the old unavailable management role no longer qualifies before replacement'
);

create temporary table access_before_replacement on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22700000-0000-4000-8000-000000000001';
create temporary table replacement_result on commit drop as
select *
from vortex_access.coordinate_organization_management_application_requirement(
  'replace_management_application_requirement',
  '22700000-0000-4000-8000-000000000001', 2,
  '32700000-0000-4000-8000-000000000002',
  '62700000-0000-4000-8000-000000000102', 1,
  '92700000-0000-4000-8000-000000000003',
  'a2700000-0000-4000-8000-000000000028'
);
select is(
  (
    select operation || '|' || (requirement ->> 'revision') || '|' ||
      (requirement ->> 'managementApplicationRootId') || '|' ||
      access_version::text
    from replacement_result
  ),
  'replace_management_application_requirement|3|32700000-0000-4000-8000-000000000002|' ||
    (select (current_version + 1)::text from access_before_replacement),
  'replacement atomically binds the complete new final condition and Access once'
);

create temporary table old_withdraw_result on commit drop as
select * from vortex_access.coordinate_application_access_change(
  'withdraw', 1, null,
  '22700000-0000-4000-8000-000000000001',
  '32700000-0000-4000-8000-000000000001',
  '92700000-0000-4000-8000-000000000003',
  'a2700000-0000-4000-8000-000000000029'
);
select is(
  (select outcome || '|' || registration_state from old_withdraw_result),
  'changed|withdrawn',
  'after atomic replacement the old application may be withdrawn normally'
);
select ok(
  vortex_access.organization_has_permanent_steward(
    '22700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp()
  ),
  'replacement qualification depends only on the new complete binding'
);

-- Model an additive application update: the required permission remains
-- continuous while a new permission is pending and the role awaits review.
insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
)
select history.organization_id, history.registration_kind,
  history.registration_owner_id, 2, 'active', 'update',
  history.source_definition_key, '1.1.0', 2,
  history.validation_contract_version,
  'sha256:' || pg_catalog.repeat('6', 64),
  'sha256:' || pg_catalog.repeat('7', 64),
  'sha256:' || pg_catalog.repeat('8', 64),
  'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.clock_timestamp(),
  '92700000-0000-4000-8000-000000000003'::uuid,
  'a2700000-0000-4000-8000-000000000037'::uuid
from vortex_access.permission_registration_revisions as history
where history.organization_id = '22700000-0000-4000-8000-000000000001'
  and history.registration_kind = 'application'
  and history.registration_owner_id =
    '32700000-0000-4000-8000-000000000002'
  and history.revision = 1;

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint
)
select entry.organization_id, entry.registration_kind,
  entry.registration_owner_id, 2, entry.application_root_id,
  entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.permission_key, entry.label, entry.description, entry.record_type_id,
  entry.action_kind, entry.named_action, entry.administrative,
  entry.source_kind, entry.source_definition_key, entry.source_root_id,
  '1.1.0', 2, entry.source_validation_contract_version,
  'sha256:' || pg_catalog.repeat('6', 64),
  'sha256:' || pg_catalog.repeat('7', 64),
  entry.source_catalogue_fingerprint, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '22700000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'application'
  and entry.registration_owner_id =
    '32700000-0000-4000-8000-000000000002'
  and entry.registration_revision = 1;
insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint
) values (
  '22700000-0000-4000-8000-000000000001', 'application',
  '32700000-0000-4000-8000-000000000002', 2,
  '32700000-0000-4000-8000-000000000002', 'application',
  '32700000-0000-4000-8000-000000000002',
  '42700000-0000-4000-8000-000000000212',
  'example.management_two.records.update', 'Update records',
  'Update records in the neutral management fixture.', null, 'update', null,
  false, 'application', 'example.management_two',
  '32700000-0000-4000-8000-000000000002', '1.1.0', 2, '1.0.0',
  'sha256:' || pg_catalog.repeat('6', 64),
  'sha256:' || pg_catalog.repeat('7', 64), null,
  'sha256:' || pg_catalog.repeat('e', 64)
);

update vortex_access.permission_registrations
set revision = 2, source_version = '1.1.0', source_revision = 2,
  source_content_fingerprint = 'sha256:' || pg_catalog.repeat('6', 64),
  source_resolution_fingerprint = 'sha256:' || pg_catalog.repeat('7', 64),
  permission_catalogue_fingerprint = 'sha256:' || pg_catalog.repeat('8', 64),
  candidate_fingerprint = 'sha256:' || pg_catalog.repeat('9', 64),
  changed_at = pg_catalog.clock_timestamp(),
  change_correlation_id = 'a2700000-0000-4000-8000-000000000037'
where organization_id = '22700000-0000-4000-8000-000000000001'
  and registration_kind = 'application'
  and registration_owner_id = '32700000-0000-4000-8000-000000000002';
update vortex_access.permission_continuities
set last_processed_registration_revision = 2,
  changed_at = pg_catalog.clock_timestamp()
where organization_id = '22700000-0000-4000-8000-000000000001'
  and application_root_id = '32700000-0000-4000-8000-000000000002';
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id, state,
  continuity_revision, meaning_fingerprint,
  last_processed_registration_revision, changed_at
) values (
  '22700000-0000-4000-8000-000000000001',
  '32700000-0000-4000-8000-000000000002', 'application',
  '32700000-0000-4000-8000-000000000002',
  '42700000-0000-4000-8000-000000000212', 'application',
  '32700000-0000-4000-8000-000000000002', 'available', 1,
  'sha256:' || pg_catalog.repeat('e', 64), 2,
  pg_catalog.clock_timestamp()
);
update vortex_access.application_role_template_continuities
set last_processed_registration_revision = 2,
  source_template_fingerprint = 'sha256:' || pg_catalog.repeat('f', 64),
  changed_at = pg_catalog.clock_timestamp()
where organization_id = '22700000-0000-4000-8000-000000000001'
  and application_root_id = '32700000-0000-4000-8000-000000000002';

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select permission.organization_id, permission.role_id, 2,
  permission.entry_ordinal, permission.role_kind,
  permission.role_application_root_id, permission.application_root_id,
  permission.owner_kind, permission.owner_id, permission.permission_id,
  permission.registration_kind, permission.registration_owner_id,
  permission.accepted_registration_revision, permission.catalogue_fingerprint,
  permission.continuity_revision, permission.meaning_fingerprint
from vortex_access.organization_role_permission_entries as permission
where permission.organization_id = '22700000-0000-4000-8000-000000000001'
  and permission.role_id = '62700000-0000-4000-8000-000000000102'
  and permission.role_revision = 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, source_definition_key,
  source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
)
select revision.organization_id, revision.role_id, 2, revision.role_kind,
  revision.application_root_id, 'acceptance_required',
  revision.privilege_classification, revision.assignment_policy,
  revision.policy_continuity_revision, revision.authority_continuity_revision,
  revision.role_key, 'Management application role revised',
  'Retained required authority with one pending addition.',
  revision.source_definition_key, revision.source_release_revision,
  revision.source_release_version, revision.source_validation_contract_version,
  revision.source_content_fingerprint, revision.source_resolution_fingerprint,
  revision.source_template_fingerprint, revision.source_catalogue_fingerprint,
  revision.accepted_registration_revision,
  revision.template_continuity_revision, revision.accepted_grant_fingerprint,
  '92700000-0000-4000-8000-000000000003'::uuid,
  pg_catalog.clock_timestamp(),
  'a2700000-0000-4000-8000-000000000038'::uuid
from vortex_access.organization_role_revisions as revision
where revision.organization_id = '22700000-0000-4000-8000-000000000001'
  and revision.role_id = '62700000-0000-4000-8000-000000000102'
  and revision.revision = 1;
update vortex_access.organization_roles
set live_revision = 2
where organization_id = '22700000-0000-4000-8000-000000000001'
  and role_id = '62700000-0000-4000-8000-000000000102';
set constraints all immediate;
set constraints all deferred;

select ok(
  vortex_access.organization_has_permanent_steward(
    '22700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp()
  ),
  'metadata and pending additions retain the immutable required subset'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_assignment_change(
      'revoke',
      '22700000-0000-4000-8000-000000000001',
      '72700000-0000-4000-8000-000000000102', 1,
      null, null, null, null, null, null, null, null,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000039'
    )
  $$,
  '23514'::char(5), null,
  'the actual assignment writer cannot remove the final operating assignment'
);
select is(
  (
    select state || '|' || revision::text
    from vortex_access.organization_role_assignments
    where organization_id = '22700000-0000-4000-8000-000000000001'
      and role_assignment_id = '72700000-0000-4000-8000-000000000102'
  ),
  'live|1',
  'refused operating-assignment removal preserves its current fact'
);

create temporary table access_before_required_withdraw on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22700000-0000-4000-8000-000000000001';
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'withdraw', 2, null,
      '22700000-0000-4000-8000-000000000001',
      '32700000-0000-4000-8000-000000000002',
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000040'
    )
  $$,
  '23514'::char(5), null,
  'the actual B2 writer cannot remove the immutable required permission subset'
);
select is(
  (
    select registration.state || '|' || registration.revision::text || '|' ||
      role.live_revision::text || '|' || version.current_version::text
    from vortex_access.permission_registrations as registration
    join vortex_access.organization_roles as role
      on role.organization_id = registration.organization_id
      and role.application_root_id = registration.registration_owner_id
      and role.role_id = '62700000-0000-4000-8000-000000000102'
    join vortex_access.organization_access_versions as version
      on version.organization_id = registration.organization_id
    where registration.organization_id =
      '22700000-0000-4000-8000-000000000001'
      and registration.registration_kind = 'application'
      and registration.registration_owner_id =
        '32700000-0000-4000-8000-000000000002'
  ),
  'active|2|2|' ||
    (select current_version::text from access_before_required_withdraw),
  'required-source refusal rolls back registration, role and Access together'
);

-- Access exhaustion occurs after the requirement update and final assertion;
-- it must still roll that update back completely.
set constraints all immediate;
alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 9007199254740991,
  changed_at = pg_catalog.clock_timestamp(),
  changed_by = '92700000-0000-4000-8000-000000000003',
  change_correlation_id = 'a2700000-0000-4000-8000-000000000041',
  change_reason = 'stewardship_changed'
where organization_id = '22700000-0000-4000-8000-000000000001';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;
set constraints all deferred;

create temporary table access_exhausted_snapshot on commit drop as
select pg_catalog.jsonb_build_object(
  'requirement', to_jsonb(requirement.*), 'access', to_jsonb(version.*)
) as value
from vortex_access.organization_stewardship_requirements as requirement
join vortex_access.organization_access_versions as version
  on version.organization_id = requirement.organization_id
where requirement.organization_id = '22700000-0000-4000-8000-000000000001';
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'replace_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 3,
      '32700000-0000-4000-8000-000000000003',
      '62700000-0000-4000-8000-000000000103', 1,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000042'
    )
  $$,
  '22003'::char(5), 'Access version is exhausted',
  'Access exhaustion rolls back a valid proposed D2 replacement'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'requirement', to_jsonb(requirement.*), 'access', to_jsonb(version.*)
    )
    from vortex_access.organization_stewardship_requirements as requirement
    join vortex_access.organization_access_versions as version
      on version.organization_id = requirement.organization_id
    where requirement.organization_id =
      '22700000-0000-4000-8000-000000000001'
  ),
  (select value from access_exhausted_snapshot),
  'Access exhaustion preserves the exact requirement and Access evidence'
);

-- Required-revision exhaustion is checked before any write and leaves the
-- current complete D2 binding and Access evidence unchanged.
set constraints all immediate;
alter table vortex_access.organization_stewardship_requirements
  disable trigger organization_stewardship_requirements_protect_change;
update vortex_access.organization_stewardship_requirements
set revision = 9007199254740991,
  changed_at = pg_catalog.clock_timestamp()
where organization_id = '22700000-0000-4000-8000-000000000001';
alter table vortex_access.organization_stewardship_requirements
  enable trigger organization_stewardship_requirements_protect_change;
set constraints all deferred;

create temporary table exhausted_snapshot on commit drop as
select pg_catalog.jsonb_build_object(
  'requirement', to_jsonb(requirement.*),
  'access', to_jsonb(version.*)
) as value
from vortex_access.organization_stewardship_requirements as requirement
join vortex_access.organization_access_versions as version
  on version.organization_id = requirement.organization_id
where requirement.organization_id = '22700000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_management_application_requirement(
      'replace_management_application_requirement',
      '22700000-0000-4000-8000-000000000001', 9007199254740991,
      '32700000-0000-4000-8000-000000000001',
      '62700000-0000-4000-8000-000000000101', 2,
      '92700000-0000-4000-8000-000000000003',
      'a2700000-0000-4000-8000-000000000030'
    )
  $$,
  '22003'::char(5),
  'Organization stewardship requirement revision is exhausted',
  'requirement revision exhaustion refuses before any D2 change'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'requirement', to_jsonb(requirement.*),
      'access', to_jsonb(version.*)
    )
    from vortex_access.organization_stewardship_requirements as requirement
    join vortex_access.organization_access_versions as version
      on version.organization_id = requirement.organization_id
    where requirement.organization_id =
      '22700000-0000-4000-8000-000000000001'
  ),
  (select value from exhausted_snapshot),
  'exhaustion leaves the requirement and Access row byte-for-byte unchanged'
);

set constraints all immediate;
select * from finish();

rollback;
