\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_definition',
  'postgres',
  false,
  true
);

select has_table('vortex_definition', 'releases', 'immutable Definition release storage exists');
select has_table(
  'vortex_definition',
  'release_dependencies',
  'exact immutable Definition dependency storage exists'
);
select columns_are(
  'vortex_definition',
  'releases',
  array[
    'root_id', 'release_revision', 'release_version', 'authored_source',
    'authored_source_fingerprint', 'source_contract_version', 'canonical_content',
    'content_fingerprint', 'resolution_fingerprint', 'validation_contract_version',
    'comparison_fingerprint', 'impact_reasons', 'release_note', 'published_at',
    'published_by'
  ],
  'release rows contain immutable source, canonical, validation and publication evidence'
);
select columns_are(
  'vortex_definition',
  'release_dependencies',
  array[
    'root_id', 'release_revision', 'dependency_kind', 'dependency_reference',
    'dependency_version', 'dependency_content_fingerprint', 'evidence_fingerprint',
    'target_root_id', 'target_release_revision', 'catalogue_item_id'
  ],
  'dependency rows bind one release to an exact module release or catalogue item'
);
select col_type_is(
  'vortex_definition',
  'roots',
  'current_release_revision',
  'bigint',
  'root current-release pointers use exact integer storage'
);
select col_type_is(
  'vortex_definition',
  'releases',
  'release_revision',
  'bigint',
  'published draft revisions use exact integer storage'
);
select col_type_is(
  'vortex_definition',
  'releases',
  'authored_source',
  'jsonb',
  'immutable authored source uses jsonb'
);
select col_type_is(
  'vortex_definition',
  'releases',
  'canonical_content',
  'jsonb',
  'immutable canonical content uses jsonb'
);
select has_pk('vortex_definition', 'releases', 'one release is identified by its root and draft revision');
select has_pk(
  'vortex_definition',
  'release_dependencies',
  'one release dependency is identified by its kind and key'
);
select has_fk('vortex_definition', 'releases', 'releases belong to permanent roots');
select has_fk(
  'vortex_definition',
  'release_dependencies',
  'dependency rows belong to one immutable release'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.roots'::regclass
      and conname = 'roots_current_release_fk'
      and pg_catalog.pg_get_constraintdef(oid) =
        'FOREIGN KEY (root_id, current_release_revision) REFERENCES vortex_definition.releases(root_id, release_revision)'
  ),
  'a current-release pointer can reference only a release of the same root'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.release_dependencies'::regclass
      and conname = 'release_dependencies_target_release_fk'
      and pg_catalog.pg_get_constraintdef(oid) =
        'FOREIGN KEY (target_root_id, target_release_revision, dependency_version, dependency_content_fingerprint) REFERENCES vortex_definition.releases(root_id, release_revision, release_version, content_fingerprint)'
  ),
  'a module dependency binds one exact target release and its immutable content'
);
select has_index(
  'vortex_definition',
  'release_dependencies',
  'release_dependencies_target_release_idx',
  'module dependency reverse lookups use an index'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.releases'::regclass
      and conname = 'releases_root_version_unique'
      and pg_catalog.pg_get_constraintdef(oid) = 'UNIQUE (root_id, release_version)'
  ),
  'two revisions of one root cannot reuse a release version'
);
select has_check(
  'vortex_definition',
  'releases',
  'release storage has named shape, version, fingerprint and publication checks'
);
select has_check(
  'vortex_definition',
  'release_dependencies',
  'dependency storage has named kind, exact-version and target-shape checks'
);

