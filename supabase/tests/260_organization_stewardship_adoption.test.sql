\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.stewardship_role_retirement_evidence(
  p_organization_id uuid,
  p_role_id uuid,
  p_expected_role_revision bigint
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'candidate', pg_catalog.jsonb_build_object(
      'operation', 'retire_role',
      'organizationId', p_organization_id,
      'roleId', p_role_id,
      'expectedRoleRevision', p_expected_role_revision
    ),
    'roleCandidateFingerprint',
      'sha256:' || pg_catalog.repeat('2', 64)
  )
$function$;

create function pg_temp.create_stewardship_scope(
  p_organization_id uuid,
  p_identity_id uuid,
  p_organization_account_id uuid,
  p_short_name text,
  p_account_state text default 'active'
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
    p_organization_id, '12600000-0000-4000-8000-000000000001',
    p_short_name, p_short_name, 'active', operation_at,
    '92600000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_identity_id, 'active', operation_at, operation_at,
    '92600000-0000-4000-8000-000000000001', p_identity_id, 1
  );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, suspended_at, closed_at, changed_at,
    state_changed_at, state_changed_by, state_change_correlation_id, revision
  ) values (
    p_organization_account_id, p_organization_id, p_identity_id, p_short_name,
    p_account_state, operation_at - interval '1 minute',
    case when p_account_state = 'suspended' then operation_at else null end,
    case when p_account_state = 'closed' then operation_at else null end,
    operation_at, operation_at,
    '92600000-0000-4000-8000-000000000001', p_organization_account_id, 1
  );

  perform 1
  from vortex_access.initialize_organization_access_version(
    p_organization_id,
    '92600000-0000-4000-8000-000000000001',
    p_organization_id
  );
  perform 1
  from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id,
    '92600000-0000-4000-8000-000000000001',
    p_identity_id
  );
end
$function$;

create function pg_temp.seed_platform_continuities(
  p_organization_id uuid,
  p_limit integer
)
returns void
language sql
volatile
set search_path = ''
as $function$
  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    'available', 1, entry.meaning_fingerprint, entry.registration_revision,
    pg_catalog.clock_timestamp()
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform'
  order by entry.owner_kind collate "C", entry.owner_id, entry.permission_id
  limit p_limit
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_table(
  'vortex_access', 'organization_stewardship_requirements',
  'Access stores one private current stewardship requirement'
);

select has_function(
  'vortex_access', 'coordinate_organization_stewardship_adoption',
  array[
    'uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'uuid', 'uuid',
    'uuid', 'uuid'
  ],
  'Access exposes one private trusted stewardship adoption composition'
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
      'vortex_access.coordinate_organization_stewardship_adoption(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', false,
    'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the adoption coordinator is owner-held, invoker-security and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_stewardship_adoption(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private adoption coordinator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request role can resolve Access before function privilege is tested'
);

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_stewardship_adoption(
      '22600000-0000-4000-8000-000000000001',
      '52600000-0000-4000-8000-000000000001',
      '62600000-0000-4000-8000-000000000001',
      'organization_steward', 'Organisation steward',
      'Permanent minimum organisation administration.',
      '72600000-0000-4000-8000-000000000001',
      '82600000-0000-4000-8000-000000000001',
      '92600000-0000-4000-8000-000000000001',
      'a2600000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_stewardship_adoption',
  'an actual request role cannot invoke trusted stewardship adoption'
);
reset role;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '12600000-0000-4000-8000-000000000001', 'stewardship_adoption',
  'Stewardship adoption', 'active', pg_catalog.statement_timestamp(),
  '92600000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '22600000-0000-4000-8000-000000000001',
  '12600000-0000-4000-8000-000000000001', 'stewardship_adoption',
  'Stewardship adoption', 'active', pg_catalog.statement_timestamp(),
  '92600000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '42600000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '92600000-0000-4000-8000-000000000001',
    'a2600000-0000-4000-8000-000000000002', 1
  ),
  (
    '42600000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '92600000-0000-4000-8000-000000000001',
    'a2600000-0000-4000-8000-000000000003', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '52600000-0000-4000-8000-000000000001',
    '22600000-0000-4000-8000-000000000001',
    '42600000-0000-4000-8000-000000000001', 'Original steward', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '92600000-0000-4000-8000-000000000001',
    'a2600000-0000-4000-8000-000000000004', 1
  ),
  (
    '52600000-0000-4000-8000-000000000002',
    '22600000-0000-4000-8000-000000000001',
    '42600000-0000-4000-8000-000000000002', 'Replacement steward', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '92600000-0000-4000-8000-000000000001',
    'a2600000-0000-4000-8000-000000000005', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '22600000-0000-4000-8000-000000000001',
  '92600000-0000-4000-8000-000000000001',
  'a2600000-0000-4000-8000-000000000006'
);

