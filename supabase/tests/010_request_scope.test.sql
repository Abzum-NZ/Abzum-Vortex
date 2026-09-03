\ir helpers/private-schema-assertions.psql

select plan(123);

begin;

select * from pg_temp.vortex_private_schema_assertions('vortex_context', 'postgres', true);

select has_role('vortex_request', 'the non-login request role exists');
select has_role('vortex_runtime', 'the restricted runtime login exists');
select is((select rolcanlogin from pg_roles where rolname = 'vortex_request'), false, 'request cannot log in');
select is((select rolcanlogin from pg_roles where rolname = 'vortex_runtime'), true, 'runtime can log in');
select is((select rolbypassrls from pg_roles where rolname = 'vortex_request'), false, 'request cannot bypass row security');
select is((select rolbypassrls from pg_roles where rolname = 'vortex_runtime'), false, 'runtime cannot bypass row security');
select is((select rolsuper from pg_roles where rolname = 'vortex_request'), false, 'request is not a superuser');
select is((select rolsuper from pg_roles where rolname = 'vortex_runtime'), false, 'runtime is not a superuser');
select is((select rolcreatedb from pg_roles where rolname = 'vortex_request'), false, 'request cannot create databases');
select is((select rolcreaterole from pg_roles where rolname = 'vortex_request'), false, 'request cannot create roles');
select is((select rolreplication from pg_roles where rolname = 'vortex_request'), false, 'request cannot replicate');
select is((select rolinherit from pg_roles where rolname = 'vortex_request'), false, 'request does not inherit role privileges');
select is((select rolcreatedb from pg_roles where rolname = 'vortex_runtime'), false, 'runtime cannot create databases');
select is((select rolcreaterole from pg_roles where rolname = 'vortex_runtime'), false, 'runtime cannot create roles');
select is((select rolreplication from pg_roles where rolname = 'vortex_runtime'), false, 'runtime cannot replicate');
select is((select rolinherit from pg_roles where rolname = 'vortex_runtime'), false, 'runtime does not inherit role privileges');
select is(
  (select count(*)::integer from pg_class where relowner = 'vortex_request'::regrole and relpersistence <> 't'),
  0,
  'request owns no persistent relation'
);
select is(
  (select count(*)::integer from pg_class where relowner = 'vortex_runtime'::regrole and relpersistence <> 't'),
  0,
  'runtime owns no persistent relation'
);
select is(
  (select count(*)::integer from pg_namespace where nspowner = 'vortex_request'::regrole),
  0,
  'request owns no schema'
);
select is(
  (select count(*)::integer from pg_namespace where nspowner = 'vortex_runtime'::regrole),
  0,
  'runtime owns no schema'
);
select ok(pg_has_role('vortex_runtime', 'vortex_request', 'SET'), 'runtime may explicitly enter the request role');
select ok(not pg_has_role('vortex_runtime', 'vortex_request', 'USAGE'), 'runtime does not inherit request privileges');
select is(
  (select count(*)::integer from pg_auth_members where member = 'vortex_runtime'::regrole),
  1,
  'runtime has exactly one role membership'
);
select is(
  (
    select coalesce(bool_or(admin_option), false)
    from pg_auth_members
    where member = 'vortex_runtime'::regrole
      and roleid = 'vortex_request'::regrole
  ),
  false,
  'runtime cannot grant request-role membership to another role'
);
select is(
  (
    select coalesce(bool_or(admin_option), false)
    from pg_auth_members
    where member = 'postgres'::regrole
      and roleid = 'vortex_runtime'::regrole
  ),
  true,
  'the project owner can provision and rotate the runtime role'
);
select is(
  (
    select coalesce(bool_or(admin_option), false)
    from pg_auth_members
    where member = 'postgres'::regrole
      and roleid = 'vortex_request'::regrole
  ),
  true,
  'the project owner can administer the request role'
);
select is(
  (select count(*)::integer from pg_auth_members where member = 'vortex_request'::regrole),
  0,
  'request is not a member of another role'
);
select ok(not has_schema_privilege('anon', 'vortex_context', 'USAGE'), 'anon cannot use request context');
select ok(not has_schema_privilege('authenticated', 'vortex_context', 'USAGE'), 'authenticated cannot use request context');
select ok(not has_schema_privilege('service_role', 'vortex_context', 'USAGE'), 'service role cannot use request context');
select ok(
  not has_function_privilege('vortex_request', 'vortex_context.initialize(jsonb)', 'EXECUTE'),
  'request cannot establish trusted context'
);
select ok(
  has_function_privilege('vortex_runtime', 'vortex_context.initialize(jsonb)', 'EXECUTE'),
  'runtime can establish trusted context'
);
select ok(
  not has_function_privilege('vortex_runtime', 'vortex_context.current_context()', 'EXECUTE'),
  'runtime cannot read through request accessors'
);
select ok(
  has_function_privilege('vortex_request', 'vortex_context.current_context()', 'EXECUTE'),
  'request can read validated context'
);
select ok(
  not has_schema_privilege('vortex_request', 'vortex_context', 'CREATE'),
  'request cannot create persistent context objects'
);
select ok(
  not has_function_privilege('public', 'vortex_context.initialize(jsonb)', 'EXECUTE'),
  'PUBLIC cannot execute the context initializer'
);