select is(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'vortex_definition.releases'::regclass),
  true,
  'release storage enables row security'
);
select is(
  (select relforcerowsecurity from pg_catalog.pg_class where oid = 'vortex_definition.releases'::regclass),
  true,
  'release storage forces row security'
);
select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_definition.release_dependencies'::regclass
  ),
  true,
  'dependency storage enables row security'
);
select is(
  (
    select relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_definition.release_dependencies'::regclass
  ),
  true,
  'dependency storage forces row security'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'vortex_definition'
      and tablename in ('releases', 'release_dependencies')
  ),
  0,
  'private immutable release storage has no direct row policies'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request',
    'vortex_definition.releases',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'request code has no direct release-table access'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request',
    'vortex_definition.release_dependencies',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'request code has no direct release-dependency-table access'
);
select ok(
  not pg_catalog.has_table_privilege(
    'service_role',
    'vortex_definition.releases',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'the Supabase service role cannot bypass immutable release storage'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.refuse_release_mutation()',
    'EXECUTE'
  ),
  'request code cannot invoke the internal immutable-release trigger helper'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.validate_release_insert()',
    'EXECUTE'
  ),
  'request code cannot invoke the internal release validation helper'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  '10000000-0000-4000-8000-000000000050',
  'release_store_tenant',
  'Release store tenant',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000050',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '20000000-0000-4000-8000-000000000050',
  '10000000-0000-4000-8000-000000000050',
  null,
  'release_store_org',
  'Release store organisation',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000050',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '30000000-0000-4000-8000-000000000050',
    '20000000-0000-4000-8000-000000000050',
    'module',
    'vortex.release_owner',
    pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000050'
  ),
  (
    '30000000-0000-4000-8000-000000000051',
    '20000000-0000-4000-8000-000000000050',
    'module',
    'vortex.release_target',
    pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000050'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, canonical_content,
  content_fingerprint, resolution_fingerprint, validation_contract_version,
  comparison_fingerprint, impact_reasons, release_note, published_at, published_by
) values (
  '30000000-0000-4000-8000-000000000051',
  1,
  '1.0.0',
  '{"source_contract_version":"1.0.0","kind":"module","key":"vortex.release_target"}'::jsonb,
  'sha256:' || pg_catalog.repeat('a', 64),
  '1.0.0',
  '{"name":"Target"}'::jsonb,
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('c', 64),
  '1.0.0',
  'sha256:' || pg_catalog.repeat('0', 64),
  '[]'::jsonb,
  'Initial target release.',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000050'
), (
  '30000000-0000-4000-8000-000000000050',
  1,
  '1.0.0',
  '{"source_contract_version":"1.0.0","kind":"module","key":"vortex.release_owner"}'::jsonb,
  'sha256:' || pg_catalog.repeat('d', 64),
  '1.0.0',
  '{"name":"Owner"}'::jsonb,
  'sha256:' || pg_catalog.repeat('e', 64),
  'sha256:' || pg_catalog.repeat('f', 64),
  '1.0.0',
  'sha256:' || pg_catalog.repeat('3', 64),
  '[]'::jsonb,
  'Initial owner release.',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000050'
);

update vortex_definition.roots
set current_release_revision = 1
where root_id = '30000000-0000-4000-8000-000000000050';

select is(
  (
    select current_release_revision
    from vortex_definition.roots
    where root_id = '30000000-0000-4000-8000-000000000050'
  ),
  1::bigint,
  'a root may expose its own current release as a discovery/default pointer'
);
select throws_ok(
  $sql$
    update vortex_definition.roots
    set current_release_revision = 2
    where root_id = '30000000-0000-4000-8000-000000000050'
  $sql$,
  '23503'::char(5),
  null,
  'a root cannot point at another root''s release revision'
);

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values
  (
    '30000000-0000-4000-8000-000000000050',
    1,
    'module',
    'vortex.release_target',
    '1.0.0',
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('4', 64),
    '30000000-0000-4000-8000-000000000051',
    1,
    null
  ),
  (
    '30000000-0000-4000-8000-000000000050',
    1,
    'connection_type',
    'vortex.platform.connection',
    '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('5', 64),
    null,
    null,
    '50000000-0000-4000-8000-000000000050'
  ),
  (
    '30000000-0000-4000-8000-000000000050',
    1,
    'platform_theme',
    '40000000-0000-4000-8000-000000000050',
    '1.0.0',
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    null,
    null,
    null
  );

