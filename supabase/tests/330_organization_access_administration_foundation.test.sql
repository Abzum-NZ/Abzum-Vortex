\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_administration_context(
  p_identity_id uuid,
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
  where version.organization_id = '23300000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83300000-0000-4000-8000-000000000001',
    'tenantId', '13300000-0000-4000-8000-000000000001',
    'organizationId', '23300000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '63300000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3300000-0000-4000-8000-000000000099'
  ));
end
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'resolve_human_organization_change_scope',
  array['uuid', 'uuid'],
  'Access exposes one runtime-only governance-first organization change resolver'
);
select has_function(
  'vortex_access', 'resolve_human_application_change_scope',
  array['uuid', 'uuid', 'uuid'],
  'Access exposes one runtime-only governance-first application change resolver'
);
select has_function(
  'vortex_access', 'list_organization_groups_for_administration',
  array['uuid', 'integer'],
  'Access exposes one bounded protected Group list'
);
select has_function(
  'vortex_access', 'read_organization_group_for_administration',
  array['uuid'],
  'Access exposes one exact protected Group detail read'
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
      'vortex_access.resolve_human_organization_change_scope(uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', true,
    'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the change resolver is owner-held, volatile and empty-search-path'
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
      'vortex_access.list_organization_groups_for_administration(uuid,integer)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', true,
    'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the Group list is a narrow owner-held protected projection'
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.resolve_human_organization_change_scope(uuid,uuid)',
    'EXECUTE'
  ),
  'runtime can resolve the change scope before request-role entry'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_groups_for_administration(uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_group_for_administration(uuid)',
    'EXECUTE'
  ),
  'request role can execute only the protected Group projections'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.resolve_human_organization_change_scope(uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot resolve a governance-first change scope'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_groups_for_administration(uuid,integer)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the protected Group list'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.organization_groups_administration_scope()',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_group(uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_groups', 'SELECT'
  ),
  'request role cannot bypass the fixed decision through helpers or raw facts'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13300000-0000-4000-8000-000000000001', 'access_administration',
  'Access administration', 'active', pg_catalog.clock_timestamp(),
  '93300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23300000-0000-4000-8000-000000000001',
    '13300000-0000-4000-8000-000000000001', 'access_administration',
    'Access administration', 'active', pg_catalog.clock_timestamp(),
    '93300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  ),
  (
    '23300000-0000-4000-8000-000000000002',
    '13300000-0000-4000-8000-000000000001', 'foreign_application',
    'Foreign application', 'active', pg_catalog.clock_timestamp(),
    '93300000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43300000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93300000-0000-4000-8000-000000000001',
    'a3300000-0000-4000-8000-000000000001', 1
  ),
  (
    '43300000-0000-4000-8000-000000000002', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93300000-0000-4000-8000-000000000001',
    'a3300000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '53300000-0000-4000-8000-000000000001',
    '23300000-0000-4000-8000-000000000001',
    '43300000-0000-4000-8000-000000000001', 'Group reader', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93300000-0000-4000-8000-000000000001',
    'a3300000-0000-4000-8000-000000000003', 1
  ),
  (
    '53300000-0000-4000-8000-000000000002',
    '23300000-0000-4000-8000-000000000001',
    '43300000-0000-4000-8000-000000000002', 'No Group authority', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93300000-0000-4000-8000-000000000001',
    'a3300000-0000-4000-8000-000000000004', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '23300000-0000-4000-8000-000000000001',
  '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000005'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '23300000-0000-4000-8000-000000000001',
  '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000006'
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
  pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '23300000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values
  (
    '23300000-0000-4000-8000-000000000001', 'application',
    '33300000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'neutral.access_administration', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64),
    pg_catalog.clock_timestamp(), '93300000-0000-4000-8000-000000000001',
    'a3300000-0000-4000-8000-000000000050'
  ),
  (
    '23300000-0000-4000-8000-000000000002', 'application',
    '33300000-0000-4000-8000-000000000002', 1, 'active', 'register',
    'neutral.foreign_application', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('7', 64),
    'sha256:' || pg_catalog.repeat('8', 64),
    pg_catalog.clock_timestamp(), '93300000-0000-4000-8000-000000000001',
    'a3300000-0000-4000-8000-000000000051'
  );

insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state,
  revision, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
)
select organization_id, registration_kind, registration_owner_id, state,
  revision, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
