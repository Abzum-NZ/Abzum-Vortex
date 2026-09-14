\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.create_eligibility_scope()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '12900000-0000-4000-8000-000000000001', 'permission_eligibility',
    'Permission eligibility', 'active', operation_at,
    '92900000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '22900000-0000-4000-8000-000000000001',
    '12900000-0000-4000-8000-000000000001', 'permission_eligibility',
    'Permission eligibility', 'active', operation_at,
    '92900000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '42900000-0000-4000-8000-000000000001', 'active', operation_at,
    operation_at, '92900000-0000-4000-8000-000000000001',
    'a2900000-0000-4000-8000-000000000001', 1
  );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '52900000-0000-4000-8000-000000000001',
    '22900000-0000-4000-8000-000000000001',
    '42900000-0000-4000-8000-000000000001', 'Eligibility account',
    'active', operation_at - interval '1 minute', operation_at, operation_at,
    '92900000-0000-4000-8000-000000000001',
    'a2900000-0000-4000-8000-000000000002', 1
  );

  perform 1 from vortex_access.initialize_organization_access_version(
    '22900000-0000-4000-8000-000000000001',
    '92900000-0000-4000-8000-000000000001',
    'a2900000-0000-4000-8000-000000000003'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '22900000-0000-4000-8000-000000000001',
    '92900000-0000-4000-8000-000000000001',
    'a2900000-0000-4000-8000-000000000004'
  );
end
$function$;

create function pg_temp.seed_eligibility_application()
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
    '22900000-0000-4000-8000-000000000001', 'application',
    '32900000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.permission_eligibility', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '92900000-0000-4000-8000-000000000001',
    'a2900000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '22900000-0000-4000-8000-000000000001', 'application',
    '32900000-0000-4000-8000-000000000001', 'active', 1,
    'example.permission_eligibility', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '92900000-0000-4000-8000-000000000001',
    'a2900000-0000-4000-8000-000000000010'
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
  )
  select
    '22900000-0000-4000-8000-000000000001'::uuid, 'application',
    '32900000-0000-4000-8000-000000000001'::uuid, 1,
    '32900000-0000-4000-8000-000000000001'::uuid, 'application',
    '32900000-0000-4000-8000-000000000001'::uuid,
    permission.permission_id, permission.permission_key,
    permission.label, 'Permission eligibility fixture.',
    permission.record_type_id, permission.action_kind, null, false,
    'application', 'example.permission_eligibility',
    '32900000-0000-4000-8000-000000000001'::uuid, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64)
  from (values
    ('43900000-0000-4000-8000-000000000001'::uuid,
      'example.permission_eligibility.direct', 'Direct', 'read', null::uuid, 'a'),
    ('43900000-0000-4000-8000-000000000002'::uuid,
      'example.permission_eligibility.group', 'Group', 'read', null::uuid, 'b'),
    ('43900000-0000-4000-8000-000000000003'::uuid,
      'example.permission_eligibility.direct_activation', 'Direct activation',
      'update', null::uuid, 'c'),
    ('43900000-0000-4000-8000-000000000004'::uuid,
      'example.permission_eligibility.group_activation', 'Group activation',
      'update', null::uuid, 'd'),
    ('43900000-0000-4000-8000-000000000005'::uuid,
      'example.permission_eligibility.record', 'Record scoped', 'read',
      '53900000-0000-4000-8000-000000000005'::uuid, 'e'),
    ('43900000-0000-4000-8000-000000000006'::uuid,
      'example.permission_eligibility.unassigned', 'Unassigned', 'read',
      null::uuid, 'f')
  ) as permission(
    permission_id, permission_key, label, action_kind, record_type_id,
    fingerprint_character
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, entry.application_root_id, entry.owner_kind,
    entry.owner_id, entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, 'available', 1, entry.meaning_fingerprint,
    1, operation_at
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = '22900000-0000-4000-8000-000000000001'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id =
      '32900000-0000-4000-8000-000000000001';

  insert into vortex_access.application_role_template_continuities (
    organization_id, application_root_id, source_role_id, state,
    continuity_revision, source_template_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    '22900000-0000-4000-8000-000000000001',
    '32900000-0000-4000-8000-000000000001',
    '43900000-0000-4000-8000-000000000101', 'available', 1,
    'sha256:' || pg_catalog.repeat('5', 64), 1, operation_at
  );

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, live_revision, created_by, created_at
  ) values (
    '22900000-0000-4000-8000-000000000001',
    '62900000-0000-4000-8000-000000000001', 'application',
    'application_direct', '32900000-0000-4000-8000-000000000001',
    '43900000-0000-4000-8000-000000000101', 1,
    '92900000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id,
    '62900000-0000-4000-8000-000000000001'::uuid, 1, 1, 'application',
    entry.application_root_id, entry.application_root_id, entry.owner_kind,
    entry.owner_id, entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, 1,
    'sha256:' || pg_catalog.repeat('3', 64), 1, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = '22900000-0000-4000-8000-000000000001'
    and entry.permission_id = '43900000-0000-4000-8000-000000000001';

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
    '22900000-0000-4000-8000-000000000001',
    '62900000-0000-4000-8000-000000000001', 1, 'application',
    '32900000-0000-4000-8000-000000000001', 'active', 'standard',
    'standing', 1, 1, 'application_direct', 'Application direct',
    'Direct standing application role.', 'example.permission_eligibility',
    1, '1.0.0', '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('3', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('6', 64),
    '92900000-0000-4000-8000-000000000001', operation_at,
    'a2900000-0000-4000-8000-000000000011'
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    '22900000-0000-4000-8000-000000000001',
    '72900000-0000-4000-8000-000000000001',
    '62900000-0000-4000-8000-000000000001', 'organization_account',
    '52900000-0000-4000-8000-000000000001', null, 'standing', 1,
    operation_at - interval '1 minute', operation_at + interval '30 minutes',
    'live', '92900000-0000-4000-8000-000000000001', operation_at,
    'a2900000-0000-4000-8000-000000000012',
    '92900000-0000-4000-8000-000000000001', operation_at,
    'a2900000-0000-4000-8000-000000000012'
  );
