\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select has_table(
  'vortex_definition',
  'source_identities',
  'permanent source identity storage exists'
);
select has_table(
  'vortex_definition',
  'source_identity_aliases',
  'historical source alias storage exists'
);
select columns_are(
  'vortex_definition',
  'source_identities',
  array[
    'identity_id', 'root_id', 'owner_scope', 'kind', 'component_owner',
    'created_at', 'created_by'
  ],
  'identity owners contain only stable ownership and creation evidence'
);
select columns_are(
  'vortex_definition',
  'source_identity_aliases',
  array[
    'root_id', 'owner_scope', 'scope', 'kind', 'alias', 'component_owner',
    'identity_id', 'created_at', 'created_by'
  ],
  'alias history preserves stable owner scope and current lookup scope'
);
select has_pk('vortex_definition', 'source_identities', 'identity UUIDs are globally unique');
select has_pk(
  'vortex_definition',
  'source_identity_aliases',
  'one lookup alias can identify only one component within a root, scope and kind'
);
select has_fk(
  'vortex_definition',
  'source_identities',
  'source identities belong to a permanent Definition root'
);
select has_fk(
  'vortex_definition',
  'source_identity_aliases',
  'every historical alias references its exact permanent owner'
);
select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_definition.source_identities'::regclass
  ),
  true,
  'source identity storage enables row security'
);
select is(
  (
    select relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_definition.source_identities'::regclass
  ),
  true,
  'source identity storage forces row security'
);
select is(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_definition.source_identity_aliases'::regclass
  ),
  true,
  'source alias storage enables row security'
);
select is(
  (
    select relforcerowsecurity
    from pg_catalog.pg_class
    where oid = 'vortex_definition.source_identity_aliases'::regclass
  ),
  true,
  'source alias storage forces row security'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request',
    'vortex_definition.source_identities',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'request code has no direct source identity table access'
);
select ok(
  not pg_catalog.has_table_privilege(
    'service_role',
    'vortex_definition.source_identity_aliases',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'the Supabase service role cannot bypass the Definition operation boundary'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.create_root(text,text,jsonb,text,jsonb)',
    'EXECUTE'
  ),
  'request code may create roots through the identity-aware entry point'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_definition.record_source_identities(uuid,jsonb,uuid,timestamptz)',
    'EXECUTE'
  ),
  'request code cannot call the internal identity recorder directly'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  '10000000-0000-4000-8000-000000000041',
  'identity_store_tenant',
  'Identity store tenant',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000041',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '20000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000041',
  null,
  'identity_store_org',
  'Identity store organisation',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000041',
  pg_catalog.statement_timestamp(),
  1
);

set constraints all immediate;

create function pg_temp.identity_store_context()
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '10000000-0000-4000-8000-000000000041'::uuid,
    'organizationId', '20000000-0000-4000-8000-000000000041'::uuid,
    'sessionId', '60000000-0000-4000-8000-000000000041'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000041'::uuid,
    'systemActorId', '90000000-0000-4000-8000-000000000041'::uuid,
    'authenticationStrength', 'service'
  )
$function$;

grant execute on function pg_temp.identity_store_context() to vortex_runtime;
grant usage on schema extensions to vortex_runtime, vortex_request;

set local role vortex_runtime;
select vortex_context.initialize(pg_temp.identity_store_context());
set local role vortex_request;

select root_id
from vortex_definition.create_root(
  'module',
  'example.identity_store',
  '{
    "source_contract_version":"1.0.0",
    "kind":"module",
    "root_alias":"module_root",
    "key":"example.identity_store",
    "body":{"record_types":[]}
  }'::jsonb,
  'sha256:' || pg_catalog.repeat('a', 64),
  '[
    {
      "definitionKey":"example.identity_store",
      "ownerScope":"document",
      "scope":"document",
      "kind":"root",
      "componentOwner":"root",
      "aliases":["example.identity_store","module_root"]
    },
    {
      "definitionKey":"example.identity_store",
      "ownerScope":"content",
      "scope":"content",
      "kind":"record_type",
      "componentOwner":"record_owner",
      "aliases":["record_owner","entry"]
    },
    {
      "definitionKey":"example.identity_store",
      "ownerScope":"record_owner:record_owner",
      "scope":"record:entry",
      "kind":"storage_contract",
      "componentOwner":"storage_owner",
      "aliases":["storage_owner","entry"]
    },
    {
      "definitionKey":"example.identity_store",
      "ownerScope":"record_owner:record_owner",
      "scope":"record:entry",
      "kind":"field",
      "componentOwner":"field_owner",
      "aliases":["field_owner","title"]
    }
  ]'::jsonb
) \gset identity_created_

