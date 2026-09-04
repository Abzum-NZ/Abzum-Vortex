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

select has_table('vortex_definition', 'roots', 'Definition root storage exists');
select has_table('vortex_definition', 'drafts', 'Definition draft storage exists');
select tables_are(
  'vortex_definition',
  array[
    'drafts', 'release_dependencies', 'releases', 'roots',
    'source_identities', 'source_identity_aliases'
  ],
  'Definition storage contains roots, drafts, identities and immutable releases'
);
select columns_are(
  'vortex_definition',
  'roots',
  array[
    'root_id', 'organization_id', 'kind', 'key', 'created_at', 'created_by',
    'current_release_revision'
  ],
  'root columns contain permanent identity, creation evidence and the discovery pointer'
);
select columns_are(
  'vortex_definition',
  'drafts',
  array[
    'root_id', 'draft_revision', 'draft_source', 'source_contract_version',
    'identity_requirements', 'source_fingerprint', 'updated_at', 'updated_by',
    'restored_from_release_revision', 'restored_from_source_fingerprint',
    'restored_by', 'restored_at', 'restore_correlation_id'
  ],
  'draft columns contain current authored source, identity requirements, update evidence and optional restore provenance'
);
select col_type_is('vortex_definition', 'roots', 'root_id', 'uuid', 'root identifiers use UUID');
select col_type_is(
  'vortex_definition',
  'drafts',
  'draft_revision',
  'bigint',
  'draft revisions use exact integer storage'
);
select col_type_is(
  'vortex_definition',
  'drafts',
  'draft_source',
  'jsonb',
  'complete authored source uses jsonb'
);
select col_type_is(
  'vortex_definition',
  'drafts',
  'identity_requirements',
  'jsonb',
  'current source identity requirements use jsonb'
);
select col_type_is(
  'vortex_definition',
  'roots',
  'created_at',
  'timestamp with time zone',
  'root creation time is unambiguous'
);
select col_type_is(
  'vortex_definition',
  'drafts',
  'updated_at',
  'timestamp with time zone',
  'draft update time is unambiguous'
);
select has_pk('vortex_definition', 'roots', 'roots have a primary key');
select has_pk('vortex_definition', 'drafts', 'one draft is keyed by one root');
select has_fk('vortex_definition', 'roots', 'roots reference an owning organisation');
select has_fk('vortex_definition', 'drafts', 'drafts reference their permanent root');
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.roots'::regclass
      and conname = 'roots_organization_kind_key_unique'
      and pg_catalog.pg_get_constraintdef(oid) = 'UNIQUE (organization_id, kind, key)'
  ),
  'root keys are unique only within organisation and definition kind'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.drafts'::regclass
      and conname = 'drafts_revision_range'
      and pg_catalog.pg_get_constraintdef(oid) =
        'CHECK (((draft_revision >= 1) AND (draft_revision <= ''9007199254740991''::bigint)))'
  ),
  'draft revision storage is bounded by the JavaScript-safe integer maximum'
);
select has_check(
  'vortex_definition',
  'roots',
  'root storage has named checks including finite creation evidence'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.roots'::regclass
      and conname = 'roots_created_at_finite'
      and pg_catalog.pg_get_constraintdef(oid) like '%created_at <>%infinity%'
  ),
  'root creation timestamps must be finite'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_definition.drafts'::regclass
      and conname = 'drafts_updated_at_finite'
      and pg_catalog.pg_get_constraintdef(oid) like '%updated_at <>%infinity%'
  ),
  'draft update timestamps must be finite'
);
select is(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'vortex_definition.roots'::regclass),
  true,
  'root storage enables row security'
);
select is(
  (select relforcerowsecurity from pg_catalog.pg_class where oid = 'vortex_definition.roots'::regclass),
  true,
  'root storage forces row security'
);
select is(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'vortex_definition.drafts'::regclass),
  true,
  'draft storage enables row security'
);
select is(
  (select relforcerowsecurity from pg_catalog.pg_class where oid = 'vortex_definition.drafts'::regclass),
  true,
  'draft storage forces row security'
);
select is(
  (select count(*)::integer from pg_catalog.pg_policies where schemaname = 'vortex_definition'),
  0,
  'private Definition tables expose no direct row-security policy'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class
    where relnamespace = 'vortex_definition'::regnamespace
      and relkind in ('r', 'p')
      and relowner <> 'postgres'::regrole
  ),
  0,
  'postgres owns every Definition relation'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) as privilege
    left join pg_catalog.pg_roles as granted_role on granted_role.oid = privilege.grantee
    where relation.relnamespace = 'vortex_definition'::regnamespace
      and relation.relkind in ('r', 'p')
      and (
        privilege.grantee = 0
        or granted_role.rolname in (
          'anon', 'authenticated', 'service_role', 'vortex_runtime', 'vortex_request'
        )
      )
  ),
  0,
  'no public, Data API, runtime or request table privilege exists'
);
select is(
  (
    select pg_catalog.array_agg(function.proname::text order by function.proname)
    from pg_catalog.pg_proc as function
    cross join lateral pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
    ) as privilege
    where function.pronamespace = 'vortex_definition'::regnamespace
      and privilege.grantee = 'vortex_request'::regrole
      and privilege.privilege_type = 'EXECUTE'
  ),
  array[
    'append_release',
    'create_root',
    'list_module_releases',
    'list_release_history',
    'read_consumer_release',
    'read_module_release',
    'read_publication_state',
    'read_release_history_entry',
    'read_restore_release_evidence',
    'restore_release_draft',
    'save_draft'
  ],
  'request receives EXECUTE only on the narrow Definition entry points'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as function
    cross join lateral pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
    ) as privilege
    left join pg_catalog.pg_roles as granted_role on granted_role.oid = privilege.grantee
    where function.pronamespace = 'vortex_definition'::regnamespace
      and privilege.privilege_type = 'EXECUTE'
      and (
        privilege.grantee = 0
        or granted_role.rolname in ('anon', 'authenticated', 'service_role', 'vortex_runtime')
      )
  ),
  0,
  'PUBLIC, Data API and runtime roles cannot execute any Definition function'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.create_root(text,text,jsonb,text,jsonb)',
    'EXECUTE'
  ),
  'request may create roots only through the exact entry point'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.save_draft(uuid,bigint,jsonb,text,jsonb)',
    'EXECUTE'
  ),
  'request may save drafts only through the exact entry point'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.validated_system_context()',
    'EXECUTE'
  ),
  'request cannot execute the internal context validator directly'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as function
    where function.pronamespace = 'vortex_definition'::regnamespace
      and function.proowner <> 'postgres'::regrole
  ),
  0,
  'postgres owns every Definition function'
);
select is(
  (
    select pg_catalog.array_agg(function.proname::text order by function.proname)
    from pg_catalog.pg_proc as function
    where function.pronamespace = 'vortex_definition'::regnamespace
      and function.prosecdef
  ),
  array[
    'append_release',
    'create_root',
    'list_module_releases',
    'list_release_history',
    'read_consumer_release',
    'read_module_release',
    'read_publication_state',
    'read_release_history_entry',
    'read_restore_release_evidence',
    'restore_release_draft',
    'save_draft'
  ],
  'only table-isolating Definition entry points are security definer'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as function
    where function.pronamespace = 'vortex_definition'::regnamespace
      and function.proconfig @> array['search_path=""']
  ),
  18,
  'every Definition function fixes an empty search path'
);
select has_function(
  'vortex_definition',
  'create_root',
  array['text', 'text', 'jsonb', 'text', 'jsonb'],
  'root creation has no caller-supplied root identifier argument'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as function
    where function.oid =
      'vortex_definition.create_root(text,text,jsonb,text,jsonb)'::regprocedure
      and 'uuid'::regtype::oid = any (function.proargtypes::oid[])
  ),
  0,
  'the root creation input cannot carry a permanent UUID'
);
select is(
  pg_catalog.pg_get_function_result(
    'vortex_definition.create_root(text,text,jsonb,text,jsonb)'::regprocedure
  ),
  'TABLE(root_id uuid, organization_id uuid, kind text, definition_key text, draft_revision bigint, published_revision bigint, authored_source jsonb, source_contract_version text, source_fingerprint text, created_at timestamp with time zone, created_by uuid, updated_at timestamp with time zone, updated_by uuid)',
  'create returns the complete stored-draft contract'
);
select is(
  pg_catalog.pg_get_function_result(
    'vortex_definition.save_draft(uuid,bigint,jsonb,text,jsonb)'::regprocedure
  ),
  'TABLE(root_id uuid, organization_id uuid, kind text, definition_key text, draft_revision bigint, published_revision bigint, authored_source jsonb, source_contract_version text, source_fingerprint text, created_at timestamp with time zone, created_by uuid, updated_at timestamp with time zone, updated_by uuid)',
  'save returns the complete stored-draft contract'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values
  (
    '10000000-0000-4000-8000-000000000031', 'definition_tenant_one',
    'Definition tenant one', 'active', pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000031', pg_catalog.statement_timestamp(), 1
  ),
  (
    '10000000-0000-4000-8000-000000000032', 'definition_tenant_two',
    'Definition tenant two', 'active', pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000031', pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '20000000-0000-4000-8000-000000000031',
    '10000000-0000-4000-8000-000000000031', null, 'definition_org_one',
    'Definition organisation one', 'active', pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000031', pg_catalog.statement_timestamp(), 1
  ),
  (
    '20000000-0000-4000-8000-000000000032',
    '10000000-0000-4000-8000-000000000032', null, 'definition_org_two',
    'Definition organisation two', 'active', pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000031', pg_catalog.statement_timestamp(), 1
  );

set constraints all immediate;

create function pg_temp.definition_test_context(
  caller_kind text,
  tenant_id uuid,
  organization_id uuid,
  actor_id uuid
)
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'callerKind', caller_kind,
    'tenantId', tenant_id,
    'organizationId', organization_id,
    'sessionId', '60000000-0000-4000-8000-000000000030'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000030'::uuid,
    'systemActorId', case when caller_kind = 'system' then actor_id end,
    'authenticationStrength', case
      when caller_kind = 'system' then 'service'
      when caller_kind = 'public' then 'anonymous'
    end
  ))
