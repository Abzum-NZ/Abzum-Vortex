begin;
select plan(27);

set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_request;
-- The new fixtures below call pgTAP's is()/ok() while local role is
-- vortex_module_owner (needed to call the owner-private reachability
-- resolver directly), so that role also needs schema usage for pgTAP.
grant usage on schema extensions to vortex_module_owner;

create function pg_temp.initialize_reader_context(
  p_with_application boolean default true,
  p_application_root_id uuid default '34600000-0000-4000-8000-000000000001'
)
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
      'applicationRootId', p_application_root_id
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

-- Issue #45 follow-up: vortex_module.read_current_active_installation used to
-- carry four inline copies of the recursive Module dependency walk that
-- vortex_definition.reachable_module_dependency_edges now owns. Each new
-- fixture below lives under its own Application root so it cannot interact
-- with the bindings mutated above. release_dependencies_target_release_fk
-- pins dependency_version and dependency_content_fingerprint to the exact
-- target release row, so a declared-versus-actual mismatch can only be
-- constructed through dependency_reference or evidence_fingerprint, neither
-- of which carries an FK; the fixtures below use exactly those two columns.

-- Diamond: Modules D and E are both declared directly by one Application,
-- and both separately declare a dependency on the same shared Module F
-- release. D's edge to F declares F's real key; E's edge declares a
-- different (aliased) reference for the identical target release, so the
-- two edges are identical in five of six columns and differ only in
-- dependency_reference. The retired four-column walk (target_root_id,
-- target_release_revision, dependency_content_fingerprint,
-- evidence_fingerprint) collapses them to one row; the shared six-column
-- resolver keeps both.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34600000-0000-4000-8000-000000000002',
    '24600000-0000-4000-8000-000000000001', 'application',
    'vortex.bound_reader.diamond_application', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000020',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.diamond_module_d', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000021',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.diamond_module_e', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000022',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.diamond_module_f', pg_catalog.statement_timestamp(),
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
    '34600000-0000-4000-8000-000000000002', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.bound_reader.diamond_application"}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    '{"kind":"application","canonical":{"content":{},"envelope":{"rootId":"34600000-0000-4000-8000-000000000002"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64), '[]',
    'Diamond Application release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000020', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.diamond_module_d"}',
    'sha256:' || pg_catalog.repeat('1', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000020"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('1', 64), '[]',
    'Diamond Module D release; one of two paths to Module F.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000021', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.diamond_module_e"}',
    'sha256:' || pg_catalog.repeat('3', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000021"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('4', 64)),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('3', 64), '[]',
    'Diamond Module E release; the other path to Module F.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000022', 1, '5.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.diamond_module_f"}',
    'sha256:' || pg_catalog.repeat('5', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000022"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('6', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('5', 64), '[]',
    'Diamond Module F release; the shared node reached by both D and E.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values
  (
    '34600000-0000-4000-8000-000000000002', 1, 'module',
    'vortex.bound_reader.diamond_module_d', '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '44600000-0000-4000-8000-000000000020', 1, null
  ),
  (
    '34600000-0000-4000-8000-000000000002', 1, 'module',
    'vortex.bound_reader.diamond_module_e', '1.0.0',
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    '44600000-0000-4000-8000-000000000021', 1, null
  ),
  (
    '44600000-0000-4000-8000-000000000020', 1, 'module',
    'vortex.bound_reader.diamond_module_f', '5.0.0',
    'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('6', 64),
    '44600000-0000-4000-8000-000000000022', 1, null
  ),
  (
    '44600000-0000-4000-8000-000000000021', 1, 'module',
    'vortex.bound_reader.diamond_module_f_alias', '5.0.0',
    'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('6', 64),
    '44600000-0000-4000-8000-000000000022', 1, null
  );

set local role vortex_module_owner;
select is(
  (
    with recursive module_nodes as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = '34600000-0000-4000-8000-000000000002'
        and dependency.release_revision = 1
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from module_nodes as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select pg_catalog.count(*)::int from module_nodes
    where target_root_id = '44600000-0000-4000-8000-000000000022'
  ),
  1,
  'the retired four-column walk collapses both diamond edges into Module F into one row'
);
select is(
  (
    select pg_catalog.count(*)::int
    from vortex_definition.reachable_module_dependency_edges(
      '34600000-0000-4000-8000-000000000002', 1
    ) as edge
    where edge.target_root_id = '44600000-0000-4000-8000-000000000022'
  ),
  2,
  'the shared six-column resolver keeps both diamond edges into Module F distinct'
);
reset role;

set local role vortex_module_owner;
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
) values
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000002',
    '44600000-0000-4000-8000-000000000020', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000020'::uuid]
  ),
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000002',
    '44600000-0000-4000-8000-000000000021', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000021'::uuid]
  ),
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000002',
    '44600000-0000-4000-8000-000000000022', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('6', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000022'::uuid]
  );