end
$function$;

create function pg_temp.seed_custom_eligibility_role(
  p_role_id uuid,
  p_role_key text,
  p_permission_id uuid,
  p_assignment_policy text,
  p_activation_policy_id uuid,
  p_second_permission_id uuid default null
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision,
    created_by, created_at
  ) values (
    '22900000-0000-4000-8000-000000000001', p_role_id, 'custom',
    p_role_key, 1, '92900000-0000-4000-8000-000000000001', operation_at
  );

  if p_assignment_policy = 'activation_required' then
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision,
      policy_fingerprint, maximum_activation_duration_seconds,
      reason_required, authentication_requirement,
      authentication_maximum_age_seconds, independent_approval_required,
      changed_by, changed_at, change_correlation_id
    ) values (
      '22900000-0000-4000-8000-000000000001', p_role_id,
      p_activation_policy_id, 1,
      'sha256:' || pg_catalog.repeat('7', 64), 3600, false, 'none', null,
      false, '92900000-0000-4000-8000-000000000001', operation_at,
      p_role_id
    );
  end if;

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, p_role_id, 1,
    pg_catalog.row_number() over (order by entry.permission_id), 'custom', null,
    entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id is not distinct from
      entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from
      entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '22900000-0000-4000-8000-000000000001'
    and entry.permission_id in (p_permission_id, p_second_permission_id);

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '22900000-0000-4000-8000-000000000001', p_role_id, 1, 'custom',
    'active', case when exists (
      select 1
      from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = '22900000-0000-4000-8000-000000000001'
        and entry.permission_id = p_permission_id
        and entry.administrative
    ) then 'privileged' else 'standard' end,
    p_assignment_policy, 1, 1,
    p_activation_policy_id,
    case when p_activation_policy_id is null then null else 1 end,
    case when p_activation_policy_id is null then null
      else 'sha256:' || pg_catalog.repeat('7', 64) end,
    p_role_key, 'Eligibility role', 'Permission eligibility role fixture.',
    '92900000-0000-4000-8000-000000000001', operation_at, p_role_id
  );
