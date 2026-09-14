\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.create_activation_read_scope(
  p_organization_id uuid,
  p_admin_identity_id uuid,
  p_admin_account_id uuid,
  p_beneficiary_identity_id uuid,
  p_beneficiary_account_id uuid,
  p_steward_role_id uuid,
  p_steward_assignment_id uuid,
  p_steward_delegation_id uuid,
  p_activation_role_id uuid,
  p_activation_policy_id uuid,
  p_direct_assignment_id uuid,
  p_direct_activation_id uuid,
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
    p_organization_id, '13900000-0000-4000-8000-000000000001',
    p_short_name, p_short_name, 'active', operation_at,
    '93900000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
  (
    p_admin_identity_id, 'active', operation_at, operation_at,
    '93900000-0000-4000-8000-000000000001', p_admin_identity_id, 1
  ),
  (
    p_beneficiary_identity_id, 'active', operation_at, operation_at,
    '93900000-0000-4000-8000-000000000001', p_beneficiary_identity_id, 1
  );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
  (
    p_admin_account_id, p_organization_id, p_admin_identity_id,
    p_short_name || ' administrator', 'active', operation_at - interval '1 minute',
    operation_at, operation_at,
    '93900000-0000-4000-8000-000000000001', p_admin_account_id, 1
  ),
  (
    p_beneficiary_account_id, p_organization_id, p_beneficiary_identity_id,
    p_short_name || ' beneficiary', 'active', operation_at - interval '1 minute',
    operation_at, operation_at,
    '93900000-0000-4000-8000-000000000001', p_beneficiary_account_id, 1
  );

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id,
    '93900000-0000-4000-8000-000000000001',
    p_organization_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id,
    '93900000-0000-4000-8000-000000000001',
    p_activation_role_id
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
    p_organization_id, p_admin_account_id, p_steward_role_id,
    p_short_name || '_steward', p_short_name || ' steward',
    'Minimum neutral authority for the protected activation ledger fixture.',
    p_steward_assignment_id, p_steward_delegation_id,
    '93900000-0000-4000-8000-000000000001', p_steward_role_id
  );

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, live_revision, created_by, created_at
  ) values (
    p_organization_id, p_activation_role_id, 'custom',
    p_short_name || '_activation', null, null, 1,
    '93900000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_activation_policy_revisions (
    organization_id, role_id, activation_policy_id, revision,
    policy_fingerprint, maximum_activation_duration_seconds,
    reason_required, authentication_requirement,
    authentication_maximum_age_seconds, independent_approval_required,
    changed_by, changed_at, change_correlation_id
  ) values (
    p_organization_id, p_activation_role_id, p_activation_policy_id, 1,
    'sha256:' || pg_catalog.repeat('3', 64), 3600, true,
    'multi_factor', 900, false,
    '93900000-0000-4000-8000-000000000001', operation_at,
    p_activation_policy_id
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, p_activation_role_id, 1,
    pg_catalog.row_number() over (order by entry.entry_ordinal),
    'custom', null, entry.application_root_id,
    entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.registration_kind, entry.registration_owner_id,
    entry.accepted_registration_revision, entry.catalogue_fingerprint,
    entry.continuity_revision, entry.meaning_fingerprint
  from vortex_access.organization_role_permission_entries as entry
  where entry.organization_id = p_organization_id
    and entry.role_id = p_steward_role_id
    and entry.role_revision = 1
    and entry.permission_id in (
      '687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid,
      '9901c0dc-8bac-45c7-be0b-3642cb839bb1'::uuid
    );

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
    p_organization_id, p_activation_role_id, 1, 'custom', null,
    'active', 'privileged', 'activation_required', 1, 1,
    p_activation_policy_id, 1, 'sha256:' || pg_catalog.repeat('3', 64),
    p_short_name || '_activation', p_short_name || ' activation role',
    'Neutral activation-required role used by the safe read fixture.',
    null, null, null, null, null, null, null, null, null, null, null,
    '93900000-0000-4000-8000-000000000001', operation_at,
    p_activation_role_id
  );

  perform 1 from vortex_access.coordinate_organization_role_assignment_change(
    'grant', p_organization_id, p_direct_assignment_id, null,
    p_activation_role_id, 1, 'organization_account',
    p_beneficiary_account_id, null, 'eligible',
    operation_at - interval '1 minute', null,
    '93900000-0000-4000-8000-000000000001', p_direct_assignment_id
  );

  perform 1 from vortex_access.coordinate_organization_role_activation_change(
    'activate_role', p_organization_id, p_direct_activation_id, null,
    p_beneficiary_account_id, p_activation_role_id, 1, 3600, 'direct',
    p_direct_assignment_id, 1, null, null,
    '93900000-0000-4000-8000-000000000001', p_direct_activation_id
  );
