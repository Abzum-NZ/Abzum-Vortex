begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- Function shape and ACL assertions for the shared core and the record
-- entry point. `evaluate_organization_permission_eligibility` keeps its
-- existing request/module-owner grants (290 already proves its full route
-- matrix); the other three objects are owner-only.
select has_function(
  'vortex_access', 'evaluate_permission_role_path_internal',
  array['jsonb', 'timestamptz', 'jsonb', 'jsonb', 'uuid'],
  'Access owns one shared private current-permission/role-path predicate'
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
      'vortex_access.evaluate_permission_role_path_internal(jsonb,timestamptz,jsonb,jsonb,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 's',
    'configuration', array['search_path=""']
  ),
  'the shared role-path core is owner-held, stable, invoker-rights and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_permission_role_path_internal(jsonb,timestamptz,jsonb,jsonb,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private role-path core'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request'), ('vortex_module_owner'),
  ('vortex_record_owner'), ('vortex_record_adapter')
) as caller(role_name)
order by caller.role_name collate "C";

select has_function(
  'vortex_access', 'recent_authentication_deadline_internal',
  array['jsonb', 'timestamptz', 'jsonb'],
  'Access owns one shared private recent-authentication deadline predicate'
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
      'vortex_access.recent_authentication_deadline_internal(jsonb,timestamptz,jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 's',
    'configuration', array['search_path=""']
  ),
  'the shared authentication-deadline core is owner-held, stable, invoker-rights and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.recent_authentication_deadline_internal(jsonb,timestamptz,jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private authentication-deadline core'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request'), ('vortex_module_owner'),
  ('vortex_record_owner'), ('vortex_record_adapter')
) as caller(role_name)
order by caller.role_name collate "C";

select has_function(
  'vortex_access', 'evaluate_organization_permission_eligibility',
  array['jsonb'],
  'Access still exposes the one non-record eligibility predicate after extraction'
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
  'the replaced non-record wrapper keeps its definer, volatile, empty-search-path shape'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_organization_permission_eligibility(jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' still cannot execute the non-record wrapper'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";
select ok(
  pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_organization_permission_eligibility(jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' keeps its existing grant on the non-record wrapper'
)
from (values ('vortex_request'), ('vortex_module_owner')) as caller(role_name)
order by caller.role_name collate "C";

select has_function(
  'vortex_access', 'evaluate_organization_record_permission_eligibility_internal',
  array['jsonb', 'jsonb', 'timestamptz'],
  'Access owns one private record-permission eligibility predicate'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig,
      'result', pg_catalog.pg_get_function_result(procedure_row.oid)
    )
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.evaluate_organization_record_permission_eligibility_internal(jsonb,jsonb,timestamptz)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 's',
    'configuration', array['search_path=""'], 'result', 'jsonb'
  ),
  'the record eligibility predicate is owner-held, stable, invoker-rights and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_organization_record_permission_eligibility_internal(jsonb,jsonb,timestamptz)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private record eligibility predicate'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request'), ('vortex_module_owner'),
  ('vortex_record_owner'), ('vortex_record_adapter')
) as caller(role_name)
order by caller.role_name collate "C";

-- Fixture: one tenant/organisation/account/Access-version scope, one
-- application registration owning five permissions on a shared record type --
-- two record-scoped permissions with different scopes/deadlines (A, B), one
-- non-record permission (legacy wrapper equivalence), one record permission
-- with a legacy null record_scope, and one record-scoped permission that is
-- never granted to any role. A sixth permission id is deliberately never
-- registered at all, to exercise "no catalogue entry".
create function pg_temp.create_record_eligibility_scope()
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
    '14250000-0000-4000-8000-000000000001', 'record_eligibility',
    'Record eligibility', 'active', operation_at,
    '94250000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '24250000-0000-4000-8000-000000000001',
    '14250000-0000-4000-8000-000000000001', 'record_eligibility',
    'Record eligibility', 'active', operation_at,
    '94250000-0000-4000-8000-000000000001', operation_at, 1
  );

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '44250000-0000-4000-8000-000000000001', 'active', operation_at,
    operation_at, '94250000-0000-4000-8000-000000000001',
    'a4250000-0000-4000-8000-000000000001', 1
  );

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '54250000-0000-4000-8000-000000000001',
    '24250000-0000-4000-8000-000000000001',
    '44250000-0000-4000-8000-000000000001', 'Record eligibility account',
    'active', operation_at - interval '1 minute', operation_at, operation_at,
    '94250000-0000-4000-8000-000000000001',
    'a4250000-0000-4000-8000-000000000002', 1
  );

  perform 1 from vortex_access.initialize_organization_access_version(
    '24250000-0000-4000-8000-000000000001',
    '94250000-0000-4000-8000-000000000001',
    'a4250000-0000-4000-8000-000000000003'
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    '24250000-0000-4000-8000-000000000001',
    '94250000-0000-4000-8000-000000000001',
    'a4250000-0000-4000-8000-000000000004'
  );
