\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select ok(
  (
    select pg_catalog.pg_get_constraintdef(candidate_constraint.oid)
    from pg_catalog.pg_constraint as candidate_constraint
    where candidate_constraint.conrelid = 'vortex_definition.source_identities'::regclass
      and candidate_constraint.conname = 'source_identities_kind_valid'
  ) like all (
    array[
      '%''field''%',
      '%''shell_content_slot''%',
      '%''rule_node''%',
      '%''rule_input''%',
      '%''rule_variable''%'
    ]
  ),
  'the identity constraint preserves historical kinds and admits all Rule graph owners'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '10000000-0000-4000-8000-000000000465',
  'rule_graph_identity_tenant',
  'Rule graph identity tenant',
  'active',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000465',
  pg_catalog.statement_timestamp(),
  1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '20000000-0000-4000-8000-000000000465',
    '10000000-0000-4000-8000-000000000465',
    null,
    'rule_graph_identity_org_a',
    'Rule graph identity organisation A',
    'active',
    pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000465',
    pg_catalog.statement_timestamp(),
    1
  ),
  (
    '20000000-0000-4000-8000-000000000466',
    '10000000-0000-4000-8000-000000000465',
    null,
    'rule_graph_identity_org_b',
    'Rule graph identity organisation B',
    'active',
    pg_catalog.statement_timestamp(),
    '90000000-0000-4000-8000-000000000466',
    pg_catalog.statement_timestamp(),
    1
  );

set constraints all immediate;

create function pg_temp.rule_graph_identity_context(
  p_organization_id uuid,
  p_actor_id uuid,
  p_correlation_id uuid
)
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'system',
    'tenantId', '10000000-0000-4000-8000-000000000465'::uuid,
    'organizationId', p_organization_id,
    'sessionId', '60000000-0000-4000-8000-000000000465'::uuid,
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', p_correlation_id,
    'systemActorId', p_actor_id,
    'authenticationStrength', 'service'
  )
$function$;

create function pg_temp.rule_graph_identity_source(p_rule_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'source_contract_version', '3.0.0',
    'kind', 'module',
    'root_alias', 'rule_graph_module',
    'key', 'example.rule_graph_identity',
    'body', pg_catalog.jsonb_build_object(
      'record_types', '[]'::jsonb,
      'rules', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('id', 'rule_owner', 'key', p_rule_key)
      )
    )
  )
$function$;

create function pg_temp.rule_graph_identity_requirements(
  p_rule_key text,
  p_input_key text,
  p_variable_key text,
  p_node_key text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'definitionKey', 'example.rule_graph_identity',
      'ownerScope', 'document',
      'scope', 'document',
      'kind', 'root',
      'componentOwner', 'root',
      'aliases', pg_catalog.jsonb_build_array('example.rule_graph_identity', 'rule_graph_module')
    ),
    pg_catalog.jsonb_build_object(
      'definitionKey', 'example.rule_graph_identity',
      'ownerScope', 'content',
      'scope', 'content',
      'kind', 'field',
      'componentOwner', 'historical_field_owner',
      'aliases', pg_catalog.jsonb_build_array('historical_field_owner', 'historical_field')
    ),
    pg_catalog.jsonb_build_object(
      'definitionKey', 'example.rule_graph_identity',
      'ownerScope', 'content',
      'scope', 'content',
      'kind', 'rule',
      'componentOwner', 'rule_owner',
      'aliases', pg_catalog.jsonb_build_array('rule_owner', p_rule_key)
    ),
    pg_catalog.jsonb_build_object(
      'definitionKey', 'example.rule_graph_identity',
      'ownerScope', 'rule_owner:rule_owner',
      'scope', 'rule:' || p_rule_key,
      'kind', 'rule_input',
      'componentOwner', 'input_owner',
      'aliases', pg_catalog.jsonb_build_array('input_owner', p_input_key)
    ),
    pg_catalog.jsonb_build_object(
      'definitionKey', 'example.rule_graph_identity',
      'ownerScope', 'rule_owner:rule_owner',
      'scope', 'rule:' || p_rule_key,
      'kind', 'rule_variable',
      'componentOwner', 'variable_owner',
      'aliases', pg_catalog.jsonb_build_array('variable_owner', p_variable_key)
    ),
    pg_catalog.jsonb_build_object(
      'definitionKey', 'example.rule_graph_identity',
      'ownerScope', 'rule_owner:rule_owner',
      'scope', 'rule:' || p_rule_key,
      'kind', 'rule_node',
      'componentOwner', 'node_owner',
      'aliases', pg_catalog.jsonb_build_array('node_owner', p_node_key)
    )
  )