end
$function$;

create function pg_temp.install_eligibility_context(
  p_application_root_id uuid,
  p_primary_age interval,
  p_include_multi_factor boolean,
  p_delegated boolean
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
  candidate jsonb;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '22900000-0000-4000-8000-000000000001';

  candidate := pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '82900000-0000-4000-8000-000000000001',
    'tenantId', '12900000-0000-4000-8000-000000000001',
    'organizationId', '22900000-0000-4000-8000-000000000001',
    'organizationAccountId', '52900000-0000-4000-8000-000000000001',
    'identityId', '42900000-0000-4000-8000-000000000001',
    'sessionId', '62900000-0000-4000-8000-000000000099',
    'authenticationStrength',
      case when p_include_multi_factor then 'multi_factor' else 'single_factor' end,
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a2900000-0000-4000-8000-000000000099',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at - p_primary_age
  );

  if p_application_root_id is not null then
    candidate := candidate || pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id
    );
  end if;
  if p_include_multi_factor then
    candidate := candidate || pg_catalog.jsonb_build_object(
      'multiFactorAuthenticatedAt', operation_at - p_primary_age
    );
  end if;
  if p_delegated then
    candidate := candidate || pg_catalog.jsonb_build_object(
      'delegatedContext', pg_catalog.jsonb_build_object(
        'delegatedByOrganizationAccountId',
          '52900000-0000-4000-8000-000000000002',
        'reason', 'Neutral eligibility refusal fixture.',
        'expiresAt', operation_at + interval '10 minutes'
      )
    );
  end if;

  perform vortex_context.initialize(candidate);
end
$function$;

create function pg_temp.application_declaration(
  p_permission_id uuid,
  p_action_kind text,
  p_authentication_kind text default 'none',
  p_maximum_age_seconds bigint default null,
  p_delegated_management boolean default false
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operationKey', 'application.configuration.update',
    'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '32900000-0000-4000-8000-000000000001'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '32900000-0000-4000-8000-000000000001',
      'ownerKind', 'application',
      'ownerId', '32900000-0000-4000-8000-000000000001',
      'permissionId', p_permission_id
    ),
    'recentAuthentication', case
      when p_authentication_kind = 'none'
        then pg_catalog.jsonb_build_object('kind', 'none')
      else pg_catalog.jsonb_build_object(
        'kind', p_authentication_kind,
        'maximumAgeSeconds', p_maximum_age_seconds
      )
    end,
    'authority', case
      when not p_delegated_management
        then pg_catalog.jsonb_build_object('kind', 'permission')
      else pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'none'),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    end
  )
$function$;

create function pg_temp.module_declaration()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operationKey', 'application.configuration.update',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '32900000-0000-4000-8000-000000000001'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '32900000-0000-4000-8000-000000000001',
      'ownerKind', 'module',
      'ownerId', '33900000-0000-4000-8000-000000000007',
      'permissionId', '43900000-0000-4000-8000-000000000007'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'evaluate_organization_permission_eligibility',
  array['jsonb'],
  'Access exposes one transaction-bound permission eligibility predicate'
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
      'vortex_access.evaluate_organization_permission_eligibility(jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the eligibility predicate is owner-held, definer-security and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_organization_permission_eligibility(jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the request-only eligibility predicate'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.evaluate_organization_permission_eligibility(jsonb)',
    'EXECUTE'
  ),
  'the protected request role can execute the eligibility predicate'
);

