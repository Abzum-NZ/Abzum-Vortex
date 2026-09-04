\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_definition', 'postgres', false, true
);

select has_function(
  'vortex_definition', 'read_publication_state', array['uuid'],
  'the Definition service exposes one organization-scoped publication-state read operation'
);
select has_function(
  'vortex_definition', 'append_release', array['uuid', 'bigint', 'text', 'jsonb'],
  'the Definition service exposes one atomic append-and-advance publication operation'
);
select has_function(
  'vortex_definition', 'list_module_releases', array['text'],
  'the Definition service exposes a same-organization Module dependency release listing'
);
select has_function(
  'vortex_definition', 'read_module_release', array['uuid', 'bigint'],
  'the Definition service exposes an exact same-organization Module dependency release read'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_definition.read_publication_state(uuid)', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_definition.list_module_releases(text)', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_definition.read_module_release(uuid,bigint)', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_definition.append_release(uuid,bigint,text,jsonb)', 'EXECUTE'
  ),
  'request code can use only the narrow publication operations'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_definition.append_release(uuid,bigint,text,jsonb)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_definition.list_module_releases(text)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role', 'vortex_definition.read_publication_state(uuid)', 'EXECUTE'
  ),
  'runtime and Supabase service roles cannot bypass the Definition request boundary'
);
select is(
  (select prosecdef from pg_catalog.pg_proc
    where oid = 'vortex_definition.append_release(uuid,bigint,text,jsonb)'::regprocedure),
  true,
  'publication appends execute inside the protected private-operation boundary'
);
select is(
  (select array_to_string(proconfig, ',') = 'search_path=""'
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.read_publication_state(uuid)'::regprocedure),
  true,
  'publication reads use an empty search path'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  '10000000-0000-4000-8000-000000000060',
  'publication_operation_tenant',
  'Publication operation tenant',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
(
  '20000000-0000-4000-8000-000000000060',
  '10000000-0000-4000-8000-000000000060',
  null,
  'publication_operation_org',
  'Publication operation organization',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060',
  pg_catalog.statement_timestamp(),
  1
),
(
  '20000000-0000-4000-8000-000000000061',
  '10000000-0000-4000-8000-000000000060',
  null,
  'publication_other_org',
  'Publication other organization',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060',
  pg_catalog.statement_timestamp(),
  1
);

create function pg_temp.publication_operation_context()
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '10000000-0000-4000-8000-000000000060'::uuid,
    'organizationId', '20000000-0000-4000-8000-000000000060'::uuid,
    'sessionId', '60000000-0000-4000-8000-000000000060'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000060'::uuid,
    'systemActorId', '90000000-0000-4000-8000-000000000060'::uuid,
    'authenticationStrength', 'service'
  )
$function$;

grant execute on function pg_temp.publication_operation_context() to vortex_runtime;
grant usage on schema extensions to vortex_runtime, vortex_request;

set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;

select root_id
from vortex_definition.create_root(
  'module',
  'example.publication_dependency',
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.publication_dependency","body":{}}'::jsonb,
  'sha256:' || pg_catalog.repeat('a', 64),
  '[{"definitionKey":"example.publication_dependency","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.publication_dependency"]}]'::jsonb
) \gset publication_dependency_

select root_id
from vortex_definition.create_root(
  'application',
  'example.publication_application',
  '{"source_contract_version":"1.0.0","kind":"application","key":"example.publication_application","body":{}}'::jsonb,
  'sha256:' || pg_catalog.repeat('b', 64),
  '[{"definitionKey":"example.publication_application","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.publication_application"]}]'::jsonb
) \gset publication_application_

reset role;

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output, resolution_snapshot,
  content_fingerprint, resolution_fingerprint, validation_contract_version,
  comparison_fingerprint, impact_reasons, release_note, published_at, published_by
) values (
  :'publication_dependency_root_id'::uuid,
  1,
  '1.0.0',
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.publication_dependency","body":{}}'::jsonb,
  'sha256:' || pg_catalog.repeat('a', 64),
  '1.0.0',
  '{"kind":"module","canonical":{"envelope":{"kind":"module"},"content":{}}}'::jsonb,
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('d', 64)),
  'sha256:' || pg_catalog.repeat('c', 64),
  'sha256:' || pg_catalog.repeat('d', 64),
  '1.0.0',
  'sha256:' || pg_catalog.repeat('e', 64),
  '[]'::jsonb,
  'Initial dependency release',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);