select * from vortex_access.initialize_platform_permission_catalogue(
  '22600000-0000-4000-8000-000000000001',
  '92600000-0000-4000-8000-000000000001',
  'a2600000-0000-4000-8000-000000000007'
);

-- Existing application authority is independent of first platform-continuity
-- observation. This exact accepted permission is also used below to prove that
-- a steward role may later contain separately accepted extras.
insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision, state,
  operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '22600000-0000-4000-8000-000000000001', 'application',
  '32600000-0000-4000-8000-000000000010', 1, 'active', 'register',
  'example.stewardship_extra', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64),
  pg_catalog.transaction_timestamp(),
  '92600000-0000-4000-8000-000000000001',
  'a2600000-0000-4000-8000-000000000020'
);

insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state, revision,
  source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '22600000-0000-4000-8000-000000000001', 'application',
  '32600000-0000-4000-8000-000000000010', 'active', 1,
  'example.stewardship_extra', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64),
  pg_catalog.transaction_timestamp(),
  '92600000-0000-4000-8000-000000000001',
  'a2600000-0000-4000-8000-000000000020'
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
  '22600000-0000-4000-8000-000000000001', 'application',
  '32600000-0000-4000-8000-000000000010', 1,
  '32600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010',
  '41600000-0000-4000-8000-000000000010',
  'example.stewardship_extra.read', 'Read extra records',
  'Read a separately accepted application record.', null, 'read', null, false,
  'application', 'example.stewardship_extra',
  '32600000-0000-4000-8000-000000000010', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('a', 64)
);

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values (
  '22600000-0000-4000-8000-000000000001',
  '32600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010',
  '41600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010', 'available', 1,
  'sha256:' || pg_catalog.repeat('a', 64), 1,
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '22600000-0000-4000-8000-000000000001',
  '63600000-0000-4000-8000-000000000050', 'custom',
  'unrelated_app_authority', 1,
  '92600000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
) values (
  '22600000-0000-4000-8000-000000000001',
  '63600000-0000-4000-8000-000000000050', 1, 1, 'custom', null,
  '32600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010',
  '41600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 1,
  'sha256:' || pg_catalog.repeat('a', 64)
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values (
  '22600000-0000-4000-8000-000000000001',
  '63600000-0000-4000-8000-000000000050', 1, 'custom', null,
  'active', 'standard', 'standing', 1, 1,
  'unrelated_app_authority', 'Unrelated application authority',
  'Accepted application authority that is unrelated to platform stewardship.',
  null, '92600000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a2600000-0000-4000-8000-000000000021'
);

set constraints all immediate;
set constraints all deferred;

create temporary table access_before_adoption on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22600000-0000-4000-8000-000000000001';

create temporary table adoption_result on commit drop as
select *
from vortex_access.coordinate_organization_stewardship_adoption(
  '22600000-0000-4000-8000-000000000001',
  '52600000-0000-4000-8000-000000000001',
  '62600000-0000-4000-8000-000000000001',
  'organization_steward', 'Organisation steward',
  'Permanent minimum organisation administration.',
  '72600000-0000-4000-8000-000000000001',
  '82600000-0000-4000-8000-000000000001',
  '92600000-0000-4000-8000-000000000002',
  'a2600000-0000-4000-8000-000000000008'
);

select is(
  (select outcome || '|' || operation from adoption_result),
  'changed|adopt_organization_stewardship',
  'explicit adoption reports one changed stewardship operation'
);

select is(
  (select access_version from adoption_result),
  (select current_version + 1 from access_before_adoption),
  'adoption increments the existing organization Access version exactly once'
);

select is(
  (
    select requirement - array['adoptedAt', 'changedAt']
    from adoption_result
  ),
  pg_catalog.jsonb_build_object(
    'organizationId', '22600000-0000-4000-8000-000000000001'::uuid,
    'revision', 1,
    'originalOrganizationAccountId',
      '52600000-0000-4000-8000-000000000001'::uuid,
    'originalRoleId', '62600000-0000-4000-8000-000000000001'::uuid,
    'originalRoleAssignmentId',
      '72600000-0000-4000-8000-000000000001'::uuid,
    'originalDelegationAuthorityId',
      '82600000-0000-4000-8000-000000000001'::uuid,
    'adoptedByActorId', '92600000-0000-4000-8000-000000000002'::uuid,
    'adoptionCorrelationId', 'a2600000-0000-4000-8000-000000000008'::uuid,
    'changedByActorId', '92600000-0000-4000-8000-000000000002'::uuid,
    'changeCorrelationId', 'a2600000-0000-4000-8000-000000000008'::uuid
  ),
  'the stored result is the complete immutable adoption provenance and current marker'
);

select is(
  (
    select pg_catalog.count(*)
    from vortex_access.permission_continuities as continuity
    where continuity.organization_id =
      '22600000-0000-4000-8000-000000000001'
      and continuity.application_root_id is null
      and continuity.registration_kind = 'platform'
      and continuity.state = 'available'
      and continuity.continuity_revision = 1
  ),
  13::bigint,
  'adoption initializes exactly the thirteen platform continuities once'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'kind', revision.role_kind,
      'lifecycle', revision.lifecycle,
      'classification', revision.privilege_classification,
      'policy', revision.assignment_policy,
      'permissions', pg_catalog.count(permission.entry_ordinal),
      'applicationPermissions', pg_catalog.count(*) filter (
        where permission.application_root_id is not null
      )
    )
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    where role.organization_id = '22600000-0000-4000-8000-000000000001'
      and role.role_id = '62600000-0000-4000-8000-000000000001'
    group by revision.role_kind, revision.lifecycle,
      revision.privilege_classification, revision.assignment_policy
  ),
  pg_catalog.jsonb_build_object(
    'kind', 'custom', 'lifecycle', 'active',
    'classification', 'privileged', 'policy', 'standing',
    'permissions', 13, 'applicationPermissions', 0
  ),
  'initial stewardship is exactly the minimum platform role with no application use'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'assignmentHolder', assignment.organization_account_id,
      'assignmentKind', assignment.assignment_kind,
      'assignmentState', assignment.state,
      'assignmentExpiry', assignment.expires_at,
      'delegationHolder', delegation.organization_account_id,
      'delegationScope', delegation.scope_kind,
      'delegationState', delegation.state,
      'delegationExpiry', delegation.expires_at
    )
    from vortex_access.organization_role_assignments as assignment
    cross join vortex_access.organization_delegation_authorities as delegation
    where assignment.organization_id = '22600000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id =
        '72600000-0000-4000-8000-000000000001'
      and delegation.organization_id = assignment.organization_id
      and delegation.delegation_authority_id =
        '82600000-0000-4000-8000-000000000001'
  ),
  pg_catalog.jsonb_build_object(
    'assignmentHolder', '52600000-0000-4000-8000-000000000001'::uuid,
    'assignmentKind', 'standing', 'assignmentState', 'live',
    'assignmentExpiry', null,
    'delegationHolder', '52600000-0000-4000-8000-000000000001'::uuid,
    'delegationScope', 'organization_catalogue', 'delegationState', 'live',
    'delegationExpiry', null
  ),
  'initial assignment and delegation are direct, permanent and same-account'
);