select pg_temp.create_eligibility_scope();
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '22900000-0000-4000-8000-000000000001',
  '52900000-0000-4000-8000-000000000001',
  '62900000-0000-4000-8000-000000000098',
  'eligibility_steward', 'Eligibility steward',
  'Exact platform authority for the eligibility fixture.',
  '72900000-0000-4000-8000-000000000098',
  '82900000-0000-4000-8000-000000000098',
  '92900000-0000-4000-8000-000000000001',
  'a2900000-0000-4000-8000-000000000005'
);
select pg_temp.seed_eligibility_application();

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
  '22900000-0000-4000-8000-000000000001', 'application',
  '32900000-0000-4000-8000-000000000001', 1,
  '32900000-0000-4000-8000-000000000001', 'module',
  '33900000-0000-4000-8000-000000000007',
  '43900000-0000-4000-8000-000000000007',
  'example.permission_eligibility.module_read', 'Read module',
  'Read one module in the eligibility fixture.', null, 'read', null, false,
  'module', 'example.permission_eligibility',
  '33900000-0000-4000-8000-000000000007', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('0', 64)
);
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id, state,
  continuity_revision, meaning_fingerprint,
  last_processed_registration_revision, changed_at
) values (
  '22900000-0000-4000-8000-000000000001',
  '32900000-0000-4000-8000-000000000001', 'module',
  '33900000-0000-4000-8000-000000000007',
  '43900000-0000-4000-8000-000000000007', 'application',
  '32900000-0000-4000-8000-000000000001', 'available', 1,
  'sha256:' || pg_catalog.repeat('0', 64), 1,
  pg_catalog.clock_timestamp()
);

select pg_temp.seed_custom_eligibility_role(
  '62900000-0000-4000-8000-000000000002', 'group_standing',
  '43900000-0000-4000-8000-000000000002', 'standing', null,
  '43900000-0000-4000-8000-000000000001'
);
select pg_temp.seed_custom_eligibility_role(
  '62900000-0000-4000-8000-000000000003', 'direct_activation',
  '43900000-0000-4000-8000-000000000003', 'activation_required',
  '63900000-0000-4000-8000-000000000003'
);
select pg_temp.seed_custom_eligibility_role(
  '62900000-0000-4000-8000-000000000004', 'group_activation',
  '43900000-0000-4000-8000-000000000004', 'activation_required',
  '63900000-0000-4000-8000-000000000004'
);
select pg_temp.seed_custom_eligibility_role(
  '62900000-0000-4000-8000-000000000006', 'module_direct',
  '43900000-0000-4000-8000-000000000007', 'standing', null
);

create temporary table platform_permission on commit drop as
select entry.application_root_id, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.action_kind, entry.named_action
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '22900000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform'
  and entry.record_type_id is null
order by entry.permission_id
limit 1;

set constraints all immediate;
set constraints all deferred;

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '22900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001', 'standing_group',
    'Standing Group', 'active', 1,
    '92900000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(),
    '92900000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000020'
  ),
  (
    '22900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000002', 'activation_group',
    'Activation Group', 'active', 1,
    '92900000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(),
    '92900000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000021'
  );

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values
  (
    '22900000-0000-4000-8000-000000000001',
    '83900000-0000-4000-8000-000000000001',
    '63900000-0000-4000-8000-000000000001',
    '52900000-0000-4000-8000-000000000001', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '25 minutes', 'live',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000022',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000022'
  ),
  (
    '22900000-0000-4000-8000-000000000001',
    '83900000-0000-4000-8000-000000000002',
    '63900000-0000-4000-8000-000000000002',
    '52900000-0000-4000-8000-000000000001', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '50 minutes', 'live',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000023',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000023'
  );

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values
  (
    '22900000-0000-4000-8000-000000000001',
    '72900000-0000-4000-8000-000000000002',
    '62900000-0000-4000-8000-000000000002', 'group', null,
    '63900000-0000-4000-8000-000000000001', 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '45 minutes', 'live',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000024',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000024'
  ),
  (
    '22900000-0000-4000-8000-000000000001',
    '72900000-0000-4000-8000-000000000003',
    '62900000-0000-4000-8000-000000000003', 'organization_account',
    '52900000-0000-4000-8000-000000000001', null, 'eligible', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '45 minutes', 'live',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000025',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000025'
  ),
  (
    '22900000-0000-4000-8000-000000000001',
    '72900000-0000-4000-8000-000000000004',
    '62900000-0000-4000-8000-000000000004', 'group', null,
    '63900000-0000-4000-8000-000000000002', 'eligible', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '55 minutes', 'live',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000026',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000026'
  ),
  (
    '22900000-0000-4000-8000-000000000001',
    '72900000-0000-4000-8000-000000000006',
    '62900000-0000-4000-8000-000000000006', 'organization_account',
    '52900000-0000-4000-8000-000000000001', null, 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '45 minutes', 'live',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000028',
    '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a2900000-0000-4000-8000-000000000028'
  );

