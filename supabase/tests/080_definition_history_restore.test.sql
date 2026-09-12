\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_definition', 'postgres', false, true
);

select has_function(
  'vortex_definition', 'list_release_history', array['text', 'uuid', 'integer', 'bigint'],
  'Definition exposes a bounded same-organisation immutable release-history read'
);
select has_function(
  'vortex_definition', 'read_release_history_entry', array['text', 'uuid', 'bigint'],
  'Definition exposes one exact immutable release-history metadata read'
);
select has_function(
  'vortex_definition', 'read_restore_release_evidence', array['text', 'uuid', 'bigint'],
  'Definition exposes the narrow private evidence required to verify one restore target'
);
select has_function(
  'vortex_definition', 'restore_release_draft', array['text', 'uuid', 'bigint', 'bigint', 'text', 'jsonb'],
  'Definition exposes one conditional immutable-source restore operation'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.list_release_history(text,uuid,integer,bigint)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.read_release_history_entry(text,uuid,bigint)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.read_restore_release_evidence(text,uuid,bigint)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)',
    'EXECUTE'
  ),
  'only the request boundary receives the four history and restore entry points'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)',
    'EXECUTE'
  ),
  'public, Supabase and runtime roles cannot bypass the request restore boundary'
);
select is(
  (
    select prosecdef
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)'::regprocedure
  ),
  true,
  'the restore operation executes within the protected private-operation boundary'
);
select is(
  (
    select provolatile
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.list_release_history(text,uuid,integer,bigint)'::regprocedure
  ),
  's'::"char",
  'the release-history page is stable within one statement snapshot'
);
select is(
  (
    select provolatile
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)'::regprocedure
  ),
  'v'::"char",
  'the conditional restore is correctly declared volatile'
);
select is(
  (
    select pg_catalog.array_to_string(proconfig, ',')
    from pg_catalog.pg_proc
    where oid = 'vortex_definition.restore_release_draft(text,uuid,bigint,bigint,text,jsonb)'::regprocedure
  ),
  'search_path=""',
  'the restore operation fixes an empty search path'
);
select has_column(
  'vortex_definition', 'drafts', 'restored_from_release_revision',
  'drafts store the immutable release revision from which they were restored'
);
select has_column(
  'vortex_definition', 'drafts', 'restore_correlation_id',
  'drafts store the operation correlation identifier for restores'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.drafts'::regclass
      and conname = 'drafts_restore_provenance_all_or_none'
  ),
  'restore provenance is all-or-none at the storage boundary'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.drafts'::regclass
      and conname = 'drafts_restored_release_source_fk'
      and pg_catalog.pg_get_constraintdef(oid) like
        'FOREIGN KEY (root_id, restored_from_release_revision, restored_from_source_fingerprint)%REFERENCES vortex_definition.releases%'
  ),
  'restore provenance references one exact immutable release source snapshot'
);
select has_index(
  'vortex_definition',
  'drafts',
  'drafts_restored_release_source_idx',
  array[
    'root_id',
    'restored_from_release_revision',
    'restored_from_source_fingerprint'
  ]::name[],
  'restore provenance foreign-key checks use a covering index'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '18000000-0000-4000-8000-000000000080',
  'history_restore_tenant',
  'History restore tenant',
  'active',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
(
  '28000000-0000-4000-8000-000000000080',
  '18000000-0000-4000-8000-000000000080',
  null,
  'history_restore_org',
  'History restore organisation',
  'active',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080',
  pg_catalog.statement_timestamp(),
  1
),
(
  '28000000-0000-4000-8000-000000000081',
  '18000000-0000-4000-8000-000000000080',
  null,
  'history_restore_other_org',
  'History restore other organisation',
  'active',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
(
  '38000000-0000-4000-8000-000000000080',
  '28000000-0000-4000-8000-000000000080',
  'module',
  'example.history_restore',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
),
(
  '38000000-0000-4000-8000-000000000081',
  '28000000-0000-4000-8000-000000000080',
  'application',
  'example.history_restore',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
),
(
  '38000000-0000-4000-8000-000000000082',
  '28000000-0000-4000-8000-000000000081',
  'module',
  'example.history_restore',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
);

insert into vortex_definition.source_identities (
  identity_id, root_id, owner_scope, kind, component_owner, created_at, created_by
) values (
  '38000000-0000-4000-8000-000000000080',
  '38000000-0000-4000-8000-000000000080',
  'document',
  'root',
  'root',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
);
insert into vortex_definition.source_identity_aliases (
  root_id, owner_scope, scope, kind, alias, component_owner, identity_id, created_at, created_by
) values (
  '38000000-0000-4000-8000-000000000080',
  'document',
  'document',
  'root',
  'example.history_restore',
  'root',
  '38000000-0000-4000-8000-000000000080',
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
);

insert into vortex_definition.drafts (
  root_id, draft_revision, draft_source, source_contract_version, source_fingerprint,
  identity_requirements, updated_at, updated_by
) values
(
  '38000000-0000-4000-8000-000000000080', 1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_restore","body":{"marker":"old"}}'::jsonb,
  '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
  '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb,
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
),
(
  '38000000-0000-4000-8000-000000000081', 1,
  '{"source_contract_version":"2.0.0","kind":"application","key":"example.history_restore","body":{"shells":[],"pages":[]}}'::jsonb,
  '2.0.0', 'sha256:' || pg_catalog.repeat('a', 64),
  '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb,
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
),
(
  '38000000-0000-4000-8000-000000000082', 1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_restore","body":{"marker":"foreign"}}'::jsonb,
  '1.0.0', 'sha256:' || pg_catalog.repeat('7', 64),
  '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb,
  pg_catalog.statement_timestamp(),
  '98000000-0000-4000-8000-000000000080'
);

create or replace function pg_temp.history_restore_context()
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '18000000-0000-4000-8000-000000000080'::uuid,
    'organizationId', '28000000-0000-4000-8000-000000000080'::uuid,
    'sessionId', '68000000-0000-4000-8000-000000000080'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '78000000-0000-4000-8000-000000000080'::uuid,
    'systemActorId', '98000000-0000-4000-8000-000000000080'::uuid,
    'authenticationStrength', 'service'
  )
$function$;

create function pg_temp.history_restore_release_compilation(
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

create or replace function pg_temp.history_restore_context_org_081()
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '18000000-0000-4000-8000-000000000080'::uuid,
    'organizationId', '28000000-0000-4000-8000-000000000081'::uuid,
    'sessionId', '68000000-0000-4000-8000-000000000081'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '78000000-0000-4000-8000-000000000081'::uuid,
    'systemActorId', '98000000-0000-4000-8000-000000000080'::uuid,
    'authenticationStrength', 'service'
  )
$function$;

create function pg_temp.history_restore_resolution_snapshot(
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

grant execute on function pg_temp.history_restore_context() to vortex_runtime, vortex_request;
grant execute on function pg_temp.history_restore_context_org_081() to vortex_runtime, vortex_request;
grant execute on function pg_temp.history_restore_release_compilation(uuid,uuid,text,text,text,text,jsonb,text,text) to vortex_runtime, vortex_request;
grant execute on function pg_temp.history_restore_resolution_snapshot(uuid,text,text,text,text) to vortex_runtime, vortex_request;
grant usage on schema extensions to vortex_runtime, vortex_request;

set local role vortex_runtime;
select vortex_context.initialize(pg_temp.history_restore_context());
set local role vortex_request;

select * from vortex_definition.append_release(
  '38000000-0000-4000-8000-000000000080'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('1', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_temp.history_restore_release_compilation(
      '38000000-0000-4000-8000-000000000080'::uuid,
      '28000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.0.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('marker', 'old'),
      'sha256:' || pg_catalog.repeat('b', 64),
      'sha256:' || pg_catalog.repeat('a', 64)
    ),
    'resolutionSnapshot', pg_temp.history_restore_resolution_snapshot(
      '38000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.0.0',
      'sha256:' || pg_catalog.repeat('a', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Initial generic release',
    'dependencies', '[]'::jsonb
  )
);
select * from vortex_definition.save_draft(
  '38000000-0000-4000-8000-000000000080'::uuid,
  1,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_restore","body":{"marker":"middle"}}'::jsonb,
  'sha256:' || pg_catalog.repeat('2', 64),
  '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
);
select * from vortex_definition.append_release(
  '38000000-0000-4000-8000-000000000080'::uuid,
  2,
  'sha256:' || pg_catalog.repeat('2', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.1.0',
    'compilationOutput', pg_temp.history_restore_release_compilation(
      '38000000-0000-4000-8000-000000000080'::uuid,
      '28000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.1.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('marker', 'middle'),
      'sha256:' || pg_catalog.repeat('f', 64),
      'sha256:' || pg_catalog.repeat('e', 64)
    ),
    'resolutionSnapshot', pg_temp.history_restore_resolution_snapshot(
      '38000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.1.0',
      'sha256:' || pg_catalog.repeat('e', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('f', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('0', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Middle generic release',
    'dependencies', '[]'::jsonb
  )
);
select * from vortex_definition.save_draft(
  '38000000-0000-4000-8000-000000000080'::uuid,
  2,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_restore","body":{"marker":"current"}}'::jsonb,
  'sha256:' || pg_catalog.repeat('3', 64),
  '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
);
select * from vortex_definition.append_release(
  '38000000-0000-4000-8000-000000000080'::uuid,
  3,
  'sha256:' || pg_catalog.repeat('3', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.2.0',
    'compilationOutput', pg_temp.history_restore_release_compilation(
      '38000000-0000-4000-8000-000000000080'::uuid,
      '28000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.2.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('marker', 'current'),
      'sha256:' || pg_catalog.repeat('5', 64),
      'sha256:' || pg_catalog.repeat('4', 64)
    ),
    'resolutionSnapshot', pg_temp.history_restore_resolution_snapshot(
      '38000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.2.0',
      'sha256:' || pg_catalog.repeat('4', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('4', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('6', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Current generic release',
    'dependencies', '[]'::jsonb
  )
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.history_restore_context_org_081());
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select * from vortex_definition.append_release(
  '38000000-0000-4000-8000-000000000082'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('7', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_temp.history_restore_release_compilation(
      '38000000-0000-4000-8000-000000000082'::uuid,
      '28000000-0000-4000-8000-000000000081'::uuid,
      'module',
      'example.history_restore',
      '1.0.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('marker', 'foreign'),
      'sha256:' || pg_catalog.repeat('9', 64),
      'sha256:' || pg_catalog.repeat('8', 64)
    ),
    'resolutionSnapshot', pg_temp.history_restore_resolution_snapshot(
      '38000000-0000-4000-8000-000000000082'::uuid,
      'module',
      'example.history_restore',
      '1.0.0',
      'sha256:' || pg_catalog.repeat('8', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('9', 64),
  'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Foreign generic release',
    'dependencies', '[]'::jsonb
  )
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.history_restore_context());
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select * from vortex_definition.append_release(
  '38000000-0000-4000-8000-000000000081'::uuid,
  1,
  'sha256:' || pg_catalog.repeat('a', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.0.0',
    'compilationOutput', pg_temp.history_restore_release_compilation(
      '38000000-0000-4000-8000-000000000081'::uuid,
      '28000000-0000-4000-8000-000000000080'::uuid,
      'application',
      'example.history_restore',
      '1.0.0',
      '2.0.0',
      pg_catalog.jsonb_build_object(
        'shells', pg_catalog.jsonb_build_array(),
        'pages', pg_catalog.jsonb_build_array()
      ),
      'sha256:' || pg_catalog.repeat('c', 64),
      'sha256:' || pg_catalog.repeat('b', 64)
    ),
    'resolutionSnapshot', pg_temp.history_restore_resolution_snapshot(
      '38000000-0000-4000-8000-000000000081'::uuid,
      'application',
      'example.history_restore',
      '1.0.0',
      'sha256:' || pg_catalog.repeat('b', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
    'validationContractVersion', '2.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('d', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Native application release',
    'dependencies', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'kind', 'platform_block',
        'blockId', '68000000-0000-4000-8000-000000000080'::uuid,
        'releaseVersion', '3.0.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
        'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('f', 64)
      )
    )
  )
);

select is(
  pg_catalog.jsonb_build_array(
    vortex_definition.list_release_history(
      'module', '38000000-0000-4000-8000-000000000080', 2, null
    ) -> 'entries' -> 0 ->> 'releaseRevision',
    vortex_definition.list_release_history(
      'module', '38000000-0000-4000-8000-000000000080', 2, null
    ) -> 'entries' -> 1 ->> 'releaseRevision',
    vortex_definition.list_release_history(
      'module', '38000000-0000-4000-8000-000000000080', 2, null
    ) -> 'entries' -> 0 ->> 'releaseNote',
    vortex_definition.list_release_history(
      'module', '38000000-0000-4000-8000-000000000080', 2, null
    ) -> 'entries' -> 0 ->> 'isCurrent'
  ),
  '["3","2","Current generic release","true"]'::jsonb,
  'the first bounded history page is newest-first with the root pointer marked current'
);
select is(
  vortex_definition.list_release_history(
    'module', '38000000-0000-4000-8000-000000000080', 2, null
  ) ->> 'nextBeforeReleaseRevision',
  '2',
  'a bounded history page exposes a strict cursor for the next older page'
);
select is(
  vortex_definition.list_release_history(
    'module', '38000000-0000-4000-8000-000000000080', 2, 2
  ) -> 'entries' -> 0 ->> 'releaseRevision',
  '1',
  'the continuation starts strictly below the previous page cursor'
);
select pg_catalog.set_config(
  'vortex.test_history_previous_cursor',
  vortex_definition.list_release_history(
    'module', '38000000-0000-4000-8000-000000000080', 2, null
  ) ->> 'nextBeforeReleaseRevision',
  true
);
savepoint history_append_proof;
reset role;
select * from vortex_definition.save_draft(
  '38000000-0000-4000-8000-000000000080'::uuid,
  3,
  '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_restore","body":{"marker":"newest"}}'::jsonb,
  'sha256:' || pg_catalog.repeat('4', 64),
  '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
);
select * from vortex_definition.append_release(
  '38000000-0000-4000-8000-000000000080'::uuid,
  4,
  'sha256:' || pg_catalog.repeat('4', 64),
  pg_catalog.jsonb_build_object(
    'releaseVersion', '1.3.0',
    'compilationOutput', pg_temp.history_restore_release_compilation(
      '38000000-0000-4000-8000-000000000080'::uuid,
      '28000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.3.0',
      '1.0.0',
      pg_catalog.jsonb_build_object('marker', 'newest'),
      'sha256:' || pg_catalog.repeat('8', 64),
      'sha256:' || pg_catalog.repeat('7', 64)
    ),
    'resolutionSnapshot', pg_temp.history_restore_resolution_snapshot(
      '38000000-0000-4000-8000-000000000080'::uuid,
      'module',
      'example.history_restore',
      '1.3.0',
      'sha256:' || pg_catalog.repeat('7', 64)
    ),
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
    'validationContractVersion', '1.0.0',
    'comparisonFingerprint', 'sha256:' || pg_catalog.repeat('9', 64),
    'impactReasons', '[]'::jsonb,
    'releaseNote', 'Later generic release',
    'dependencies', '[]'::jsonb
  )
);
set local role vortex_request;
select is(
  (
    select pg_catalog.jsonb_agg(entry.value ->> 'releaseRevision' order by entry.ordinality)
    from pg_catalog.jsonb_array_elements(
      vortex_definition.list_release_history(
        'module',
        '38000000-0000-4000-8000-000000000080',
        2,
        pg_catalog.current_setting('vortex.test_history_previous_cursor')::bigint
      ) -> 'entries'
    ) with ordinality as entry(value, ordinality)
  ),
  '["1"]'::jsonb,
  'an older continuation remains isolated from a later append without duplicate or omitted older entries'
);
select is(
  vortex_definition.list_release_history(
    'module', '38000000-0000-4000-8000-000000000080', 2, null
  ) -> 'entries' -> 0 ->> 'releaseRevision',
  '4',
  'a fresh first history page sees the appended latest immutable release'
);
reset role;
rollback to savepoint history_append_proof;
set local role vortex_request;
select ok(
  not (
    vortex_definition.list_release_history(
      'module', '38000000-0000-4000-8000-000000000080', 2, null
    ) -> 'entries' -> 0 ?| array[
      'authoredSource', 'sourceContractVersion', 'compilationOutput',
      'resolutionSnapshot', 'dependencyManifest', 'identityEvidence'
    ]
  ),
  'history entries expose metadata only and never leak authored source or restoration evidence'
);
select ok(
  not (
    vortex_definition.read_release_history_entry(
      'module', '38000000-0000-4000-8000-000000000080', 1
    ) -> 'entry' ?| array['authoredSource', 'compilationOutput', 'identityEvidence']
  ),
  'an exact history entry remains metadata-only'
);
select is(
  vortex_definition.read_restore_release_evidence(
    'module', '38000000-0000-4000-8000-000000000080', 1
  ) -> 'authoredSource' -> 'body' ->> 'marker',
  'old',
  'restore evidence contains the exact immutable authored source only through its narrow operation'
);
select is(
  (
    select item.value
    from pg_catalog.jsonb_array_elements(
      vortex_definition.read_restore_release_evidence(
        'application', '38000000-0000-4000-8000-000000000081', 1
      ) -> 'dependencyManifest'
    ) as item(value)
    where item.value ->> 'kind' = 'platform_block'
  ),
  pg_catalog.jsonb_build_object(
    'kind', 'platform_block',
    'blockId', '68000000-0000-4000-8000-000000000080'::uuid,
    'releaseVersion', '3.0.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
    'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('f', 64)
  ),
  'restore evidence reproduces the exact platform-block dependency for a stored V2 release'
);
select is(
  vortex_definition.list_release_history(
    'application', '38000000-0000-4000-8000-000000000080', 1, null
  ),
  null::jsonb,
  'a wrong kind is indistinguishable from a missing history root'
);
select is(
  vortex_definition.list_release_history(
    'module', '38000000-0000-4000-8000-000000000082', 1, null
  ),
  null::jsonb,
  'another organisation history root is indistinguishable from absence'
);
select is(
  vortex_definition.read_release_history_entry(
    'module', '38000000-0000-4000-8000-000000000080', 99
  ),
  null::jsonb,
  'a missing immutable release is absent'
);
select throws_ok(
  $$select vortex_definition.list_release_history('module', '38000000-0000-4000-8000-000000000080', 0, null)$$,
  '22023',
  'Definition release history has an invalid selector',
  'invalid history pagination is refused before database evidence returns'
);

savepoint restore_rollback_proof;
select is(
  vortex_definition.restore_release_draft(
    'module',
    '38000000-0000-4000-8000-000000000080',
    1,
    3,
    'sha256:' || pg_catalog.repeat('1', 64),
    '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
  ) ->> 'draftRevision',
  '4',
  'a verified restore increments the expected draft revision exactly once'
);
rollback to savepoint restore_rollback_proof;
reset role;
select is(
  (
    select pg_catalog.jsonb_build_object(
      'revision', draft_revision,
      'marker', draft_source #>> '{body,marker}',
      'provenance', restored_from_release_revision
    )
    from vortex_definition.drafts
    where root_id = '38000000-0000-4000-8000-000000000080'
  ),
  '{"marker":"current","provenance":null,"revision":3}'::jsonb,
  'a rolled-back restore leaves neither draft changes nor provenance behind'
);
set local role vortex_request;
select is(
  vortex_definition.restore_release_draft(
    'module',
    '38000000-0000-4000-8000-000000000080',
    1,
    3,
    'sha256:' || pg_catalog.repeat('1', 64),
    '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
  ) ->> 'draftRevision',
  '4',
  'the committed verified restore advances the draft once'
);
reset role;
select is(
  (
    select pg_catalog.jsonb_build_object(
      'marker', draft_source #>> '{body,marker}',
      'fingerprint', source_fingerprint,
      'fromRevision', restored_from_release_revision,
      'fromFingerprint', restored_from_source_fingerprint,
      'by', restored_by,
      'correlation', restore_correlation_id,
      'hasTimestamp', restored_at is not null
    )
    from vortex_definition.drafts
    where root_id = '38000000-0000-4000-8000-000000000080'
  ),
  pg_catalog.jsonb_build_object(
    'marker', 'old',
    'fingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
    'fromRevision', 1,
    'fromFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
    'by', '98000000-0000-4000-8000-000000000080'::uuid,
    'correlation', '78000000-0000-4000-8000-000000000080'::uuid,
    'hasTimestamp', true
  ),
  'restore copies the immutable source and records complete verified provenance'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'releaseCount', (select count(*) from vortex_definition.releases where root_id = '38000000-0000-4000-8000-000000000080'),
      'currentRevision', (select current_release_revision from vortex_definition.roots where root_id = '38000000-0000-4000-8000-000000000080'),
      'identityCount', (select count(*) from vortex_definition.source_identities where root_id = '38000000-0000-4000-8000-000000000080'),
      'aliasCount', (select count(*) from vortex_definition.source_identity_aliases where root_id = '38000000-0000-4000-8000-000000000080'),
      'consumerMarker', vortex_definition.read_consumer_release('module', '38000000-0000-4000-8000-000000000080', null) -> 'compilationOutput' -> 'canonical' -> 'content' ->> 'marker'
    )
  ),
  '{"aliasCount":1,"consumerMarker":"current","currentRevision":3,"identityCount":1,"releaseCount":3}'::jsonb,
  'restore leaves immutable releases, the current pointer, consumer reads and identities unchanged'
);
set local role vortex_request;
select is(
  vortex_definition.restore_release_draft(
    'module',
    '38000000-0000-4000-8000-000000000080',
    1,
    3,
    'sha256:' || pg_catalog.repeat('1', 64),
    '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
  ),
  null::jsonb,
  'a stale competing restore changes nothing and is indistinguishable from a stale draft'
);
reset role;
select is(
  (
    select draft_revision
    from vortex_definition.drafts
    where root_id = '38000000-0000-4000-8000-000000000080'
  ),
  4::bigint,
  'the stale competing restore cannot increment the draft a second time'
);
set local role vortex_request;
select is(
  (
    select draft_revision
    from vortex_definition.save_draft(
      '38000000-0000-4000-8000-000000000080',
      4,
      '{"source_contract_version":"1.0.0","kind":"module","key":"example.history_restore","body":{"marker":"ordinary-save"}}'::jsonb,
      'sha256:' || pg_catalog.repeat('f', 64),
      '[{"definitionKey":"example.history_restore","ownerScope":"document","scope":"document","kind":"root","componentOwner":"root","aliases":["example.history_restore"]}]'::jsonb
    )
  ),
  5::bigint,
  'an ordinary save continues to use the normal one-step optimistic draft update'
);
reset role;
select is(
  (
    select pg_catalog.num_nonnulls(
      restored_from_release_revision,
      restored_from_source_fingerprint,
      restored_by,
      restored_at,
      restore_correlation_id
    )
    from vortex_definition.drafts
    where root_id = '38000000-0000-4000-8000-000000000080'
  ),
  0,
  'an ordinary save clears all restore provenance'
);

reset role;
select * from finish();
rollback;
