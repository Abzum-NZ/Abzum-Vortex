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

insert into vortex_definition.drafts (
  root_id, draft_revision, draft_source, identity_requirements,
  source_contract_version, source_fingerprint, updated_at, updated_by
) values
(
  '31000000-0000-4000-8000-000000000070', 1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.consumer_module","body":{}}'::jsonb,
  '[{"definitionKey":"example.consumer_module","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.consumer_module"]}]'::jsonb,
  '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000071', 1,
  '{"source_contract_version":"1.0.0","kind":"application","key":"example.consumer_application","body":{}}'::jsonb,
  '[{"definitionKey":"example.consumer_application","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.consumer_application"]}]'::jsonb,
  '1.0.0', 'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
),
(
  '31000000-0000-4000-8000-000000000072', 1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.foreign_module","body":{}}'::jsonb,
  '[{"definitionKey":"example.foreign_module","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.foreign_module"]}]'::jsonb,
  '1.0.0', 'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000070'
);

create function pg_temp.consumer_read_system_context()
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

grant execute on function pg_temp.consumer_read_system_context() to vortex_runtime, vortex_request;

create function pg_temp.consumer_release_compilation(
  p_root_id uuid,
  p_organization_id uuid,
  p_kind text,
  p_key text,
  p_release_version text,
  p_validation_contract_version text,
  p_canonical_content jsonb,
  p_content_fingerprint text,
  p_resolution_fingerprint text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', p_kind,
    'resolutionFingerprint', p_resolution_fingerprint,
    'artifact', pg_catalog.jsonb_build_object(
      'kind', p_kind,
      'rootId', p_root_id,
      'definitionKey', p_key,
      'exactVersion', p_release_version,
      'contentFingerprint', p_content_fingerprint,
      'resolutionFingerprint', p_resolution_fingerprint
    ),
    'canonical', pg_catalog.jsonb_build_object(
      'envelope', pg_catalog.jsonb_build_object(
        'kind', p_kind,
        'key', p_key,
        'rootId', p_root_id,
        'organizationId', p_organization_id
      ),
      'content', p_canonical_content
    ),
    'validationContractVersion', p_validation_contract_version
  )
$function$;

grant execute on function pg_temp.consumer_release_compilation(uuid,uuid,text,text,text,text,jsonb,text,text) to vortex_runtime, vortex_request;

create function pg_temp.consumer_resolution_snapshot(
  p_root_id uuid,
  p_kind text,
  p_definition_key text,
  p_release_version text,
  p_resolution_fingerprint text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'fingerprint', p_resolution_fingerprint,
    'definitions', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'kind', p_kind,
        'key', p_definition_key,
        'rootId', p_root_id,
        'exactVersion', p_release_version
      )
    )
  )
$function$;

grant execute on function pg_temp.consumer_resolution_snapshot(uuid,text,text,text,text) to vortex_runtime, vortex_request;
grant usage on schema extensions to vortex_request, vortex_runtime;

