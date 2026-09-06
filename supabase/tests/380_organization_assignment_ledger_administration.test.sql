\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.create_assignment_ledger_scope(
  p_organization_id uuid,
  p_identity_id uuid,
  p_organization_account_id uuid,
  p_role_id uuid,
  p_role_assignment_id uuid,
  p_delegation_authority_id uuid,
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
    p_organization_id, '13800000-0000-4000-8000-000000000001',
    p_short_name, p_short_name, 'active', operation_at,
    '93800000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_identity_id, 'active', operation_at, operation_at,
    '93800000-0000-4000-8000-000000000001', p_identity_id, 1
  );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_organization_account_id, p_organization_id, p_identity_id,
    p_short_name, 'active', operation_at - interval '1 minute', operation_at,
    operation_at, '93800000-0000-4000-8000-000000000001',
    p_organization_account_id, 1
  );

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id,
    '93800000-0000-4000-8000-000000000001',
    'a3800000-0000-4000-8000-000000000001'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id,
    '93800000-0000-4000-8000-000000000001',
    'a3800000-0000-4000-8000-000000000002'
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    'available', 1, entry.meaning_fingerprint, entry.registration_revision,
    operation_at
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'platform';

  perform 1 from vortex_access.coordinate_organization_stewardship_adoption(
    p_organization_id, p_organization_account_id, p_role_id,
    p_short_name || '_steward', p_short_name || ' steward',
    'Minimum neutral authority for the protected assignment ledger fixture.',
    p_role_assignment_id, p_delegation_authority_id,
    '93800000-0000-4000-8000-000000000001', p_role_id
  );
end
$function$;

create function pg_temp.install_assignment_ledger_context(
  p_identity_id uuid,
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  current_access_version bigint;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83800000-0000-4000-8000-000000000001',
    'tenantId', '13800000-0000-4000-8000-000000000001',
    'organizationId', p_organization_id,
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '73800000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3800000-0000-4000-8000-000000000099'
  ));