select ok(
  vortex_access.organization_has_permanent_steward(
    '22600000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp()
  ),
  'the exact initial facts qualify as permanent stewardship'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'revoke_delegation',
      '22600000-0000-4000-8000-000000000001',
      '82600000-0000-4000-8000-000000000001', 1,
      null, null, null, null, null, null, null, null,
      '92600000-0000-4000-8000-000000000003',
      'a2600000-0000-4000-8000-000000000092'
    )
  $$,
  '23514'::char(5), null,
  'the real delegation writer cannot remove the final permanent steward'
);

select is(
  (
    select state || '|' || revision::text
    from vortex_access.organization_delegation_authorities
    where organization_id = '22600000-0000-4000-8000-000000000001'
      and delegation_authority_id = '82600000-0000-4000-8000-000000000001'
  ),
  'live|1',
  'refused final-steward delegation removal leaves the grant unchanged'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_change(
      pg_temp.stewardship_role_retirement_evidence(
        '22600000-0000-4000-8000-000000000001',
        '62600000-0000-4000-8000-000000000001', 1
      ),
      '92600000-0000-4000-8000-000000000003',
      'a2600000-0000-4000-8000-000000000093'
    )
  $$,
  '23514'::char(5), null,
  'the real role writer cannot retire the final permanent steward role'
);