create temporary table organization_scope_probe (
  id uuid primary key,
  organization_id uuid not null,
  value text not null
);
alter table organization_scope_probe enable row level security;
alter table organization_scope_probe force row level security;
create index organization_scope_probe_scope_idx on organization_scope_probe (organization_id, id);

create policy organization_scope_probe_select on organization_scope_probe
  for select to vortex_request
  using (organization_id = (select vortex_context.organization_id()));
create policy organization_scope_probe_insert on organization_scope_probe
  for insert to vortex_request
  with check (organization_id = (select vortex_context.organization_id()));
create policy organization_scope_probe_update on organization_scope_probe
  for update to vortex_request
  using (organization_id = (select vortex_context.organization_id()))
  with check (organization_id = (select vortex_context.organization_id()));
create policy organization_scope_probe_delete on organization_scope_probe
  for delete to vortex_request
  using (organization_id = (select vortex_context.organization_id()));
grant select, insert, update, delete on organization_scope_probe to vortex_request;

create temporary table application_scope_probe (
  id uuid primary key,
  organization_id uuid not null,
  application_root_id uuid not null,
  value text not null
);
alter table application_scope_probe enable row level security;
alter table application_scope_probe force row level security;
create index application_scope_probe_scope_idx
  on application_scope_probe (organization_id, application_root_id, id);

create policy application_scope_probe_select on application_scope_probe
  for select to vortex_request
  using (
    organization_id = (select vortex_context.organization_id())
    and application_root_id = (select vortex_context.application_root_id(true))
  );
create policy application_scope_probe_insert on application_scope_probe
  for insert to vortex_request
  with check (
    organization_id = (select vortex_context.organization_id())
    and application_root_id = (select vortex_context.application_root_id(true))
  );
create policy application_scope_probe_update on application_scope_probe
  for update to vortex_request
  using (
    organization_id = (select vortex_context.organization_id())
    and application_root_id = (select vortex_context.application_root_id(true))
  )
  with check (
    organization_id = (select vortex_context.organization_id())
    and application_root_id = (select vortex_context.application_root_id(true))
  );
create policy application_scope_probe_delete on application_scope_probe
  for delete to vortex_request
  using (
    organization_id = (select vortex_context.organization_id())
    and application_root_id = (select vortex_context.application_root_id(true))
  );
grant select, insert, update, delete on application_scope_probe to vortex_request;

create temporary table context_candidate_probe (value jsonb not null);
insert into context_candidate_probe values (jsonb_build_object(
  'callerKind', 'human',
  'tenantId', '10000000-0000-4000-8000-000000000001',
  'organizationId', '20000000-0000-4000-8000-000000000001',
  'applicationRootId', '30000000-0000-4000-8000-000000000001',
  'sessionId', '60000000-0000-4000-8000-000000000001',
  'issuedAt', clock_timestamp() - interval '1 minute',
  'expiresAt', clock_timestamp() + interval '5 minutes',
  'accessVersion', 1,
  'correlationId', '70000000-0000-4000-8000-000000000001',
  'identityId', '40000000-0000-4000-8000-000000000001',
  'organizationAccountId', '50000000-0000-4000-8000-000000000001',
  'authenticationStrength', 'multi_factor'
));
grant select on context_candidate_probe to vortex_runtime;