reset role;

select is(
  (select count(*)::integer from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid),
  4,
  'creation records one root and each contained permanent owner atomically'
);
select is(
  (select identity_id from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid and kind = 'root'),
  :'identity_created_root_id'::uuid,
  'the Definition root UUID is also its permanent source root identity'
);
select is(
  (select count(*)::integer from vortex_definition.source_identity_aliases
    where root_id = :'identity_created_root_id'::uuid),
  8,
  'creation records every authentic owner alias exactly once'
);
select is(
  (
    select count(distinct identity_id)::integer
    from vortex_definition.source_identity_aliases
    where root_id = :'identity_created_root_id'::uuid
      and kind = 'record_type'
      and alias in ('record_owner', 'entry')
  ),
  1,
  'an authored id and mutable key resolve to the same permanent identity'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.identity_store_context());
set local role vortex_request;

select is(
  (
    select draft_revision
    from vortex_definition.save_draft(
      :'identity_created_root_id'::uuid,
      1,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"module_root",
        "key":"example.identity_store",
        "body":{"record_types":[]}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('b', 64),
      '[
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"document",
          "scope":"document",
          "kind":"root",
          "componentOwner":"root",
          "aliases":["example.identity_store","module_root"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"content",
          "scope":"content",
          "kind":"record_type",
          "componentOwner":"record_owner",
          "aliases":["record_owner","item"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"record_owner:record_owner",
          "scope":"record:item",
          "kind":"storage_contract",
          "componentOwner":"storage_owner",
          "aliases":["storage_owner","item"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"record_owner:record_owner",
          "scope":"record:item",
          "kind":"field",
          "componentOwner":"field_owner",
          "aliases":["field_owner","title"]
        }
      ]'::jsonb
    )
  ),
  2::bigint,
  'a key rename saves one new draft revision'
);

reset role;

select is(
  (select count(*)::integer from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid),
  4,
  'renaming a parent key creates no new permanent owner identities'
);
select ok(
  (
    select old_alias.identity_id = new_alias.identity_id
    from vortex_definition.source_identity_aliases as old_alias
    join vortex_definition.source_identity_aliases as new_alias
      on new_alias.root_id = old_alias.root_id
      and new_alias.kind = old_alias.kind
      and new_alias.alias = old_alias.alias
    where old_alias.root_id = :'identity_created_root_id'::uuid
      and old_alias.kind = 'field'
      and old_alias.scope = 'record:entry'
      and new_alias.scope = 'record:item'
      and old_alias.alias = 'title'
  ),
  'nested component identity survives a parent-key rename through stable owner scope'
);
select ok(
  exists (
    select 1
    from vortex_definition.source_identity_aliases
    where root_id = :'identity_created_root_id'::uuid
      and kind = 'record_type'
      and alias = 'entry'
  ),
  'the old record key remains reserved as historical alias evidence'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.identity_store_context());
set local role vortex_request;

select throws_ok(
  format(
    $sql$
      select *
      from vortex_definition.save_draft(
        %L::uuid,
        2,
        '{
          "source_contract_version":"1.0.0",
          "kind":"module",
          "root_alias":"module_root",
          "key":"example.identity_store",
          "body":{"record_types":[]}
        }'::jsonb,
        'sha256:%s',
        '[
          {
            "definitionKey":"example.identity_store",
            "ownerScope":"document",
            "scope":"document",
            "kind":"root",
            "componentOwner":"root",
            "aliases":["example.identity_store","module_root"]
          },
          {
            "definitionKey":"example.identity_store",
            "ownerScope":"content",
            "scope":"content",
            "kind":"record_type",
            "componentOwner":"different_owner",
            "aliases":["different_owner","item"]
          }
        ]'::jsonb
      )
    $sql$,
    :'identity_created_root_id',
    pg_catalog.repeat('c', 64)
  ),
  '23505'::char(5),
  'A historical source identity alias cannot be reassigned',
  'a historical alias cannot be stolen by a different authored owner'
);