end
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'list_organization_role_assignments_for_administration',
  array['uuid', 'integer'],
  'Access exposes one bounded protected role-assignment list'
);
select has_function(
  'vortex_access', 'read_organization_role_assignment_for_administration',
  array['uuid'],
  'Access exposes one exact protected role-assignment detail read'
);
select has_function(
  'vortex_access', 'list_organization_delegation_authorities_for_administration',
  array['uuid', 'integer'],
  'Access exposes one bounded protected delegation list'
);
select has_function(
  'vortex_access', 'read_organization_delegation_authority_for_administration',
  array['uuid'],
  'Access exposes one exact protected delegation detail read'
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
      'vortex_access.list_organization_role_assignments_for_administration(uuid,integer)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the role-assignment list is a narrow owner-held protected projection'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_role_assignments_for_administration(uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_role_assignment_for_administration(uuid)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_delegation_authorities_for_administration(uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_delegation_authority_for_administration(uuid)',
    'EXECUTE'
  ),
  'request role can execute the four protected ledger projections'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_role_assignments_for_administration(uuid,integer)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_delegation_authorities_for_administration(uuid,integer)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the protected assignment ledger'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.organization_assignment_ledger_administration_scope()',
    'EXECUTE'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_role_assignments', 'SELECT'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_delegation_authorities', 'SELECT'
  ),
  'request role cannot bypass the leaf projections through scope or raw facts'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13800000-0000-4000-8000-000000000001', 'assignment_ledger',
  'Assignment ledger', 'active', pg_catalog.clock_timestamp(),
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

select pg_temp.create_assignment_ledger_scope(
  '23800000-0000-4000-8000-000000000001',
  '43800000-0000-4000-8000-000000000001',
  '53800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000001',
  '73800000-0000-4000-8000-000000000001',
  '83800000-0000-4000-8000-000000000001',
  'assignment_ledger'
);
select pg_temp.create_assignment_ledger_scope(
  '23800000-0000-4000-8000-000000000002',
  '43800000-0000-4000-8000-000000000010',
  '53800000-0000-4000-8000-000000000010',
  '63800000-0000-4000-8000-000000000010',
  '73800000-0000-4000-8000-000000000010',
  '83800000-0000-4000-8000-000000000010',
  'foreign_assignment_ledger'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '43800000-0000-4000-8000-000000000002', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000010', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '53800000-0000-4000-8000-000000000002',
  '23800000-0000-4000-8000-000000000001',
  '43800000-0000-4000-8000-000000000002', 'Ledger observer', 'active',
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000011', 1
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000020', null,
  'ledger_reviewers', 'Ledger reviewers',
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000020'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000030', 'custom',
  'activation_reviewer', null, null, 1,
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp()
);
insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision,
  policy_fingerprint, maximum_activation_duration_seconds,
  reason_required, authentication_requirement,
  authentication_maximum_age_seconds, independent_approval_required,
  changed_by, changed_at, change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000030',
  '64800000-0000-4000-8000-000000000030', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 3600, true,
  'multi_factor', 900, false,
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3800000-0000-4000-8000-000000000030'
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select entry.organization_id,
  '63800000-0000-4000-8000-000000000030', 1, entry.entry_ordinal,
  'custom', null, entry.application_root_id, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  entry.accepted_registration_revision, entry.catalogue_fingerprint,
  entry.continuity_revision, entry.meaning_fingerprint
from vortex_access.organization_role_permission_entries as entry
where entry.organization_id = '23800000-0000-4000-8000-000000000001'
  and entry.role_id = '63800000-0000-4000-8000-000000000001'
  and entry.role_revision = 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  activation_policy_id, activation_policy_revision,
  activation_policy_fingerprint, role_key, label, description,
  source_definition_key, source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000030', 1, 'custom', null,
  'active', 'privileged', 'activation_required', 1, 1,
  '64800000-0000-4000-8000-000000000030', 1,
  'sha256:' || pg_catalog.repeat('3', 64),
  'activation_reviewer', 'Activation reviewer',
  'Neutral activation-required role used by the ledger fixture.',
  null, null, null, null, null, null, null, null, null, null, null,
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3800000-0000-4000-8000-000000000031'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23800000-0000-4000-8000-000000000001',
  '73800000-0000-4000-8000-000000000030', null,
  '63800000-0000-4000-8000-000000000030', 1,
  'group', null, '63800000-0000-4000-8000-000000000020', 'eligible',
  pg_catalog.clock_timestamp() + interval '1 day', null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000032'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23800000-0000-4000-8000-000000000001',
  '73800000-0000-4000-8000-000000000040', null,
  '63800000-0000-4000-8000-000000000001', 1,
  'group', null, '63800000-0000-4000-8000-000000000020', 'standing',
  pg_catalog.clock_timestamp() - interval '1 day', null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000033'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '23800000-0000-4000-8000-000000000001',
  '73800000-0000-4000-8000-000000000040', 1,
  null, null, null, null, null, null, null, null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000034'
);

create temporary table bounded_permission on commit drop as
select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'kind', 'exact',
  'ownerKind', entry.owner_kind,
  'ownerId', entry.owner_id,
  'permissionId', entry.permission_id,
  'acceptedRegistrationRevision', entry.accepted_registration_revision,
  'catalogueFingerprint', entry.catalogue_fingerprint,
  'continuityRevision', entry.continuity_revision,
  'meaningFingerprint', entry.meaning_fingerprint
) order by entry.entry_ordinal) as value
from vortex_access.organization_role_permission_entries as entry
where entry.organization_id = '23800000-0000-4000-8000-000000000001'
  and entry.role_id = '63800000-0000-4000-8000-000000000001'
  and entry.role_revision = 1
  and entry.permission_id = '9901c0dc-8bac-45c7-be0b-3642cb839bb1';