end
$function$;

create function pg_temp.seed_record_eligibility_application()
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
    '24250000-0000-4000-8000-000000000001', 'application',
    '34250000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.record_eligibility', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94250000-0000-4000-8000-000000000001',
    'a4250000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24250000-0000-4000-8000-000000000001', 'application',
    '34250000-0000-4000-8000-000000000001', 'active', 1,
    'example.record_eligibility', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94250000-0000-4000-8000-000000000001',
    'a4250000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope
  )
  select
    '24250000-0000-4000-8000-000000000001'::uuid, 'application',
    '34250000-0000-4000-8000-000000000001'::uuid, 1,
    '34250000-0000-4000-8000-000000000001'::uuid, 'application',
    '34250000-0000-4000-8000-000000000001'::uuid,
    permission.permission_id, permission.permission_key,
    permission.label, 'Record eligibility fixture.',
    permission.record_type_id, 'read', null, false,
    'application', 'example.record_eligibility',
    '34250000-0000-4000-8000-000000000001'::uuid, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64),
    permission.record_scope
  from (values
    ('c4250000-0000-4000-8000-000000000010'::uuid,
      'example.record_eligibility.all_records', 'All records',
      '84250000-0000-4000-8000-000000000001'::uuid, 'a',
      '{"routes":[{"kind":"all_records"}]}'::jsonb),
    ('c4250000-0000-4000-8000-000000000020'::uuid,
      'example.record_eligibility.ownership', 'Ownership',
      '84250000-0000-4000-8000-000000000001'::uuid, 'b',
      '{"routes":[{"kind":"ownership"}]}'::jsonb),
    ('c4250000-0000-4000-8000-000000000030'::uuid,
      'example.record_eligibility.non_record', 'Non record',
      null::uuid, 'c', null::jsonb),
    ('c4250000-0000-4000-8000-000000000040'::uuid,
      'example.record_eligibility.legacy', 'Legacy record',
      '84250000-0000-4000-8000-000000000001'::uuid, 'd', null::jsonb),
    ('c4250000-0000-4000-8000-000000000050'::uuid,
      'example.record_eligibility.unassigned', 'Unassigned scoped',
      '84250000-0000-4000-8000-000000000001'::uuid, 'e',
      '{"routes":[{"kind":"ownership"}]}'::jsonb)
  ) as permission(
    permission_id, permission_key, label, record_type_id,
    fingerprint_character, record_scope
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
  where entry.organization_id = '24250000-0000-4000-8000-000000000001'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id =
      '34250000-0000-4000-8000-000000000001';
end
$function$;

-- A minimal standing direct grant. Group and activation routing are already
-- proven by 290/300 through the shared role-path core; this file exercises
-- the record function's own aggregation and precedence, not route selection.
create function pg_temp.seed_record_standing_role(
  p_role_id uuid,
  p_role_key text,
  p_permission_id uuid
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
    '24250000-0000-4000-8000-000000000001', p_role_id, 'custom',
    p_role_key, 1, '94250000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, p_role_id, 1, 1, 'custom', null,
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
  where entry.organization_id = '24250000-0000-4000-8000-000000000001'
    and entry.permission_id = p_permission_id;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '24250000-0000-4000-8000-000000000001', p_role_id, 1, 'custom',
    'active', 'standard', 'standing', 1, 1,
    p_role_key, 'Record eligibility role',
    'Record eligibility role fixture.',
    '94250000-0000-4000-8000-000000000001', operation_at, p_role_id
  );
end
$function$;

-- Builds the trusted context jsonb directly, exactly as the (still
-- unimplemented) later decision wrapper will supply it: this function never
-- samples it itself.
create function pg_temp.record_context(
  p_expires_at timestamptz,
  p_primary_authenticated_at timestamptz default null,
  p_delegated boolean default false
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select (
    pg_catalog.jsonb_build_object(
      'organizationId', '24250000-0000-4000-8000-000000000001',
      'organizationAccountId', '54250000-0000-4000-8000-000000000001',
      'accessVersion', (
        select version.current_version
        from vortex_access.organization_access_versions as version
        where version.organization_id =
          '24250000-0000-4000-8000-000000000001'
      ),
      'applicationRootId', '34250000-0000-4000-8000-000000000001',
      'expiresAt', p_expires_at,
      'correlationId', 'a4250000-0000-4000-8000-000000000099'
    )
    || case when p_primary_authenticated_at is not null
      then pg_catalog.jsonb_build_object(
        'primaryAuthenticatedAt', p_primary_authenticated_at
      )
      else '{}'::jsonb
    end
    || case when p_delegated
      then pg_catalog.jsonb_build_object(
        'delegatedContext', pg_catalog.jsonb_build_object(
          'delegatedByOrganizationAccountId',
            '54250000-0000-4000-8000-000000000002',
          'reason', 'Neutral record-eligibility refusal fixture.',
          'expiresAt', p_expires_at
        )
      )
      else '{}'::jsonb
    end
  )
$function$;

create function pg_temp.record_permission_ref(p_permission_id uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'applicationRootId', '34250000-0000-4000-8000-000000000001',
    'ownerKind', 'application',
    'ownerId', '34250000-0000-4000-8000-000000000001',
    'permissionId', p_permission_id
  )
$function$;

create function pg_temp.record_declaration(
  p_permission_ids text[],
  p_authentication_kind text default 'none',
  p_maximum_age_seconds bigint default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '34250000-0000-4000-8000-000000000001'
    ),
    'requiredPermissions', (
      select pg_catalog.jsonb_agg(
        pg_temp.record_permission_ref(item.value::uuid) order by item.ordinality
      )
      from pg_catalog.unnest(p_permission_ids)
        with ordinality as item(value, ordinality)
    ),
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', '34250000-0000-4000-8000-000000000002',
      'recordTypeId', '84250000-0000-4000-8000-000000000001',
      'storageContractId', '84250000-0000-4000-8000-000000000002',
      'storageScope', 'organization_shared'
    ),
    'recentAuthentication', case
      when p_authentication_kind = 'none'
        then pg_catalog.jsonb_build_object('kind', 'none')
      else pg_catalog.jsonb_build_object(
        'kind', p_authentication_kind,
        'maximumAgeSeconds', p_maximum_age_seconds
      )
    end,
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
$function$;

create function pg_temp.record_eligibility_result(
  p_declaration jsonb,
  p_context jsonb
)
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, p_context, pg_catalog.clock_timestamp()
  )
