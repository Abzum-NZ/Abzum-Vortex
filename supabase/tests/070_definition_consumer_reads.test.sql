\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_definition', 'postgres', false, true
);

select has_function(
  'vortex_definition', 'read_consumer_release', array['text', 'uuid', 'bigint'],
  'Definition exposes one narrow Module and Application consumer-release read'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.read_consumer_release(text,uuid,bigint)',
    'EXECUTE'
  ),
  'the non-owning request role can execute the consumer read'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public', 'vortex_definition.read_consumer_release(text,uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon', 'vortex_definition.read_consumer_release(text,uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated', 'vortex_definition.read_consumer_release(text,uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role', 'vortex_definition.read_consumer_release(text,uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_definition.read_consumer_release(text,uuid,bigint)', 'EXECUTE'
  ),
  'public, Supabase and runtime roles cannot bypass the request boundary'
);
select is(
  (
    select prosecdef
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.read_consumer_release(text,uuid,bigint)'::regprocedure
  ),
  true,
  'the private operation executes with its narrowly granted owner privileges'
);
select is(
  (
    select provolatile
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.read_consumer_release(text,uuid,bigint)'::regprocedure
  ),
  's'::"char",
  'the consumer read is stable within one statement snapshot'
);
select is(
  (
    select pg_catalog.array_to_string(proconfig, ',')
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.read_consumer_release(text,uuid,bigint)'::regprocedure
  ),
  'search_path=""',
  'the consumer read has an empty fixed search path'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000070',
  'consumer_read_tenant',
  'Consumer read tenant',
  'active',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
(
  '21000000-0000-4000-8000-000000000070',
  '11000000-0000-4000-8000-000000000070',
  null,
  'consumer_read_org',
  'Consumer read organization',
  'active',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070',
  pg_catalog.statement_timestamp(),
  1
),
(
  '21000000-0000-4000-8000-000000000071',
  '11000000-0000-4000-8000-000000000070',
  null,
  'consumer_read_other_org',
  'Consumer read other organization',
  'active',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
(
  '31000000-0000-4000-8000-000000000070',
  '21000000-0000-4000-8000-000000000070',
  'module',
  'example.consumer_module',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000071',
  '21000000-0000-4000-8000-000000000070',
  'application',
  'example.consumer_application',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000072',
  '21000000-0000-4000-8000-000000000071',
  'module',
  'example.foreign_module',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000073',
  '21000000-0000-4000-8000-000000000070',
  'module',
  'example.unpublished_module',
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
(
  '31000000-0000-4000-8000-000000000070', 1, '1.0.0',
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.consumer_module","body":{}}',
  'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
  '{"kind":"module","canonical":{"envelope":{"kind":"module"},"content":{"revision":1}}}',
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  '1.0.0', 'sha256:' || pg_catalog.repeat('4', 64), '[]',
  'Initial consumer release', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000070', 2, '1.1.0',
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.consumer_module","body":{}}',
  'sha256:' || pg_catalog.repeat('5', 64), '1.0.0',
  '{"kind":"module","canonical":{"envelope":{"kind":"module"},"content":{"revision":2}}}',
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
  'sha256:' || pg_catalog.repeat('7', 64),
  'sha256:' || pg_catalog.repeat('6', 64),
  '1.0.0', 'sha256:' || pg_catalog.repeat('8', 64), '[]',
  'Later consumer release', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000071', 1, '1.0.0',
  '{"source_contract_version":"1.0.0","kind":"application","key":"example.consumer_application","body":{}}',
  'sha256:' || pg_catalog.repeat('9', 64), '1.0.0',
  '{"kind":"application","canonical":{"envelope":{"kind":"application"},"content":{}}}',
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('a', 64)),
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('a', 64),
  '1.0.0', 'sha256:' || pg_catalog.repeat('c', 64), '[]',
  'Consumer application release', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000072', 1, '1.0.0',
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.foreign_module","body":{}}',
  'sha256:' || pg_catalog.repeat('d', 64), '1.0.0',
  '{"kind":"module","canonical":{"envelope":{"kind":"module"},"content":{}}}',
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('e', 64)),
  'sha256:' || pg_catalog.repeat('f', 64),
  'sha256:' || pg_catalog.repeat('e', 64),
  '1.0.0', 'sha256:' || pg_catalog.repeat('0', 64), '[]',
  'Foreign consumer release', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
);

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values (
  '31000000-0000-4000-8000-000000000071', 1, 'module',
  'example.consumer_module', '1.0.0', 'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  '31000000-0000-4000-8000-000000000070', 1, null
);

update vortex_definition.roots
set current_release_revision = case
  when root_id = '31000000-0000-4000-8000-000000000070'::uuid then 2
  else 1
end
where root_id in (
  '31000000-0000-4000-8000-000000000070'::uuid,
  '31000000-0000-4000-8000-000000000071'::uuid,
  '31000000-0000-4000-8000-000000000072'::uuid
);

create function pg_temp.consumer_read_context()
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '11000000-0000-4000-8000-000000000070'::uuid,
    'organizationId', '21000000-0000-4000-8000-000000000070'::uuid,
    'sessionId', '61000000-0000-4000-8000-000000000070'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '71000000-0000-4000-8000-000000000070'::uuid,
    'systemActorId', '91000000-0000-4000-8000-000000000070'::uuid,
    'authenticationStrength', 'service'
  )
$function$;

grant execute on function pg_temp.consumer_read_context() to vortex_runtime;
grant usage on schema extensions to vortex_runtime, vortex_request;

set local role vortex_runtime;
select vortex_context.initialize(pg_temp.consumer_read_context());
set local role vortex_request;

select is(
  vortex_definition.read_consumer_release(
    'module', '31000000-0000-4000-8000-000000000070', null
  ) ->> 'releaseRevision',
  '2',
  'current selects the root pointer and its immutable release together'
);
select is(
  vortex_definition.read_consumer_release(
    'module', '31000000-0000-4000-8000-000000000070', 1
  ) -> 'compilationOutput' -> 'canonical' -> 'content' ->> 'revision',
  '1',
  'an exact read stays pinned to the named earlier immutable revision'
);
select ok(
  not (
    vortex_definition.read_consumer_release(
      'module', '31000000-0000-4000-8000-000000000070', 1
    ) ?| array['authoredSource', 'releaseNote', 'publishedAt', 'publishedBy']
  ),
  'the private evidence omits authored source and publication metadata'
);
select is(
  vortex_definition.read_consumer_release(
    'application', '31000000-0000-4000-8000-000000000071', 1
  ) -> 'dependencyManifest' -> 0 ->> 'releaseRevision',
  '1',
  'the consumer evidence contains the complete exact Module dependency revision'
);
select is(
  vortex_definition.read_consumer_release(
    'application', '31000000-0000-4000-8000-000000000071', 1
  ) -> 'moduleDependencyTargets' -> 0 ->> 'releaseVersion',
  '1.0.0',
  'the consumer evidence joins the exact immutable Module target release'
);
select is(
  vortex_definition.read_consumer_release(
    'module', '31000000-0000-4000-8000-000000000070', 99
  ),
  null::jsonb,
  'an unknown exact revision is absent'
);
select is(
  vortex_definition.read_consumer_release(
    'application', '31000000-0000-4000-8000-000000000070', null
  ),
  null::jsonb,
  'a wrong-kind root is indistinguishable from absence'
);
select is(
  vortex_definition.read_consumer_release(
    'module', '31000000-0000-4000-8000-000000000072', null
  ),
  null::jsonb,
  'another organisation root is indistinguishable from absence'
);
select is(
  vortex_definition.read_consumer_release(
    'module', '31000000-0000-4000-8000-000000000073', null
  ),
  null::jsonb,
  'an unpublished current root is indistinguishable from absence'
);
select throws_ok(
  $$select vortex_definition.read_consumer_release('module', '31000000-0000-4000-8000-000000000070', 0)$$,
  '22023',
  'Definition consumer read has an invalid selector',
  'an invalid selector is refused'
);

reset role;
select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_request;
select throws_ok(
  $$select vortex_definition.read_consumer_release('module', '31000000-0000-4000-8000-000000000070', 1)$$,
  '55000',
  'Vortex request context is not established',
  'a missing request context is refused before release evidence returns'
);

reset role;
select * from finish();
rollback;