select is(
  (
    select revision.lifecycle || '|' || role.live_revision::text
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = '22600000-0000-4000-8000-000000000001'
      and role.role_id = '62600000-0000-4000-8000-000000000001'
  ),
  'active|1',
  'refused final-steward retirement leaves the role unchanged'
);

-- Add one separately accepted application permission to the steward role.
-- The current qualifier is intentionally a required-platform subset check,
-- not an exact-role-size check.
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
) values (
  '22600000-0000-4000-8000-000000000001',
  '62600000-0000-4000-8000-000000000001', 2, 1, 'custom', null,
  '32600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010',
  '41600000-0000-4000-8000-000000000010', 'application',
  '32600000-0000-4000-8000-000000000010', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 1,
  'sha256:' || pg_catalog.repeat('a', 64)
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select permission.organization_id, permission.role_id, 2,
  permission.entry_ordinal + 1, permission.role_kind,
  permission.role_application_root_id, permission.application_root_id,
  permission.owner_kind, permission.owner_id, permission.permission_id,
  permission.registration_kind, permission.registration_owner_id,
  permission.accepted_registration_revision, permission.catalogue_fingerprint,
  permission.continuity_revision, permission.meaning_fingerprint
from vortex_access.organization_role_permission_entries as permission
where permission.organization_id = '22600000-0000-4000-8000-000000000001'
  and permission.role_id = '62600000-0000-4000-8000-000000000001'
  and permission.role_revision = 1
order by permission.entry_ordinal;

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values (
  '22600000-0000-4000-8000-000000000001',
  '62600000-0000-4000-8000-000000000001', 2, 'custom', null,
  'active', 'privileged', 'standing', 1, 2,
  'organization_steward', 'Organisation steward',
  'Permanent minimum organisation administration plus accepted application use.',
  null, '92600000-0000-4000-8000-000000000003',
  pg_catalog.clock_timestamp(),
  'a2600000-0000-4000-8000-000000000094'
);

update vortex_access.organization_roles
set live_revision = 2
where organization_id = '22600000-0000-4000-8000-000000000001'
  and role_id = '62600000-0000-4000-8000-000000000001';

select *
from vortex_access.increment_organization_access_version(
  '22600000-0000-4000-8000-000000000001',
  '92600000-0000-4000-8000-000000000003',
  'a2600000-0000-4000-8000-000000000094',
  'role_catalogue_changed'
);

set constraints all immediate;
set constraints all deferred;

select is(
  (
    select pg_catalog.jsonb_build_object(
      'permissions', pg_catalog.count(*),
      'applicationPermissions', pg_catalog.count(*) filter (
        where permission.application_root_id is not null
      ),
      'authorityContinuityRevision', revision.authority_continuity_revision,
      'qualifies', vortex_access.organization_has_permanent_steward(
        role.organization_id, pg_catalog.clock_timestamp()
      )
    )
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    where role.organization_id = '22600000-0000-4000-8000-000000000001'
      and role.role_id = '62600000-0000-4000-8000-000000000001'
    group by role.organization_id, revision.authority_continuity_revision
  ),
  pg_catalog.jsonb_build_object(
    'permissions', 14,
    'applicationPermissions', 1,
    'authorityContinuityRevision', 2,
    'qualifies', true
  ),
  'one direct standing assignment may qualify with the required thirteen plus accepted extras'
);

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '32600000-0000-4000-8000-000000000001',
    'tenantId', '12600000-0000-4000-8000-000000000001',
    'organizationId', '22600000-0000-4000-8000-000000000001',
    'sessionId', '62600000-0000-4000-8000-000000000090',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', (select access_version from adoption_result),
    'correlationId', 'a2600000-0000-4000-8000-000000000090',
    'identityId', '42600000-0000-4000-8000-000000000001',
    'organizationAccountId', '52600000-0000-4000-8000-000000000001',
    'authenticationStrength', 'single_factor'
  )
);