end
$function$;

create function pg_temp.install_activation_read_context(
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
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id;

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83900000-0000-4000-8000-000000000001',
    'tenantId', '13900000-0000-4000-8000-000000000001',
    'organizationId', p_organization_id,
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '73900000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3900000-0000-4000-8000-000000000099'
  ));
end
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'list_organization_role_activations_for_administration',
  array['uuid', 'integer'],
  'Access exposes one bounded protected role-activation list'
);
select has_function(
  'vortex_access', 'read_organization_role_activation_for_administration',
  array['uuid'],
  'Access exposes one exact protected role-activation detail read'
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
      'vortex_access.list_organization_role_activations_for_administration(uuid,integer)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the activation list is one narrow owner-held protected projection'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_role_activations_for_administration(uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_role_activation_for_administration(uuid)',
    'EXECUTE'
  ),
  'request role can execute the two protected activation projections'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_role_activations_for_administration(uuid,integer)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the protected activation ledger'
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
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_role_activation(uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_role_activations', 'SELECT'
  ),
  'request role cannot bypass the safe leaves through private activation facts'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13900000-0000-4000-8000-000000000001', 'activation_reader',
  'Activation reader', 'active', pg_catalog.clock_timestamp(),
  '93900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

select pg_temp.create_activation_read_scope(
  '23900000-0000-4000-8000-000000000001',
  '43900000-0000-4000-8000-000000000001',
  '53900000-0000-4000-8000-000000000001',
  '43900000-0000-4000-8000-000000000002',
  '53900000-0000-4000-8000-000000000002',
  '63900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000001',
  '83900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000030',
  '64900000-0000-4000-8000-000000000030',
  '73900000-0000-4000-8000-000000000030',
  '63900000-0000-4000-8000-000000000090',
  'activation_reader'
);
select pg_temp.create_activation_read_scope(
  '23900000-0000-4000-8000-000000000002',
  '43900000-0000-4000-8000-000000000010',
  '53900000-0000-4000-8000-000000000010',
  '43900000-0000-4000-8000-000000000011',
  '53900000-0000-4000-8000-000000000011',
  '63900000-0000-4000-8000-000000000010',
  '73900000-0000-4000-8000-000000000010',
  '83900000-0000-4000-8000-000000000010',
  '63900000-0000-4000-8000-000000000031',
  '64900000-0000-4000-8000-000000000031',
  '73900000-0000-4000-8000-000000000031',
  '63900000-0000-4000-8000-000000000099',
  'foreign_activation_reader'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000050', null,
  'activation_reviewers', 'Activation reviewers',
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000050'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000060', null,
  '63900000-0000-4000-8000-000000000050',
  '53900000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() - interval '1 minute', null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000060'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000031', null,
  '63900000-0000-4000-8000-000000000030', 1,
  'group', null, '63900000-0000-4000-8000-000000000050', 'eligible',
  pg_catalog.clock_timestamp() - interval '1 minute', null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000070'
);
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000092', null,
  '53900000-0000-4000-8000-000000000002',
  '63900000-0000-4000-8000-000000000030', 1, 3600, 'group',
  '73900000-0000-4000-8000-000000000031', 1,
  '63900000-0000-4000-8000-000000000060', 1,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000092'
);
select * from vortex_access.coordinate_organization_role_activation_change(
  'revoke_role_activation', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000092', 1,
  null, null, null, null, null, null, null, null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000093'
);

