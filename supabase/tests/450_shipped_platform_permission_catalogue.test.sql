\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

create function pg_temp.install_catalogue_request_context()
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
  where version.organization_id = '21000000-0000-4000-8000-000000000450';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '91000000-0000-4000-8000-000000000451',
    'tenantId', '11000000-0000-4000-8000-000000000450',
    'organizationId', '21000000-0000-4000-8000-000000000450',
    'organizationAccountId', '51000000-0000-4000-8000-000000000450',
    'identityId', '41000000-0000-4000-8000-000000000450',
    'sessionId', '61000000-0000-4000-8000-000000000451',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', '71000000-0000-4000-8000-000000000460',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  ));
end
$function$;

select has_function(
  'vortex_access', 'adopt_shipped_platform_permission_catalogue',
  array['uuid', 'bigint', 'text', 'text', 'uuid', 'uuid'],
  'Access owns one generic selector for compiled-in platform catalogue successors'
);
select ok(
  (
    select prosecdef and proconfig @> array['search_path=""']
    from pg_catalog.pg_proc
    where oid = 'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)'::regprocedure
  ),
  'catalogue adoption is a security-definer operation with an empty search path'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.adopt_shipped_platform_permission_catalogue(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  ),
  'no browser, runtime or request role can select or author a shipped catalogue'
);
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000450', 'shipped_catalogue_tenant',
  'Shipped catalogue tenant', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000450', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '21000000-0000-4000-8000-000000000450',
  '11000000-0000-4000-8000-000000000450', null, 'shipped_catalogue_org',
  'Shipped catalogue organisation', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000450', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '41000000-0000-4000-8000-000000000450', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000456', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '51000000-0000-4000-8000-000000000450',
  '21000000-0000-4000-8000-000000000450',
  '41000000-0000-4000-8000-000000000450', 'Catalogue steward', 'active',
  pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000457', 1
);

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000450',
  '91000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000450'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21000000-0000-4000-8000-000000000450',
  '91000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000451'
);
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  '21000000-0000-4000-8000-000000000450', 1, '1.0.0', '1.0.1',
  '91000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000452'
);

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '21000000-0000-4000-8000-000000000450',
  '51000000-0000-4000-8000-000000000450',
  '61000000-0000-4000-8000-000000000450',
  'catalogue_steward', 'Catalogue steward',
  'Permanent organisation catalogue stewardship.',
  '71000000-0000-4000-8000-000000000458',
  '81000000-0000-4000-8000-000000000450',
  '41000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000459'
);
select ok(
  vortex_access.organization_has_permanent_steward(
    '21000000-0000-4000-8000-000000000450', pg_catalog.clock_timestamp()
  ),
  'the original thirteen authorities form a real permanent steward before adoption'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000450'
      and registration_kind = 'platform'
      and state = 'available'
      and continuity_revision = 1
      and last_processed_registration_revision = 2
  ),
  13,
  'the adopted steward starts from thirteen exact revision-two continuities'
);
grant usage on schema extensions to vortex_request;
select pg_temp.install_catalogue_request_context();
set local role vortex_request;
select is(
  (
    select outcome
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.permissions.read',
        'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    )
  ),
  'eligible',
  'the steward can use an original platform permission before adoption'
);
reset role;

create temporary table steward_authority_before on commit drop as
select pg_catalog.jsonb_build_object(
  'rolePermissions', (
    select pg_catalog.jsonb_agg(to_jsonb(permission) order by permission.entry_ordinal)
    from vortex_access.organization_role_permission_entries as permission
    where permission.organization_id = '21000000-0000-4000-8000-000000000450'
      and permission.role_id = '61000000-0000-4000-8000-000000000450'
  ),
  'assignment', (
    select to_jsonb(assignment)
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = '21000000-0000-4000-8000-000000000450'
      and assignment.role_assignment_id = '71000000-0000-4000-8000-000000000458'
  ),
  'delegation', (
    select to_jsonb(delegation)
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = '21000000-0000-4000-8000-000000000450'
      and delegation.delegation_authority_id = '81000000-0000-4000-8000-000000000450'
  )
) as evidence;

