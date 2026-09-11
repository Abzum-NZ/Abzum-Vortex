\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

grant usage on schema extensions to vortex_runtime, vortex_request;

create temporary table probe (name text primary key, value jsonb not null);
insert into probe values
  ('first', jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '81200000-0000-4000-8000-000000000001',
    'tenantId', '11200000-0000-4000-8000-000000000001',
    'organizationId', '21200000-0000-4000-8000-000000000001',
    'sessionId', '61200000-0000-4000-8000-000000000001',
    'issuedAt', clock_timestamp() - interval '1 minute',
    'expiresAt', clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '71200000-0000-4000-8000-000000000001',
    'identityId', '41200000-0000-4000-8000-000000000001',
    'organizationAccountId', '51200000-0000-4000-8000-000000000001',
    'authenticationStrength', 'multi_factor'
  )),
  ('second', jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '81200000-0000-4000-8000-000000000001',
    'tenantId', '11200000-0000-4000-8000-000000000002',
    'organizationId', '21200000-0000-4000-8000-000000000002',
    'sessionId', '61200000-0000-4000-8000-000000000002',
    'issuedAt', clock_timestamp() - interval '1 minute',
    'expiresAt', clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '71200000-0000-4000-8000-000000000001',
    'identityId', '41200000-0000-4000-8000-000000000002',
    'organizationAccountId', '51200000-0000-4000-8000-000000000002',
    'authenticationStrength', 'multi_factor'
  ));
grant select on probe to vortex_runtime, vortex_request;

-- 1. A value written into the session setting is never read.
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '55000'::char(5),
  'Vortex request context is not established',
  'no context is established before the initializer runs'
);
select pg_catalog.set_config('vortex.request_context', (select value::text from probe where name = 'first'), true);
select throws_ok(
  'select vortex_context.current_context()',
  '55000'::char(5),
  'Vortex request context is not established',
  'the setting is never read'
);

-- 2. The initializer establishes the context; the setting cannot replace it.
reset role;
set local role vortex_runtime;
select vortex_context.initialize((select value from probe where name = 'first'));
set local role vortex_request;
select is(
  (select vortex_context.current_context() ->> 'sessionId'),
  '61200000-0000-4000-8000-000000000001',
  'the initializer establishes the first context'
);
select pg_catalog.set_config('vortex.request_context', (select value::text from probe where name = 'second'), true);
select is(
  (select vortex_context.current_context() ->> 'sessionId'),
  '61200000-0000-4000-8000-000000000001',
  'a second context written into the setting does not replace the established context'
);
select is(
  vortex_context.organization_id(),
  '21200000-0000-4000-8000-000000000001'::uuid,
  'row policies still read the established organisation'
);

-- 3. Reverting to the runtime login, which PostgreSQL always permits, cannot re-establish.
select pg_catalog.set_config('role', 'vortex_runtime', true);
select is(current_user::text, 'vortex_runtime', 'the request role can revert to the runtime login');
select ok(
  has_function_privilege(current_user, 'vortex_context.initialize(jsonb)', 'execute'),
  'the reverted runtime login holds the initializer grant'
);
select throws_ok(
  $$select vortex_context.initialize((select value from probe where name = 'second'))$$,
  '55000'::char(5),
  'Vortex request context is already established',
  'a re-issue after the role escape is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select value from probe where name = 'first'))$$,
  '55000'::char(5),
  'Vortex request context is already established',
  're-issuing the same context after the role escape is refused'
);
select pg_catalog.set_config('role', 'none', true);
select throws_ok(
  $$select vortex_context.initialize((select value from probe where name = 'second'))$$,
  '55000'::char(5),
  'Vortex request context is already established',
  'a re-issue after resetting to the session role is refused'
);
select pg_catalog.set_config('role', 'vortex_request', true);
select is(
  (select vortex_context.current_context() ->> 'sessionId'),
  '61200000-0000-4000-8000-000000000001',
  'the established context survives every re-issue attempt'
);

-- 4. Neither login role can read or write the store, even while a context is live.
select pg_catalog.set_config('role', 'vortex_runtime', true);
select throws_ok(
  'delete from vortex_context.request_contexts',
  '42501'::char(5),
  null::text,
  'vortex_runtime cannot delete the context row'
);
select throws_ok(
  $$update vortex_context.request_contexts set context = '{}'$$,
  '42501'::char(5),
  null::text,
  'vortex_runtime cannot update the context row'
);
select throws_ok(
  $$insert into vortex_context.request_contexts values (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), '{}')$$,
  '42501'::char(5),
  null::text,
  'vortex_runtime cannot insert a context row'
);
select throws_ok(
  'truncate vortex_context.request_contexts',
  '42501'::char(5),
  null::text,
  'vortex_runtime cannot truncate the context store'
);
select throws_ok(
  'select count(*) from vortex_context.request_contexts',
  '42501'::char(5),
  null::text,
  'vortex_runtime cannot read the context store'
);
select pg_catalog.set_config('role', 'vortex_request', true);
select throws_ok(
  'delete from vortex_context.request_contexts',
  '42501'::char(5),
  null::text,
  'vortex_request cannot delete the context row'
);
select throws_ok(
  $$update vortex_context.request_contexts set context = '{}'$$,
  '42501'::char(5),
  null::text,
  'vortex_request cannot update the context row'
);
select throws_ok(
  $$insert into vortex_context.request_contexts values (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), '{}')$$,
  '42501'::char(5),
  null::text,
  'vortex_request cannot insert a context row'
);
select throws_ok(
  'truncate vortex_context.request_contexts',
  '42501'::char(5),
  null::text,
  'vortex_request cannot truncate the context store'
);
select throws_ok(
  'select count(*) from vortex_context.request_contexts',
  '42501'::char(5),
  null::text,
  'vortex_request cannot read the context store'
);
select ok(
  not has_table_privilege('vortex_record_owner', 'vortex_context.request_contexts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'vortex_record_owner cannot touch the context store'
);
select ok(
  not has_table_privilege('vortex_record_adapter', 'vortex_context.request_contexts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'vortex_record_adapter cannot touch the context store'
);
select ok(
  not has_table_privilege('vortex_module_owner', 'vortex_context.request_contexts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'vortex_module_owner cannot touch the context store'
);

-- 5. Only the owner can clear the row; a new context can then be established.
reset role;
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
set local role vortex_request;
select throws_ok(
  'select vortex_context.current_context()',
  '55000'::char(5),
  'Vortex request context is not established',
  'after the owner clears the row no context is established'
);
reset role;
set local role vortex_runtime;
select lives_ok(
  $$select vortex_context.initialize((select value from probe where name = 'second'))$$,
  'after the owner clears the row a new context can be established'
);
set local role vortex_request;
select is(
  (select vortex_context.current_context() ->> 'sessionId'),
  '61200000-0000-4000-8000-000000000002',
  'the newly established context is read'
);

-- 6. The row is bound to the establishing transaction.
reset role;
select is(
  (select transaction_id from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid()),
  pg_catalog.pg_current_xact_id(),
  'the row is stamped with this transaction'
);

select * from finish();
rollback;