select throws_ok(
  $$
    select *
    from vortex_access.change_organization_account_state(
      '52600000-0000-4000-8000-000000000001', 1, 'suspended'
    )
  $$,
  '23514'::char(5), null,
  'the real Access-owned account writer cannot suspend the final permanent steward'
);

select is(
  (
    select state || '|' || revision::text
    from vortex_identity.organization_accounts
    where organization_account_id = '52600000-0000-4000-8000-000000000001'
  ),
  'active|1',
  'refused final-steward suspension leaves the original account unchanged'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_role_assignment_change(
      'revoke',
      '22600000-0000-4000-8000-000000000001',
      '72600000-0000-4000-8000-000000000001', 1,
      null, null, null, null, null, null, null, null,
      '92600000-0000-4000-8000-000000000003',
      'a2600000-0000-4000-8000-000000000009'
    )
  $$,
  '23514'::char(5), null,
  'the real assignment writer cannot remove the final permanent steward'
);

select is(
  (
    select state || '|' || revision::text
    from vortex_access.organization_role_assignments
    where organization_id = '22600000-0000-4000-8000-000000000001'
      and role_assignment_id = '72600000-0000-4000-8000-000000000001'
  ),
  'live|1',
  'refused final-steward removal leaves the original assignment unchanged'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant',
  '22600000-0000-4000-8000-000000000001',
  '72600000-0000-4000-8000-000000000002', null,
  '62600000-0000-4000-8000-000000000001', 2,
  'organization_account', '52600000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.statement_timestamp(), null,
  '92600000-0000-4000-8000-000000000003',
  'a2600000-0000-4000-8000-000000000010'
);

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '22600000-0000-4000-8000-000000000001',
  '82600000-0000-4000-8000-000000000002', null,
  'organization_account', '52600000-0000-4000-8000-000000000002', null,
  'organization_catalogue', null, null,
  pg_catalog.statement_timestamp(), null,
  '92600000-0000-4000-8000-000000000003',
  'a2600000-0000-4000-8000-000000000011'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke',
  '22600000-0000-4000-8000-000000000001',
  '72600000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null,
  '92600000-0000-4000-8000-000000000003',
  'a2600000-0000-4000-8000-000000000012'
);

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'revoke_delegation',
  '22600000-0000-4000-8000-000000000001',
  '82600000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null,
  '92600000-0000-4000-8000-000000000003',
  'a2600000-0000-4000-8000-000000000013'
);

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '32600000-0000-4000-8000-000000000001',
    'tenantId', '12600000-0000-4000-8000-000000000001',
    'organizationId', '22600000-0000-4000-8000-000000000001',
    'sessionId', '62600000-0000-4000-8000-000000000091',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', (
      select current_version
      from vortex_access.organization_access_versions
      where organization_id = '22600000-0000-4000-8000-000000000001'
    ),
    'correlationId', 'a2600000-0000-4000-8000-000000000091',
    'identityId', '42600000-0000-4000-8000-000000000001',
    'organizationAccountId', '52600000-0000-4000-8000-000000000001',
    'authenticationStrength', 'single_factor'
  )
);