update vortex_definition.roots
set current_release_revision = 1
where root_id = :'publication_dependency_root_id'::uuid;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '30000000-0000-4000-8000-000000000060',
  '20000000-0000-4000-8000-000000000061',
  'module',
  'example.publication_dependency',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);
insert into vortex_definition.drafts (
  root_id, draft_revision, draft_source, source_contract_version, source_fingerprint, updated_at, updated_by
) values (
  '30000000-0000-4000-8000-000000000060',
  1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.publication_dependency","body":{}}'::jsonb,
  '1.0.0',
  'sha256:' || pg_catalog.repeat('f', 64),
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;

select is(
  (vortex_definition.read_publication_state(:'publication_application_root_id'::uuid) -> 'draft' ->> 'publishedRevision') is null,
  true,
  'the publication read returns the current root, draft and unpublished pointer evidence'
);
select is(
  pg_catalog.jsonb_array_length(
    vortex_definition.read_publication_state(:'publication_application_root_id'::uuid) -> 'identities'
  ),
  1,
  'the publication read returns permanent source identity aliases needed for compilation'
);
select is(
  (
    select pg_catalog.jsonb_agg(subject order by subject collate "C")
    from (values ('module:a.a'), ('module:a_a.a')) as subjects(subject)
  ),
  '["module:a.a", "module:a_a.a"]'::jsonb,
  'database manifest ordering matches the runtime ordinal contract under hosted ICU collations'
);
select ok(
  pg_catalog.pg_get_functiondef(
    'vortex_definition.append_release(uuid,bigint,text,jsonb)'::regprocedure
  ) like '%dependency.dependency_reference collate "C"%',
  'the atomic append returns its exact manifest with explicit ordinal collation'
);
select throws_ok(
  $$select vortex_definition.read_publication_state('30000000-0000-4000-8000-000000000060'::uuid)$$,
  '42501'::char(5),
  'Definition root does not belong to the context organization',
  'publication reads reject a root from another organization'
);
select is(
  pg_catalog.jsonb_array_length(
    vortex_definition.list_module_releases('example.publication_dependency')
  ),
  1,
  'module release listing returns only exact same-organization releases for the requested key'
);
select is(
  vortex_definition.read_module_release(
    :'publication_dependency_root_id'::uuid, 1
  ) -> 'resolutionSnapshot' ->> 'fingerprint',
  'sha256:' || pg_catalog.repeat('d', 64),
  'exact module reads return the immutable resolution snapshot rather than current aliases'
);
select is(
  vortex_definition.read_module_release(
    :'publication_dependency_root_id'::uuid, 1
  ) -> 'compilationOutput' ->> 'kind',
  'module',
  'exact module reads return the complete immutable compilation output'
);
select throws_ok(
  $$select vortex_definition.read_module_release('30000000-0000-4000-8000-000000000060'::uuid, 1)$$,
  '42501'::char(5),
  'Definition root does not belong to the context organization',
  'exact module reads reject a root from another organization'
);

select *
from vortex_definition.append_release(
  :'publication_application_root_id'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('b', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
      'artifact', pg_catalog.jsonb_build_object(
        'kind', 'application',
        'rootId', :'publication_application_root_id'::uuid,
        'definitionKey', 'example.publication_application',
        'exactVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
      ),
      'canonical', pg_catalog.jsonb_build_object(
        'envelope', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'key', 'example.publication_application',
          'rootId', :'publication_application_root_id'::uuid,
          'organizationId', '20000000-0000-4000-8000-000000000060'::uuid
        ),
        'content', '{}'::jsonb
      )
    ),
    'resolutionSnapshot', pg_catalog.jsonb_build_object(
      'fingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
      'definitions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'application', 'key', 'example.publication_application',
        'rootId', :'publication_application_root_id'::uuid, 'exactVersion', '1.0.0'
      ))
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Initial application release',
    'dependencies', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'kind', 'module',
        'key', 'example.publication_dependency',
        'rootId', :'publication_dependency_root_id'::uuid,
        'releaseRevision', 1,
        'releaseVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
      ),
      pg_catalog.jsonb_build_object(
        'kind', 'connection_type',
        'key', 'vortex.connection_type',
        'rootId', '40000000-0000-4000-8000-000000000060'::uuid,
        'releaseVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('4', 64),
        'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
      ),
      pg_catalog.jsonb_build_object(
        'kind', 'platform_theme',
        'catalogueThemeId', '50000000-0000-4000-8000-000000000060'::uuid,
        'releaseVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('6', 64),
        'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
      )
    )
  )
) \gset publication_result_