-- This current ledger can retain a naturally expired historical grant. Only
-- the insert-time "must still be live" validator is disabled while an
-- otherwise constraint-valid fact with exact current bounded evidence is
-- seeded; the immutable-change protector remains enabled throughout.
select vortex_access.validate_organization_delegation_bounded_permissions(
  '23800000-0000-4000-8000-000000000001',
  (select value from bounded_permission)
);
set constraints all immediate;
set constraints all deferred;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_validate_scope;
insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
  granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001',
  '83800000-0000-4000-8000-000000000030', 'group',
  null, '63800000-0000-4000-8000-000000000020',
  'bounded', (select value from bounded_permission),
  'sha256:' || pg_catalog.repeat('8', 64), 1,
  pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '1 day', 'live',
  '93800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 days',
  'a3800000-0000-4000-8000-000000000035',
  '93800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 days',
  'a3800000-0000-4000-8000-000000000035'
);
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_validate_scope;
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation', '23800000-0000-4000-8000-000000000001',
  '83800000-0000-4000-8000-000000000040', null,
  'organization_account', '53800000-0000-4000-8000-000000000002', null,
  'organization_catalogue', null, null,
  pg_catalog.clock_timestamp() - interval '1 day', null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000036'
);
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'revoke_delegation', '23800000-0000-4000-8000-000000000001',
  '83800000-0000-4000-8000-000000000040', 1,
  null, null, null, null, null, null, null, null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000037'
);

select * from vortex_access.coordinate_organization_group_change(
  'retire_group', '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000020', 1, null, null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000038'
);

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_request;
select pg_temp.install_assignment_ledger_context(
  '43800000-0000-4000-8000-000000000001',
  '23800000-0000-4000-8000-000000000001',
  '53800000-0000-4000-8000-000000000001'
);
set local role vortex_request;

select results_eq(
  $$
    select pg_catalog.jsonb_array_length(assignments),
      next_after_role_assignment_id,
      organization_id,
      access_version
    from vortex_access.list_organization_role_assignments_for_administration(
      null, 2
    )
  $$,
  $$values (
    2,
    '73800000-0000-4000-8000-000000000030'::uuid,
    '23800000-0000-4000-8000-000000000001'::uuid,
    10::bigint
  )$$,
  'authorized request receives one complete role-assignment keyset page'
);
select results_eq(
  $$
    select item ->> 'roleAssignmentId', item #>> '{assignee,kind}',
      item ->> 'assignmentKind', item ->> 'temporalState',
      item #>> '{role,lifecycle}'
    from vortex_access.list_organization_role_assignments_for_administration(
      null, 2
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.assignments) as item
    order by item ->> 'roleAssignmentId'
  $$,
  $$values
    ('73800000-0000-4000-8000-000000000001', 'organization_account',
      'standing', 'active', 'active'),
    ('73800000-0000-4000-8000-000000000030', 'group',
      'eligible', 'scheduled', 'active')$$,
  'assignment page distinguishes direct standing and Group eligible facts'
);
select results_eq(
  $$
    select item ->> 'roleAssignmentId', item ->> 'temporalState',
      item #>> '{assignee,state}'
    from vortex_access.list_organization_role_assignments_for_administration(
      '73800000-0000-4000-8000-000000000030', 2
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.assignments) as item
  $$,
  $$values
    ('73800000-0000-4000-8000-000000000040', 'revoked', 'retired')$$,
  'assignment continuation retains terminal facts and retired Group summary'
);
select is(
  (
    select outcome || '|' || (assignment_summary ->> 'roleAssignmentId')
      || '|' || (assignment_summary ->> 'revision')
      || '|' || (assignment_summary #>> '{role,key}')
    from vortex_access.read_organization_role_assignment_for_administration(
      '73800000-0000-4000-8000-000000000040'
    )
  ),
  'available|73800000-0000-4000-8000-000000000040|2|assignment_ledger_steward',
  'role-assignment detail returns the current safe role reference and fact revision'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_organization_role_assignment_for_administration(
      '73800000-0000-4000-8000-000000000001'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.assignment_summary) as key
  ),
  '{assignee,assignmentKind,revision,role,roleAssignmentId,startsAt,state,temporalState}',
  'assignment detail omits grant and change audit evidence'
);

