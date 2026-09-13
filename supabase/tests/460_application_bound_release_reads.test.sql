\ir helpers/definition-release-writer.psql

begin;
select plan(18);

set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_request;

create function pg_temp.initialize_reader_context(p_with_application boolean default true)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  request_context jsonb;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  request_context := pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '94600000-0000-4000-8000-000000000001',
    'tenantId', '14600000-0000-4000-8000-000000000001',
    'organizationId', '24600000-0000-4000-8000-000000000001',
    'organizationAccountId', '54600000-0000-4000-8000-000000000001',
    'identityId', '44600000-0000-4000-8000-000000000001',
    'sessionId', '64600000-0000-4000-8000-000000000001',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', 1,
    'correlationId', 'a4600000-0000-4000-8000-000000000001',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  );
  if p_with_application then
    request_context := request_context || pg_catalog.jsonb_build_object(
      'applicationRootId', '34600000-0000-4000-8000-000000000001'
    );
  end if;
  perform vortex_context.initialize(request_context);
end
$function$;

select has_function(
  'vortex_definition', 'read_application_bound_release_set', array['bigint'],
  'Definition exposes one revision-only bound release-set reader'
);
select has_function(
  'vortex_module', 'read_current_active_installation', array[]::text[],
  'Module exposes one no-input active installation reader'
);
select is(
  pg_catalog.pg_get_function_identity_arguments(
    'vortex_module.read_current_active_installation()'::regprocedure
  ), '',
  'active discovery accepts no caller-selected scope'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_definition.read_application_bound_release_set(bigint)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.project_consumer_release_evidence(text,uuid,bigint)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'public', 'vortex_definition.read_application_bound_release_set(bigint)', 'EXECUTE'
  ),
  'the exact projector stays owner-private behind the fixed Definition reader'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'public', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  ),
  'only the restricted request boundary invokes active installation discovery'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14600000-0000-4000-8000-000000000001', 'bound_reader_tenant',
  'Bound reader tenant', 'active', pg_catalog.statement_timestamp(),
  '94600000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '24600000-0000-4000-8000-000000000001',
  '14600000-0000-4000-8000-000000000001', null, 'bound_reader_local',
  'Bound reader local', 'active', pg_catalog.statement_timestamp(),
  '94600000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '44600000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '94600000-0000-4000-8000-000000000001',
  'a4600000-0000-4000-8000-000000000002', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '54600000-0000-4000-8000-000000000001',
  '24600000-0000-4000-8000-000000000001',
  '44600000-0000-4000-8000-000000000001', 'Bound reader member', 'active',
  pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '94600000-0000-4000-8000-000000000001',
  'a4600000-0000-4000-8000-000000000003', 1
);
select * from vortex_access.initialize_organization_access_version(
  '24600000-0000-4000-8000-000000000001',
  '94600000-0000-4000-8000-000000000001',
  'a4600000-0000-4000-8000-000000000004'
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34600000-0000-4000-8000-000000000001',
    '24600000-0000-4000-8000-000000000001', 'application',
    'vortex.bound_reader.application', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000010',
    '24600000-0000-4000-8000-000000000001', 'module',
    'vortex.bound_reader.direct_module', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000011',
    '24600000-0000-4000-8000-000000000001', 'module',
    'vortex.bound_reader.transitive_module', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000012',
    '24600000-0000-4000-8000-000000000001', 'module',
    'vortex.bound_reader.unrelated_module', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

-- Every release is published through the writer, in the Application's own
-- organisation. Application@1 declares only the direct Module, which declares
-- the transitive Module, so the transitive Module is reached only through
-- another Module. Application@2 declares the transitive Module; it is the
-- other Application revision the mixed-revision case below needs.
select pg_temp.append_writer_release(
  '44600000-0000-4000-8000-000000000011', '2.1.0', '[]', '{}', '2.0.0'
);
select pg_temp.append_writer_release(
  '44600000-0000-4000-8000-000000000010', '2.0.0',
  '[["44600000-0000-4000-8000-000000000011", 1]]', '{}', '2.0.0'
);
select pg_temp.append_writer_release(
  '44600000-0000-4000-8000-000000000012', '2.2.0', '[]', '{}', '2.0.0'
);
select pg_temp.append_writer_release(
  '34600000-0000-4000-8000-000000000001', '1.0.0',
  '[["44600000-0000-4000-8000-000000000010", 1]]'
);
select pg_temp.append_writer_release(
  '34600000-0000-4000-8000-000000000001', '1.1.0',
  '[["44600000-0000-4000-8000-000000000011", 1]]'
);

set local role vortex_module_owner;
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
)
select '24600000-0000-4000-8000-000000000001', '34600000-0000-4000-8000-000000000001',
  release.root_id, fixture.binding_revision, fixture.application_release_revision,
  release.release_revision, fixture.state, release.content_fingerprint,
  release.resolution_fingerprint, '1.0.0', array[fixture.storage_contract_id]