$function$;

create function pg_temp.definition_root_requirements(
  definition_key text,
  root_alias text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'definitionKey', definition_key,
      'ownerScope', 'document',
      'scope', 'document',
      'kind', 'root',
      'componentOwner', 'root',
      'aliases', pg_catalog.jsonb_build_array(definition_key, root_alias)
    )
  )
$function$;

grant execute on function pg_temp.definition_test_context(text, uuid, uuid, uuid)
  to vortex_runtime;
grant execute on function pg_temp.definition_root_requirements(text, text)
  to vortex_request;
grant usage on schema extensions to vortex_runtime, vortex_request;

set local role vortex_runtime;
select vortex_context.initialize(pg_temp.definition_test_context(
  'system',
  '10000000-0000-4000-8000-000000000031',
  '20000000-0000-4000-8000-000000000031',
  '90000000-0000-4000-8000-000000000031'
));
set local role vortex_request;
select is(
  (
    select count(*)::integer
    from vortex_definition.create_root(
      'module',
      'vortex.shared.root',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"shared_root",
        "key":"vortex.shared.root",
        "body":{"order":["first","second"],"preserved":{"enabled":true}}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('a', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'shared_root')
    )
  ),
  1,
  'system context creates one Module root and initial draft'
);
select is(
  (
    select count(*)::integer
    from vortex_definition.create_root(
      'application',
      'vortex.shared.root',
      '{
        "source_contract_version":"1.0.0",
        "kind":"application",
        "root_alias":"shared_application",
        "key":"vortex.shared.root",
        "body":{"pages":[]}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('b', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'shared_application')
    )
  ),
  1,
  'the same organisation may use one key for both definition kinds'
);
select throws_ok(
  $$
    select *
    from vortex_definition.create_root(
      'module',
      'vortex.shared.root',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"duplicate_root",
        "key":"vortex.shared.root",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('c', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'duplicate_root')
    )
  $$,
  '23505'::char(5),
  null::text,
  'a duplicate organisation, kind and key is refused'
);
reset role;