set local role vortex_runtime;
select vortex_context.initialize(pg_temp.consumer_read_system_context());
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select * from vortex_definition.append_release(
  '31000000-0000-4000-8000-000000000070'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('1', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_temp.consumer_release_compilation(
      '31000000-0000-4000-8000-000000000070'::uuid,
      '21000000-0000-4000-8000-000000000070'::uuid,
      'module',
      'example.consumer_module',
      '1.0.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('revision', 1),
      'sha256:' || pg_catalog.repeat('3', 64),
      'sha256:' || pg_catalog.repeat('2', 64)
    ),
    'resolutionSnapshot', pg_temp.consumer_resolution_snapshot(
      '31000000-0000-4000-8000-000000000070'::uuid,
      'module',
      'example.consumer_module',
      '1.0.0',
      'sha256:' || pg_catalog.repeat('2', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('4', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Initial consumer release',
    'dependencies', '[]'::jsonb
  )
);
select * from vortex_definition.save_draft(
  '31000000-0000-4000-8000-000000000070'::uuid,
  1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.consumer_module","body":{}}'::jsonb,
  'sha256:' || pg_catalog.repeat('5', 64),
  '[{"definitionKey":"example.consumer_module","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.consumer_module"]}]'::jsonb
);
select * from vortex_definition.append_release(
  '31000000-0000-4000-8000-000000000070'::uuid,
  2,
  'sha256:' || pg_catalog.repeat('5', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.1.0',
    'compilationOutput', pg_temp.consumer_release_compilation(
      '31000000-0000-4000-8000-000000000070'::uuid,
      '21000000-0000-4000-8000-000000000070'::uuid,
      'module',
      'example.consumer_module',
      '1.1.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('revision', 2),
      'sha256:' || pg_catalog.repeat('7', 64),
      'sha256:' || pg_catalog.repeat('6', 64)
    ),
    'resolutionSnapshot', pg_temp.consumer_resolution_snapshot(
      '31000000-0000-4000-8000-000000000070'::uuid,
      'module',
      'example.consumer_module',
      '1.1.0',
      'sha256:' || pg_catalog.repeat('6', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('6', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Later consumer release',
    'dependencies', '[]'::jsonb
  )
);

select * from vortex_definition.append_release(
  '31000000-0000-4000-8000-000000000071'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_temp.consumer_release_compilation(
      '31000000-0000-4000-8000-000000000071'::uuid,
      '21000000-0000-4000-8000-000000000070'::uuid,
      'application',
      'example.consumer_application',
      '1.0.0',
      '1.0.0',
      '{}'::jsonb,
      'sha256:' || pg_catalog.repeat('b', 64),
      'sha256:' || pg_catalog.repeat('a', 64)
    ),
    'resolutionSnapshot', pg_temp.consumer_resolution_snapshot(
      '31000000-0000-4000-8000-000000000071'::uuid,
      'application',
      'example.consumer_application',
      '1.0.0',
      'sha256:' || pg_catalog.repeat('a', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Consumer application V1 release',
    'dependencies', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'kind', 'module',
        'key', 'example.consumer_module',
        'rootId', '31000000-0000-4000-8000-000000000070'::uuid,
        'releaseRevision', 1,
        'releaseVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
      )
    )
  )
);
select * from vortex_definition.save_draft(
  '31000000-0000-4000-8000-000000000071'::uuid,
  1,
  '{"source_contract_version":"2.0.0","kind":"application","key":"example.consumer_application","body":{"shells":[],"pages":[]}}'::jsonb,
  'sha256:' || pg_catalog.repeat('d', 64),
  '[{"definitionKey":"example.consumer_application","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.consumer_application"]}]'::jsonb
);
select * from vortex_definition.append_release(
  '31000000-0000-4000-8000-000000000071'::uuid,
  2,
  'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '2.0.0',
    'compilationOutput', pg_temp.consumer_release_compilation(
      '31000000-0000-4000-8000-000000000071'::uuid,
      '21000000-0000-4000-8000-000000000070'::uuid,
      'application',
      'example.consumer_application',
      '2.0.0',
      '2.0.0',
      pg_catalog.jsonb_build_object('shells', pg_catalog.jsonb_build_array(), 'pages', pg_catalog.jsonb_build_array()),
      'sha256:' || pg_catalog.repeat('f', 64),
      'sha256:' || pg_catalog.repeat('e', 64)
    ),
    'resolutionSnapshot', pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'fingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
      'identities', '[]'::jsonb,
      'definitions', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'kind', 'application',
          'key', 'example.consumer_application',
          'rootId', '31000000-0000-4000-8000-000000000071'::uuid,
          'exactVersion', '2.0.0'
        )
      )
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('f', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
    'validationContractVersion', '2.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('0', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Consumer application V2 release',
    'dependencies', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'kind', 'module',
        'key', 'example.consumer_module',
        'rootId', '31000000-0000-4000-8000-000000000070'::uuid,
        'releaseRevision', 1,
        'releaseVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
      ),
      pg_catalog.jsonb_build_object(
        'kind', 'platform_block',
        'blockId', '61000000-0000-4000-8000-000000000070'::uuid,
        'releaseVersion', '2.1.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
        'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
      )
    )
  )
);

create function pg_temp.consumer_read_system_context_org_71()
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '11000000-0000-4000-8000-000000000070'::uuid,
    'organizationId', '21000000-0000-4000-8000-000000000071'::uuid,
    'sessionId', '61000000-0000-4000-8000-000000000070'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '71000000-0000-4000-8000-000000000071'::uuid,
    'systemActorId', '91000000-0000-4000-8000-000000000070'::uuid,
    'authenticationStrength', 'service'
  )