from (values
  (
    '44600000-0000-4000-8000-000000000010'::uuid, 3::bigint, 1::bigint, 'active',
    '64600000-0000-4000-8000-000000000010'::uuid
  ),
  (
    '44600000-0000-4000-8000-000000000011'::uuid, 2::bigint, 1::bigint, 'active',
    '64600000-0000-4000-8000-000000000011'::uuid
  ),
  (
    '44600000-0000-4000-8000-000000000012'::uuid, 1::bigint, 2::bigint, 'detached',
    '64600000-0000-4000-8000-000000000012'::uuid
  )
) as fixture(
  module_root_id, binding_revision, application_release_revision, state, storage_contract_id
)
join vortex_definition.releases as release
  on release.root_id = fixture.module_root_id
  and release.release_revision = 1;
reset role;

select pg_temp.initialize_reader_context();
set local role vortex_request;
select is(
  vortex_module.read_current_active_installation() ->> 'applicationReleaseRevision', '1',
  'active discovery selects one exact Application release'
);
select is(
  pg_catalog.jsonb_array_length(
    vortex_module.read_current_active_installation() -> 'moduleBindings'
  ), 2,
  'active discovery returns the complete direct and transitive Module binding closure'
);
select is(
  vortex_definition.read_application_bound_release_set(1)
    #>> '{application,rootId}',
  '34600000-0000-4000-8000-000000000001',
  'Definition derives the local Application root from trusted context'
);
select is(
  vortex_definition.read_application_bound_release_set(1)
    #>> '{modules,0,rootId}',
  '44600000-0000-4000-8000-000000000010',
  'the exact Module the Application release declares is included'
);
select is(
  vortex_definition.read_application_bound_release_set(1)
    #>> '{modules,1,rootId}',
  '44600000-0000-4000-8000-000000000011',
  'the exact Module reached only through another Module is included'
);
select ok(
  not (
    vortex_definition.read_application_bound_release_set(1) -> 'modules'
  ) @> '[{"rootId":"44600000-0000-4000-8000-000000000012"}]'::jsonb,
  'an unrelated Module root is not included'
);
select ok(
  not (
    vortex_module.read_current_active_installation() -> 'moduleBindings'
  ) @> '[{"moduleRootId":"44600000-0000-4000-8000-000000000012"}]'::jsonb,
  'detached unrelated binding history is ignored'
);
select throws_ok(
  $$select vortex_definition.read_application_bound_release_set(3)$$::text,
  'P0002'::char(5), 'Exact bound Application release is unavailable'::text,
  'an unavailable Application revision fails closed'
);
reset role;

select pg_temp.initialize_reader_context(false);
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '22023'::char(5), 'Active Application context is required'::text,
  'Module discovery refuses organization-only context'
);
select throws_ok(
  $$select vortex_definition.read_application_bound_release_set(1)$$::text,
  '22023'::char(5), 'Application release-set context is invalid'::text,
  'Definition bound reads refuse organization-only context'
);
reset role;

set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'provisioned'
where organization_id = '24600000-0000-4000-8000-000000000001'
  and application_root_id = '34600000-0000-4000-8000-000000000001'
  and module_root_id = '44600000-0000-4000-8000-000000000011';
reset role;
select pg_temp.initialize_reader_context();
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'a partial required active set fails closed'
);
reset role;

set local role vortex_module_owner;
update vortex_module.installation_bindings
set application_release_revision = 2, state = 'active'
where module_root_id = '44600000-0000-4000-8000-000000000011';
reset role;
select pg_temp.initialize_reader_context();
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application installation is mixed'::text,
  'mixed active Application revisions fail closed'
);
select throws_ok(
  $$select * from vortex_module.installation_bindings$$::text,
  '42501'::char(5), null,
  'request callers cannot read raw binding rows'
);

reset role;
select * from finish();
rollback;
