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
  perform pg_catalog.set_config('vortex.request_context', '', true);
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
) values
  (
    '24600000-0000-4000-8000-000000000001',
    '14600000-0000-4000-8000-000000000001', null, 'bound_reader_local',
    'Bound reader local', 'active', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '24600000-0000-4000-8000-000000000002',
    '14600000-0000-4000-8000-000000000001', null, 'bound_reader_foreign',
    'Bound reader foreign', 'active', pg_catalog.statement_timestamp(),
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
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.foreign_module', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000011',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.transitive_module', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000012',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.unrelated_module', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '34600000-0000-4000-8000-000000000001', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.bound_reader.application"}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    '{"kind":"application","canonical":{"content":{},"envelope":{"rootId":"34600000-0000-4000-8000-000000000001"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('4', 64), '[]',
    'Bound reader Application release one.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '34600000-0000-4000-8000-000000000001', 2, '1.1.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.bound_reader.application"}',
    'sha256:' || pg_catalog.repeat('5', 64), '1.0.0',
    '{"kind":"application","canonical":{"content":{},"envelope":{"rootId":"34600000-0000-4000-8000-000000000001"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('7', 64), 'sha256:' || pg_catalog.repeat('6', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('8', 64), '[]',
    'Bound reader Application release two.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000010', 4, '2.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.foreign_module"}',
    'sha256:' || pg_catalog.repeat('9', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000010"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('a', 64)),
    'sha256:' || pg_catalog.repeat('b', 64), 'sha256:' || pg_catalog.repeat('a', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('c', 64), '[]',
    'Foreign exact Module release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000011', 5, '2.1.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.transitive_module"}',
    'sha256:' || pg_catalog.repeat('d', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000011"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('e', 64)),
    'sha256:' || pg_catalog.repeat('f', 64), 'sha256:' || pg_catalog.repeat('e', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('0', 64), '[]',
    'Transitive exact Module release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000012', 6, '2.2.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.unrelated_module"}',
    'sha256:' || pg_catalog.repeat('1', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000012"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('4', 64), '[]',
    'Unrelated exact Module release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values
  (
    '34600000-0000-4000-8000-000000000001', 1, 'module',
    'vortex.bound_reader.foreign_module', '2.0.0',
    'sha256:' || pg_catalog.repeat('b', 64), 'sha256:' || pg_catalog.repeat('a', 64),
    '44600000-0000-4000-8000-000000000010', 4, null
  ),
  (
    '34600000-0000-4000-8000-000000000001', 2, 'module',
    'vortex.bound_reader.transitive_module', '2.1.0',
    'sha256:' || pg_catalog.repeat('f', 64), 'sha256:' || pg_catalog.repeat('e', 64),
    '44600000-0000-4000-8000-000000000011', 5, null
  ),
  (
    '44600000-0000-4000-8000-000000000010', 4, 'module',
    'vortex.bound_reader.transitive_module', '2.1.0',
    'sha256:' || pg_catalog.repeat('f', 64), 'sha256:' || pg_catalog.repeat('e', 64),
    '44600000-0000-4000-8000-000000000011', 5, null
  );

set local role vortex_module_owner;
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
) values
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000001',
    '44600000-0000-4000-8000-000000000010', 3, 1, 4, 'active',
    'sha256:' || pg_catalog.repeat('b', 64), 'sha256:' || pg_catalog.repeat('a', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000010'::uuid]
  ),
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000001',
    '44600000-0000-4000-8000-000000000011', 2, 1, 5, 'active',
    'sha256:' || pg_catalog.repeat('f', 64), 'sha256:' || pg_catalog.repeat('e', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000011'::uuid]
  ),
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000001',
    '44600000-0000-4000-8000-000000000012', 1, 2, 6, 'detached',
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000012'::uuid]
  );
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
  'an exact foreign-owned Module is readable only through the local Application dependency'
);
select is(
  vortex_definition.read_application_bound_release_set(1)
    #>> '{modules,1,rootId}',
  '44600000-0000-4000-8000-000000000011',
  'the exact foreign-owned transitive Module dependency is included'
);
select ok(
  not (
    vortex_definition.read_application_bound_release_set(1) -> 'modules'
  ) @> '[{"rootId":"44600000-0000-4000-8000-000000000012"}]'::jsonb,
  'an unrelated foreign Module root is not included'
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
