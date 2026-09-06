\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_activity', 'postgres', false, false
);

select has_table(
  'vortex_activity', 'organization_activity_entries',
  'private organization Activity storage exists'
);

select columns_are(
  'vortex_activity',
  'organization_activity_entries',
  array[
    'organization_id', 'activity_id', 'occurred_at', 'actor_kind', 'actor_id',
    'action', 'subject_ids', 'changed_field_ids', 'source', 'correlation_id',
    'outcome'
  ],
  'Activity storage contains only the closed content-free evidence fields'
);

select has_pk(
  'vortex_activity', 'organization_activity_entries',
  'Activity identity is unique within an organization'
);
select has_fk(
  'vortex_activity', 'organization_activity_entries',
  'Activity evidence retains its organization owner'
);

select ok(
  table_row.relrowsecurity and table_row.relforcerowsecurity,
  'Activity storage enables and forces row-level security'
)
from pg_catalog.pg_class as table_row
where table_row.oid = 'vortex_activity.organization_activity_entries'::regclass;

select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_policy
    where polrelid = 'vortex_activity.organization_activity_entries'::regclass
  ),
  0::bigint,
  'Activity storage has no direct row policy'
);

select has_function(
  'vortex_activity', 'append_organization_activity_entry',
  array[
    'uuid', 'uuid', 'timestamp with time zone', 'text', 'uuid', 'text',
    'uuid[]', 'uuid[]', 'text', 'uuid', 'text'
  ],
  'one private Activity append helper exists'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig
    )
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_activity.append_organization_activity_entry(uuid,uuid,timestamptz,text,uuid,text,uuid[],uuid[],text,uuid,text)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', false,
    'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the append helper is an owner-invoked volatile SECURITY INVOKER with an empty path'
);