insert into organization_scope_probe values
  ('81000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'first scope'),
  ('81000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'other scope');
insert into application_scope_probe values
  ('82000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'first application'),
  ('82000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'other application'),
  ('82000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'other organisation');

select is((select relrowsecurity from pg_class where oid = 'organization_scope_probe'::regclass), true, 'organisation proof enables row security');
select is((select relforcerowsecurity from pg_class where oid = 'organization_scope_probe'::regclass), true, 'organisation proof forces row security');
select is((select relrowsecurity from pg_class where oid = 'application_scope_probe'::regclass), true, 'application proof enables row security');
select is((select relforcerowsecurity from pg_class where oid = 'application_scope_probe'::regclass), true, 'application proof forces row security');
select ok(
  exists (
    select 1 from pg_index
    where indrelid = 'organization_scope_probe'::regclass
      and indkey::text like '2 1%'
  ),
  'organisation proof has a scope-first index'
);
select ok(
  exists (
    select 1 from pg_index
    where indrelid = 'application_scope_probe'::regclass
      and indkey::text like '2 3 1%'
  ),
  'application proof has a complete scope-first index'
);
select table_privs_are(
  'organization_scope_probe',
  'vortex_request',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'request receives only the four declared organisation-row operations'
);
select ok(
  not has_table_privilege('vortex_runtime', 'organization_scope_probe', 'SELECT'),
  'runtime has no direct service-table access'
);

commit;

begin;
grant usage on schema extensions to vortex_request;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select count(*) from organization_scope_probe',
  '55000'::char(5),
  'Vortex request context is not established',
  'missing context refuses protected reads'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_request;
select pg_catalog.set_config('vortex.request_context', 'not-json', true);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '22023'::char(5),
  'Stored Vortex request context is invalid',
  'accessor refuses malformed stored JSON'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_request;
select pg_catalog.set_config('vortex.request_context', '{}', true);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '22023'::char(5),
  'Vortex request context is incomplete',
  'accessor refuses incomplete stored context'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_request;
select pg_catalog.set_config(
  'vortex.request_context',
  (select jsonb_set(
    value,
    '{expiresAt}',
    to_jsonb(to_char(clock_timestamp() at time zone 'UTC' - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  )::text from context_candidate_probe),
  true
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '22023'::char(5),
  'Vortex request context is expired or inconsistent',
  'accessor refuses expired stored context'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.initialize(null)',
  '22023'::char(5),
  'Vortex request context must be an object',
  'null context is refused'
);
select throws_ok(
  $$select vortex_context.initialize('[]'::jsonb)$$,
  '22023'::char(5),
  'Vortex request context must be an object',
  'non-object context is refused'
);
select throws_ok(
  $$select vortex_context.initialize('{}'::jsonb)$$,
  '22023'::char(5),
  'Vortex request context is incomplete',
  'empty context is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select value - 'tenantId' from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context is incomplete',
  'context missing a required field is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{tenantId}', 'null'::jsonb) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid identifier',
  'JSON-null scope identifier is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{authenticationStrength}', 'null'::jsonb) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex human context has an invalid actor',
  'JSON-null authentication strength is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{issuedAt}', 'null'::jsonb) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid time',
  'JSON-null issue time is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{expiresAt}', '"infinity"') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid time',
  'non-RFC3339 infinity time is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{expiresAt}', '"tomorrow"') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid time',
  'relative database time is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{expiresAt}', '"2099-01-01T24:00:00Z"') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid time',
  'time outside the closed ISO datetime contract is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{accessVersion}', 'null'::jsonb) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid access version',
  'JSON-null access version is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{organizationId}', '"bad"') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid identifier',
  'malformed scope identifier is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{callerKind}', '"robot"') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an unsupported caller kind',
  'unsupported caller kind is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select value - 'identityId' from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex human context has an invalid actor',
  'wrong caller and actor combination is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(
    value,
    '{expiresAt}',
    to_jsonb(to_char(clock_timestamp() at time zone 'UTC' - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context is expired or inconsistent',
  'expired context is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select value || '{"unexpected":true}'::jsonb from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an unknown field',
  'unknown context field is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{accessVersion}', '0') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid access version',
  'non-positive access version is refused'
);
select throws_ok(
  $$select vortex_context.initialize((select jsonb_set(value, '{accessVersion}', '9007199254740992') from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex request context has an invalid access version',
  'access version above the JavaScript safe-integer contract is refused'
);
select lives_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{correlationId}', '"70000000-0000-7000-8000-000000000001"') from context_candidate_probe))$$,
  'RFC UUID version 7 identifiers are accepted'
);
select throws_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{delegatedContext}', jsonb_build_object(
    'delegatedByOrganizationAccountId', '50000000-0000-4000-8000-000000000001',
    'reason', null,
    'expiresAt', clock_timestamp() + interval '2 minutes'
  )) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex delegated context is invalid',
  'delegation with a JSON-null reason is refused'
);
select throws_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{delegatedContext}', jsonb_build_object(
    'delegatedByOrganizationAccountId', '50000000-0000-4000-8000-000000000001',
    'reason', 'approved delegation',
    'expiresAt', null
  )) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex delegated context has an invalid time',
  'delegation with a JSON-null expiry is refused'
);
select lives_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{delegatedContext}', jsonb_build_object(
    'delegatedByOrganizationAccountId', '50000000-0000-4000-8000-000000000001',
    'reason', 'approved delegation',
    'expiresAt', clock_timestamp() + interval '2 minutes'
  )) from context_candidate_probe))$$,
  'valid delegated context is accepted'
);
select throws_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{supportContext}', jsonb_build_object(
    'supportActorId', '90000000-0000-4000-8000-000000000001',
    'approvedByOrganizationAccountId', '50000000-0000-4000-8000-000000000001',
    'reason', null,
    'expiresAt', clock_timestamp() + interval '2 minutes'
  )) from context_candidate_probe))$$,
  '22023'::char(5),
  'Vortex support context is invalid',
  'support context with a JSON-null reason is refused'
);
select lives_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{supportContext}', jsonb_build_object(
    'supportActorId', '90000000-0000-4000-8000-000000000001',
    'approvedByOrganizationAccountId', '50000000-0000-4000-8000-000000000001',
    'reason', 'approved support',
    'expiresAt', clock_timestamp() + interval '2 minutes'
  )) from context_candidate_probe))$$,
  'valid support context is accepted'
);
select lives_ok(
  $$select vortex_context.validated(jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '10000000-0000-4000-8000-000000000001',
    'organizationId', '20000000-0000-4000-8000-000000000001',
    'sessionId', '60000000-0000-4000-8000-000000000001',
    'issuedAt', clock_timestamp() - interval '1 minute',
    'expiresAt', clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000001',
    'systemActorId', '90000000-0000-4000-8000-000000000001',
    'authenticationStrength', 'service'
  ))$$,
  'valid system context is accepted'
);
select lives_ok(
  $$select vortex_context.validated((select jsonb_set(value, '{callerKind}', '"federated"') from context_candidate_probe))$$,
  'valid federated context is accepted'
);
select throws_ok('create schema runtime_should_fail', '42501'::char(5), null::text, 'runtime cannot create a schema');
select throws_ok('create table public.runtime_should_fail(id integer)', '42501'::char(5), null::text, 'runtime cannot create a persistent relation');
reset role;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok('create schema request_should_fail', '42501'::char(5), null::text, 'request cannot create a schema');
select throws_ok('create table public.request_should_fail(id integer)', '42501'::char(5), null::text, 'request cannot create a persistent relation');
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_runtime;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select vortex_context.initialize('{"callerKind":"human"}'::jsonb)$$,
  '22023'::char(5),
  'Vortex request context is incomplete',
  'incomplete context is refused'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;