from vortex_access.permission_registration_revisions
where registration_kind = 'application'
  and registration_owner_id in (
    '33300000-0000-4000-8000-000000000001'::uuid,
    '33300000-0000-4000-8000-000000000002'::uuid
  );

insert into vortex_access.application_role_template_continuities (
  organization_id, application_root_id, source_role_id, state,
  continuity_revision, source_template_fingerprint,
  last_processed_registration_revision, changed_at
) values
  (
    '23300000-0000-4000-8000-000000000001',
    '33300000-0000-4000-8000-000000000001',
    '63300000-0000-4000-8000-000000000101', 'available', 1,
    'sha256:' || pg_catalog.repeat('9', 64), 1, pg_catalog.clock_timestamp()
  ),
  (
    '23300000-0000-4000-8000-000000000002',
    '33300000-0000-4000-8000-000000000002',
    '63300000-0000-4000-8000-000000000102', 'available', 1,
    'sha256:' || pg_catalog.repeat('a', 64), 1, pg_catalog.clock_timestamp()
  );

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '23300000-0000-4000-8000-000000000001',
  '53300000-0000-4000-8000-000000000001',
  '63300000-0000-4000-8000-000000000001',
  'access_administration_steward', 'Access administration steward',
  'Minimum neutral authority used by the protected Group read fixture.',
  '73300000-0000-4000-8000-000000000001',
  '83300000-0000-4000-8000-000000000001',
  '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000007'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23300000-0000-4000-8000-000000000001',
  '63300000-0000-4000-8000-000000000010', null,
  'alpha_group', 'Alpha group',
  '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000010'
);
select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23300000-0000-4000-8000-000000000001',
  '63300000-0000-4000-8000-000000000020', null,
  'review_group', 'Review group',
  '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000020'
);
select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23300000-0000-4000-8000-000000000001',
  '63300000-0000-4000-8000-000000000030', null,
  'zeta_group', 'Zeta group',
  '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000030'
);

create temporary table expected_administration_page on commit drop as
select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'groupId', organization_group.group_id,
    'key', organization_group.group_key,
    'label', organization_group.label,
    'state', organization_group.state,
    'revision', organization_group.revision
  ) order by organization_group.group_id)::text
    || '|63300000-0000-4000-8000-000000000020|'
    || version.current_version::text as expected_value,
  version.current_version
from vortex_access.organization_groups as organization_group
cross join vortex_access.organization_access_versions as version
where organization_group.organization_id =
  '23300000-0000-4000-8000-000000000001'
  and organization_group.group_id <=
    '63300000-0000-4000-8000-000000000020'
  and version.organization_id = organization_group.organization_id
group by version.current_version;
grant select on pg_temp.expected_administration_page to vortex_request;

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
select lives_ok(
  $$
    select *
    from vortex_access.resolve_human_organization_change_scope(
      '43300000-0000-4000-8000-000000000001',
      '23300000-0000-4000-8000-000000000001'
    )
  $$,
  'runtime resolves the exact active change scope through the governance-first path'
);
select results_eq(
  $$
    select application_root_id, access_version
    from vortex_access.resolve_human_application_change_scope(
      '43300000-0000-4000-8000-000000000001',
      '23300000-0000-4000-8000-000000000001',
      '33300000-0000-4000-8000-000000000001'
    )
  $$,
  $$values ('33300000-0000-4000-8000-000000000001'::uuid, 6::bigint)$$,
  'runtime resolves the exact active same-organization application and Access version'
);
select throws_ok(
  $$
    select *
    from vortex_access.resolve_human_application_change_scope(
      '43300000-0000-4000-8000-000000000001',
      '23300000-0000-4000-8000-000000000001',
      '33300000-0000-4000-8000-000000000002'
    )
  $$,
  '42501'::char(5),
  'Application change selection is unavailable',
  'runtime refuses an application registered to another organization'
);
select throws_ok(
  $$
    select *
    from vortex_access.resolve_human_organization_change_scope(
      '43300000-0000-4000-8000-000000000001',
      '23300000-0000-4000-8000-000000000099'
    )
  $$,
  '42501'::char(5),
  'Organisation change selection is unavailable',
  'runtime cannot resolve a foreign organization change scope'
);
reset role;