create temporary table suspended_original_account on commit drop as
select *
from vortex_access.change_organization_account_state(
  '52600000-0000-4000-8000-000000000001', 1, 'suspended'
);

select is(
  (
    select state || '|' || revision::text || '|' || access_version::text
    from suspended_original_account
  ),
  (
    select 'suspended|2|' || current_version::text
    from vortex_access.organization_access_versions
    where organization_id = '22600000-0000-4000-8000-000000000001'
  ),
  'the Access-owned account writer can suspend the original account after replacement'
);

create temporary table access_before_replay on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22600000-0000-4000-8000-000000000001';

create temporary table replay_result on commit drop as
select *
from vortex_access.coordinate_organization_stewardship_adoption(
  '22600000-0000-4000-8000-000000000001',
  '52600000-0000-4000-8000-000000000001',
  '62600000-0000-4000-8000-000000000001',
  'ignored_on_replay', 'Ignored on completed replay',
  'Creation-only metadata cannot restore the original grant.',
  '72600000-0000-4000-8000-000000000001',
  '82600000-0000-4000-8000-000000000001',
  '92600000-0000-4000-8000-000000000002',
  'a2600000-0000-4000-8000-000000000008'
);

select is(
  (
    select outcome || '|' || access_version::text
    from replay_result
  ),
  (
    select 'unchanged|' || current_version::text
    from access_before_replay
  ),
  'exact replay returns unchanged with the current Access version'
);

select is(
  (
    select assignment.state || '|' || delegation.state
    from vortex_access.organization_role_assignments as assignment
    cross join vortex_access.organization_delegation_authorities as delegation
    where assignment.organization_id = '22600000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id =
        '72600000-0000-4000-8000-000000000001'
      and delegation.organization_id = assignment.organization_id
      and delegation.delegation_authority_id =
        '82600000-0000-4000-8000-000000000001'
  ),
  'revoked|revoked',
  'replay after legitimate replacement does not recreate or revive original grants'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_stewardship_adoption(
      '22600000-0000-4000-8000-000000000001',
      '52600000-0000-4000-8000-000000000001',
      '62600000-0000-4000-8000-000000000099',
      'ignored_on_replay', 'Ignored on completed replay',
      'Creation-only metadata cannot restore the original grant.',
      '72600000-0000-4000-8000-000000000001',
      '82600000-0000-4000-8000-000000000001',
      '92600000-0000-4000-8000-000000000002',
      'a2600000-0000-4000-8000-000000000008'
    )
  $$,
  '40001'::char(5), null,
  'replay with conflicting immutable adoption evidence refuses'
);

select pg_temp.create_stewardship_scope(
  '22600000-0000-4000-8000-000000000002',
  '42600000-0000-4000-8000-000000000003',
  '52600000-0000-4000-8000-000000000003',
  'partial_continuity'
);
select pg_temp.seed_platform_continuities(
  '22600000-0000-4000-8000-000000000002', 1
);