reset role;

select is(:'publication_result_root_id'::uuid, :'publication_application_root_id'::uuid,
  'append returns the root it published');
select is(:'publication_result_release_revision'::bigint, 1::bigint,
  'append publishes the exact current draft revision');
select is(:'publication_result_published_by'::uuid, '90000000-0000-4000-8000-000000000060'::uuid,
  'append derives the actor from validated system context rather than the supplied payload');
select is(
  pg_catalog.jsonb_array_length(:'publication_result_dependency_manifest'::jsonb),
  3,
  'append returns the exact one-for-one dependency manifest'
);
select is(
  (select current_release_revision from vortex_definition.roots
    where root_id = :'publication_application_root_id'::uuid),
  1::bigint,
  'append advances only the published root current-release pointer'
);
select is(
  (select count(*)::integer from vortex_definition.release_dependencies
    where root_id = :'publication_application_root_id'::uuid and release_revision = 1),
  3,
  'append records one immutable row for each supplied dependency'
);
select is(
  (select evidence_fingerprint from vortex_definition.release_dependencies
    where root_id = :'publication_application_root_id'::uuid
      and release_revision = 1 and dependency_kind = 'platform_theme'),
  'sha256:' || pg_catalog.repeat('7', 64),
  'platform catalogue evidence is stored without pretending a theme has a namespaced key'
);
select is(
  (select target_root_id from vortex_definition.release_dependencies
    where root_id = :'publication_application_root_id'::uuid
      and release_revision = 1 and dependency_kind = 'module'),
  :'publication_dependency_root_id'::uuid,
  'a module dependency binds the exact target root and release evidence'
);
select is(
  pg_catalog.jsonb_array_length(
    vortex_definition.read_publication_state(:'publication_application_root_id'::uuid) -> 'history' -> 'history'
  ),
  1,
  'the publication read returns immutable release history after publication'
);
select is(
  (
    vortex_definition.read_publication_state(:'publication_application_root_id'::uuid)
      -> 'history' -> 'history' -> 0 -> 'dependencyManifest' -> 0 ? 'key'
  ),
  false,
  'published history exposes public dependency references rather than internal exact manifest entries'
);
select is(
  vortex_definition.read_publication_state(:'publication_application_root_id'::uuid)
    -> 'history' -> 'history' -> 0 -> 'dependencyManifest' -> 0 ->> 'revision',
  '1',
  'published history binds a module dependency to its immutable published release reference'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;

select is(
  (select published_revision from vortex_definition.save_draft(
    :'publication_application_root_id'::uuid,
    1,
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.publication_application","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('8', 64),
    '[{"definitionKey":"example.publication_application","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.publication_application"]}]'::jsonb
  )),
  1::bigint,
  'saving after publication returns the exact current published revision'
);

reset role;

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;

select throws_ok(
  format(
    $sql$
      select * from vortex_definition.append_release(
        %L::uuid, 2, 'sha256:%s',
        jsonb_build_object(
          'releaseVersion', '1.0.1',
          'compilationOutput', jsonb_build_object(
            'kind', 'application',
            'resolutionFingerprint', 'sha256:' || repeat('2', 64),
            'artifact', jsonb_build_object(
              'kind', 'application', 'rootId', %L::uuid,
              'definitionKey', 'example.publication_application', 'exactVersion', '1.0.1',
              'contentFingerprint', 'sha256:' || repeat('1', 64),
              'resolutionFingerprint', 'sha256:' || repeat('2', 64)
            ),
            'canonical', jsonb_build_object(
              'envelope', jsonb_build_object(
                'kind', 'application', 'key', 'example.publication_application',
                'rootId', %L::uuid, 'organizationId',
                '20000000-0000-4000-8000-000000000060'::uuid
              ), 'content', '{}'::jsonb
            )
          ),
          'resolutionSnapshot', jsonb_build_object(
            'fingerprint', 'sha256:' || repeat('2', 64),
            'definitions', jsonb_build_array(jsonb_build_object(
              'kind', 'application', 'key', 'example.publication_application',
              'rootId', %L::uuid, 'exactVersion', '1.0.1'
            ))
          ),
          'contentFingerprint', 'sha256:%s',
          'resolutionFingerprint', 'sha256:%s',
          'validationContractVersion', '1.0.0',
          'comparisonFingerprint', 'sha256:%s',
          'impactReasons', '[]'::jsonb,
          'releaseNote', 'Substituted module resolution evidence',
          'dependencies', jsonb_build_array(jsonb_build_object(
            'kind', 'module', 'key', 'example.publication_dependency',
            'rootId', %L::uuid, 'releaseRevision', 1, 'releaseVersion', '1.0.0',
            'contentFingerprint', 'sha256:%s',
            'resolutionFingerprint', 'sha256:%s'
          ))
        )
      )
    $sql$,
    :'publication_application_root_id', pg_catalog.repeat('8', 64),
    :'publication_application_root_id', :'publication_application_root_id',
    :'publication_application_root_id', pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64), pg_catalog.repeat('3', 64),
    :'publication_dependency_root_id', pg_catalog.repeat('c', 64), pg_catalog.repeat('f', 64)
  ),
  '23514'::char(5),
  'Module dependency does not identify an exact same-organization module release',
  'append rejects a module whose resolution evidence was substituted'
);