set constraints all immediate;
set constraints all deferred;

create temporary table direct_activation on commit drop as
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role', '22900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000103', null,
  '52900000-0000-4000-8000-000000000001',
  '62900000-0000-4000-8000-000000000003', 1, 1800, 'direct',
  '72900000-0000-4000-8000-000000000003', 1, null, null,
  '92900000-0000-4000-8000-000000000001',
  'a2900000-0000-4000-8000-000000000030'
);
create temporary table group_activation on commit drop as
select * from vortex_access.coordinate_organization_role_activation_change(
  'activate_role', '22900000-0000-4000-8000-000000000001',
  '63900000-0000-4000-8000-000000000104', null,
  '52900000-0000-4000-8000-000000000001',
  '62900000-0000-4000-8000-000000000004', 1, 2100, 'group',
  '72900000-0000-4000-8000-000000000004', 1,
  '83900000-0000-4000-8000-000000000002', 1,
  '92900000-0000-4000-8000-000000000001',
  'a2900000-0000-4000-8000-000000000031'
);

-- Preserve a valid accepted direct grant while its supplied role waits for new
-- application authority. Eligibility is based on the retained sealed entry.
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
where organization_id = '22900000-0000-4000-8000-000000000001'
  and role_id = '62900000-0000-4000-8000-000000000001'
  and role_revision = 1;
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
select organization_id, role_id, 2, role_kind, application_root_id,
  'acceptance_required', privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, source_definition_key,
  source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  '92900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a2900000-0000-4000-8000-000000000032'
from vortex_access.organization_role_revisions
where organization_id = '22900000-0000-4000-8000-000000000001'
  and role_id = '62900000-0000-4000-8000-000000000001'
  and revision = 1;
update vortex_access.organization_roles
set live_revision = 2
where organization_id = '22900000-0000-4000-8000-000000000001'
  and role_id = '62900000-0000-4000-8000-000000000001';

set constraints all immediate;
set constraints all deferred;

create temporary table eligibility_deadlines (
  route text primary key,
  expires_at timestamptz not null
) on commit drop;
insert into eligibility_deadlines (route, expires_at)
select 'direct_standing', assignment.expires_at
from vortex_access.organization_role_assignments as assignment
where assignment.organization_id = '22900000-0000-4000-8000-000000000001'
  and assignment.role_assignment_id = '72900000-0000-4000-8000-000000000001'
union all
select 'group_standing', membership.expires_at
from vortex_access.organization_group_memberships as membership
where membership.organization_id = '22900000-0000-4000-8000-000000000001'
  and membership.membership_id = '83900000-0000-4000-8000-000000000001'
union all
select 'direct_activation', activation.expires_at
from vortex_access.organization_role_activations as activation
where activation.organization_id = '22900000-0000-4000-8000-000000000001'
  and activation.role_activation_id = '63900000-0000-4000-8000-000000000103'
union all
select 'group_activation', activation.expires_at
from vortex_access.organization_role_activations as activation
where activation.organization_id = '22900000-0000-4000-8000-000000000001'
  and activation.role_activation_id = '63900000-0000-4000-8000-000000000104';
grant select on eligibility_deadlines, platform_permission to vortex_request;
-- Test-only pgTAP visibility; the enclosing transaction rolls this back.
grant usage on schema extensions to vortex_request;
grant execute on function pg_temp.application_declaration(uuid, text, text, bigint, boolean),
  pg_temp.module_declaration() to vortex_request;