$function$;

-- The legacy non-record declaration shape, unchanged from the pre-extraction
-- contract, used to prove the replaced wrapper is still behaviourally
-- identical for ordinary (non-record) callers.
create function pg_temp.legacy_declaration(
  p_permission_id uuid,
  p_action_kind text default 'read'
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
      'applicationRootId', '34250000-0000-4000-8000-000000000001'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '34250000-0000-4000-8000-000000000001',
      'ownerKind', 'application',
      'ownerId', '34250000-0000-4000-8000-000000000001',
      'permissionId', p_permission_id
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
$function$;

select pg_temp.create_record_eligibility_scope();
select pg_temp.seed_record_eligibility_application();

select pg_temp.seed_record_standing_role(
  '64250000-0000-4000-8000-000000000010', 'permission_a_standing',
  'c4250000-0000-4000-8000-000000000010'
);
select pg_temp.seed_record_standing_role(
  '64250000-0000-4000-8000-000000000020', 'permission_b_standing',
  'c4250000-0000-4000-8000-000000000020'
);
select pg_temp.seed_record_standing_role(
  '64250000-0000-4000-8000-000000000030', 'permission_legacy_standing',
  'c4250000-0000-4000-8000-000000000030'
);
-- permission ...040 (legacy null record_scope) and ...050 (unassigned
-- scoped) deliberately receive no role assignment.

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values
  (
    '24250000-0000-4000-8000-000000000001',
    '74250000-0000-4000-8000-000000000010',
    '64250000-0000-4000-8000-000000000010', 'organization_account',
    '54250000-0000-4000-8000-000000000001', null, 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '40 minutes', 'live',
    '94250000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a4250000-0000-4000-8000-000000000020',
    '94250000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a4250000-0000-4000-8000-000000000020'
  ),
  (
    '24250000-0000-4000-8000-000000000001',
    '74250000-0000-4000-8000-000000000020',
    '64250000-0000-4000-8000-000000000020', 'organization_account',
    '54250000-0000-4000-8000-000000000001', null, 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '25 minutes', 'live',
    '94250000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a4250000-0000-4000-8000-000000000021',
    '94250000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a4250000-0000-4000-8000-000000000021'
  ),
  (
    '24250000-0000-4000-8000-000000000001',
    '74250000-0000-4000-8000-000000000030',
    '64250000-0000-4000-8000-000000000030', 'organization_account',
    '54250000-0000-4000-8000-000000000001', null, 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.transaction_timestamp() + interval '50 minutes', 'live',
    '94250000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a4250000-0000-4000-8000-000000000022',
    '94250000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
    'a4250000-0000-4000-8000-000000000022'
  );

set constraints all immediate;
set constraints all deferred;

create temporary table record_eligibility_deadlines (
  route text primary key,
  expires_at timestamptz not null
) on commit drop;
insert into record_eligibility_deadlines (route, expires_at)
select 'permission_a', assignment.expires_at
from vortex_access.organization_role_assignments as assignment
where assignment.organization_id = '24250000-0000-4000-8000-000000000001'
  and assignment.role_assignment_id = '74250000-0000-4000-8000-000000000010'
union all
select 'permission_b', assignment.expires_at
from vortex_access.organization_role_assignments as assignment
where assignment.organization_id = '24250000-0000-4000-8000-000000000001'
  and assignment.role_assignment_id = '74250000-0000-4000-8000-000000000020'
union all
select 'permission_legacy', assignment.expires_at
from vortex_access.organization_role_assignments as assignment
where assignment.organization_id = '24250000-0000-4000-8000-000000000001'
  and assignment.role_assignment_id = '74250000-0000-4000-8000-000000000030';

-- Two simultaneously eligible alternatives: carries no recordId, lists both
-- alternatives with their own scope/source/deadline in declared order, and
-- the top-level validUntil is the earliest of the two (permission B, which
-- sorts second in the declaration but expires first).
select ok(
  not (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(array[
        'c4250000-0000-4000-8000-000000000010',
        'c4250000-0000-4000-8000-000000000020'
      ]),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    ) ? 'recordId'
  ),
  'record-permission eligibility never carries a recordId'
);
select is(
  (
    select result ->> 'outcome'
    from (
      select pg_temp.record_eligibility_result(
        pg_temp.record_declaration(array[
          'c4250000-0000-4000-8000-000000000010',
          'c4250000-0000-4000-8000-000000000020'
        ]),
        pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
      ) as result
    ) as evaluated
  ),
  'eligible',
  'two record-scoped alternatives with live paths are eligible'
);
select is(
  (
    select pg_catalog.jsonb_array_length(result -> 'eligiblePermissions')
    from (
      select pg_temp.record_eligibility_result(
        pg_temp.record_declaration(array[
          'c4250000-0000-4000-8000-000000000010',
          'c4250000-0000-4000-8000-000000000020'
        ]),
        pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
      ) as result
    ) as evaluated
  ),
  2,
  'both eligible alternatives are listed, none dropped'
);
select is(
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'permissionId', entry -> 'permission' ->> 'permissionId',
        'recordScope', entry -> 'recordScope'
      ) order by entry -> 'permission' ->> 'permissionId'
    )
    from (
      select pg_temp.record_eligibility_result(
        pg_temp.record_declaration(array[
          'c4250000-0000-4000-8000-000000000010',
          'c4250000-0000-4000-8000-000000000020'
        ]),
        pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
      ) as result
    ) as evaluated
    cross join lateral pg_catalog.jsonb_array_elements(
      result -> 'eligiblePermissions'
    ) as entry
  ),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'permissionId', 'c4250000-0000-4000-8000-000000000010',
      'recordScope', '{"routes":[{"kind":"all_records"}]}'::jsonb
    ),
    pg_catalog.jsonb_build_object(
      'permissionId', 'c4250000-0000-4000-8000-000000000020',
      'recordScope', '{"routes":[{"kind":"ownership"}]}'::jsonb
    )
  ),
  'each alternative keeps its own exact catalogue record scope'
);
select is(
  (
    select (result ->> 'validUntil')::timestamptz
    from (
      select pg_temp.record_eligibility_result(
        pg_temp.record_declaration(array[
          'c4250000-0000-4000-8000-000000000010',
          'c4250000-0000-4000-8000-000000000020'
        ]),
        pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
      ) as result
    ) as evaluated
  ),
  (select expires_at from record_eligibility_deadlines where route = 'permission_b'),
  'the eligible validUntil is the earliest of the two candidate deadlines'
);
select is(
  (
    select (entry ->> 'validUntil')::timestamptz
    from (
      select pg_temp.record_eligibility_result(
        pg_temp.record_declaration(array[
          'c4250000-0000-4000-8000-000000000010',
          'c4250000-0000-4000-8000-000000000020'
        ]),
        pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
      ) as result
    ) as evaluated
    cross join lateral pg_catalog.jsonb_array_elements(
      result -> 'eligiblePermissions'
    ) as entry
    where entry -> 'permission' ->> 'permissionId' =
      'c4250000-0000-4000-8000-000000000010'
  ),
  (select expires_at from record_eligibility_deadlines where route = 'permission_a'),
  'permission A keeps its own later deadline in its own list entry'
);

