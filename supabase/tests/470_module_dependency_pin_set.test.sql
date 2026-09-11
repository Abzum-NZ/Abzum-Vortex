\ir helpers/definition-release-writer.psql

begin;
select plan(11);

set local search_path = pg_catalog, extensions, public;

-- Every release below is produced by vortex_definition.append_release through
-- pg_temp.append_writer_release, so each fixture is a closure the writer
-- itself accepts or refuses.

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14700000-0000-4000-8000-000000000001', 'pin_set_tenant', 'Pin set tenant',
  'active', pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '24700000-0000-4000-8000-000000000001', '14700000-0000-4000-8000-000000000001',
  null, 'pin_set_organisation', 'Pin set organisation', 'active',
  pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '44700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
    'module', 'vortex.pin_set.shared_module', pg_catalog.statement_timestamp(),
    '94700000-0000-4000-8000-000000000001'
  ),
  (
    '44700000-0000-4000-8000-000000000002', '24700000-0000-4000-8000-000000000001',
    'module', 'vortex.pin_set.dependent_module', pg_catalog.statement_timestamp(),
    '94700000-0000-4000-8000-000000000001'
  ),
  (
    '44700000-0000-4000-8000-000000000003', '24700000-0000-4000-8000-000000000001',
    'module', 'vortex.pin_set.cycle_module', pg_catalog.statement_timestamp(),
    '94700000-0000-4000-8000-000000000001'
  ),
  (
    '44700000-0000-4000-8000-000000000004', '24700000-0000-4000-8000-000000000001',
    'module', 'vortex.pin_set.cycle_bridge_module', pg_catalog.statement_timestamp(),
    '94700000-0000-4000-8000-000000000001'
  ),
  (
    '34700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
    'application', 'vortex.pin_set.application', pg_catalog.statement_timestamp(),
    '94700000-0000-4000-8000-000000000001'
  );

-- S@1, then P published against S@1, then S@2.
select is(
  pg_temp.append_writer_release('44700000-0000-4000-8000-000000000001', '1.0.0'),
  1::bigint,
  'the shared Module publishes release one'
);
select is(
  pg_temp.append_writer_release(
    '44700000-0000-4000-8000-000000000002', '1.0.0',
    '[["44700000-0000-4000-8000-000000000001", 1]]'
  ),
  1::bigint,
  'a dependent Module publishes against the shared Module release one'
);
select is(
  pg_temp.append_writer_release('44700000-0000-4000-8000-000000000001', '1.1.0'),
  2::bigint,
  'the shared Module publishes release two'
);

-- Z declares P (which pins S@1) and S@2 directly: S would be pinned twice.
select throws_ok(
  $$select pg_temp.append_writer_release(
    '34700000-0000-4000-8000-000000000001', '1.0.0',
    '[["44700000-0000-4000-8000-000000000002", 1], ["44700000-0000-4000-8000-000000000001", 2]]'
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the writer refuses an Application whose closure pins one Module at two revisions'::text
);
select ok(
  not exists (
    select 1 from vortex_definition.releases
    where root_id = '34700000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1 from vortex_definition.release_dependencies
    where root_id = '34700000-0000-4000-8000-000000000001'
  )
  and (
    select current_release_revision from vortex_definition.roots
    where root_id = '34700000-0000-4000-8000-000000000001'
  ) is null,
  'the refused append stores no release or dependency row and leaves the current pointer unset'
);

select is(
  pg_temp.append_writer_release(
    '34700000-0000-4000-8000-000000000001', '1.0.0',
    '[["44700000-0000-4000-8000-000000000002", 1], ["44700000-0000-4000-8000-000000000001", 1]]'
  ),
  1::bigint,
  'the Application publishes once it pins the shared Module at the revision its dependency pins'
);
select results_eq(
  $$select target_root_id, target_release_revision
    from vortex_definition.reachable_module_dependency_edges(
      '34700000-0000-4000-8000-000000000001', 1
    )
    order by target_root_id$$::text,
  $$values
    ('44700000-0000-4000-8000-000000000001'::uuid, 1::bigint),
    ('44700000-0000-4000-8000-000000000002'::uuid, 1::bigint)$$::text,
  'the pin set holds one row per Module root although two edges reach the shared Module'::text
);

-- A Module release that reaches an older release of itself pins its own root twice.
select is(
  pg_temp.append_writer_release('44700000-0000-4000-8000-000000000003', '1.0.0'),
  1::bigint,
  'a Module publishes release one'
);
select is(
  pg_temp.append_writer_release(
    '44700000-0000-4000-8000-000000000004', '1.0.0',
    '[["44700000-0000-4000-8000-000000000003", 1]]'
  ),
  1::bigint,
  'a bridge Module publishes against that release'
);
select throws_ok(
  $$select pg_temp.append_writer_release(
    '44700000-0000-4000-8000-000000000003', '2.0.0',
    '[["44700000-0000-4000-8000-000000000004", 1]]'
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the writer refuses a Module release whose closure reaches an older release of itself'::text
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_module_owner',
    'vortex_definition.reachable_module_dependency_edges(uuid,bigint)', 'EXECUTE'
  )
  and not exists (
    select 1
    from (values
      ('public'), ('anon'), ('authenticated'), ('service_role'),
      ('vortex_runtime'), ('vortex_request')
    ) as denied(role_name)
    where pg_catalog.has_function_privilege(
      denied.role_name,
      'vortex_definition.reachable_module_dependency_edges(uuid,bigint)', 'EXECUTE'
    )
  )
  and (
    select not procedure.prosecdef
      and procedure.provolatile = 's'
      and procedure.proconfig = array['search_path=""']
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'vortex_definition.reachable_module_dependency_edges(uuid,bigint)'::regprocedure
  ),
  'the pin-set resolver stays owner-private, runs with its caller rights and has an empty search path'
);

select * from finish();
rollback;