select throws_ok(
  format(
    $sql$
      select * from vortex_definition.append_release(
        %L::uuid, 1, 'sha256:%s',
        jsonb_build_object(
          'releaseVersion', '1.0.1',
          'compilationOutput', jsonb_build_object(
            'kind', 'application',
            'resolutionFingerprint', 'sha256:' || repeat('2', 64),
            'artifact', jsonb_build_object(
              'kind', 'application', 'rootId', %L::uuid,
              'definitionKey', 'example.publication_application', 'exactVersion', '1.0.1',
              'contentFingerprint', 'sha256:' || repeat('1', 64),
              'resolutionFingerprint', 'sha256:' || repeat('2', 64)
            ),
            'canonical', jsonb_build_object(
              'envelope', jsonb_build_object(
                'kind', 'application', 'key', 'example.publication_application',
                'rootId', %L::uuid, 'organizationId',
                '20000000-0000-4000-8000-000000000060'::uuid
              ), 'content', '{}'::jsonb
            )
          ),
          'resolutionSnapshot', jsonb_build_object(
            'fingerprint', 'sha256:' || repeat('2', 64),
            'definitions', jsonb_build_array(jsonb_build_object(
              'kind', 'application', 'key', 'example.publication_application',
              'rootId', %L::uuid, 'exactVersion', '1.0.1'
            ))
          ),
          'contentFingerprint', 'sha256:%s',
          'resolutionFingerprint', 'sha256:%s',
          'validationContractVersion', '1.0.0',
          'comparisonFingerprint', 'sha256:%s',
          'impactReasons', '[]'::jsonb,
          'releaseNote', 'Stale release',
          'dependencies', '[]'::jsonb
        )
      )
    $sql$,
    :'publication_application_root_id', pg_catalog.repeat('b', 64),
    :'publication_application_root_id', :'publication_application_root_id',
    :'publication_application_root_id', pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64), pg_catalog.repeat('3', 64)
  ),
  '40001'::char(5),
  'Definition release append is stale or source evidence was substituted',
  'append rejects stale draft revisions and substituted source evidence'
);