select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000091', null,
  '53900000-0000-4000-8000-000000000002',
  '63900000-0000-4000-8000-000000000030', 1, 1, 'direct',
  '73900000-0000-4000-8000-000000000030', 1, null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000091'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '23900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000030', 1,
  null, null, null, null, null, null, null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000071'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000095', null,
  '63900000-0000-4000-8000-000000000030', 1,
  'organization_account', '53900000-0000-4000-8000-000000000001', null,
  'eligible', pg_catalog.clock_timestamp(), null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000095'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000096', null,
  '63900000-0000-4000-8000-000000000030', 1,
  'organization_account', '53900000-0000-4000-8000-000000000001', null,
  'eligible', pg_catalog.clock_timestamp(), null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000096'
);
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000095', null,
  '53900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000030', 1, 3600, 'direct',
  '73900000-0000-4000-8000-000000000095', 1, null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000097'
);
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role', '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000096', null,
  '53900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000030', 1, 3600, 'direct',
  '73900000-0000-4000-8000-000000000096', 1, null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000098'
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision,
  policy_fingerprint, maximum_activation_duration_seconds,
  reason_required, authentication_requirement,
  authentication_maximum_age_seconds, independent_approval_required,
  changed_by, changed_at, change_correlation_id
) values (
  '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000030',
  '64900000-0000-4000-8000-000000000030', 2,
  'sha256:' || pg_catalog.repeat('4', 64), 7200, false,
  'none', null, true,
  '93900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3900000-0000-4000-8000-000000000080'
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select entry.organization_id, '63900000-0000-4000-8000-000000000030',
  2, entry.entry_ordinal,
  entry.role_kind, entry.role_application_root_id, entry.application_root_id,
  entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.registration_kind, entry.registration_owner_id,
  entry.accepted_registration_revision, entry.catalogue_fingerprint,
  entry.continuity_revision, entry.meaning_fingerprint
from vortex_access.organization_role_permission_entries as entry
where entry.organization_id = '23900000-0000-4000-8000-000000000001'
  and entry.role_id = '63900000-0000-4000-8000-000000000001'
  and entry.role_revision = 1
  and entry.permission_id = '156d01f3-8f80-45fb-8fc8-b31c47dbb1df';
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
  '23900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000030', 2, 'custom', null,
  'active', 'privileged', 'activation_required', 2, 2,
  '64900000-0000-4000-8000-000000000030', 2,
  'sha256:' || pg_catalog.repeat('4', 64),
  'activation_reader_activation', 'Updated activation role',
  'Updated label and policy retained separately from historical activations.',
  null, null, null, null, null, null, null, null, null, null, null,
  '93900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3900000-0000-4000-8000-000000000081'
);
update vortex_access.organization_roles
set live_revision = 2
where organization_id = '23900000-0000-4000-8000-000000000001'
  and role_id = '63900000-0000-4000-8000-000000000030';

select pg_catalog.pg_sleep(1.05);

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_request;

select pg_temp.install_activation_read_context(
  '43900000-0000-4000-8000-000000000002',
  '23900000-0000-4000-8000-000000000001',
  '53900000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select throws_ok(
  $$ select * from vortex_access.list_organization_role_activations_for_administration(null, 10) $$,
  '42501'::char(5), null,
  'an account without assignments-read cannot inspect the activation ledger'
);
reset role;

select pg_temp.install_activation_read_context(
  '43900000-0000-4000-8000-000000000001',
  '23900000-0000-4000-8000-000000000001',
  '53900000-0000-4000-8000-000000000001'
);
set local role vortex_request;