-- A legacy record entry without record_scope refuses with
-- target_policy_unavailable, distinct from "no catalogue entry at all".
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array['c4250000-0000-4000-8000-000000000040']
      ),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    ) ->> 'reasonCode'
  ),
  'target_policy_unavailable',
  'a catalogue entry without record_scope refuses distinctly from a missing entry'
);

-- Refusal precedence, one representative cause per branch.
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array['c4250000-0000-4000-8000-000000000010']
      ),
      pg_temp.record_context(pg_catalog.clock_timestamp() - interval '1 minute')
    ) ->> 'reasonCode'
  ),
  'target_policy_unavailable',
  'branch 1: an already-expired context refuses ahead of every other check'
);
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array['c4250000-0000-4000-8000-000000000099']
      ),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    ) ->> 'reasonCode'
  ),
  'permission_unavailable',
  'branch 2: no alternative has any catalogue entry'
);
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array['c4250000-0000-4000-8000-000000000050']
      ),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    ) ->> 'reasonCode'
  ),
  'permission_not_effective',
  'branch 4: a scoped entry with no live role path refuses distinctly from an unavailable permission'
);
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array['c4250000-0000-4000-8000-000000000010'], 'primary', 60
      ),
      pg_temp.record_context(
        pg_catalog.clock_timestamp() + interval '1 hour',
        pg_catalog.clock_timestamp() - interval '2 hours'
      )
    ) ->> 'reasonCode'
  ),
  'authentication_unsatisfied',
  'branch 5: an otherwise-complete scoped path still refuses on stale recent authentication'
);