select throws_ok(
  format(
    $sql$
      select * from vortex_definition.append_release(
        %L::uuid, 2, 'sha256:%s',
        jsonb_build_object(
          'releaseVersion', '1.0.1',
          'compilationOutput', jsonb_build_object(
            'kind', 'application', 'resolutionFingerprint', 'sha256:%s',
            'artifact', jsonb_build_object(
              'kind', 'application', 'rootId', %L::uuid,
              'definitionKey', 'example.publication_application', 'exactVersion', '1.0.1',
              'contentFingerprint', 'sha256:%s', 'resolutionFingerprint', 'sha256:%s'
            ),
            'canonical', jsonb_build_object('envelope', jsonb_build_object(
              'kind', 'application', 'key', 'example.publication_application',
              'rootId', %L::uuid, 'organizationId',
              '20000000-0000-4000-8000-000000000060'::uuid
            ), 'content', '{}'::jsonb)
          ),
          'resolutionSnapshot', jsonb_build_object(
            'fingerprint', 'sha256:%s',
            'definitions', jsonb_build_array(jsonb_build_object(
              'kind', 'application', 'key', 'example.publication_application',
              'rootId', %L::uuid, 'exactVersion', '1.0.1'
            ))
          ),
          'contentFingerprint', 'sha256:%s', 'resolutionFingerprint', 'sha256:%s',
          'validationContractVersion', '1.0.0', 'comparisonFingerprint', 'sha256:%s',
          'impactReasons', '[]'::jsonb, 'releaseNote', 'Invalid artifact evidence',
          'dependencies', '[]'::jsonb
        )
      )
    $sql$,
    :'publication_application_root_id', pg_catalog.repeat('8', 64),
    pg_catalog.repeat('2', 64), :'publication_application_root_id', pg_catalog.repeat('9', 64),
    pg_catalog.repeat('2', 64), :'publication_application_root_id', pg_catalog.repeat('2', 64),
    :'publication_application_root_id', pg_catalog.repeat('1', 64),
    pg_catalog.repeat('2', 64), pg_catalog.repeat('3', 64)
  ),
  '23514'::char(5),
  'Definition compilation output does not match immutable release evidence',
  'append rejects a compiled artifact substituted from the confirmed release evidence'
);

reset role;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '30000000-0000-4000-8000-000000000062',
  '20000000-0000-4000-8000-000000000060',
  'application',
  'example.failure_atomicity',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);
insert into vortex_definition.drafts (
  root_id, draft_revision, draft_source, source_contract_version, source_fingerprint, updated_at, updated_by
) values (
  '30000000-0000-4000-8000-000000000062',
  1,
  '{"source_contract_version":"1.0.0","kind":"application","key":"example.failure_atomicity","body":{}}'::jsonb,
  '1.0.0',
  'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);

create function pg_temp.abort_definition_dependency_write()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'injected dependency write failure' using errcode = 'P0001';
end
$function$;
create trigger release_dependencies_test_abort
before insert on vortex_definition.release_dependencies
for each row execute function pg_temp.abort_definition_dependency_write();

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;

select throws_ok(
  $$
    select * from vortex_definition.append_release(
      '30000000-0000-4000-8000-000000000062'::uuid,
      1,
      'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      jsonb_build_object(
        'releaseVersion', '1.0.0',
        'compilationOutput', jsonb_build_object(
          'kind', 'application',
          'resolutionFingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'artifact', jsonb_build_object(
            'kind', 'application', 'rootId', '30000000-0000-4000-8000-000000000062'::uuid,
            'definitionKey', 'example.failure_atomicity', 'exactVersion', '1.0.0',
            'contentFingerprint', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'resolutionFingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          ),
          'canonical', jsonb_build_object(
            'envelope', jsonb_build_object(
              'kind', 'application', 'key', 'example.failure_atomicity',
              'rootId', '30000000-0000-4000-8000-000000000062'::uuid,
              'organizationId', '20000000-0000-4000-8000-000000000060'::uuid
            ), 'content', '{}'::jsonb
          )
        ),
        'resolutionSnapshot', jsonb_build_object(
          'fingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'definitions', jsonb_build_array(jsonb_build_object(
            'kind', 'application', 'key', 'example.failure_atomicity',
            'rootId', '30000000-0000-4000-8000-000000000062'::uuid, 'exactVersion', '1.0.0'
          ))
        ),
        'contentFingerprint', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'resolutionFingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'validationContractVersion', '1.0.0',
        'comparisonFingerprint', 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'impactReasons', '[]'::jsonb,
        'releaseNote', 'Injected failure release',
        'dependencies', jsonb_build_array(jsonb_build_object(
          'kind', 'connection_type', 'key', 'vortex.failure_connection',
          'rootId', '40000000-0000-4000-8000-000000000061'::uuid,
          'releaseVersion', '1.0.0',
          'contentFingerprint', 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          'catalogueFingerprint', 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        ))
      )
    )
  $$,
  'P0001'::char(5),
  'injected dependency write failure',
  'a dependency-write failure aborts the private publication operation'
);