select is(
  (
    select count(*)::integer
    from vortex_definition.roots
    where organization_id = '20000000-0000-4000-8000-000000000031'
      and key = 'vortex.shared.root'
  ),
  2,
  'the duplicate attempt leaves only the Module and Application roots'
);
select is(
  (
    select count(*)::integer
    from vortex_definition.drafts
    where draft_revision = 1
  ),
  2,
  'root creation atomically creates exactly one initial draft per successful root'
);
select ok(
  not exists (
    select 1
    from vortex_definition.roots
    where root_id = '00000000-0000-0000-0000-000000000000'::uuid
  ),
  'internally allocated root identifiers are non-nil'
);
select is(
  (
    select count(distinct root_id)::integer
    from vortex_definition.roots
    where organization_id = '20000000-0000-4000-8000-000000000031'
  ),
  2,
  'each successful creation allocates a distinct permanent root identifier'
);
select is(
  (
    select created_by
    from vortex_definition.roots
    where organization_id = '20000000-0000-4000-8000-000000000031'
      and kind = 'module'
      and key = 'vortex.shared.root'
  ),
  '90000000-0000-4000-8000-000000000031'::uuid,
  'root creator comes from the validated system context'
);
select ok(
  (
    select root.created_at = draft.updated_at
      and root.created_by = draft.updated_by
    from vortex_definition.roots as root
    join vortex_definition.drafts as draft on draft.root_id = root.root_id
    where root.organization_id = '20000000-0000-4000-8000-000000000031'
      and root.kind = 'module'
      and root.key = 'vortex.shared.root'
  ),
  'the database records one creation instant and context actor for root and initial draft'
);
select is(
  (
    select draft_source #> '{body,order}'
    from vortex_definition.drafts as draft
    join vortex_definition.roots as root on root.root_id = draft.root_id
    where root.organization_id = '20000000-0000-4000-8000-000000000031'
      and root.kind = 'module'
      and root.key = 'vortex.shared.root'
  ),
  '["first", "second"]'::jsonb,
  'authored JSON values and array order are preserved'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.definition_test_context(
  'system',
  '10000000-0000-4000-8000-000000000032',
  '20000000-0000-4000-8000-000000000032',
  '90000000-0000-4000-8000-000000000032'
));
set local role vortex_request;
select is(
  (
    select count(*)::integer
    from vortex_definition.create_root(
      'module',
      'vortex.shared.root',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"other_org_root",
        "key":"vortex.shared.root",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('d', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'other_org_root')
    )
  ),
  1,
  'another organisation may use the same kind and key'
);
reset role;
select is(
  (
    select count(*)::integer
    from vortex_definition.roots
    where kind = 'module' and key = 'vortex.shared.root'
  ),
  2,
  'same-kind roots with one key remain separately organisation-owned'
);