-- Precedence is genuine ordering, not just reachability: combine two failure
-- causes and confirm the earlier branch wins.
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array['c4250000-0000-4000-8000-000000000099']
      ),
      pg_temp.record_context(pg_catalog.clock_timestamp() - interval '1 minute')
    ) ->> 'reasonCode'
  ),
  'target_policy_unavailable',
  'branch 1 outranks branch 2 when both an expired context and a missing entry apply'
);
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(array[
        'c4250000-0000-4000-8000-000000000040',
        'c4250000-0000-4000-8000-000000000099'
      ]),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    ) ->> 'reasonCode'
  ),
  'target_policy_unavailable',
  'branch 3 outranks branch 2: the legacy entry proves catalogue_available so the missing alternative alone does not win'
);
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(array[
        'c4250000-0000-4000-8000-000000000040',
        'c4250000-0000-4000-8000-000000000050'
      ]),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    ) ->> 'reasonCode'
  ),
  'permission_not_effective',
  'branch 4 outranks branch 3: the unassigned scoped alternative proves scoped_available'
);
select is(
  (
    pg_temp.record_eligibility_result(
      pg_temp.record_declaration(
        array[
          'c4250000-0000-4000-8000-000000000010',
          'c4250000-0000-4000-8000-000000000050'
        ], 'primary', 60
      ),
      pg_temp.record_context(
        pg_catalog.clock_timestamp() + interval '1 hour',
        pg_catalog.clock_timestamp() - interval '2 hours'
      )
    ) ->> 'reasonCode'
  ),
  'authentication_unsatisfied',
  'branch 5 outranks branch 4: permission A alone proves a live path exists despite the unassigned alternative'
);