create temporary table adopted_catalogue on commit drop as
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  '21000000-0000-4000-8000-000000000450', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  '91000000-0000-4000-8000-000000000450',
  '71000000-0000-4000-8000-000000000453'
);
select is((select source_catalogue_version from adopted_catalogue), '1.0.1',
  'the adopter retains its exact shipped source version');
select is((select target_catalogue_version from adopted_catalogue), '1.1.0',
  'the adopter records its exact shipped target version');
select is((select registration_revision from adopted_catalogue), 3::bigint,
  'the additive catalogue is immutable revision three');
select ok(
  vortex_access.platform_permission_catalogue_revision_is_exact(
    '21000000-0000-4000-8000-000000000450', 3
  ),
  'the stored revision matches every compiled-in 1.1.0 byte'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000450'
      and registration_kind = 'platform'
      and registration_revision = 3
  ),
  14,
  'the additive catalogue has thirteen historical entries plus one lifecycle authority'
);
select ok(
  vortex_access.organization_has_permanent_steward(
    '21000000-0000-4000-8000-000000000450', pg_catalog.clock_timestamp()
  ),
  'catalogue adoption preserves the real permanent steward'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000450'
      and registration_kind = 'platform'
      and state = 'available'
      and continuity_revision = 1
      and last_processed_registration_revision = 3
  ),
  14,
  'unchanged authorities retain continuity while all current permissions advance to revision three'
);
select is(
  (
    select pg_catalog.concat_ws(
      ':', state, continuity_revision, last_processed_registration_revision
    )
    from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000450'
      and permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba'
  ),
  'available:1:3',
  'the additive permission is registered as available continuity without inheriting a grant'
);
select is(
  pg_catalog.jsonb_build_object(
    'rolePermissions', (
      select pg_catalog.jsonb_agg(to_jsonb(permission) order by permission.entry_ordinal)
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = '21000000-0000-4000-8000-000000000450'
        and permission.role_id = '61000000-0000-4000-8000-000000000450'
    ),
    'assignment', (
      select to_jsonb(assignment)
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = '21000000-0000-4000-8000-000000000450'
        and assignment.role_assignment_id = '71000000-0000-4000-8000-000000000458'
    ),
    'delegation', (
      select to_jsonb(delegation)
      from vortex_access.organization_delegation_authorities as delegation
      where delegation.organization_id = '21000000-0000-4000-8000-000000000450'
        and delegation.delegation_authority_id = '81000000-0000-4000-8000-000000000450'
    )
  ),
  (select evidence from steward_authority_before),
  'catalogue adoption does not rewrite existing role use or organisation-catalogue delegation'
);
select pg_temp.install_catalogue_request_context();
set local role vortex_request;
select is(
  (
    select outcome
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.permissions.read',
        'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform',
          'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    )
  ),
  'eligible',
  'the steward retains use of an original platform permission after adoption'
);
reset role;
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_permission_entries
    where organization_id = '21000000-0000-4000-8000-000000000450'
      and permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba'
  ),
  0,
  'catalogue adoption creates no role grant for the new lifecycle authority'
);
select is(
  (
    select access_version
    from vortex_access.adopt_shipped_platform_permission_catalogue(
      '21000000-0000-4000-8000-000000000450', 2, '1.1.0',
      'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
      '91000000-0000-4000-8000-000000000450',
      '71000000-0000-4000-8000-000000000454'
    )
  ),
  (select access_version from adopted_catalogue),
  'an exact replay reuses revision three without incrementing Access'
);
select throws_ok(
  $$select * from vortex_access.adopt_shipped_platform_permission_catalogue(
    '21000000-0000-4000-8000-000000000450', 2, '1.1.0',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '91000000-0000-4000-8000-000000000450',
    '71000000-0000-4000-8000-000000000455')$$,
  '22023', 'Shipped platform catalogue adoption input is invalid',
  'unknown fingerprints cannot select or author a catalogue'
);

select * from finish();

rollback;