select results_eq(
  $$
    select pg_catalog.jsonb_array_length(activations),
      next_after_role_activation_id
    from vortex_access.list_organization_role_activations_for_administration(
      null, 2
    )
  $$,
  $$ values (2, '63900000-0000-4000-8000-000000000091'::uuid) $$,
  'the first activation page is bounded and returns the last emitted cursor'
);
select results_eq(
  $$
    select pg_catalog.jsonb_array_length(activations),
      next_after_role_activation_id
    from vortex_access.list_organization_role_activations_for_administration(
      '63900000-0000-4000-8000-000000000091', 10
    )
  $$,
  $$ values (3, null::uuid) $$,
  'the next activation page completes the stable activation-ID order'
);
select is(
  (
    select pg_catalog.string_agg(
      (item ->> 'roleActivationId') || ':' ||
      (item ->> 'eligibilitySourceKind') || ':' ||
      (item ->> 'temporalState'), ',' order by item ->> 'roleActivationId'
    )
    from vortex_access.list_organization_role_activations_for_administration(
      null, 10
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.activations) as item
  ),
  '63900000-0000-4000-8000-000000000090:direct:active,' ||
  '63900000-0000-4000-8000-000000000091:direct:expired,' ||
  '63900000-0000-4000-8000-000000000092:group:revoked,' ||
  '63900000-0000-4000-8000-000000000095:direct:active,' ||
  '63900000-0000-4000-8000-000000000096:direct:active',
  'summary timing is descriptive with revoked taking precedence over expiry'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', activation_summary #>> '{beneficiary,displayName}',
      activation_summary #>> '{role,label}',
      activation_summary #>> '{role,lifecycle}',
      activation_summary ->> 'historicalRoleRevision',
      activation_summary #>> '{eligibilitySource,kind}',
      activation_summary #>> '{eligibilitySource,eligibilityAssignment,revision}',
      activation_summary #>> '{policyAtActivation,maximumActivationDurationSeconds}',
      activation_summary #>> '{policyAtActivation,reasonRequired}',
      activation_summary #>> '{policyAtActivation,recentAuthentication,kind}',
      activation_summary #>> '{policyAtActivation,recentAuthentication,maximumAgeSeconds}',
      activation_summary #>> '{policyAtActivation,independentApprovalRequired}',
      activation_summary ->> 'temporalState'
    )
    from vortex_access.read_organization_role_activation_for_administration(
      '63900000-0000-4000-8000-000000000090'
    )
  ),
  'activation_reader beneficiary|Updated activation role|active|1|direct|1|' ||
  '3600|true|multi_factor|900|false|active',
  'detail keeps historical source and policy settings while showing the current role label'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', assignment.assignment_summary ->> 'state',
      assignment.assignment_summary ->> 'revision',
      detail.activation_summary #>> '{eligibilitySource,eligibilityAssignment,revision}',
      detail.activation_summary ->> 'temporalState'
    )
    from vortex_access.read_organization_role_assignment_for_administration(
      '73900000-0000-4000-8000-000000000030'
    ) as assignment
    cross join vortex_access.read_organization_role_activation_for_administration(
      '63900000-0000-4000-8000-000000000090'
    ) as detail
  ),
  'revoked|2|1|active',
  'a retained activation remains inspectable without treating its changed source as current authority'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', activation_summary #>> '{eligibilitySource,kind}',
      activation_summary #>> '{eligibilitySource,eligibilityAssignment,roleAssignmentId}',
      activation_summary #>> '{eligibilitySource,originatingMembership,membershipId}',
      activation_summary ->> 'state', activation_summary ->> 'temporalState'
    )
    from vortex_access.read_organization_role_activation_for_administration(
      '63900000-0000-4000-8000-000000000092'
    )
  ),
  'group|73900000-0000-4000-8000-000000000031|' ||
  '63900000-0000-4000-8000-000000000060|revoked|revoked',
  'Group detail returns only the exact assignment and originating membership references'
);
select is(
  (
    select (activation_summary ?| array[
      'authorityContinuityRevision', 'policyContinuityRevision',
      'activationPolicyId', 'activationPolicyFingerprint',
      'activatedByActorId', 'activationCorrelationId',
      'changedByActorId', 'changeCorrelationId',
      'revokedByActorId', 'revocationCorrelationId',
      'effective', 'currentlyEligible'
    ]) or (activation_summary -> 'beneficiary' ? 'state')
    from vortex_access.read_organization_role_activation_for_administration(
      '63900000-0000-4000-8000-000000000090'
    )
  ),
  false,
  'safe activation detail omits private evidence and effective-access claims'
);
select is(
  (
    select outcome
    from vortex_access.read_organization_role_activation_for_administration(
      '63900000-0000-4000-8000-000000000099'
    )
  ),
  'unavailable',
  'a foreign activation is unavailable in the selected organization'
);
select is(
  (
    select outcome
    from vortex_access.read_organization_role_activation_for_administration(
      '63900000-0000-4000-8000-000000000098'
    )
  ),
  'unavailable',
  'an unknown activation uses the same unavailable result'
);
select throws_ok(
  $$ select * from vortex_access.list_organization_role_activations_for_administration(null, 0) $$,
  '22023'::char(5), null,
  'an invalid activation page is refused'
);
select throws_ok(
  $$ select * from vortex_access.read_organization_role_activation_for_administration('00000000-0000-0000-0000-000000000000') $$,
  '22023'::char(5), null,
  'a nil activation detail identity is refused'
);
select throws_ok(
  $$ select * from vortex_access.deactivate_organization_role_activation_for_administration(
    '63900000-0000-4000-8000-000000000099', 1,
    'a3900000-0000-4000-8000-000000000088') $$,
  '40001'::char(5), null,
  'a same-tenant foreign activation is unavailable through the protected writer'
);