select is(
  (
    select count(*)::integer
    from vortex_definition.save_draft(
      :'identity_created_root_id'::uuid,
      1,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"module_root",
        "key":"example.identity_store",
        "body":{"record_types":[]}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('d', 64),
      '[
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"document",
          "scope":"document",
          "kind":"root",
          "componentOwner":"root",
          "aliases":["example.identity_store","module_root"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"content",
          "scope":"content",
          "kind":"permission",
          "componentOwner":"stale_owner",
          "aliases":["stale_owner","example.permission.stale"]
        }
      ]'::jsonb
    )
  ),
  0,
  'a stale save returns before recording any proposed identity'
);

reset role;

select is(
  (select draft_revision from vortex_definition.drafts
    where root_id = :'identity_created_root_id'::uuid),
  2::bigint,
  'alias theft and stale saves leave the current draft revision unchanged'
);
select is(
  (select count(*)::integer from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid),
  4,
  'alias theft and stale saves leave permanent owners unchanged'
);
select is(
  (select count(*)::integer from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid
      and component_owner = 'stale_owner'),
  0,
  'a stale save leaves no partial identity owner'
);

select pg_catalog.set_config(
  'vortex.test_field_identity',
  (
    select identity_id::text
    from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid
      and kind = 'field'
      and component_owner = 'field_owner'
  ),
  true
);
select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(pg_temp.identity_store_context());
set local role vortex_request;

select is(
  (
    select draft_revision
    from vortex_definition.save_draft(
      :'identity_created_root_id'::uuid,
      2,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"module_root",
        "key":"example.identity_store",
        "body":{"record_types":[]}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('e', 64),
      '[
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"document",
          "scope":"document",
          "kind":"root",
          "componentOwner":"root",
          "aliases":["example.identity_store","module_root"]
        }
      ]'::jsonb
    )
  ),
  3::bigint,
  'removing contained components saves without deleting their permanent identities'
);

select is(
  (
    select draft_revision
    from vortex_definition.save_draft(
      :'identity_created_root_id'::uuid,
      3,
      '{
        "source_contract_version":"1.0.0",
        "kind":"module",
        "root_alias":"module_root",
        "key":"example.identity_store",
        "body":{"record_types":[{"id":"record_owner","key":"entry"}]}
      }'::jsonb,
      'sha256:' || pg_catalog.repeat('f', 64),
      '[
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"document",
          "scope":"document",
          "kind":"root",
          "componentOwner":"root",
          "aliases":["example.identity_store","module_root"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"content",
          "scope":"content",
          "kind":"record_type",
          "componentOwner":"record_owner",
          "aliases":["record_owner","entry"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"record_owner:record_owner",
          "scope":"record:entry",
          "kind":"storage_contract",
          "componentOwner":"storage_owner",
          "aliases":["storage_owner","entry"]
        },
        {
          "definitionKey":"example.identity_store",
          "ownerScope":"record_owner:record_owner",
          "scope":"record:entry",
          "kind":"field",
          "componentOwner":"field_owner",
          "aliases":["field_owner","title"]
        }
      ]'::jsonb
    )
  ),
  4::bigint,
  'reintroducing removed owners succeeds as a later draft revision'
);

reset role;

select is(
  (
    select identity_id
    from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid
      and kind = 'field'
      and component_owner = 'field_owner'
  ),
  pg_catalog.current_setting('vortex.test_field_identity')::uuid,
  'reintroduction reuses the original permanent component identity'
);
select is(
  (select count(*)::integer from vortex_definition.source_identities
    where root_id = :'identity_created_root_id'::uuid),
  4,
  'removal and reintroduction add no duplicate owner identities'
);
select throws_ok(
  format(
    'update vortex_definition.source_identities set component_owner = %L where root_id = %L::uuid and kind = %L',
    'changed_owner',
    :'identity_created_root_id',
    'field'
  ),
  '23514'::char(5),
  'Definition source identities and aliases are append-only',
  'direct source owner mutation is refused'
);
select throws_ok(
  format(
    'delete from vortex_definition.source_identity_aliases where root_id = %L::uuid and alias = %L',
    :'identity_created_root_id',
    'entry'
  ),
  '23514'::char(5),
  'Definition source identities and aliases are append-only',
  'historical aliases cannot be deleted'
);

select * from finish();
rollback;
