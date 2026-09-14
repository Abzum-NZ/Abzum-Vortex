\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.seed_management_application(
  p_application_root_id uuid,
  p_definition_key text,
  p_source_role_id uuid,
  p_first_permission_id uuid,
  p_first_fingerprint_character text,
  p_second_permission_id uuid default null,
  p_second_fingerprint_character text default null
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '23000000-0000-4000-8000-000000000001', 'application',
    p_application_root_id, 1, 'active', 'register', p_definition_key,
    '1.0.0', 1, '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '93000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '23000000-0000-4000-8000-000000000001', 'application',
    p_application_root_id, 'active', 1, p_definition_key, '1.0.0', 1,
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '93000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000010'
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
  select '23000000-0000-4000-8000-000000000001', 'application',
    p_application_root_id, 1, p_application_root_id, 'application',
    p_application_root_id, permission.permission_id,
    p_definition_key || '.' || permission.permission_ordinal || '.read',
    'Read fixture', 'Delegated management eligibility fixture.', null,
    'read', null, false, 'application', p_definition_key,
    p_application_root_id, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64)
  from (values
    (p_first_permission_id, 'first', p_first_fingerprint_character),
    (p_second_permission_id, 'second', p_second_fingerprint_character)
  ) as permission(permission_id, permission_ordinal, fingerprint_character)
  where permission.permission_id is not null;

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
  where entry.organization_id = '23000000-0000-4000-8000-000000000001'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id;

  -- A delivered active application has observed at least one current role
  -- template even when this organization has not accepted that template into
  -- an application Role. The real B2 writer requires that complete current
  -- application state before it can coordinate a withdrawal.
  insert into vortex_access.application_role_template_continuities (
    organization_id, application_root_id, source_role_id, state,
    continuity_revision, source_template_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    '23000000-0000-4000-8000-000000000001', p_application_root_id,
    p_source_role_id, 'available', 1,
    'sha256:' || pg_catalog.repeat('5', 64), 1, operation_at
  );
end
$function$;

create function pg_temp.exact_bounded_permission(
  p_application_root_id uuid,
  p_permission_id uuid,
  p_fingerprint_character text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'applicationRootId', p_application_root_id,
    'ownerKind', 'application',
    'ownerId', p_application_root_id,
    'permissionId', p_permission_id
  )
$function$;

create function pg_temp.stored_bounded_permission(
  p_application_root_id uuid,
  p_permission_id uuid,
  p_fingerprint_character text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_temp.exact_bounded_permission(
    p_application_root_id, p_permission_id, p_fingerprint_character
  ) || pg_catalog.jsonb_build_object(
    'kind', 'exact',
    'acceptedRegistrationRevision', 1,
    'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
    'continuityRevision', 1,
    'meaningFingerprint',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64)
  )
$function$;

create function pg_temp.management_declaration(
  p_before jsonb,
  p_after jsonb
)
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
      'applicationRootId', '33000000-0000-4000-8000-000000000001'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '33000000-0000-4000-8000-000000000001',
      'ownerKind', 'application',
      'ownerId', '33000000-0000-4000-8000-000000000001',
      'permissionId', '43000000-0000-4000-8000-000000000001'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object(
      'kind', 'delegated_management', 'before', p_before, 'after', p_after
    )
  )
$function$;

create function pg_temp.install_management_context()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id =
    '23000000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83000000-0000-4000-8000-000000000001',
    'tenantId', '13000000-0000-4000-8000-000000000001',
    'organizationId', '23000000-0000-4000-8000-000000000001',
    'applicationRootId', '33000000-0000-4000-8000-000000000001',
    'organizationAccountId', '53000000-0000-4000-8000-000000000001',
    'identityId', '43000000-0000-4000-8000-000000000099',
    'sessionId', '63000000-0000-4000-8000-000000000099',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3000000-0000-4000-8000-000000000099',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