create temporary table partial_access_before on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22600000-0000-4000-8000-000000000002';

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_stewardship_adoption(
      '22600000-0000-4000-8000-000000000002',
      '52600000-0000-4000-8000-000000000003',
      '62600000-0000-4000-8000-000000000010',
      'partial_steward', 'Partial steward',
      'This adoption must refuse incomplete continuity evidence.',
      '72600000-0000-4000-8000-000000000010',
      '82600000-0000-4000-8000-000000000010',
      '92600000-0000-4000-8000-000000000002',
      'a2600000-0000-4000-8000-000000000100'
    )
  $$,
  '55000'::char(5), null,
  'a partial platform-continuity set refuses initial stewardship adoption'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'requirements', (
        select pg_catalog.count(*)
        from vortex_access.organization_stewardship_requirements
        where organization_id = '22600000-0000-4000-8000-000000000002'
      ),
      'roles', (
        select pg_catalog.count(*)
        from vortex_access.organization_roles
        where organization_id = '22600000-0000-4000-8000-000000000002'
      ),
      'accessVersion', version.current_version
    )
    from vortex_access.organization_access_versions as version
    where version.organization_id = '22600000-0000-4000-8000-000000000002'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'requirements', 0,
      'roles', 0,
      'accessVersion', current_version
    )
    from partial_access_before
  ),
  'partial-continuity refusal leaves no stewardship facts or Access change'
);

select pg_temp.create_stewardship_scope(
  '22600000-0000-4000-8000-000000000003',
  '42600000-0000-4000-8000-000000000004',
  '52600000-0000-4000-8000-000000000004',
  'exact_continuity'
);
select pg_temp.seed_platform_continuities(
  '22600000-0000-4000-8000-000000000003', 13
);

create temporary table exact_continuity_adoption on commit drop as
select *
from vortex_access.coordinate_organization_stewardship_adoption(
  '22600000-0000-4000-8000-000000000003',
  '52600000-0000-4000-8000-000000000004',
  '62600000-0000-4000-8000-000000000011',
  'exact_steward', 'Exact steward',
  'Existing exact platform continuity evidence is adopted without duplication.',
  '72600000-0000-4000-8000-000000000011',
  '82600000-0000-4000-8000-000000000011',
  '92600000-0000-4000-8000-000000000002',
  'a2600000-0000-4000-8000-000000000101'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'outcome', result.outcome,
      'continuities', (
        select pg_catalog.count(*)
        from vortex_access.permission_continuities as continuity
        where continuity.organization_id =
          '22600000-0000-4000-8000-000000000003'
          and continuity.registration_kind = 'platform'
      ),
      'qualifies', vortex_access.organization_has_permanent_steward(
        '22600000-0000-4000-8000-000000000003',
        pg_catalog.clock_timestamp()
      )
    )
    from exact_continuity_adoption as result
  ),
  pg_catalog.jsonb_build_object(
    'outcome', 'changed', 'continuities', 13, 'qualifies', true
  ),
  'an exact pre-existing continuity set is adopted once without duplicates'
);

select pg_temp.create_stewardship_scope(
  '22600000-0000-4000-8000-000000000004',
  '42600000-0000-4000-8000-000000000005',
  '52600000-0000-4000-8000-000000000005',
  'inactive_steward', 'suspended'
);

