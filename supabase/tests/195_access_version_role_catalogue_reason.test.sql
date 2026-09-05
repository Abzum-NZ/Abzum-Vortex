begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select is(
  (
    select pg_catalog.pg_get_constraintdef(constraint_row.oid)
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid =
      'vortex_access.organization_access_versions'::regclass
      and constraint_row.conname = 'organization_access_versions_reason_valid'
  ),
  'CHECK ((change_reason = ANY (ARRAY[''organization_initialized''::text, ''organization_account_activated''::text, ''organization_account_reactivated''::text, ''organization_account_suspended''::text, ''organization_account_closed''::text, ''role_assignment_changed''::text, ''role_catalogue_changed''::text, ''team_membership_changed''::text, ''application_access_changed''::text, ''direct_share_changed''::text, ''access_grant_changed''::text, ''public_policy_changed''::text, ''federation_mirror_changed''::text, ''mcp_authorization_changed''::text])))',
  'the exact stored V1 reason allowlist adds only the role catalogue reason'
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
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.increment_organization_access_version(uuid,uuid,uuid,text)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', true,
    'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the existing increment keeps its owner, execution mode, volatility and empty search path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.increment_organization_access_version(uuid,uuid,uuid,text)',
    'EXECUTE'
  ),
  caller.role_name || ' receives no generic Access-version increment authority'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11950000-0000-4000-8000-000000000001',
  'role_reason_tenant', 'Role reason tenant', 'active',
  pg_catalog.statement_timestamp(), '91950000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '21950000-0000-4000-8000-000000000001',
  '11950000-0000-4000-8000-000000000001', null,
  'role_reason_org', 'Role reason organisation', 'active',
  pg_catalog.statement_timestamp(), '91950000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '21950000-0000-4000-8000-000000000001',
  '91950000-0000-4000-8000-000000000001',
  '71950000-0000-4000-8000-000000000001'
);

create temporary table role_catalogue_increment on commit drop as
select * from vortex_access.increment_organization_access_version(
  '21950000-0000-4000-8000-000000000001',
  '91950000-0000-4000-8000-000000000002',
  '71950000-0000-4000-8000-000000000002',
  'role_catalogue_changed'
);

select is(
  (
    select pg_catalog.to_jsonb(increment_row.*) - 'changed_at'
    from role_catalogue_increment as increment_row
  ),
  pg_catalog.jsonb_build_object(
    'organization_id', '21950000-0000-4000-8000-000000000001'::uuid,
    'current_version', 2,
    'changed_by', '91950000-0000-4000-8000-000000000002'::uuid,
    'change_correlation_id', '71950000-0000-4000-8000-000000000002'::uuid,
    'change_reason', 'role_catalogue_changed'
  ),
  'the new reason increments once and returns exact trusted change evidence'
);

create temporary table legacy_membership_increment on commit drop as
select * from vortex_access.increment_organization_access_version(
  '21950000-0000-4000-8000-000000000001',
  '91950000-0000-4000-8000-000000000003',
  '71950000-0000-4000-8000-000000000003',
  'team_membership_changed'
);

select is(
  (
    select pg_catalog.to_jsonb(increment_row.*) - 'changed_at'
    from legacy_membership_increment as increment_row
  ),
  pg_catalog.jsonb_build_object(
    'organization_id', '21950000-0000-4000-8000-000000000001'::uuid,
    'current_version', 3,
    'changed_by', '91950000-0000-4000-8000-000000000003'::uuid,
    'change_correlation_id', '71950000-0000-4000-8000-000000000003'::uuid,
    'change_reason', 'team_membership_changed'
  ),
  'the immutable V1 Team membership reason remains accepted without translation'
);

select throws_ok(
  $$
    select * from vortex_access.increment_organization_access_version(
      '21950000-0000-4000-8000-000000000001',
      '91950000-0000-4000-8000-000000000004',
      '71950000-0000-4000-8000-000000000004',
      'group_membership_changed'
    )
  $$,
  '22023'::char(5),
  null,
  'the V1 storage writer does not broadly accept the current Group spelling'
);

select throws_ok(
  $$
    select * from vortex_access.increment_organization_access_version(
      '21950000-0000-4000-8000-000000000001',
      '91950000-0000-4000-8000-000000000004',
      '71950000-0000-4000-8000-000000000004',
      'organization_initialized'
    )
  $$,
  '22023'::char(5),
  null,
  'the generic increment still cannot falsify initialization'
);

select is(
  (
    select pg_catalog.to_jsonb(version_row.*) - 'changed_at'
    from vortex_access.organization_access_versions as version_row
    where version_row.organization_id =
      '21950000-0000-4000-8000-000000000001'
  ),
  pg_catalog.jsonb_build_object(
    'organization_id', '21950000-0000-4000-8000-000000000001'::uuid,
    'current_version', 3,
    'changed_by', '91950000-0000-4000-8000-000000000003'::uuid,
    'change_correlation_id', '71950000-0000-4000-8000-000000000003'::uuid,
    'change_reason', 'team_membership_changed'
  ),
  'refused reasons preserve the last complete Access-version change'
);

select * from finish();

rollback;