select has_function(
  'vortex_access', 'evaluate_organization_permission_eligibility',
  array['jsonb'],
  'Access keeps one private permission and delegation eligibility predicate'
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
      'vortex_access.evaluate_organization_permission_eligibility(jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the extended predicate preserves its private definer-security boundary'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_organization_permission_eligibility(jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute delegated-management eligibility'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13000000-0000-4000-8000-000000000001', 'management_eligibility',
  'Management eligibility', 'active', pg_catalog.statement_timestamp(),
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '23000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001', 'management_eligibility',
  'Management eligibility', 'active', pg_catalog.statement_timestamp(),
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '43000000-0000-4000-8000-000000000099', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, suspended_at, changed_at, state_changed_at,
  state_changed_by, state_change_correlation_id, revision
) values (
  '53000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000099', 'Management actor', 'active',
  pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(),
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000002', 1
);

select * from vortex_access.initialize_organization_access_version(
  '23000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000003'
);

select pg_temp.seed_management_application(
  '33000000-0000-4000-8000-000000000001',
  'example.management_use',
  '43000000-0000-4000-8000-000000000101',
  '43000000-0000-4000-8000-000000000001', 'a'
);
select pg_temp.seed_management_application(
  '33000000-0000-4000-8000-000000000002',
  'example.management_scope',
  '43000000-0000-4000-8000-000000000102',
  '43000000-0000-4000-8000-000000000002', 'b',
  '43000000-0000-4000-8000-000000000003', 'c'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001', 'custom',
  'management_use', 1, '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
) values (
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001', 1, 1, 'custom', null,
  '33000000-0000-4000-8000-000000000001', 'application',
  '33000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001', 'application',
  '33000000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 1,
  'sha256:' || pg_catalog.repeat('a', 64)
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, changed_by, changed_at,
  change_correlation_id
) values (
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001', 1, 'custom', 'active',
  'standard', 'standing', 1, 1, 'management_use', 'Management use',
  'Use permission for delegated-management eligibility.',
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a3000000-0000-4000-8000-000000000004'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '23000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001', 'organization_account',
  '53000000-0000-4000-8000-000000000001', null, 'standing', 1,
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '1 hour', 'live',
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a3000000-0000-4000-8000-000000000005',
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a3000000-0000-4000-8000-000000000005'
);

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000002', 'management_group',
  'Management Group', 'active', 1,
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a3000000-0000-4000-8000-000000000006'
);

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '23000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000002',
  '53000000-0000-4000-8000-000000000001', 1,
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '25 minutes', 'live',
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a3000000-0000-4000-8000-000000000007',
  '93000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a3000000-0000-4000-8000-000000000007'
);

set constraints all immediate;
set constraints all deferred;

create temporary table management_deadlines (
  path text primary key,
  expires_at timestamptz not null
) on commit drop;

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000101', null,
  'organization_account',
  '53000000-0000-4000-8000-000000000001', null,
  'bounded',
  pg_catalog.jsonb_build_array(pg_temp.stored_bounded_permission(
    '33000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000002', 'b'
  )),
  'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '40 minutes',
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000011'
);

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000102', null,
  'group', null, '63000000-0000-4000-8000-000000000002',
  'bounded',
  pg_catalog.jsonb_build_array(pg_temp.stored_bounded_permission(
    '33000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000003', 'c'
  )),
  'sha256:' || pg_catalog.repeat('e', 64),
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '35 minutes',
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000012'
);

insert into management_deadlines (path, expires_at)
select 'direct_bounded', delegation.expires_at
from vortex_access.organization_delegation_authorities as delegation
where delegation.organization_id =
    '23000000-0000-4000-8000-000000000001'
  and delegation.delegation_authority_id =
    '63000000-0000-4000-8000-000000000101'
union all
select 'group_bounded', membership.expires_at
from vortex_access.organization_group_memberships as membership
where membership.organization_id =
    '23000000-0000-4000-8000-000000000001'
  and membership.membership_id = '83000000-0000-4000-8000-000000000001';

grant usage on schema extensions to vortex_request;
grant execute on function pg_temp.management_declaration(jsonb, jsonb)
  to vortex_request;
grant execute on function pg_temp.exact_bounded_permission(uuid, uuid, text)
  to vortex_request;
grant select on management_deadlines to vortex_request;

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select throws_ok(
  $$
    select *
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        '{"kind":"none"}'::jsonb
      )
    )
  $$,
  '22023'::char(5), 'Organization permission declaration is invalid',
  'management with no before or after authority is rejected before evaluation'
);

select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code, access_version)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        )
      )
    )
  ),
  'eligible|3',
  'a direct bounded delegation covers exact authority introduced in the after scope'
);