select pg_catalog.set_config(
  'vortex.test_module_root',
  (
    select root_id::text
    from vortex_definition.roots
    where organization_id = '20000000-0000-4000-8000-000000000031'
      and kind = 'module'
      and key = 'vortex.shared.root'
  ),
  true
);
select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.definition_test_context(
  'system',
  '10000000-0000-4000-8000-000000000031',
  '20000000-0000-4000-8000-000000000031',
  '90000000-0000-4000-8000-000000000033'
));
set local role vortex_request;
select is(
  (
    select draft_revision
    from vortex_definition.save_draft(
      pg_catalog.current_setting('vortex.test_module_root')::uuid,
      1,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"shared_root",
        "key":"vortex.shared.root",
        "body":{"order":["second","first"],"preserved":{"enabled":false}}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('e', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'shared_root')
    )
  ),
  2::bigint,
  'a current expected revision saves once and returns the next exact revision'
);
select is(
  (
    select count(*)::integer
    from vortex_definition.save_draft(
      pg_catalog.current_setting('vortex.test_module_root')::uuid,
      1,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"stale_attempt",
        "key":"vortex.shared.root",
        "body":{"order":["stale"]}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('f', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'stale_attempt')
    )
  ),
  0,
  'a stale expected revision returns no saved draft'
);
select is(
  (
    select count(*)::integer
    from vortex_definition.save_draft(
      '30000000-0000-4000-8000-000000000038'::uuid,
      1,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"missing_root",
        "key":"vortex.missing.root",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('9', 64),
      pg_temp.definition_root_requirements('vortex.missing.root', 'missing_root')
    )
  ),
  0,
  'a missing root returns no saved draft without creating state'
);
select throws_ok(
  $$
    select *
    from vortex_definition.save_draft(
      pg_catalog.current_setting('vortex.test_module_root')::uuid,
      9007199254740992,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"unsafe_revision",
        "key":"vortex.shared.root",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('0', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'unsafe_revision')
    )
  $$,
  '22023'::char(5),
  'Definition draft save has an invalid root or expected revision',
  'save refuses an expected revision outside the JavaScript-safe range'
);
reset role;