$function$;

grant execute on function pg_temp.rule_graph_identity_context(uuid, uuid, uuid)
  to vortex_runtime;
grant execute on function pg_temp.rule_graph_identity_source(text)
  to vortex_request;
grant execute on function pg_temp.rule_graph_identity_requirements(text, text, text, text)
  to vortex_request;
grant usage on schema extensions to vortex_runtime, vortex_request;

set local role vortex_runtime;
select vortex_context.initialize(
  pg_temp.rule_graph_identity_context(
    '20000000-0000-4000-8000-000000000465',
    '90000000-0000-4000-8000-000000000465',
    '70000000-0000-4000-8000-000000000465'
  )
);
set local role vortex_request;

select root_id
from vortex_definition.create_root(
  'module',
  'example.rule_graph_identity',
  pg_temp.rule_graph_identity_source('prepare_candidate'),
  'sha256:' || pg_catalog.repeat('a', 64),
  pg_temp.rule_graph_identity_requirements(
    'prepare_candidate', 'minimum_amount', 'effective_budget', 'start'
  )
) \gset graph_created_

reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_definition.source_identities
    where root_id = :'graph_created_root_id'::uuid
      and kind in ('rule_node', 'rule_input', 'rule_variable')
  ),
  3,
  'ordinary Module V3 creation allocates all three Rule graph child identities'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_definition.source_identities
    where root_id = :'graph_created_root_id'::uuid
      and kind in ('rule_node', 'rule_input', 'rule_variable')
      and owner_scope = 'rule_owner:rule_owner'
  ),
  3,
  'Rule graph child identities are scoped by the permanent authored Rule owner'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_definition.source_identities
    where root_id = :'graph_created_root_id'::uuid
      and kind = 'field'
  ),
  1,
  'a historical identity kind remains accepted by the same allocator'
);

create temporary table graph_identity_evidence (
  kind text primary key,
  identity_id uuid not null
) on commit drop;

insert into graph_identity_evidence (kind, identity_id)
select kind, identity_id
from vortex_definition.source_identities
where root_id = :'graph_created_root_id'::uuid
  and kind in ('rule_node', 'rule_input', 'rule_variable');

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(
  pg_temp.rule_graph_identity_context(
    '20000000-0000-4000-8000-000000000465',
    '90000000-0000-4000-8000-000000000465',
    '70000000-0000-4000-8000-000000000466'
  )
);
set local role vortex_request;

select is(
  (
    select draft_revision
    from vortex_definition.save_draft(
      :'graph_created_root_id'::uuid,
      1,
      pg_temp.rule_graph_identity_source('prepare_renamed'),
      'sha256:' || pg_catalog.repeat('b', 64),
      pg_temp.rule_graph_identity_requirements(
        'prepare_renamed', 'threshold', 'remembered_budget', 'begin'
      )
    )
  ),
  2::bigint,
  'an ordinary revision-checked edit records renamed Rule graph aliases'
);

reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from graph_identity_evidence as original
    join vortex_definition.source_identities as current
      on current.root_id = :'graph_created_root_id'::uuid
      and current.kind = original.kind
      and current.identity_id = original.identity_id
      and current.owner_scope = 'rule_owner:rule_owner'
  ),
  3,
  'an edit preserves every permanent Rule graph child identity'
);

select is(
  (
    select pg_catalog.count(distinct alias.scope)::integer
    from vortex_definition.source_identity_aliases as alias
    where alias.root_id = :'graph_created_root_id'::uuid
      and alias.kind in ('rule_node', 'rule_input', 'rule_variable')
  ),
  2,
  'old and renamed Rule lookup scopes remain distinct historical evidence'
);