select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        )
      )
    )
  ),
  (select expires_at from management_deadlines where path = 'direct_bounded'),
  'the direct delegation fixed window bounds management eligibility'
);

select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code, valid_until)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        ),
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  'eligible|' || (
    select expires_at::text
    from management_deadlines where path = 'group_bounded'
  ),
  'separate direct and Group delegations cover distinct before and onward tuples'
);

select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"organization_catalogue"}'::jsonb,
        '{"kind":"none"}'::jsonb
      )
    )
  ),
  'refused|delegation_insufficient',
  'bounded delegations cannot synthesize organization-catalogue governance'
);

select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000004', 'd'
            )
          )
        )
      )
    )
  ),
  'refused|delegation_insufficient',
  'every distinct exact tuple requires one complete current delegation path'
);

-- Stored fingerprints are provenance, but bounded meaning and continuity must
-- still agree with the current exact permission. Introduce and restore one
-- bounded stale-evidence state without weakening the production protector.
reset role;
set constraints all immediate;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_validate_scope;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_protect_change;
update vortex_access.organization_delegation_authorities
set bounded_permissions = pg_catalog.jsonb_set(
  bounded_permissions,
  '{0,meaningFingerprint}',
  pg_catalog.to_jsonb('sha256:' || pg_catalog.repeat('f', 64))
)
where organization_id = '23000000-0000-4000-8000-000000000001'
  and delegation_authority_id = '63000000-0000-4000-8000-000000000101';
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_protect_change;
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_validate_scope;

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        )
      )
    )
  ),
  'refused|delegation_insufficient',
  'a bounded delegation with stale meaning evidence grants no management authority'
);

reset role;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_validate_scope;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_protect_change;
update vortex_access.organization_delegation_authorities
set bounded_permissions = pg_catalog.jsonb_build_array(
  pg_temp.stored_bounded_permission(
    '33000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000002', 'b'
  )
)
where organization_id = '23000000-0000-4000-8000-000000000001'
  and delegation_authority_id = '63000000-0000-4000-8000-000000000101';
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_protect_change;
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_validate_scope;

select is(
  (
    select pg_catalog.concat_ws('|', outcome, operation, access_version)
    from vortex_access.coordinate_organization_group_membership_change(
      'remove_membership',
      '23000000-0000-4000-8000-000000000001',
      '83000000-0000-4000-8000-000000000001', 1,
      null, null, null, null, null,
      '93000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000013'
    )
  ),
  'changed|remove_membership|4',
  'the real membership writer removes the Group delegation path once'
);

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        ),
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  'refused|delegation_insufficient',
  'a Group delegation grants nothing after the exact account membership is revoked'
);

reset role;
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000103', null,
  'organization_account',
  '53000000-0000-4000-8000-000000000001', null,
  'bounded',
  pg_catalog.jsonb_build_array(pg_temp.stored_bounded_permission(
    '33000000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000003', 'c'
  )),
  'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '30 minutes',
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000014'
);
insert into management_deadlines (path, expires_at)
select 'replacement_direct', delegation.expires_at
from vortex_access.organization_delegation_authorities as delegation
where delegation.organization_id =
    '23000000-0000-4000-8000-000000000001'
  and delegation.delegation_authority_id =
    '63000000-0000-4000-8000-000000000103';

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        ),
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  (select expires_at from management_deadlines where path = 'replacement_direct'),
  'a complete direct replacement path restores all exact management requirements'
);

reset role;
create temporary table replacement_window on commit drop as
select starts_at, expires_at
from vortex_access.organization_delegation_authorities
where organization_id = '23000000-0000-4000-8000-000000000001'
  and delegation_authority_id = '63000000-0000-4000-8000-000000000103';
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_validate_scope;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_protect_change;
update vortex_access.organization_delegation_authorities
set starts_at = pg_catalog.statement_timestamp() - interval '2 hours',
  expires_at = pg_catalog.statement_timestamp() - interval '1 hour'
where organization_id = '23000000-0000-4000-8000-000000000001'
  and delegation_authority_id = '63000000-0000-4000-8000-000000000103';
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_protect_change;
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_validate_scope;

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  'refused|delegation_insufficient',
  'a naturally expired delegation grants no management authority'
);