-- Declared alternatives must stay in strict canonical order, same as the
-- non-record wrapper''s existing declaration contract.
select throws_ok(
  $$
    select pg_temp.record_eligibility_result(
      pg_temp.record_declaration(array[
        'c4250000-0000-4000-8000-000000000020',
        'c4250000-0000-4000-8000-000000000010'
      ]),
      pg_temp.record_context(pg_catalog.clock_timestamp() + interval '1 hour')
    )
  $$,
  '22023'::char(5), 'Organization record permission declaration is invalid',
  'declared alternatives out of canonical order are rejected before evaluation'
);

-- Legacy equivalence: the replaced non-record wrapper still evaluates an
-- ordinary singular declaration exactly as supabase/tests/290 expects, and a
-- record-scoped catalogue entry stays invisible to it.
create function vortex_access.test_legacy_eligibility_row(p_declaration jsonb)
returns table (outcome text, reason_code text, valid_until timestamptz)
language sql
volatile
security definer
set search_path = ''
as $function$
  select decision.outcome, decision.reason_code, decision.valid_until
  from vortex_access.evaluate_organization_permission_eligibility(
    p_declaration
  ) as decision
$function$;
revoke execute on function vortex_access.test_legacy_eligibility_row(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_legacy_eligibility_row(jsonb)
  to vortex_request;
grant execute on function pg_temp.legacy_declaration(uuid, text) to vortex_request;
grant select on record_eligibility_deadlines to vortex_request;
grant usage on schema extensions to vortex_request;

create function pg_temp.install_legacy_eligibility_context()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  current_access_version bigint;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24250000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'b4250000-0000-4000-8000-000000000001',
    'tenantId', '14250000-0000-4000-8000-000000000001',
    'organizationId', '24250000-0000-4000-8000-000000000001',
    'organizationAccountId', '54250000-0000-4000-8000-000000000001',
    'identityId', '44250000-0000-4000-8000-000000000001',
    'applicationRootId', '34250000-0000-4000-8000-000000000001',
    'sessionId', 'b4250000-0000-4000-8000-000000000002',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a4250000-0000-4000-8000-000000000098',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

select pg_temp.install_legacy_eligibility_context();

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  (
    select pg_catalog.concat_ws('|', outcome, coalesce(reason_code, ''))
    from vortex_access.test_legacy_eligibility_row(
      pg_temp.legacy_declaration('c4250000-0000-4000-8000-000000000030')
    )
  ),
  'eligible|',
  'legacy equivalence: an ordinary non-record declaration is still eligible after the extraction'
);
select is(
  (
    select valid_until
    from vortex_access.test_legacy_eligibility_row(
      pg_temp.legacy_declaration('c4250000-0000-4000-8000-000000000030')
    )
  ),
  (select expires_at from record_eligibility_deadlines where route = 'permission_legacy'),
  'legacy equivalence: the replaced wrapper still resolves the exact assignment deadline'
);
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.test_legacy_eligibility_row(
      pg_temp.legacy_declaration('c4250000-0000-4000-8000-000000000030', 'delete')
    )
  ),
  'refused|permission_unavailable',
  'legacy equivalence: the exact catalogue action must still match after the extraction'
);
select is(
  (
    select pg_catalog.concat_ws('|', outcome, reason_code)
    from vortex_access.test_legacy_eligibility_row(
      pg_temp.legacy_declaration('c4250000-0000-4000-8000-000000000010')
    )
  ),
  'refused|permission_unavailable',
  'a record-scoped catalogue entry is still refused by the non-record wrapper'
);
reset role;

set constraints all immediate;

select * from finish();

rollback;