select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, reason_code, operation_key, target_kind,
      target_application_root_id, organization_id,
      organization_account_id, access_version, correlation_id
    )
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read'
      )
    )
  ),
  'eligible|application.configuration.update|application|32900000-0000-4000-8000-000000000001|22900000-0000-4000-8000-000000000001|52900000-0000-4000-8000-000000000001|5|a2900000-0000-4000-8000-000000000099',
  'direct standing retained authority is eligible from the exact application context'
);
select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read'
      )
    )
  ),
  (
    select expires_at from eligibility_deadlines where route = 'direct_standing'
  ),
  'direct standing wins canonical route rank over an earlier-expiring Group path'
);
select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000002', 'read'
      )
    )
  ),
  (
    select expires_at from eligibility_deadlines where route = 'group_standing'
  ),
  'Group standing eligibility uses the context account membership and earliest path deadline'
);
select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000003', 'update'
      )
    )
  ),
  (
    select expires_at from eligibility_deadlines where route = 'direct_activation'
  ),
  'direct activation eligibility uses one exact current assignment and activation chain'
);
select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000004', 'update'
      )
    )
  ),
  (
    select expires_at from eligibility_deadlines where route = 'group_activation'
  ),
  'Group activation eligibility requires the exact originating membership and assignment revisions'
);
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.module_declaration()
    )
  ),
  'eligible',
  'a module-owned permission is eligible under its exact active parent application context'
);
select throws_ok(
  $$
    select * from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read',
        'none', null, true
      )
    )
  $$,
  '22023'::char(5), 'Organization permission declaration is invalid',
  'management cannot omit both before and after authority'
);
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code, valid_until)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000005', 'read'
      )
    )
  ),
  'refused|permission_unavailable',
  'record-scoped catalogue entries cannot satisfy a record-free declaration'
);
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000006', 'read'
      )
    )
  ),
  'refused|permission_not_effective',
  'an available permission without a complete path is not effective'
);
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'delete'
      )
    )
  ),
  'refused|permission_unavailable',
  'the exact catalogue action must match even when the permission identity exists'
);

select is(
  (
    select outcome
    from platform_permission as platform
    cross join lateral vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'organization.settings.read',
        'action', case when platform.named_action is null
          then pg_catalog.jsonb_build_object(
            'actionKind', platform.action_kind
          )
          else pg_catalog.jsonb_build_object(
            'actionKind', platform.action_kind,
            'namedAction', platform.named_action
          )
        end,
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', platform.owner_kind,
          'ownerId', platform.owner_id,
          'permissionId', platform.permission_id
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    )
  ),
  'eligible',
  'an organization operation may use platform authority from an application-bound context'
);

reset role;
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000099', interval '0 seconds', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read'
      )
    )
  ),
  'refused|target_policy_unavailable',
  'an application target refuses a different trusted context application'
);

reset role;
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '10 minutes', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code, valid_until)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read', 'primary', 60
      )
    )
  ),
  'refused|authentication_unsatisfied',
  'stale primary-authentication evidence refuses an otherwise complete path'
);

reset role;
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', false, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read',
        'multi_factor', 120
      )
    )
  ),
  'refused|authentication_unsatisfied',
  'missing MFA evidence refuses an otherwise complete path'
);

reset role;
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select ok(
  (
    select outcome = 'eligible'
      and reason_code is null
      and valid_until =
        (vortex_context.current_context() ->> 'primaryAuthenticatedAt')::timestamptz
          + interval '120 seconds'
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read', 'primary', 120
      )
    )
  ),
  'fresh recent authentication is eligible only until its exact deadline'
);

reset role;
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', true, true
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read'
      )
    )
  ),
  'refused|target_policy_unavailable',
  'delegated request context fails closed in the first eligibility slice'
);

select throws_ok(
  $$
    select * from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000001', 'read'
      ) || pg_catalog.jsonb_build_object('identityId',
        '42900000-0000-4000-8000-000000000001', 'systemActorId',
        '92900000-0000-4000-8000-000000000001')
    )
  $$,
  '22023'::char(5), 'Organization permission declaration is invalid',
  'caller identity fields are rejected before fact evaluation'
);
select throws_ok(
  $$
    select * from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_set(
        pg_temp.application_declaration(
          '43900000-0000-4000-8000-000000000001', 'read'
        ),
        '{target,kind}', '"future_target"'::jsonb
      )
    )
  $$,
  '22023'::char(5), 'Organization permission declaration is invalid',
  'unsupported target kinds are rejected before fact evaluation'
);
select throws_ok(
  $$
    select * from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_set(
        pg_temp.application_declaration(
          '43900000-0000-4000-8000-000000000001', 'read'
        ),
        '{recentAuthentication}',
        '{"kind":"primary","maximumAgeSeconds":"not-a-number"}'::jsonb
      )
    )
  $$,
  '22023'::char(5), 'Organization permission declaration is invalid',
  'malformed recent-authentication evidence has one closed input error'
);