reset role;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_validate_scope;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_protect_change;
update vortex_access.organization_delegation_authorities as delegation
set starts_at = saved.starts_at, expires_at = saved.expires_at
from replacement_window as saved
where delegation.organization_id =
    '23000000-0000-4000-8000-000000000001'
  and delegation.delegation_authority_id =
    '63000000-0000-4000-8000-000000000103';
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_protect_change;
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_validate_scope;

select is(
  (
    select pg_catalog.concat_ws('|', outcome, operation,
      delegation ->> 'revision', delegation ->> 'state', access_version)
    from vortex_access.coordinate_organization_delegation_authority_change(
      'revoke_delegation',
      '23000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000101', 1,
      null, null, null, null, null, null, null, null,
      '93000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000015'
    )
  ),
  'changed|revoke_delegation|2|revoked|6',
  'the real delegation writer terminally revokes one direct bounded path'
);

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        )
      )
    )
  ),
  'refused|delegation_insufficient',
  'a revoked bounded delegation is never an eligible path'
);

reset role;
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000104', null,
  'organization_account',
  '53000000-0000-4000-8000-000000000001', null,
  'organization_catalogue', null, null,
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.transaction_timestamp() + interval '15 minutes',
  '93000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000016'
);
insert into management_deadlines (path, expires_at)
select 'catalogue', delegation.expires_at
from vortex_access.organization_delegation_authorities as delegation
where delegation.organization_id =
    '23000000-0000-4000-8000-000000000001'
  and delegation.delegation_authority_id =
    '63000000-0000-4000-8000-000000000104';

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code, access_version)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"organization_catalogue"}'::jsonb,
        '{"kind":"none"}'::jsonb
      )
    )
  ),
  'eligible|7',
  'one real direct catalogue delegation satisfies catalogue governance'
);
select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"organization_catalogue"}'::jsonb,
        '{"kind":"none"}'::jsonb
      )
    )
  ),
  (select expires_at from management_deadlines where path = 'catalogue'),
  'the selected catalogue delegation bounds the complete decision deadline'
);

select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000099',
              '43000000-0000-4000-8000-000000000099', '9'
            )
          )
        )
      )
    )
  ),
  'eligible',
  'catalogue authority covers a future exact tuple without inventing application use'
);

select is(
  (
    select valid_until
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000002', 'b'
            )
          )
        ),
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000003',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  (select expires_at from management_deadlines where path = 'catalogue'),
  'catalogue authority covers stale and future exact tuples through one actual path'
);

-- Once the wider catalogue path is gone, a retained bounded delegation must
-- still be backed by current catalogue and continuity facts. Withdrawing only
-- the managed application leaves the separate use permission intact.
reset role;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, operation,
      delegation ->> 'revision', delegation ->> 'state', access_version)
    from vortex_access.coordinate_organization_delegation_authority_change(
      'revoke_delegation',
      '23000000-0000-4000-8000-000000000001',
      '63000000-0000-4000-8000-000000000104', 1,
      null, null, null, null, null, null, null, null,
      '93000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000017'
    )
  ),
  'changed|revoke_delegation|2|revoked|8',
  'the real delegation writer removes the wider catalogue path once'
);

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  'eligible',
  'the remaining exact direct bounded path works without catalogue authority'
);

reset role;
select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, operation, registration_state, registration_revision,
      access_version
    )
    from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '23000000-0000-4000-8000-000000000001',
      '33000000-0000-4000-8000-000000000002',
      '93000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000018'
    )
  ),
  'changed|withdraw|withdrawn|2|9',
  'the real application writer withdraws only the managed catalogue source'
);

select pg_temp.install_management_context();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_temp.management_declaration(
        '{"kind":"none"}'::jsonb,
        pg_catalog.jsonb_build_object(
          'kind', 'bounded',
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.exact_bounded_permission(
              '33000000-0000-4000-8000-000000000002',
              '43000000-0000-4000-8000-000000000003', 'c'
            )
          )
        )
      )
    )
  ),
  'refused|delegation_insufficient',
  'bounded delegation refuses after its managed application continuity is unavailable'
);

reset role;
set constraints all immediate;
set constraints all deferred;
select * from finish();

rollback;