reset role;

-- Conclusion: despite the row-count difference just proven above, the
-- binding-match exists() the fourth site depends on is identical under both
-- formulations, and both correctly report no mismatch for Module F (its
-- one real binding matches both duplicate copies of the node identically,
-- since dependency_reference is not part of that check's predicate).
set local role vortex_module_owner;
select ok(
  (
    with recursive module_nodes as (
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = '34600000-0000-4000-8000-000000000002'
        and dependency.release_revision = 1
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision,
        dependency.dependency_content_fingerprint, dependency.evidence_fingerprint
      from module_nodes as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select exists (
      select 1
      from module_nodes as node
      left join vortex_module.installation_bindings as binding
        on binding.organization_id = '24600000-0000-4000-8000-000000000001'
        and binding.application_root_id = '34600000-0000-4000-8000-000000000002'
        and binding.module_root_id = node.target_root_id
      where binding.state is distinct from 'active'
        or binding.application_release_revision is distinct from 1
        or binding.module_release_revision is distinct from node.target_release_revision
        or binding.content_fingerprint is distinct from node.dependency_content_fingerprint
        or binding.resolution_fingerprint is distinct from node.evidence_fingerprint
    )
  ) = (
    select exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        '34600000-0000-4000-8000-000000000002', 1
      ) as node
      left join vortex_module.installation_bindings as binding
        on binding.organization_id = '24600000-0000-4000-8000-000000000001'
        and binding.application_root_id = '34600000-0000-4000-8000-000000000002'
        and binding.module_root_id = node.target_root_id
      where binding.state is distinct from 'active'
        or binding.application_release_revision is distinct from 1
        or binding.module_release_revision is distinct from node.target_release_revision
        or binding.content_fingerprint is distinct from node.dependency_content_fingerprint
        or binding.resolution_fingerprint is distinct from node.evidence_fingerprint
    )
  )
  and not (
    select exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        '34600000-0000-4000-8000-000000000002', 1
      ) as node
      left join vortex_module.installation_bindings as binding
        on binding.organization_id = '24600000-0000-4000-8000-000000000001'
        and binding.application_root_id = '34600000-0000-4000-8000-000000000002'
        and binding.module_root_id = node.target_root_id
      where binding.state is distinct from 'active'
        or binding.application_release_revision is distinct from 1
        or binding.module_release_revision is distinct from node.target_release_revision
        or binding.content_fingerprint is distinct from node.dependency_content_fingerprint
        or binding.resolution_fingerprint is distinct from node.evidence_fingerprint
    )
  ),
  'the fourth site''s binding-match exists() outcome is identical under both formulations, and both correctly find no mismatch despite the row-count difference'
);
reset role;

-- End-to-end: the diamond still fails closed with the unchanged error,
-- raised here by the untouched, already-six-column first site (Module E's
-- edge aliases Module F's reference), independent of the fourth site's
-- proven-inert duplicate row.
select pg_temp.initialize_reader_context(
  p_application_root_id => '34600000-0000-4000-8000-000000000002'
);
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'the diamond''s aliased reference on Module E''s edge to F still fails closed'
);
reset role;

-- Site one still fires: Module G's stored release no longer matches the
-- evidence fingerprint its dependency edge declared. dependency_version and
-- dependency_content_fingerprint cannot drift from the target release
-- (release_dependencies_target_release_fk pins them), so the drift is
-- constructed through evidence_fingerprint, which carries no such FK.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34600000-0000-4000-8000-000000000003',
    '24600000-0000-4000-8000-000000000001', 'application',
    'vortex.bound_reader.site1_application', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000023',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.site1_module_g', pg_catalog.statement_timestamp(),
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
    '34600000-0000-4000-8000-000000000003', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.bound_reader.site1_application"}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    '{"kind":"application","canonical":{"content":{},"envelope":{"rootId":"34600000-0000-4000-8000-000000000003"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64), '[]',
    'Site-one Application release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000023', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.site1_module_g"}',
    'sha256:' || pg_catalog.repeat('7', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000023"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('8', 64)),
    'sha256:' || pg_catalog.repeat('7', 64), 'sha256:' || pg_catalog.repeat('8', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('7', 64), '[]',
    'Site-one Module G real release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values (
  '34600000-0000-4000-8000-000000000003', 1, 'module',
  'vortex.bound_reader.site1_module_g', '1.0.0',
  'sha256:' || pg_catalog.repeat('7', 64), 'sha256:' || pg_catalog.repeat('9', 64),
  '44600000-0000-4000-8000-000000000023', 1, null
);

set local role vortex_module_owner;
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
) values (
  '24600000-0000-4000-8000-000000000001',
  '34600000-0000-4000-8000-000000000003',
  '44600000-0000-4000-8000-000000000023', 1, 1, 1, 'active',
  'sha256:' || pg_catalog.repeat('7', 64), 'sha256:' || pg_catalog.repeat('9', 64),
  '1.0.0', array['64600000-0000-4000-8000-000000000023'::uuid]
);
reset role;