select is(
  (
    select draft_revision
    from vortex_definition.drafts
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  ),
  2::bigint,
  'the successful save increments the stored revision exactly once'
);
select is(
  (
    select source_fingerprint
    from vortex_definition.drafts
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  ),
  'sha256:' || pg_catalog.repeat('e', 64),
  'the stale save does not change the current source fingerprint'
);
select is(
  (
    select draft_source #> '{body,order}'
    from vortex_definition.drafts
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  ),
  '["second", "first"]'::jsonb,
  'the stale save does not change authored source or array order'
);
select is(
  (
    select updated_by
    from vortex_definition.drafts
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  ),
  '90000000-0000-4000-8000-000000000033'::uuid,
  'the successful save derives its update actor from current context'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.definition_test_context(
  'system',
  '10000000-0000-4000-8000-000000000032',
  '20000000-0000-4000-8000-000000000032',
  '90000000-0000-4000-8000-000000000032'
));
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_definition.save_draft(
      pg_catalog.current_setting('vortex.test_module_root')::uuid,
      2,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"foreign_attempt",
        "key":"vortex.shared.root",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('1', 64),
      pg_temp.definition_root_requirements('vortex.shared.root', 'foreign_attempt')
    )
  $$,
  '42501'::char(5),
  'Definition root does not belong to the context organization',
  'another organisation context cannot save the root'
);
reset role;

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.definition_test_context(
  'system',
  '10000000-0000-4000-8000-000000000031',
  '20000000-0000-4000-8000-000000000032',
  '90000000-0000-4000-8000-000000000031'
));
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_definition.create_root(
      'module',
      'vortex.context.mismatch',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"context_mismatch",
        "key":"vortex.context.mismatch",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('2', 64),
      pg_temp.definition_root_requirements('vortex.context.mismatch', 'context_mismatch')
    )
  $$,
  '23503'::char(5),
  'Vortex context organization does not exist in its tenant',
  'a context whose organisation is outside its tenant fails closed before creation'
);
reset role;

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.definition_test_context(
  'public',
  '10000000-0000-4000-8000-000000000031',
  '20000000-0000-4000-8000-000000000031',
  null
));
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_definition.create_root(
      'module',
      'vortex.public.refused',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"public_refused",
        "key":"vortex.public.refused",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('3', 64),
      pg_temp.definition_root_requirements('vortex.public.refused', 'public_refused')
    )
  $$,
  '42501'::char(5),
  'Definition root and draft operations require system context',
  'a syntactically valid public context cannot use Definition write operations'
);
reset role;

select pg_catalog.set_config('vortex.request_context', 'not-json', true);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_definition.create_root(
      'module',
      'vortex.malformed.refused',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"malformed_refused",
        "key":"vortex.malformed.refused",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('4', 64),
      pg_temp.definition_root_requirements('vortex.malformed.refused', 'malformed_refused')
    )
  $$,
  '22023'::char(5),
  'Stored Vortex request context is invalid',
  'malformed stored context fails closed before creation'
);
reset role;

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_definition.create_root(
      'module',
      'vortex.missing.refused',
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"missing_refused",
        "key":"vortex.missing.refused",
        "body":{}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('5', 64),
      pg_temp.definition_root_requirements('vortex.missing.refused', 'missing_refused')
    )
  $$,
  '55000'::char(5),
  'Vortex request context is not established',
  'missing context fails closed before creation'
);
reset role;

select throws_ok(
  $$
    update vortex_definition.roots
    set root_id = '30000000-0000-4000-8000-000000000039'
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  $$,
  '23514'::char(5),
  null::text,
  'root identifiers are immutable'
);
select throws_ok(
  $$
    update vortex_definition.roots
    set organization_id = '20000000-0000-4000-8000-000000000032'
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  $$,
  '23514'::char(5),
  null::text,
  'root organisation ownership is immutable'
);
select throws_ok(
  $$
    update vortex_definition.roots
    set kind = 'application'
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  $$,
  '23514'::char(5),
  null::text,
  'root kind is immutable'
);
select throws_ok(
  $$
    update vortex_definition.roots
    set key = 'vortex.renamed.root'
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  $$,
  '23514'::char(5),
  null::text,
  'root key is immutable'
);
select throws_ok(
  $$
    update vortex_definition.drafts
    set draft_revision = draft_revision + 2
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  $$,
  '23514'::char(5),
  'A definition draft revision must increment exactly once',
  'draft storage itself refuses revision jumps'
);
select throws_ok(
  $$
    update vortex_definition.drafts
    set
      draft_revision = draft_revision + 1,
      draft_source = pg_catalog.jsonb_set(draft_source, '{key}', '"vortex.changed.root"')
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  $$,
  '23514'::char(5),
  'Definition draft metadata must match its permanent root and source contract',
  'draft source cannot change the root key assignment'
);

select is(
  (
    select count(*)::integer
    from vortex_definition.roots
    where organization_id = '20000000-0000-4000-8000-000000000031'
      and kind = 'module'
      and key = 'vortex.shared.root'
  ),
  1,
  'failed context and immutable-column attempts leave the original root unchanged'
);
select is(
  (
    select draft_revision
    from vortex_definition.drafts
    where root_id = pg_catalog.current_setting('vortex.test_module_root')::uuid
  ),
  2::bigint,
  'failed stale, context and direct mutation attempts leave the saved revision unchanged'
);

select * from finish();
rollback;