select lives_ok(
  $$select vortex_context.initialize(jsonb_build_object(
    'callerKind', 'human',
    'tenantId', '10000000-0000-4000-8000-000000000001',
    'organizationId', '20000000-0000-4000-8000-000000000001',
    'applicationRootId', '30000000-0000-4000-8000-000000000001',
    'sessionId', '60000000-0000-4000-8000-000000000001',
    'issuedAt', clock_timestamp() - interval '1 minute',
    'expiresAt', clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000001',
    'identityId', '40000000-0000-4000-8000-000000000001',
    'organizationAccountId', '50000000-0000-4000-8000-000000000001',
    'authenticationStrength', 'multi_factor'
  ))$$,
  'runtime establishes one valid context'
);
select throws_ok(
  $$select vortex_context.initialize(jsonb_build_object(
    'callerKind', 'public',
    'tenantId', '10000000-0000-4000-8000-000000000001',
    'organizationId', '20000000-0000-4000-8000-000000000001',
    'sessionId', '60000000-0000-4000-8000-000000000001',
    'issuedAt', clock_timestamp() - interval '1 minute',
    'expiresAt', clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000001',
    'authenticationStrength', 'anonymous'
  ))$$,
  '55000'::char(5),
  'Vortex request context is already established',
  'context cannot be replaced inside the transaction'
);
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(vortex_context.organization_id(), '20000000-0000-4000-8000-000000000001'::uuid, 'request reads the active organisation');
select is(vortex_context.application_root_id(true), '30000000-0000-4000-8000-000000000001'::uuid, 'request reads the required application');
select results_eq(
  'select value from organization_scope_probe order by value',
  array['first scope'],
  'request sees only its organisation rows'
);
select is((select count(*)::integer from organization_scope_probe where value = 'other scope'), 0, 'other organisation is hidden');
select lives_ok(
  $$insert into organization_scope_probe values ('81000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'new same scope')$$,
  'same-organisation insert succeeds'
);
select throws_ok(
  $$insert into organization_scope_probe values ('81000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', 'refused insert')$$,
  '42501'::char(5),
  null::text,
  'cross-organisation insert is refused'
);
select lives_ok(
  $$update organization_scope_probe set value = 'updated same scope' where id = '81000000-0000-4000-8000-000000000003'$$,
  'same-organisation update succeeds'
);
select throws_ok(
  $$update organization_scope_probe set organization_id = '20000000-0000-4000-8000-000000000002' where id = '81000000-0000-4000-8000-000000000003'$$,
  '42501'::char(5),
  null::text,
  'an update cannot move organisation scope'
);
select lives_ok(
  $$delete from organization_scope_probe where id = '81000000-0000-4000-8000-000000000002'$$,
  'cross-organisation delete cannot reach the hidden row'
);
select lives_ok(
  $$delete from organization_scope_probe where id = '81000000-0000-4000-8000-000000000003'$$,
  'same-organisation delete succeeds'
);
select throws_ok('truncate organization_scope_probe', '42501'::char(5), null::text, 'request cannot truncate protected rows');
select throws_ok('alter table organization_scope_probe disable row level security', '42501'::char(5), null::text, 'request cannot disable row security');
select results_eq(
  'select value from application_scope_probe order by value',
  array['first application'],
  'application-contained reads require the complete scope'
);
select lives_ok(
  $$insert into application_scope_probe values ('82000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'new same application')$$,
  'same-application insert succeeds'
);
select throws_ok(
  $$insert into application_scope_probe values ('82000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'refused application')$$,
  '42501'::char(5),
  null::text,
  'another application insert is refused'
);
select throws_ok(
  $$update application_scope_probe set application_root_id = '30000000-0000-4000-8000-000000000002' where id = '82000000-0000-4000-8000-000000000004'$$,
  '42501'::char(5),
  null::text,
  'an update cannot move application scope'
);
select lives_ok(
  $$delete from application_scope_probe where id = '82000000-0000-4000-8000-000000000002'$$,
  'another application delete cannot reach the hidden row'
);
select lives_ok(
  $$delete from application_scope_probe where id = '82000000-0000-4000-8000-000000000004'$$,
  'same-application delete succeeds'
);
reset role;
revoke usage on schema extensions from vortex_runtime, vortex_request;
commit;

begin;
grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;
select vortex_context.initialize((select value from context_candidate_probe));
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$insert into organization_scope_probe values ('81000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000002', 'failed protected operation')$$,
  '42501'::char(5),
  null::text,
  'a protected operation failure is observed before driver rollback'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_request;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '55000'::char(5),
  'Vortex request context is not established',
  'driver rollback after operation failure clears context on connection reuse'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_request;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '55000'::char(5),
  'Vortex request context is not established',
  'commit clears context on the reused physical connection'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_runtime, vortex_request;
set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;
select vortex_context.initialize(jsonb_build_object(
  'callerKind', 'public',
  'tenantId', '10000000-0000-4000-8000-000000000001',
  'organizationId', '20000000-0000-4000-8000-000000000001',
  'sessionId', '60000000-0000-4000-8000-000000000001',
  'issuedAt', clock_timestamp() - interval '1 minute',
  'expiresAt', clock_timestamp() + interval '5 minutes',
  'accessVersion', 1,
  'correlationId', '70000000-0000-4000-8000-000000000001',
  'authenticationStrength', 'anonymous'
));
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select results_eq(
  'select value from organization_scope_probe order by value',
  array['first scope'],
  'organisation-only context can use organisation-scoped rows'
);
select throws_ok(
  'select vortex_context.application_root_id(true)',
  '55000'::char(5),
  'Vortex application context is required',
  'application-scoped work refuses an organisation-only context'
);
reset role;
rollback;

begin;
grant usage on schema extensions to vortex_request;
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  'select vortex_context.current_context()',
  '55000'::char(5),
  'Vortex request context is not established',
  'rollback clears context on the reused physical connection'
);
reset role;
select is((select count(*)::integer from organization_scope_probe), 2, 'owner control sees both original organisation rows');
select is((select count(*)::integer from application_scope_probe), 3, 'owner control sees all application rows');
select * from finish();
rollback;