reset role;

select is(
  (select count(*)::integer from vortex_definition.releases
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  0,
  'an injected dependency failure leaves no partial immutable release'
);
select is(
  (select count(*)::integer from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  0,
  'an injected dependency failure leaves no partial dependency manifest'
);
select is(
  (select current_release_revision from vortex_definition.roots
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  null::bigint,
  'an injected dependency failure leaves the current-release pointer unchanged'
);

drop trigger release_dependencies_test_abort on vortex_definition.release_dependencies;

create function pg_temp.failure_release_payload()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
      'artifact', pg_catalog.jsonb_build_object(
        'kind', 'application',
        'rootId', '30000000-0000-4000-8000-000000000062'::uuid,
        'definitionKey', 'example.failure_atomicity',
        'exactVersion', '1.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('b', 64)
      ),
      'canonical', pg_catalog.jsonb_build_object(
        'envelope', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'key', 'example.failure_atomicity',
          'rootId', '30000000-0000-4000-8000-000000000062'::uuid,
          'organizationId', '20000000-0000-4000-8000-000000000060'::uuid
        ),
        'content', '{}'::jsonb
      )
    ),
    'resolutionSnapshot', pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'fingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
      'definitions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'application',
        'key', 'example.failure_atomicity',
        'rootId', '30000000-0000-4000-8000-000000000062'::uuid,
        'exactVersion', '1.0.0'
      )),
      'identities', '[]'::jsonb
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Injected failure release',
    'dependencies', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', 'connection_type',
      'key', 'vortex.failure_connection',
      'rootId', '40000000-0000-4000-8000-000000000061'::uuid,
      'releaseVersion', '1.0.0',
      'contentFingerprint', 'sha256:' || pg_catalog.repeat('d', 64),
      'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('e', 64)
    ))
  )
$function$;
grant execute on function pg_temp.failure_release_payload() to vortex_request;

create function pg_temp.abort_definition_pointer_write()
returns trigger
language plpgsql
as $function$
begin
  if new.root_id = '30000000-0000-4000-8000-000000000062'::uuid
    and new.current_release_revision is not null then
    raise exception 'injected pointer write failure' using errcode = 'P0001';
  end if;
  return new;
end
$function$;
create trigger roots_pointer_test_abort
before update of current_release_revision on vortex_definition.roots
for each row execute function pg_temp.abort_definition_pointer_write();

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_definition.append_release(
      '30000000-0000-4000-8000-000000000062'::uuid,
      1,
      'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      pg_temp.failure_release_payload()
    )
  $$,
  'P0001'::char(5),
  'injected pointer write failure',
  'a pointer-write failure rolls back the release and dependency writes'
);
reset role;