select results_eq(
  $$
    select pg_catalog.jsonb_array_length(delegations),
      next_after_delegation_authority_id, organization_id, access_version
    from vortex_access.list_organization_delegation_authorities_for_administration(
      null, 2
    )
  $$,
  $$values (
    2,
    '83800000-0000-4000-8000-000000000030'::uuid,
    '23800000-0000-4000-8000-000000000001'::uuid,
    10::bigint
  )$$,
  'authorized request receives one complete delegation keyset page'
);
select results_eq(
  $$
    select item ->> 'delegationAuthorityId', item #>> '{holder,kind}',
      item #>> '{scope,kind}', item ->> 'temporalState',
      item #>> '{holder,state}'
    from vortex_access.list_organization_delegation_authorities_for_administration(
      null, 2
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.delegations) as item
    order by item ->> 'delegationAuthorityId'
  $$,
  $$values
    ('83800000-0000-4000-8000-000000000001', 'organization_account',
      'organization_catalogue', 'active', null::text),
    ('83800000-0000-4000-8000-000000000030', 'group',
      'bounded', 'expired', 'retired')$$,
  'delegation page distinguishes catalogue and bounded retained holder facts'
);
select results_eq(
  $$
    select item ->> 'delegationAuthorityId', item ->> 'temporalState'
    from vortex_access.list_organization_delegation_authorities_for_administration(
      '83800000-0000-4000-8000-000000000030', 2
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.delegations) as item
  $$,
  $$values ('83800000-0000-4000-8000-000000000040', 'revoked')$$,
  'delegation continuation retains terminal authority facts'
);
select is(
  (
    select outcome || '|' || (delegation_summary ->> 'delegationAuthorityId')
      || '|' || (delegation_summary #>> '{scope,permissions,0,ownerKind}')
      || '|' || (delegation_summary #>> '{scope,permissions,0,permissionId}')
    from vortex_access.read_organization_delegation_authority_for_administration(
      '83800000-0000-4000-8000-000000000030'
    )
  ),
  'available|83800000-0000-4000-8000-000000000030|platform|9901c0dc-8bac-45c7-be0b-3642cb839bb1',
  'delegation detail returns only the ordered exact permission identity'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_organization_delegation_authority_for_administration(
      '83800000-0000-4000-8000-000000000030'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(
      detail.delegation_summary #> '{scope,permissions,0}'
    ) as key
  ),
  '{ownerId,ownerKind,permissionId}',
  'bounded delegation strips registration, continuity, meaning and fingerprints'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_organization_delegation_authority_for_administration(
      '83800000-0000-4000-8000-000000000001'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.delegation_summary) as key
  ),
  '{delegationAuthorityId,holder,revision,scope,startsAt,state,temporalState}',
  'delegation detail omits grant, change and raw scope evidence'
);

select is(
  (
    select outcome
    from vortex_access.read_organization_role_assignment_for_administration(
      '73800000-0000-4000-8000-000000000010'
    )
  ),
  'unavailable',
  'same-tenant foreign assignment detail is unavailable'
);
select is(
  (
    select outcome
    from vortex_access.read_organization_delegation_authority_for_administration(
      '83800000-0000-4000-8000-000000000099'
    )
  ),
  'unavailable',
  'unknown delegation detail is unavailable'
);
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_role_assignments_for_administration(
      '00000000-0000-0000-0000-000000000000', 1
    )
  $$,
  '22023'::char(5), 'Organization role assignment page input is invalid',
  'assignment list refuses a nil keyset cursor'
);
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_delegation_authorities_for_administration(
      null, 101
    )
  $$,
  '22023'::char(5), 'Organization delegation authority page input is invalid',
  'delegation list refuses an oversized page'
);

reset role;
select pg_temp.install_assignment_ledger_context(
  '43800000-0000-4000-8000-000000000002',
  '23800000-0000-4000-8000-000000000001',
  '53800000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_role_assignments_for_administration(
      null, 10
    )
  $$,
  '42501'::char(5), 'Organization assignment ledger is unavailable',
  'an active account without assignments-read authority cannot inspect assignments'
);
select throws_ok(
  $$
    select *
    from vortex_access.read_organization_delegation_authority_for_administration(
      '83800000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5), 'Organization assignment ledger is unavailable',
  'an active account without assignments-read authority cannot inspect delegations'
);

reset role;
set constraints all immediate;

select * from finish();

rollback;