select is(
  (
    select count(*)::integer
    from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000050'
      and release_revision = 1
  ),
  3,
  'one release can preserve exact module and catalogue dependencies'
);
select is(
  (
    select catalogue_item_id
    from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000050'
      and release_revision = 1
      and dependency_kind = 'connection_type'
  ),
  '50000000-0000-4000-8000-000000000050'::uuid,
  'a connection-type dependency preserves its opaque platform catalogue identifier'
);
select is(
  (
    select dependency_reference
    from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000050'
      and release_revision = 1
      and dependency_kind = 'platform_theme'
  ),
  '40000000-0000-4000-8000-000000000050',
  'a platform-theme dependency preserves its opaque catalogue theme identifier'
);
select throws_ok(
  $sql$
    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint, evidence_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id
    ) values (
      '30000000-0000-4000-8000-000000000050',
      1,
      'module',
      'vortex.invalid_target',
      '1.0.0',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      null,
      null,
      null
    )
  $sql$,
  '23514'::char(5),
  null,
  'module dependencies require a target release reference'
);
select throws_ok(
  $sql$
    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint, evidence_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id
    ) values (
      '30000000-0000-4000-8000-000000000050',
      1,
      'connection_type',
      'vortex.invalid_catalogue_target',
      '1.0.0',
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      'sha256:5555555555555555555555555555555555555555555555555555555555555555',
      '30000000-0000-4000-8000-000000000051',
      1,
      '50000000-0000-4000-8000-000000000050'
    )
  $sql$,
  '23514'::char(5),
  null,
  'catalogue dependencies cannot claim a Definition release target'
);
select throws_ok(
  $sql$
    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint, evidence_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id
    ) values (
      '30000000-0000-4000-8000-000000000050',
      1,
      'module',
      'vortex.wrong_fingerprint',
      '1.0.0',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'sha256:6666666666666666666666666666666666666666666666666666666666666666',
      '30000000-0000-4000-8000-000000000051',
      1,
      null
    )
  $sql$,
  '23503'::char(5),
  null,
  'a module dependency cannot substitute different immutable target content'
);
select throws_ok(
  $sql$
    insert into vortex_definition.releases (
      root_id, release_revision, release_version, authored_source,
      authored_source_fingerprint, source_contract_version, canonical_content,
      content_fingerprint, resolution_fingerprint, validation_contract_version,
      comparison_fingerprint, impact_reasons, release_note, published_at, published_by
    ) values (
      '30000000-0000-4000-8000-000000000050',
      2,
      '1.0.1',
      '{"source_contract_version":"1.0.0","kind":"application","key":"vortex.release_owner"}'::jsonb,
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      '1.0.0',
      '{"name":"Invalid"}'::jsonb,
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      '1.0.0',
      'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      '[]'::jsonb,
      'Invalid source metadata.',
      pg_catalog.statement_timestamp(),
      '90000000-0000-4000-8000-000000000050'
    )
  $sql$,
  '23514'::char(5),
  'Definition release source metadata must match its permanent root and source contract',
  'a release source cannot contradict its permanent root'
);
select throws_ok(
  $sql$
    update vortex_definition.releases
    set release_note = 'Changed'
    where root_id = '30000000-0000-4000-8000-000000000050'
      and release_revision = 1
  $sql$,
  '23514'::char(5),
  'Definition releases and dependency manifests are append-only',
  'published releases cannot be edited'
);
select throws_ok(
  $sql$
    delete from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000050'
      and release_revision = 1
      and dependency_kind = 'module'
      and dependency_reference = 'vortex.release_target'
  $sql$,
  '23514'::char(5),
  'Definition releases and dependency manifests are append-only',
  'published dependency manifests cannot be deleted'
);

select * from finish();
rollback;