select is(
  (select count(*)::integer from vortex_definition.releases
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  0,
  'an injected pointer failure leaves no partial immutable release'
);
select is(
  (select count(*)::integer from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  0,
  'an injected pointer failure leaves no partial dependency manifest'
);
select is(
  (select current_release_revision from vortex_definition.roots
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  null::bigint,
  'an injected pointer failure leaves the discovery pointer unchanged'
);
drop trigger roots_pointer_test_abort on vortex_definition.roots;

create function pg_temp.abort_definition_release_write()
returns trigger
language plpgsql
as $function$
begin
  if new.root_id = '30000000-0000-4000-8000-000000000062'::uuid then
    raise exception 'injected release write failure' using errcode = 'P0001';
  end if;
  return new;
end
$function$;
create trigger releases_test_abort
before insert on vortex_definition.releases
for each row execute function pg_temp.abort_definition_release_write();

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_definition.append_release(
      '30000000-0000-4000-8000-000000000062'::uuid,
      1,
      'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      pg_temp.failure_release_payload()
    )
  $$,
  'P0001'::char(5),
  'injected release write failure',
  'a release-write failure commits no publication effect'
);
reset role;

select is(
  (select count(*)::integer from vortex_definition.releases
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  0,
  'an injected release failure leaves no immutable release'
);
select is(
  (select count(*)::integer from vortex_definition.release_dependencies
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  0,
  'an injected release failure leaves no dependency manifest'
);
select is(
  (select current_release_revision from vortex_definition.roots
    where root_id = '30000000-0000-4000-8000-000000000062'::uuid),
  null::bigint,
  'an injected release failure leaves the discovery pointer unchanged'
);
drop trigger releases_test_abort on vortex_definition.releases;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '30000000-0000-4000-8000-000000000063',
  '20000000-0000-4000-8000-000000000060',
  'module',
  'example.release_history_limit',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);
insert into vortex_definition.drafts (
  root_id, draft_revision, draft_source, source_contract_version,
  source_fingerprint, updated_at, updated_by
) values (
  '30000000-0000-4000-8000-000000000063',
  10001,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.release_history_limit","body":{}}'::jsonb,
  '1.0.0',
  'sha256:' || pg_catalog.repeat('9', 64),
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'
);
insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
)
select
  '30000000-0000-4000-8000-000000000063'::uuid,
  revision,
  '0.0.' || revision,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.release_history_limit","body":{}}'::jsonb,
  'sha256:' || pg_catalog.repeat('1', 64),
  '1.0.0',
  '{}'::jsonb,
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  '1.0.0',
  'sha256:' || pg_catalog.repeat('4', 64),
  '[]'::jsonb,
  'History limit fixture',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000060'::uuid
from pg_catalog.generate_series(1, 10000) as revision;
update vortex_definition.roots
set current_release_revision = 10000
where root_id = '30000000-0000-4000-8000-000000000063'::uuid;

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_definition.append_release(
      '30000000-0000-4000-8000-000000000063'::uuid,
      10001,
      'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      '{}'::jsonb
    )
  $$,
  '22023'::char(5),
  'Definition release append has an invalid request shape',
  'malformed release evidence is rejected before the history limit is evaluated'
);
reset role;

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.publication_operation_context());
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_definition.append_release(
      '30000000-0000-4000-8000-000000000063'::uuid,
      10001,
      'sha256:9999999999999999999999999999999999999999999999999999999999999999',
      jsonb_build_object(
        'releaseVersion', '1.0.0',
        'compilationOutput', jsonb_build_object(
          'kind', 'module',
          'resolutionFingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'artifact', jsonb_build_object(
            'kind', 'module', 'rootId', '30000000-0000-4000-8000-000000000063'::uuid,
            'definitionKey', 'example.release_history_limit', 'exactVersion', '1.0.0',
            'contentFingerprint', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'resolutionFingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          ),
          'canonical', jsonb_build_object(
            'envelope', jsonb_build_object(
              'kind', 'module', 'key', 'example.release_history_limit',
              'rootId', '30000000-0000-4000-8000-000000000063'::uuid,
              'organizationId', '20000000-0000-4000-8000-000000000060'::uuid
            ),
            'content', '{}'::jsonb
          )
        ),
        'resolutionSnapshot', jsonb_build_object(
          'fingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'definitions', jsonb_build_array(jsonb_build_object(
            'kind', 'module', 'key', 'example.release_history_limit',
            'rootId', '30000000-0000-4000-8000-000000000063'::uuid,
            'exactVersion', '1.0.0'
          ))
        ),
        'contentFingerprint', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'resolutionFingerprint', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'validationContractVersion', '1.0.0',
        'comparisonFingerprint', 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'impactReasons', '[]'::jsonb,
        'releaseNote', 'Rejected over history limit',
        'dependencies', '[]'::jsonb
      )
    )
  $$,
  '54000'::char(5),
  'Definition release history reached its supported limit',
  'the database enforces the same ten-thousand-release bound as the runtime contract'
);
reset role;

select * from finish();

rollback;