reset role;
select vortex_activity.append_organization_activity_entry(
  '23900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000089', pg_catalog.clock_timestamp(),
  'organization_account', '53900000-0000-4000-8000-000000000001',
  'fixture_collision', array['63900000-0000-4000-8000-000000000090'::uuid],
  array[]::uuid[], 'system', 'a3900000-0000-4000-8000-000000000089', 'completed'
);
set local role vortex_request;
select throws_ok(
  $$ select * from vortex_access.deactivate_organization_role_activation_for_administration(
    '63900000-0000-4000-8000-000000000090', 1,
    'a3900000-0000-4000-8000-000000000089') $$,
  '22023'::char(5), null,
  'an Activity collision rolls activation and Access changes back atomically'
);
reset role;
select is(
  (select state || '|' || revision::text
   from vortex_access.organization_role_activations
   where organization_id = '23900000-0000-4000-8000-000000000001'
     and role_activation_id = '63900000-0000-4000-8000-000000000090'),
  'live|1',
  'the failed Activity append leaves the activation unchanged'
);
set local role vortex_request;

select is(
  (select (activation_summary ->> 'state') || '|' ||
      (activation_summary ->> 'revision') || '|' || access_version::text
   from vortex_access.deactivate_organization_role_activation_for_administration(
     '63900000-0000-4000-8000-000000000090', 1,
     'a3900000-0000-4000-8000-000000000090')),
  'revoked|2|17',
  'an administrator deactivates another beneficiary using the immutable historical role scope'
);
reset role;
select is(
  (select count(*)::text || '|' || min(action)
   from vortex_activity.organization_activity_entries
   where organization_id = '23900000-0000-4000-8000-000000000001'
     and activity_id = 'a3900000-0000-4000-8000-000000000090'),
  '1|revoke_role_activation',
  'activation deactivation appends exactly one atomic Activity entry'
);
select pg_temp.install_activation_read_context(
  '43900000-0000-4000-8000-000000000002',
  '23900000-0000-4000-8000-000000000001',
  '53900000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select is(
  (select (activation_summary ->> 'state') || '|' || access_version::text
   from vortex_access.deactivate_organization_role_activation_for_administration(
     '63900000-0000-4000-8000-000000000091', 1,
     'a3900000-0000-4000-8000-000000000091')),
  'revoked|18',
  'a beneficiary immediately ends their own retained activation without administration permission'
);
select throws_ok(
  $$ select * from vortex_access.deactivate_organization_role_activation_for_administration(
    '63900000-0000-4000-8000-000000000091', 1,
    'a3900000-0000-4000-8000-000000000092') $$,
  '42501'::char(5), null,
  'an already deactivated activation cannot replay through its stale request context'
);