insert into vortex_definition.releases (
  root_id,
  release_revision,
  release_version,
  authored_source,
  authored_source_fingerprint,
  source_contract_version,
  compilation_output,
  resolution_snapshot,
  content_fingerprint,
  resolution_fingerprint,
  validation_contract_version,
  comparison_fingerprint,
  impact_reasons,
  release_note,
  published_at,
  published_by
) values (
  :'graph_created_root_id'::uuid,
  1,
  '1.0.0',
  pg_temp.rule_graph_identity_source('prepare_candidate'),
  'sha256:' || pg_catalog.repeat('a', 64),
  '3.0.0',
  '{"kind":"module","validationContractVersion":"3.0.0","canonical":{}}'::jsonb,
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('c', 64)),
  'sha256:' || pg_catalog.repeat('d', 64),
  'sha256:' || pg_catalog.repeat('c', 64),
  '3.0.0',
  'sha256:' || pg_catalog.repeat('e', 64),
  '[]'::jsonb,
  'Rule graph restore evidence',
  pg_catalog.statement_timestamp(),
  '90000000-0000-4000-8000-000000000465'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(
  pg_temp.rule_graph_identity_context(
    '20000000-0000-4000-8000-000000000465',
    '90000000-0000-4000-8000-000000000465',
    '70000000-0000-4000-8000-000000000467'
  )
);
set local role vortex_request;

select is(
  vortex_definition.restore_release_draft(
    'module',
    :'graph_created_root_id'::uuid,
    1,
    2,
    'sha256:' || pg_catalog.repeat('a', 64),
    pg_temp.rule_graph_identity_requirements(
      'prepare_candidate', 'minimum_amount', 'effective_budget', 'start'
    )
  ) ->> 'draftRevision',
  '3',
  'verified restore writes the historical Module V3 identity requirements'
);

reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from graph_identity_evidence as original
    join vortex_definition.source_identities as current
      on current.root_id = :'graph_created_root_id'::uuid
      and current.kind = original.kind
      and current.identity_id = original.identity_id
  ),
  3,
  'restore preserves every permanent Rule graph child identity'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_definition.source_identities
    where root_id = :'graph_created_root_id'::uuid
  ),
  6,
  'restore allocates no duplicate identity rows'
);

select pg_catalog.set_config('vortex.request_context', '', true);
set local role vortex_runtime;
select vortex_context.initialize(
  pg_temp.rule_graph_identity_context(
    '20000000-0000-4000-8000-000000000466',
    '90000000-0000-4000-8000-000000000466',
    '70000000-0000-4000-8000-000000000468'
  )
);
set local role vortex_request;

select throws_ok(
  format(
    $sql$
      select *
      from vortex_definition.save_draft(
        %L::uuid,
        3,
        pg_temp.rule_graph_identity_source('foreign_edit'),
        'sha256:%s',
        pg_temp.rule_graph_identity_requirements(
          'foreign_edit', 'foreign_input', 'foreign_variable', 'foreign_node'
        )
      )
    $sql$,
    :'graph_created_root_id',
    pg_catalog.repeat('f', 64)
  ),
  '42501'::char(5),
  'Definition root does not belong to the context organization',
  'another organisation cannot edit or allocate aliases under the Module V3 root'
);

select is(
  vortex_definition.restore_release_draft(
    'module',
    :'graph_created_root_id'::uuid,
    1,
    3,
    'sha256:' || pg_catalog.repeat('a', 64),
    pg_temp.rule_graph_identity_requirements(
      'prepare_candidate', 'minimum_amount', 'effective_budget', 'start'
    )
  ),
  null::jsonb,
  'another organisation cannot restore the Module V3 draft'
);

select throws_ok(
  $$
    select *
    from vortex_definition.create_root(
      'module',
      'example.unsupported_rule_graph_identity',
      '{"source_contract_version":"3.0.0","kind":"module","root_alias":"unsupported","key":"example.unsupported_rule_graph_identity","body":{}}'::jsonb,
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      '[
        {
          "definitionKey":"example.unsupported_rule_graph_identity",
          "ownerScope":"document",
          "scope":"document",
          "kind":"root",
          "componentOwner":"root",
          "aliases":["example.unsupported_rule_graph_identity","unsupported"]
        },
        {
          "definitionKey":"example.unsupported_rule_graph_identity",
          "ownerScope":"rule_owner:rule_owner",
          "scope":"rule:unsupported",
          "kind":"rule_output",
          "componentOwner":"unsupported_output",
          "aliases":["unsupported_output"]
        }
      ]'::jsonb
    )
  $$,
  '23514'::char(5),
  'new row for relation "source_identities" violates check constraint "source_identities_kind_valid"',
  'an unsupported future Rule identity kind remains refused by the closed allocator'
);

reset role;

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_definition.roots
    where key = 'example.unsupported_rule_graph_identity'
  ),
  0,
  'a refused unsupported identity rolls back its attempted root atomically'
);

select * from finish();
rollback;