select ok(
  not pg_catalog.has_table_privilege(
    caller.role_name, 'vortex_activity.organization_activity_entries',
    'SELECT,INSERT,UPDATE,DELETE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_activity.append_organization_activity_entry(uuid,uuid,timestamptz,text,uuid,text,uuid[],uuid[],text,uuid,text)',
    'EXECUTE'
  ),
  caller.role_name || ' has no Activity read, write or append authority'
)
from (values
  ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name;

select ok(
  not exists (
    select 1
    from pg_catalog.aclexplode(
      coalesce(
        (
          select table_row.relacl
          from pg_catalog.pg_class as table_row
          where table_row.oid =
            'vortex_activity.organization_activity_entries'::regclass
        ),
        pg_catalog.acldefault(
          'r',
          (
            select table_row.relowner
            from pg_catalog.pg_class as table_row
            where table_row.oid =
              'vortex_activity.organization_activity_entries'::regclass
          )
        )
      )
    ) as privilege
    where privilege.grantee = 0
  ),
  'PUBLIC receives no Activity table privilege'
);

select throws_ok(
  $$
    set local role vortex_request;
    select vortex_activity.append_organization_activity_entry(
      '23200000-0000-4000-8000-000000000001',
      '63200000-0000-4000-8000-000000000001',
      '2026-09-06 09:00:00+00', 'system',
      '93200000-0000-4000-8000-000000000001', 'proof_refused',
      array['73200000-0000-4000-8000-000000000001']::uuid[],
      array[]::uuid[], 'system',
      'a3200000-0000-4000-8000-000000000001', 'refused'
    );
  $$,
  '42501',
  null,
  'the request role cannot invoke the owner-only append helper'
);

select throws_ok(
  $$
    set local role vortex_request;
    select count(*) from vortex_activity.organization_activity_entries
    where organization_id = '23200000-0000-4000-8000-000000000099'
  $$,
  '42501',
  null,
  'the request role cannot read Activity entries, including a foreign organization predicate'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13200000-0000-4000-8000-000000000001',
  'activity_foundation', 'Activity foundation', 'active',
  '2026-09-06 08:00:00+00', '93200000-0000-4000-8000-000000000001',
  '2026-09-06 08:00:00+00', 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  '23200000-0000-4000-8000-000000000001',
  '13200000-0000-4000-8000-000000000001',
  'activity_foundation', 'Activity foundation', 'active',
  '2026-09-06 08:00:00+00', '93200000-0000-4000-8000-000000000001',
  '2026-09-06 08:00:00+00', 1
);

select is(
  vortex_activity.append_organization_activity_entry(
    '23200000-0000-4000-8000-000000000001',
    '63200000-0000-4000-8000-000000000001',
    '2026-09-06 09:00:00.123456+00', 'organization_account',
    '93200000-0000-4000-8000-000000000002', 'record_updated',
    array[
      '73200000-0000-4000-8000-000000000001',
      '73200000-0000-4000-8000-000000000002'
    ]::uuid[],
    array['83200000-0000-4000-8000-000000000001']::uuid[],
    'web', 'a3200000-0000-4000-8000-000000000001', 'completed'
  ),
  'inserted',
  'the owner helper appends one exact content-free entry'
);

select is(
  vortex_activity.append_organization_activity_entry(
    '23200000-0000-4000-8000-000000000001',
    '63200000-0000-4000-8000-000000000001',
    '2026-09-06 09:00:00.123456+00', 'organization_account',
    '93200000-0000-4000-8000-000000000002', 'record_updated',
    array[
      '73200000-0000-4000-8000-000000000001',
      '73200000-0000-4000-8000-000000000002'
    ]::uuid[],
    array['83200000-0000-4000-8000-000000000001']::uuid[],
    'web', 'a3200000-0000-4000-8000-000000000001', 'completed'
  ),
  'already_recorded',
  'an exact retry returns the existing result'
);

select throws_ok(
  $$
    select vortex_activity.append_organization_activity_entry(
      '23200000-0000-4000-8000-000000000001',
      '63200000-0000-4000-8000-000000000001',
      '2026-09-06 09:00:00.123456+00', 'organization_account',
      '93200000-0000-4000-8000-000000000002', 'different_action',
      array[
        '73200000-0000-4000-8000-000000000001',
        '73200000-0000-4000-8000-000000000002'
      ]::uuid[],
      array['83200000-0000-4000-8000-000000000001']::uuid[],
      'web', 'a3200000-0000-4000-8000-000000000001', 'completed'
    )
  $$,
  '22023',
  'Activity identity already records different evidence',
  'the same Activity identity cannot record conflicting evidence'
);

select throws_ok(
  $$
    select vortex_activity.append_organization_activity_entry(
      '23200000-0000-4000-8000-000000000001',
      '63200000-0000-4000-8000-000000000002',
      '2026-09-06 09:00:00+00', 'identity',
      '93200000-0000-4000-8000-000000000003', 'record_viewed',
      array[
        '73200000-0000-4000-8000-000000000002',
        '73200000-0000-4000-8000-000000000001'
      ]::uuid[],
      array[]::uuid[], 'interface',
      'a3200000-0000-4000-8000-000000000002', 'completed'
    )
  $$,
  '23514',
  null,
  'noncanonical subject order is refused by storage'
);

select throws_ok(
  $$
    select vortex_activity.append_organization_activity_entry(
      '23200000-0000-4000-8000-000000000001',
      '63200000-0000-4000-8000-000000000003',
      '2026-09-06 09:00:00+00', 'identity',
      '93200000-0000-4000-8000-000000000003', 'record_viewed',
      array['73200000-0000-4000-8000-000000000001']::uuid[],
      array[
        '83200000-0000-4000-8000-000000000001',
        '83200000-0000-4000-8000-000000000001'
      ]::uuid[],
      'interface', 'a3200000-0000-4000-8000-000000000003', 'completed'
    )
  $$,
  '23514',
  null,
  'duplicate changed-field identifiers are refused by storage'
);

select throws_ok(
  $$update vortex_activity.organization_activity_entries set outcome = 'failed'
    where organization_id = '23200000-0000-4000-8000-000000000001'$$,
  '23514', 'Activity entries are immutable',
  'Activity entries cannot be updated'
);
select throws_ok(
  $$delete from vortex_activity.organization_activity_entries
    where organization_id = '23200000-0000-4000-8000-000000000001'$$,
  '23514', 'Activity entries are immutable',
  'Activity entries cannot be deleted'
);
select throws_ok(
  $$delete from vortex_identity.organizations
    where organization_id = '23200000-0000-4000-8000-000000000001'$$,
  '23503', null,
  'organization removal cannot cascade Activity history'
);

create temporary table protected_operation_mutations (
  operation_id uuid primary key
) on commit drop;

savepoint successful_operation;
insert into protected_operation_mutations values (
  'b3200000-0000-4000-8000-000000000001'
);
select is(
  vortex_activity.append_organization_activity_entry(
    '23200000-0000-4000-8000-000000000001',
    '63200000-0000-4000-8000-000000000004',
    '2026-09-06 07:00:00+00', 'system',
    '93200000-0000-4000-8000-000000000004', 'proof_completed',
    array['b3200000-0000-4000-8000-000000000001']::uuid[],
    array[]::uuid[], 'system',
    'a3200000-0000-4000-8000-000000000004', 'completed'
  ),
  'inserted',
  'a test-owned protected operation appends success in its mutation transaction'
);
rollback to savepoint successful_operation;
select is(
  (select pg_catalog.count(*) from protected_operation_mutations), 0::bigint,
  'rolling back the owning operation removes its mutation'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_activity.organization_activity_entries
    where activity_id = '63200000-0000-4000-8000-000000000004'
  ),
  0::bigint,
  'rolling back the owning operation removes its success Activity entry'
);

