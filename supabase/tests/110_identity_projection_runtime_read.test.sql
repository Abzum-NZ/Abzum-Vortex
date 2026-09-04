\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_identity',
  'postgres',
  true,
  false
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_identity.read_identity_projection(uuid)', 'EXECUTE'
  ),
  'trusted runtime may read one existing identity projection'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public', 'vortex_identity.read_identity_projection(uuid)', 'EXECUTE'
  ),
  'PUBLIC cannot read identity projections'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon', 'vortex_identity.read_identity_projection(uuid)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated', 'vortex_identity.read_identity_projection(uuid)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role', 'vortex_identity.read_identity_projection(uuid)', 'EXECUTE'
  ),
  'Data API roles cannot read identity projections'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_identity.read_identity_projection(uuid)', 'EXECUTE'
  ),
  'request code cannot bypass the trusted runtime read boundary'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_runtime', 'vortex_identity.identity_projections', 'SELECT'
  ),
  'trusted runtime still has no direct identity projection table access'
);
select ok(
  (
    select prosecdef and proconfig @> array['search_path=""']
    from pg_catalog.pg_proc
    where oid = 'vortex_identity.read_identity_projection(uuid)'::regprocedure
  ),
  'the projection read is security definer with an empty search path'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '41000000-0000-4000-8000-000000000110', 'active',
    '2026-09-05T00:00:00Z'::timestamptz, '2026-09-05T00:00:00Z'::timestamptz,
    '41000000-0000-4000-8000-000000000110',
    '71000000-0000-4000-8000-000000000110', 1
  ),
  (
    '41000000-0000-4000-8000-000000000111', 'suspended',
    '2026-09-05T00:00:00Z'::timestamptz, '2026-09-05T00:01:00Z'::timestamptz,
    '41000000-0000-4000-8000-000000000111',
    '71000000-0000-4000-8000-000000000111', 2
  ),
  (
    '41000000-0000-4000-8000-000000000112', 'closed',
    '2026-09-05T00:00:00Z'::timestamptz, '2026-09-05T00:02:00Z'::timestamptz,
    '41000000-0000-4000-8000-000000000112',
    '71000000-0000-4000-8000-000000000112', 3
  );

create temporary table projection_read_before on commit drop as
select identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
from vortex_identity.identity_projections
where identity_id between
  '41000000-0000-4000-8000-000000000110'::uuid and
  '41000000-0000-4000-8000-000000000112'::uuid;

set local role vortex_runtime;
create temporary table active_projection_read on commit drop as
select * from vortex_identity.read_identity_projection(
  '41000000-0000-4000-8000-000000000110'
);
create temporary table suspended_projection_read on commit drop as
select * from vortex_identity.read_identity_projection(
  '41000000-0000-4000-8000-000000000111'
);
create temporary table closed_projection_read on commit drop as
select * from vortex_identity.read_identity_projection(
  '41000000-0000-4000-8000-000000000112'
);
create temporary table missing_projection_read on commit drop as
select * from vortex_identity.read_identity_projection(
  '41000000-0000-4000-8000-000000000113'
);
reset role;

select results_eq(
  'select identity_id, state, revision from active_projection_read',
  $$values ('41000000-0000-4000-8000-000000000110'::uuid, 'active'::text, 1::bigint)$$,
  'the runtime read returns the exact active projection'
);
select results_eq(
  'select identity_id, state, revision from suspended_projection_read',
  $$values ('41000000-0000-4000-8000-000000000111'::uuid, 'suspended'::text, 2::bigint)$$,
  'the runtime read returns the exact suspended projection'
);
select results_eq(
  'select identity_id, state, revision from closed_projection_read',
  $$values ('41000000-0000-4000-8000-000000000112'::uuid, 'closed'::text, 3::bigint)$$,
  'the runtime read returns the exact closed projection'
);
select is(
  (select count(*)::integer from missing_projection_read),
  0,
  'a missing projection returns no row and is never created by the read'
);
select results_eq(
  $$
    select identity_id, state, created_at, state_changed_at, state_changed_by,
      state_change_correlation_id, revision
    from vortex_identity.identity_projections
    where identity_id between
      '41000000-0000-4000-8000-000000000110'::uuid and
      '41000000-0000-4000-8000-000000000112'::uuid
  $$,
  $$
    select identity_id, state, created_at, state_changed_at, state_changed_by,
      state_change_correlation_id, revision
    from projection_read_before
  $$,
  'every projection read leaves all projection evidence unchanged'
);
select throws_ok(
  $$
    set local role vortex_request;
    select * from vortex_identity.read_identity_projection(
      '41000000-0000-4000-8000-000000000110'
    )
  $$,
  '42501'::char(5),
  null,
  'request code is denied the runtime-only identity projection read'
);
reset role;
select throws_ok(
  $$
    set local role authenticated;
    select * from vortex_identity.read_identity_projection(
      '41000000-0000-4000-8000-000000000110'
    )
  $$,
  '42501'::char(5),
  null,
  'the authenticated Data API role is denied the private projection read'
);
reset role;

select * from finish();
rollback;