reset role;
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000094', null,
  '63900000-0000-4000-8000-000000000001', 1,
  'organization_account', '53900000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000094'
);
create temporary table activation_old_scope on commit drop as
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
where entry.organization_id = '23900000-0000-4000-8000-000000000001'
  and entry.role_id = '63900000-0000-4000-8000-000000000030'
  and entry.role_revision = 1;

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation', '23900000-0000-4000-8000-000000000001',
  '83900000-0000-4000-8000-000000000095', null,
  'organization_account', '53900000-0000-4000-8000-000000000002', null,
  'bounded', (select value from activation_old_scope),
  'sha256:' || pg_catalog.repeat('8', 64),
  pg_catalog.clock_timestamp(), null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000100'
);
select pg_temp.install_activation_read_context(
  '43900000-0000-4000-8000-000000000002',
  '23900000-0000-4000-8000-000000000001',
  '53900000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select is(
  (select activation_summary ->> 'state'
   from vortex_access.deactivate_organization_role_activation_for_administration(
     '63900000-0000-4000-8000-000000000095', 1,
     'a3900000-0000-4000-8000-000000000101')),
  'revoked',
  'bounded administration uses the immutable historical activation scope rather than the different live role scope'
);

reset role;
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'revoke_delegation', '23900000-0000-4000-8000-000000000001',
  '83900000-0000-4000-8000-000000000095', 1,
  null, null, null, null, null, null, null, null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000102'
);
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation', '23900000-0000-4000-8000-000000000001',
  '83900000-0000-4000-8000-000000000096', null,
  'organization_account', '53900000-0000-4000-8000-000000000002', null,
  'bounded', pg_catalog.jsonb_build_array((select value -> 0 from activation_old_scope)),
  'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.clock_timestamp(), null,
  '93900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000103'
);
select pg_temp.install_activation_read_context(
  '43900000-0000-4000-8000-000000000002',
  '23900000-0000-4000-8000-000000000001',
  '53900000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select results_eq(
  $$ select outcome, activation_summary is null
     from vortex_access.deactivate_organization_role_activation_for_administration(
    '63900000-0000-4000-8000-000000000096', 1,
    'a3900000-0000-4000-8000-000000000104') $$,
  $$ values ('refused'::text, true) $$,
  'partial coverage records and returns one clean refusal of the immutable historical activation scope'
);
reset role;
select is(
  (
    select activity.action || '|' || activity.actor_id::text || '|' ||
      activity.subject_ids::text || '|' || activity.changed_field_ids::text || '|' ||
      activity.source || '|' || activity.correlation_id::text || '|' || activity.outcome
    from vortex_activity.organization_activity_entries as activity
    where activity.organization_id = '23900000-0000-4000-8000-000000000001'
      and activity.activity_id = 'a3900000-0000-4000-8000-000000000104'
  ),
  'revoke_role_activation|53900000-0000-4000-8000-000000000002|' ||
    '{23900000-0000-4000-8000-000000000001}|{}|web|' ||
    'a3900000-0000-4000-8000-000000000099|refused',
  'activation refusal keeps only fixed organization-scoped content-free Activity evidence'
);
select is(
  (select state || '|' || revision::text
   from vortex_access.organization_role_activations
   where organization_id = '23900000-0000-4000-8000-000000000001'
     and role_activation_id = '63900000-0000-4000-8000-000000000096'),
  'live|1',
  'partial historical-scope refusal leaves the activation unchanged'
);

reset role;
set constraints all immediate;

select * from finish();
rollback;