savepoint refused_operation;
insert into protected_operation_mutations values (
  'b3200000-0000-4000-8000-000000000002'
);
rollback to savepoint refused_operation;
select is(
  vortex_activity.append_organization_activity_entry(
    '23200000-0000-4000-8000-000000000001',
    '63200000-0000-4000-8000-000000000005',
    '2026-09-06 06:00:00+00', 'public_session',
    '93200000-0000-4000-8000-000000000005', 'proof_refused',
    array['23200000-0000-4000-8000-000000000001']::uuid[],
    array[]::uuid[], 'web',
    'a3200000-0000-4000-8000-000000000005', 'refused'
  ),
  'inserted',
  'verified refusal evidence can be appended after the failed mutation rollback'
);
select is(
  (select pg_catalog.count(*) from protected_operation_mutations), 0::bigint,
  'refusal evidence does not revive the rolled-back mutation'
);

select throws_ok(
  pg_catalog.format(
    $statement$
      select vortex_activity.append_organization_activity_entry(
        '23200000-0000-4000-8000-000000000001',
        '63200000-0000-4000-8000-000000000099',
        %L::timestamptz, %L,
        %L::uuid, 'proof_refused', %L::uuid[], array[]::uuid[],
        %L, 'a3200000-0000-4000-8000-000000000099', %L
      )
    $statement$,
    candidate.occurred_at, candidate.actor_kind, candidate.actor_id,
    candidate.subject_ids, candidate.source, candidate.outcome
  ),
  '23514', null, candidate.description
)
from (values
  ('2026-09-06T09:00:00Z', 'unknown', '93200000-0000-4000-8000-000000000001', '{23200000-0000-4000-8000-000000000001}', 'web', 'refused', 'storage refuses an unknown actor kind'),
  ('2026-09-06T09:00:00Z', 'system', '93200000-0000-4000-8000-000000000001', '{23200000-0000-4000-8000-000000000001}', 'unknown', 'refused', 'storage refuses an unknown source'),
  ('2026-09-06T09:00:00Z', 'system', '93200000-0000-4000-8000-000000000001', '{23200000-0000-4000-8000-000000000001}', 'web', 'unknown', 'storage refuses an unknown outcome'),
  ('2026-09-06T09:00:00Z', 'system', '00000000-0000-0000-0000-000000000000', '{23200000-0000-4000-8000-000000000001}', 'web', 'refused', 'storage refuses a nil actor identifier'),
  ('2026-09-06T09:00:00Z', 'system', '93200000-0000-f000-8000-000000000001', '{23200000-0000-4000-8000-000000000001}', 'web', 'refused', 'storage refuses a UUID outside the platform version contract'),
  ('infinity', 'system', '93200000-0000-4000-8000-000000000001', '{23200000-0000-4000-8000-000000000001}', 'web', 'refused', 'storage refuses non-finite occurrence time'),
  ('2026-09-06T09:00:00Z', 'system', '93200000-0000-4000-8000-000000000001', '{}', 'web', 'refused', 'storage requires a verified subject identifier'),
  ('2026-09-06T09:00:00Z', 'system', '93200000-0000-4000-8000-000000000001', '{00000000-0000-0000-0000-000000000000}', 'web', 'refused', 'storage refuses a nil subject identifier')
) as candidate(occurred_at, actor_kind, actor_id, subject_ids, source, outcome, description);

select * from finish();

rollback;