$function$;

grant execute on function pg_temp.consumer_read_system_context_org_71() to vortex_runtime, vortex_request;

set local role vortex_runtime;
select pg_catalog.set_config('vortex.request_context', '', true);
select vortex_context.initialize(pg_temp.consumer_read_system_context_org_71());
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select * from vortex_definition.append_release(
  '31000000-0000-4000-8000-000000000072'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_temp.consumer_release_compilation(
      '31000000-0000-4000-8000-000000000072'::uuid,
      '21000000-0000-4000-8000-000000000071'::uuid,
      'module',
      'example.foreign_module',
      '1.0.0',
      '1.0.0',
      '{}'::jsonb,
      'sha256:' || pg_catalog.repeat('f', 64),
      'sha256:' || pg_catalog.repeat('e', 64)
    ),
    'resolutionSnapshot', pg_temp.consumer_resolution_snapshot(
      '31000000-0000-4000-8000-000000000072'::uuid,
      'module',
      'example.foreign_module',
      '1.0.0',
      'sha256:' || pg_catalog.repeat('e', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('f', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('0', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Foreign consumer release',
    'dependencies', '[]'::jsonb
  )
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

grant execute on function pg_temp.consumer_read_context() to vortex_runtime, vortex_request;

set local role vortex_runtime;
select pg_catalog.set_config('vortex.request_context', '', true);
select vortex_context.initialize(pg_temp.consumer_read_context());
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select ok(
  (
    vortex_definition.read_consumer_release(
      'module', '31000000-0000-4000-8000-000000000070', null
    ) ->> 'releaseRevision'
  ) = '2',
  'current selects the root pointer and its immutable release together'
);
select ok(
  (
    vortex_definition.read_consumer_release(
      'module', '31000000-0000-4000-8000-000000000070', 1
    ) -> 'compilationOutput' -> 'canonical' -> 'content' ->> 'revision'
  ) = '1',
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
  ) ->> 'sourceContractVersion',
  '1.0.0',
  'consumer evidence preserves the exact historical V1 application source contract version'
);
select is(
  vortex_definition.read_consumer_release(
    'application', '31000000-0000-4000-8000-000000000071', 1
  ) ->> 'contentFingerprint',
  'sha256:' || pg_catalog.repeat('b', 64),
  'the later V2 release does not rewrite the exact historical V1 application fingerprint'
);
select is(
  vortex_definition.read_consumer_release(
    'application', '31000000-0000-4000-8000-000000000071', 2
  ) ->> 'sourceContractVersion',
  '2.0.0',
  'consumer evidence preserves the exact later V2 application source contract version'
);
select is(
  (
    select item.value
    from pg_catalog.jsonb_array_elements(
      vortex_definition.read_consumer_release(
        'application', '31000000-0000-4000-8000-000000000071', 2
      ) -> 'dependencyManifest'
    ) as item(value)
    where item.value ->> 'kind' = 'platform_block'
  ),
  pg_catalog.jsonb_build_object(
    'kind', 'platform_block',
    'blockId', '61000000-0000-4000-8000-000000000070'::uuid,
    'releaseVersion', '2.1.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
    'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
  ),
  'consumer evidence reproduces the exact stored platform-block dependency'
);
select is(
  vortex_definition.read_consumer_release(
    'application', '31000000-0000-4000-8000-000000000071', 2
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
delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select vortex_definition.read_consumer_release('module', '31000000-0000-4000-8000-000000000070', 1)$$,
  '55000',
  'Vortex request context is not established',
  'a missing request context is refused before release evidence returns'
);

reset role;
select * from finish();
rollback;