select pg_temp.initialize_reader_context(
  p_application_root_id => '34600000-0000-4000-8000-000000000003'
);
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'a Module release whose stored evidence fingerprint no longer matches its declared dependency edge still fails closed'
);
reset role;

-- Site two still fires: Module K is reachable at two different pinned
-- revisions (directly at revision one, and through Module H at revision
-- two). Each edge is individually consistent with its own target release,
-- so only the per-root revision-consistency check (and, structurally, the
-- fourth site, since one binding cannot match two revisions at once) flags
-- this graph.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34600000-0000-4000-8000-000000000004',
    '24600000-0000-4000-8000-000000000001', 'application',
    'vortex.bound_reader.site2_application', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000024',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.site2_module_h', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000025',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.site2_module_k', pg_catalog.statement_timestamp(),
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
    '34600000-0000-4000-8000-000000000004', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.bound_reader.site2_application"}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    '{"kind":"application","canonical":{"content":{},"envelope":{"rootId":"34600000-0000-4000-8000-000000000004"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64), '[]',
    'Site-two Application release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000024', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.site2_module_h"}',
    'sha256:' || pg_catalog.repeat('a', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000024"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)),
    'sha256:' || pg_catalog.repeat('a', 64), 'sha256:' || pg_catalog.repeat('b', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('a', 64), '[]',
    'Site-two Module H release; depends on Module K at revision two.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000025', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.site2_module_k"}',
    'sha256:' || pg_catalog.repeat('c', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000025"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('d', 64)),
    'sha256:' || pg_catalog.repeat('c', 64), 'sha256:' || pg_catalog.repeat('d', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('c', 64), '[]',
    'Site-two Module K release one; the revision the Application pins directly.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000025', 2, '2.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.site2_module_k"}',
    'sha256:' || pg_catalog.repeat('e', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000025"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('f', 64)),
    'sha256:' || pg_catalog.repeat('e', 64), 'sha256:' || pg_catalog.repeat('f', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('e', 64), '[]',
    'Site-two Module K release two; the revision Module H pins instead.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values
  (
    '34600000-0000-4000-8000-000000000004', 1, 'module',
    'vortex.bound_reader.site2_module_h', '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64), 'sha256:' || pg_catalog.repeat('b', 64),
    '44600000-0000-4000-8000-000000000024', 1, null
  ),
  (
    '34600000-0000-4000-8000-000000000004', 1, 'module',
    'vortex.bound_reader.site2_module_k', '1.0.0',
    'sha256:' || pg_catalog.repeat('c', 64), 'sha256:' || pg_catalog.repeat('d', 64),
    '44600000-0000-4000-8000-000000000025', 1, null
  ),
  (
    '44600000-0000-4000-8000-000000000024', 1, 'module',
    'vortex.bound_reader.site2_module_k', '2.0.0',
    'sha256:' || pg_catalog.repeat('e', 64), 'sha256:' || pg_catalog.repeat('f', 64),
    '44600000-0000-4000-8000-000000000025', 2, null
  );

set local role vortex_module_owner;
select is(
  (
    select pg_catalog.array_agg(flagged.target_root_id order by flagged.target_root_id)
    from (
      with recursive module_nodes as (
        select dependency.target_root_id, dependency.target_release_revision
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = '34600000-0000-4000-8000-000000000004'
          and dependency.release_revision = 1
          and dependency.dependency_kind = 'module'
        union
        select dependency.target_root_id, dependency.target_release_revision
        from module_nodes as parent
        join vortex_definition.release_dependencies as dependency
          on dependency.root_id = parent.target_root_id
          and dependency.release_revision = parent.target_release_revision
          and dependency.dependency_kind = 'module'
      )
      select target_root_id from module_nodes
      group by target_root_id
      having pg_catalog.count(distinct target_release_revision) <> 1
    ) as flagged
  ),
  (
    select pg_catalog.array_agg(flagged.target_root_id order by flagged.target_root_id)
    from (
      select edge.target_root_id
      from vortex_definition.reachable_module_dependency_edges(
        '34600000-0000-4000-8000-000000000004', 1
      ) as edge
      group by edge.target_root_id
      having pg_catalog.count(distinct edge.target_release_revision) <> 1
    ) as flagged
  ),
  'the second site''s per-root revision check flags the identical root set under both the retired two-column walk and the resolver'
);

insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
) values
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000004',
    '44600000-0000-4000-8000-000000000024', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('a', 64), 'sha256:' || pg_catalog.repeat('b', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000024'::uuid]
  ),
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000004',
    '44600000-0000-4000-8000-000000000025', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('c', 64), 'sha256:' || pg_catalog.repeat('d', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000025'::uuid]
  );
reset role;

select pg_temp.initialize_reader_context(
  p_application_root_id => '34600000-0000-4000-8000-000000000004'
);
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'Module K reachable at two different pinned revisions through two paths still fails closed'
);
reset role;

-- Site four still fires: Module L holds an active binding but the
-- dependency graph no longer reaches it at all (Module M is the
-- Application's only real dependency).
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34600000-0000-4000-8000-000000000005',
    '24600000-0000-4000-8000-000000000001', 'application',
    'vortex.bound_reader.site4_application', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000026',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.site4_module_l', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000027',
    '24600000-0000-4000-8000-000000000002', 'module',
    'vortex.bound_reader.site4_module_m', pg_catalog.statement_timestamp(),
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
    '34600000-0000-4000-8000-000000000005', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.bound_reader.site4_application"}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    '{"kind":"application","canonical":{"content":{},"envelope":{"rootId":"34600000-0000-4000-8000-000000000005"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64), '[]',
    'Site-four Application release.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000026', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.site4_module_l"}',
    'sha256:' || pg_catalog.repeat('1', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000026"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('3', 64)),
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('3', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('1', 64), '[]',
    'Site-four Module L release; never declared by the Application.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  ),
  (
    '44600000-0000-4000-8000-000000000027', 1, '1.0.0',
    '{"source_contract_version":"2.0.0","kind":"module","key":"vortex.bound_reader.site4_module_m"}',
    'sha256:' || pg_catalog.repeat('2', 64), '2.0.0',
    '{"kind":"module","canonical":{"content":{},"envelope":{"rootId":"44600000-0000-4000-8000-000000000027"}}}',
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('4', 64)),
    'sha256:' || pg_catalog.repeat('2', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    '2.0.0', 'sha256:' || pg_catalog.repeat('2', 64), '[]',
    'Site-four Module M release; the Application''s one real dependency.', pg_catalog.statement_timestamp(),
    '94600000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values (
  '34600000-0000-4000-8000-000000000005', 1, 'module',
  'vortex.bound_reader.site4_module_m', '1.0.0',
  'sha256:' || pg_catalog.repeat('2', 64), 'sha256:' || pg_catalog.repeat('4', 64),
  '44600000-0000-4000-8000-000000000027', 1, null
);

set local role vortex_module_owner;
select is(
  (
    with recursive module_nodes as (
      select dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = '34600000-0000-4000-8000-000000000005'
        and dependency.release_revision = 1
        and dependency.dependency_kind = 'module'
      union
      select dependency.target_root_id, dependency.target_release_revision
      from module_nodes as parent
      join vortex_definition.release_dependencies as dependency
        on dependency.root_id = parent.target_root_id
        and dependency.release_revision = parent.target_release_revision
        and dependency.dependency_kind = 'module'
    )
    select not exists (
      select 1 from module_nodes as node
      where node.target_root_id = '44600000-0000-4000-8000-000000000026'
        and node.target_release_revision = 1
    )
  ),
  (
    select not exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        '34600000-0000-4000-8000-000000000005', 1
      ) as node
      where node.target_root_id = '44600000-0000-4000-8000-000000000026'
        and node.target_release_revision = 1
    )
  ),
  'the orphaned Module L binding is unreachable under both the retired two-column walk and the resolver'
);

insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
) values
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000005',
    '44600000-0000-4000-8000-000000000027', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('2', 64), 'sha256:' || pg_catalog.repeat('4', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000027'::uuid]
  ),
  (
    '24600000-0000-4000-8000-000000000001',
    '34600000-0000-4000-8000-000000000005',
    '44600000-0000-4000-8000-000000000026', 1, 1, 1, 'active',
    'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('3', 64),
    '1.0.0', array['64600000-0000-4000-8000-000000000026'::uuid]
  );
reset role;

select pg_temp.initialize_reader_context(
  p_application_root_id => '34600000-0000-4000-8000-000000000005'
);
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'an active Module binding the dependency graph no longer reaches still fails closed'
);
reset role;

select * from finish();
rollback;