create temporary table inactive_access_before on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22600000-0000-4000-8000-000000000004';

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_stewardship_adoption(
      '22600000-0000-4000-8000-000000000004',
      '52600000-0000-4000-8000-000000000005',
      '62600000-0000-4000-8000-000000000012',
      'inactive_steward', 'Inactive steward',
      'An inactive account cannot receive initial stewardship.',
      '72600000-0000-4000-8000-000000000012',
      '82600000-0000-4000-8000-000000000012',
      '92600000-0000-4000-8000-000000000002',
      'a2600000-0000-4000-8000-000000000102'
    )
  $$,
  '40001'::char(5), null,
  'an inactive account refuses initial stewardship adoption'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'requirements', (
        select pg_catalog.count(*)
        from vortex_access.organization_stewardship_requirements
        where organization_id = '22600000-0000-4000-8000-000000000004'
      ),
      'accessVersion', version.current_version
    )
    from vortex_access.organization_access_versions as version
    where version.organization_id = '22600000-0000-4000-8000-000000000004'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'requirements', 0, 'accessVersion', current_version
    )
    from inactive_access_before
  ),
  'inactive-account refusal leaves no requirement or Access change'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_stewardship_adoption(
      '22600000-0000-4000-8000-000000000002',
      '52600000-0000-4000-8000-000000000004',
      '62600000-0000-4000-8000-000000000013',
      'foreign_steward', 'Foreign steward',
      'A foreign account cannot be appointed across organization scope.',
      '72600000-0000-4000-8000-000000000013',
      '82600000-0000-4000-8000-000000000013',
      '92600000-0000-4000-8000-000000000002',
      'a2600000-0000-4000-8000-000000000103'
    )
  $$,
  '40001'::char(5), null,
  'a foreign organization account refuses stewardship adoption'
);

select pg_temp.create_stewardship_scope(
  '22600000-0000-4000-8000-000000000005',
  '42600000-0000-4000-8000-000000000006',
  '52600000-0000-4000-8000-000000000006',
  'exhausted_stewardship'
);

set constraints all immediate;
alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 9007199254740991,
  changed_at = pg_catalog.clock_timestamp(),
  changed_by = '92600000-0000-4000-8000-000000000001',
  change_correlation_id = 'a2600000-0000-4000-8000-000000000104',
  change_reason = 'stewardship_changed'
where organization_id = '22600000-0000-4000-8000-000000000005';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;
set constraints all deferred;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_stewardship_adoption(
      '22600000-0000-4000-8000-000000000005',
      '52600000-0000-4000-8000-000000000006',
      '62600000-0000-4000-8000-000000000014',
      'exhausted_steward', 'Exhausted steward',
      'Access exhaustion must roll back every adoption fact.',
      '72600000-0000-4000-8000-000000000014',
      '82600000-0000-4000-8000-000000000014',
      '92600000-0000-4000-8000-000000000002',
      'a2600000-0000-4000-8000-000000000105'
    )
  $$,
  '22003'::char(5), null,
  'Access-version exhaustion refuses the complete adoption transaction'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'version', version.current_version,
      'continuities', (
        select pg_catalog.count(*)
        from vortex_access.permission_continuities
        where organization_id = '22600000-0000-4000-8000-000000000005'
      ),
      'requirements', (
        select pg_catalog.count(*)
        from vortex_access.organization_stewardship_requirements
        where organization_id = '22600000-0000-4000-8000-000000000005'
      ),
      'roles', (
        select pg_catalog.count(*)
        from vortex_access.organization_roles
        where organization_id = '22600000-0000-4000-8000-000000000005'
      ),
      'assignments', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_assignments
        where organization_id = '22600000-0000-4000-8000-000000000005'
      ),
      'delegations', (
        select pg_catalog.count(*)
        from vortex_access.organization_delegation_authorities
        where organization_id = '22600000-0000-4000-8000-000000000005'
      )
    )
    from vortex_access.organization_access_versions as version
    where version.organization_id = '22600000-0000-4000-8000-000000000005'
  ),
  pg_catalog.jsonb_build_object(
    'version', 9007199254740991,
    'continuities', 0,
    'requirements', 0,
    'roles', 0,
    'assignments', 0,
    'delegations', 0
  ),
  'exhaustion leaves no partial continuity, requirement or stewardship grant'
);

set constraints all immediate;
select * from finish();

rollback;