select pg_temp.install_administration_context(
  '43300000-0000-4000-8000-000000000001',
  '53300000-0000-4000-8000-000000000001'
);
set local role vortex_request;

select is(
  (
    select groups::text || '|' || next_after_group_id::text
      || '|' || access_version::text
    from vortex_access.list_organization_groups_for_administration(null, 2)
  ),
  (
    select expected_value from pg_temp.expected_administration_page
  ),
  'authorized request receives one bounded stable-ID Group page and cursor'
);

select is(
  (
    select groups::text || '|' || coalesce(next_after_group_id::text, 'none')
    from vortex_access.list_organization_groups_for_administration(
      '63300000-0000-4000-8000-000000000020', 2
    )
  ),
  '[{"key": "zeta_group", "label": "Zeta group", "state": "active", "groupId": "63300000-0000-4000-8000-000000000030", "revision": 1}]|none',
  'the next page resumes strictly after the returned cursor'
);

select is(
  (
    select outcome || '|' || (group_summary ->> 'groupId')
      || '|' || (group_summary ->> 'label') || '|' || access_version::text
    from vortex_access.read_organization_group_for_administration(
      '63300000-0000-4000-8000-000000000020'
    )
  ),
  (
    select 'available|63300000-0000-4000-8000-000000000020|Review group|'
      || current_version::text
    from pg_temp.expected_administration_page
  ),
  'authorized request reads one exact safe Group detail'
);

select is(
  (
    select pg_catalog.array_agg(key order by key)
    from vortex_access.read_organization_group_for_administration(
      '63300000-0000-4000-8000-000000000020'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.group_summary) as key
  ),
  array['groupId', 'key', 'label', 'revision', 'state'],
  'the protected detail omits actor, correlation and other private fact evidence'
);

select is(
  (
    select outcome || '|' || case when group_summary is null then 'missing' else 'present' end
    from vortex_access.read_organization_group_for_administration(
      '63300000-0000-4000-8000-000000000099'
    )
  ),
  'unavailable|missing',
  'unknown and foreign Group identity is safely unavailable'
);

select throws_ok(
  $$
    select *
    from vortex_access.list_organization_groups_for_administration(null, 101)
  $$,
  '22023'::char(5),
  'Organization Group page input is invalid',
  'the request role cannot ask for an unbounded Group page'
);
reset role;

select pg_temp.install_administration_context(
  '43300000-0000-4000-8000-000000000002',
  '53300000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_groups_for_administration(null, 25)
  $$,
  '42501'::char(5),
  'Organization Group administration is unavailable',
  'an active account without teams-read authority cannot list Groups'
);
reset role;

select pg_temp.install_administration_context(
  '43300000-0000-4000-8000-000000000001',
  '53300000-0000-4000-8000-000000000001'
);
select * from vortex_access.coordinate_organization_group_change(
  'revise_group_label', '23300000-0000-4000-8000-000000000001',
  '63300000-0000-4000-8000-000000000020', 1, null,
  'Review group revised', '93300000-0000-4000-8000-000000000001',
  'a3300000-0000-4000-8000-000000000040'
);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.read_organization_group_for_administration(
      '63300000-0000-4000-8000-000000000020'
    )
  $$,
  '42501'::char(5),
  'Request access version is stale or unavailable',
  'a stale protected context cannot read after an Access change'
);
reset role;

select lives_ok(
  $$
    select *
    from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '23300000-0000-4000-8000-000000000001',
      '33300000-0000-4000-8000-000000000001',
      '93300000-0000-4000-8000-000000000001',
      'a3300000-0000-4000-8000-000000000052'
    )
  $$,
  'the real application writer withdraws the selected application'
);
set local role vortex_runtime;
select throws_ok(
  $$
    select *
    from vortex_access.resolve_human_application_change_scope(
      '43300000-0000-4000-8000-000000000001',
      '23300000-0000-4000-8000-000000000001',
      '33300000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5),
  'Application change selection is unavailable',
  'runtime refuses the exact application after its real withdrawal'
);
reset role;

set constraints all immediate;
select * from finish();
rollback;