-- A live activation cannot outlive the exact assignment revision that made it
-- eligible, even when its role and policy remain current.
reset role;
select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, operation, revision, state, access_version
    )
    from vortex_access.coordinate_organization_role_assignment_change(
      'revoke', '22900000-0000-4000-8000-000000000001',
      '72900000-0000-4000-8000-000000000003', 1,
      null, null, null, null, null, null, null, null,
      '92900000-0000-4000-8000-000000000001',
      'a2900000-0000-4000-8000-000000000040'
    )
  ),
  'changed|revoke|2|revoked|6',
  'the real assignment writer revokes the activation source and increments Access once'
);
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000003', 'update'
      )
    )
  ),
  'refused|permission_not_effective',
  'an activation with a stale assignment-source revision is not an effective path'
);

-- Advance the Group-activation role to a new policy continuity without
-- changing its sealed permission authority. The old live activation is then
-- stale against the current policy evidence.
reset role;
do $body$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.organization_role_activation_policy_revisions (
    organization_id, role_id, activation_policy_id, revision,
    policy_fingerprint, maximum_activation_duration_seconds,
    reason_required, authentication_requirement,
    authentication_maximum_age_seconds, independent_approval_required,
    changed_by, changed_at, change_correlation_id
  ) values (
    '22900000-0000-4000-8000-000000000001',
    '62900000-0000-4000-8000-000000000004',
    '63900000-0000-4000-8000-000000000004', 2,
    'sha256:' || pg_catalog.repeat('8', 64), 3600, false, 'none', null,
    false, '92900000-0000-4000-8000-000000000001', operation_at,
    'a2900000-0000-4000-8000-000000000041'
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
  where organization_id = '22900000-0000-4000-8000-000000000001'
    and role_id = '62900000-0000-4000-8000-000000000004'
    and role_revision = 1;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  )
  select organization_id, role_id, 2, role_kind, lifecycle,
    privilege_classification, assignment_policy, 2,
    authority_continuity_revision, activation_policy_id, 2,
    'sha256:' || pg_catalog.repeat('8', 64), role_key, label, description,
    '92900000-0000-4000-8000-000000000001', operation_at,
    'a2900000-0000-4000-8000-000000000041'
  from vortex_access.organization_role_revisions
  where organization_id = '22900000-0000-4000-8000-000000000001'
    and role_id = '62900000-0000-4000-8000-000000000004'
    and revision = 1;

  update vortex_access.organization_roles
  set live_revision = 2
  where organization_id = '22900000-0000-4000-8000-000000000001'
    and role_id = '62900000-0000-4000-8000-000000000004';
end
$body$;
set constraints all immediate;
set constraints all deferred;
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.application_declaration(
        '43900000-0000-4000-8000-000000000004', 'update'
      )
    )
  ),
  'refused|permission_not_effective',
  'an activation with stale current policy-continuity evidence is not an effective path'
);

-- The module tuple is governed by the exact parent application registration.
-- A real withdrawal removes current continuity and must close eligibility.
reset role;
select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, operation, registration_state, registration_revision,
      access_version
    )
    from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '22900000-0000-4000-8000-000000000001',
      '32900000-0000-4000-8000-000000000001',
      '92900000-0000-4000-8000-000000000001',
      'a2900000-0000-4000-8000-000000000042'
    )
  ),
  'changed|withdraw|withdrawn|2|7',
  'the real application writer withdraws the module parent registration once'
);
select pg_temp.install_eligibility_context(
  '32900000-0000-4000-8000-000000000001', interval '0 seconds', true, false
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.module_declaration()
    )
  ),
  'refused|permission_unavailable',
  'a module-owned permission refuses after its parent application is withdrawn'
);

reset role;
set constraints all immediate;
set constraints all deferred;
select * from finish();

rollback;
