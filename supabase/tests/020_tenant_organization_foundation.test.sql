\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_identity',
  'postgres',
  false,
  false
);

select has_table('vortex_identity', 'tenants', 'tenant storage exists');
select has_table('vortex_identity', 'organizations', 'organisation storage exists');
select tables_are(
  'vortex_identity',
  array['organizations', 'tenants'],
  'Identity storage contains only the two structural relations owned by this issue'
);
select columns_are(
  'vortex_identity',
  'tenants',
  array[
    'tenant_id', 'short_name', 'display_name', 'state', 'created_at', 'created_by',
    'state_changed_at', 'revision'
  ],
  'tenant columns match the canonical contract'
);
select columns_are(
  'vortex_identity',
  'organizations',
  array[
    'organization_id', 'tenant_id', 'parent_organization_id', 'short_name',
    'display_name', 'state', 'created_at', 'created_by', 'state_changed_at', 'revision'
  ],
  'organisation columns match the canonical contract'
);
select col_type_is('vortex_identity', 'tenants', 'tenant_id', 'uuid', 'tenant identifiers use UUID');
select col_type_is('vortex_identity', 'tenants', 'revision', 'bigint', 'tenant revisions use bigint');
select col_type_is(
  'vortex_identity',
  'organizations',
  'parent_organization_id',
  'uuid',
  'parent identifiers use UUID'
);
select col_type_is(
  'vortex_identity',
  'organizations',
  'state_changed_at',
  'timestamp with time zone',
  'organisation state times are unambiguous'
);
select has_pk('vortex_identity', 'tenants', 'tenants have a primary key');
select has_pk('vortex_identity', 'organizations', 'organisations have a primary key');
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_identity.tenants'::regclass
      and conname = 'tenants_short_name_unique'
      and pg_catalog.pg_get_constraintdef(oid) = 'UNIQUE (short_name)'
  ),
  'tenant short names are cluster-unique'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_identity.organizations'::regclass
      and conname = 'organizations_short_name_per_tenant_unique'
      and pg_catalog.pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, short_name)'
  ),
  'organisation short names are tenant-unique'
);
select has_fk(
  'vortex_identity',
  'organizations',
  'organisations reference their tenant and same-tenant parent'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_identity.organizations'::regclass
      and conname = 'organizations_parent_same_tenant_fk'
      and pg_catalog.pg_get_constraintdef(oid) like
        'FOREIGN KEY (tenant_id, parent_organization_id) REFERENCES vortex_identity.organizations(tenant_id, organization_id)%'
  ),
  'the parent foreign key carries tenant scope on both sides'
);
select has_index(
  'vortex_identity',
  'organizations',
  'organizations_parent_lookup_idx',
  'child traversal has one scope-first parent index'
);
select is(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'vortex_identity.tenants'::regclass),
  true,
  'tenant storage enables row security'
);
select is(
  (select relforcerowsecurity from pg_catalog.pg_class where oid = 'vortex_identity.tenants'::regclass),
  true,
  'tenant storage forces row security'
);
select is(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'vortex_identity.organizations'::regclass),
  true,
  'organisation storage enables row security'
);
select is(
  (select relforcerowsecurity from pg_catalog.pg_class where oid = 'vortex_identity.organizations'::regclass),
  true,
  'organisation storage forces row security'
);
select is(
  (select count(*)::integer from pg_catalog.pg_policies where schemaname = 'vortex_identity'),
  0,
  'the structural tables expose no direct row-security policy'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class
    where relnamespace = 'vortex_identity'::regnamespace
      and relkind in ('r', 'p')
      and relowner <> 'postgres'::regrole
  ),
  0,
  'postgres owns every Identity relation'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class as relation
    cross join lateral pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) as privilege
    left join pg_catalog.pg_roles as granted_role on granted_role.oid = privilege.grantee
    where relation.relnamespace = 'vortex_identity'::regnamespace
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
    select count(*)::integer
    from pg_catalog.pg_proc as function
    cross join lateral pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault('f', function.proowner))
    ) as privilege
    left join pg_catalog.pg_roles as granted_role on granted_role.oid = privilege.grantee
    where function.pronamespace = 'vortex_identity'::regnamespace
      and privilege.privilege_type = 'EXECUTE'
      and (
        privilege.grantee = 0
        or granted_role.rolname in (
          'anon', 'authenticated', 'service_role', 'vortex_runtime', 'vortex_request'
        )
      )
  ),
  0,
  'no public, Data API, runtime or request trigger-function execution exists'
);
select is(
  (
    select pg_catalog.array_agg(indexname::text order by indexname)
    from pg_catalog.pg_indexes
    where schemaname = 'vortex_identity'
      and tablename = 'organizations'
  ),
  array[
    'organizations_parent_lookup_idx',
    'organizations_pk',
    'organizations_short_name_per_tenant_unique',
    'organizations_tenant_identity_unique'
  ],
  'organisation storage has only the declared identity, scope and hierarchy indexes'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_constraint
    where conrelid = 'vortex_identity.organizations'::regclass
      and contype = 'f'
      and confdeltype = 'a'
  ),
  2,
  'both organisation foreign keys use non-cascading deletion'
);

select ok(
  not pg_catalog.has_table_privilege('anon', 'vortex_identity.tenants', 'SELECT'),
  'anon cannot read tenants'
);
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'vortex_identity.organizations', 'INSERT'),
  'authenticated cannot create organisations'
);
select ok(
  not pg_catalog.has_table_privilege('service_role', 'vortex_identity.tenants', 'UPDATE'),
  'service_role cannot change tenants'
);
select ok(
  not pg_catalog.has_table_privilege('vortex_runtime', 'vortex_identity.organizations', 'SELECT'),
  'runtime cannot read Identity tables directly'
);
select ok(
  not pg_catalog.has_table_privilege('vortex_request', 'vortex_identity.organizations', 'SELECT'),
  'request role cannot read Identity tables directly'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as function
    where function.pronamespace = 'vortex_identity'::regnamespace
      and function.prosecdef
  ),
  0,
  'every invariant trigger function is security invoker'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc as function
    where function.pronamespace = 'vortex_identity'::regnamespace
      and function.proconfig @> array['search_path=""']
  ),
  6,
  'every invariant trigger function fixes an empty search path'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_identity.refuse_organization_cycle()',
    'EXECUTE'
  ),
  'PUBLIC cannot execute hierarchy functions directly'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_identity.validate_organization_lifecycle()',
    'EXECUTE'
  ),
  'request role cannot execute lifecycle functions directly'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values
  (
    '10000000-0000-4000-8000-000000000001', 'tenant_one', 'Tenant One', 'active',
    '2026-09-03T12:00:00Z', '90000000-0000-4000-8000-000000000001',
    '2026-09-03T12:00:00Z', 1
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'tenant_two', 'Tenant Two', 'active',
    '2026-09-03T12:00:00Z', '90000000-0000-4000-8000-000000000001',
    '2026-09-03T12:00:00Z', 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    null, 'root_one', 'Shared display name', 'active', '2026-09-03T12:01:00Z',
    '90000000-0000-4000-8000-000000000001', '2026-09-03T12:01:00Z', 1
  ),
  (
    '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001', 'child_one', 'Shared display name', 'active',
    '2026-09-03T12:02:00Z', '90000000-0000-4000-8000-000000000001',
    '2026-09-03T12:02:00Z', 1
  ),
  (
    '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002', 'grandchild_one', 'Grandchild', 'active',
    '2026-09-03T12:03:00Z', '90000000-0000-4000-8000-000000000001',
    '2026-09-03T12:03:00Z', 1
  ),
  (
    '20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002',
    null, 'root_one', 'Another tenant root', 'active', '2026-09-03T12:01:00Z',
    '90000000-0000-4000-8000-000000000001', '2026-09-03T12:01:00Z', 1
  );

set constraints all immediate;

select is(
  (
    select count(*)::integer
    from vortex_identity.organizations
    where display_name = 'Shared display name'
  ),
  2,
  'display names do not need to be unique'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.organizations
    where short_name = 'root_one'
  ),
  2,
  'the same organisation short name is valid in different tenants'
);

select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000003', 'tenant_one', 'Duplicate', 'active',
      now(), '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23505'::char(5),
  null::text,
  'duplicate tenant short names are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name, display_name,
      state, created_at, created_by, state_changed_at, revision
    ) values (
      '20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
      null, 'root_one', 'Duplicate', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23505'::char(5),
  null::text,
  'duplicate organisation short names in one tenant are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '00000000-0000-0000-0000-000000000000', 'nil_tenant', 'Nil tenant', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23514'::char(5), null::text,
  'nil tenant identifiers are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000007', 'Invalid-Key', 'Invalid key', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23514'::char(5), null::text,
  'invalid builder short names are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000007', 'blank_name', '   ', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23514'::char(5), null::text,
  'blank display names are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000007', 'padded_name', ' Padded', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23514'::char(5), null::text,
  'unnormalised display names are refused at storage'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000007', 'bad_state', 'Bad state', 'unknown', now(),
      '90000000-0000-4000-8000-000000000001', now(), 1
    )
  $$,
  '23514'::char(5), null::text,
  'unknown tenant states are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000007', 'bad_time', 'Bad time', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now() - interval '1 second', 1
    )
  $$,
  '23514'::char(5), null::text,
  'state-change time before creation is refused'
);
select throws_ok(
  $$
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      '10000000-0000-4000-8000-000000000007', 'bad_revision', 'Bad revision', 'active', now(),
      '90000000-0000-4000-8000-000000000001', now(), 9007199254740992
    )
  $$,
  '23514'::char(5), null::text,
  'revisions above the JavaScript-safe integer range are refused'
);
select throws_ok(
  $$
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name, display_name,
      state, created_at, created_by, state_changed_at, revision
    ) values (
      '20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001',
      null, 'nil_creator', 'Nil creator', 'active', now(),
      '00000000-0000-0000-0000-000000000000', now(), 1
    )
  $$,
  '23514'::char(5), null::text,
  'nil creation actors are refused'
);
select throws_ok(
  $$
    update vortex_identity.tenants
    set tenant_id = '10000000-0000-4000-8000-000000000009'
    where tenant_id = '10000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'tenant identifiers are immutable'
);
select throws_ok(
  $$
    update vortex_identity.tenants
    set short_name = 'renamed_tenant'
    where tenant_id = '10000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'tenant short names are immutable'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set organization_id = '20000000-0000-4000-8000-000000000009'
    where organization_id = '20000000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5),
  null::text,
  'organisation identifiers are immutable'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set tenant_id = '10000000-0000-4000-8000-000000000002'
    where organization_id = '20000000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5),
  null::text,
  'organisation tenant ownership is immutable'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set short_name = 'renamed'
    where organization_id = '20000000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5),
  null::text,
  'organisation short names are immutable'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set parent_organization_id = organization_id
    where organization_id = '20000000-0000-4000-8000-000000000002'
  $$,
  '23514'::char(5),
  null::text,
  'self-parenting is refused'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set parent_organization_id = '20000000-0000-4000-8000-000000000004'
    where organization_id = '20000000-0000-4000-8000-000000000002'
  $$,
  '23503'::char(5),
  null::text,
  'cross-tenant parenting is refused'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set parent_organization_id = '20000000-0000-4000-8000-000000000003'
    where organization_id = '20000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'an indirect hierarchy cycle is refused'
);
select throws_ok(
  $$
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name, display_name,
      state, created_at, created_by, state_changed_at, revision
    ) values
      (
        '20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000011', 'cycle_one', 'Cycle one', 'active', now(),
        '90000000-0000-4000-8000-000000000001', now(), 1
      ),
      (
        '20000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000010', 'cycle_two', 'Cycle two', 'active', now(),
        '90000000-0000-4000-8000-000000000001', now(), 1
      )
  $$,
  '23514'::char(5),
  null::text,
  'one multi-row insert cannot create a direct forward-reference cycle'
);
select throws_ok(
  $$
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name, display_name,
      state, created_at, created_by, state_changed_at, revision
    ) values
      (
        '20000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000013', 'cycle_three', 'Cycle three', 'active', now(),
        '90000000-0000-4000-8000-000000000001', now(), 1
      ),
      (
        '20000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000014', 'cycle_four', 'Cycle four', 'active', now(),
        '90000000-0000-4000-8000-000000000001', now(), 1
      ),
      (
        '20000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000012', 'cycle_five', 'Cycle five', 'active', now(),
        '90000000-0000-4000-8000-000000000001', now(), 1
      )
  $$,
  '23514'::char(5),
  null::text,
  'one multi-row insert cannot create an indirect forward-reference cycle'
);
select throws_ok(
  $$
    delete from vortex_identity.organizations
    where organization_id = '20000000-0000-4000-8000-000000000001'
  $$,
  '23503'::char(5),
  null::text,
  'deleting a parent does not cascade to children'
);
select throws_ok(
  $$
    delete from vortex_identity.tenants
    where tenant_id = '10000000-0000-4000-8000-000000000001'
  $$,
  '23503'::char(5),
  null::text,
  'deleting a tenant does not cascade to organisations'
);

select throws_ok(
  $$
    update vortex_identity.organizations
    set state = 'archived', state_changed_at = now(), revision = revision + 1
    where organization_id = '20000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'an archived parent cannot retain an active child'
);
select throws_ok(
  $$
    update vortex_identity.tenants
    set state = 'archived', state_changed_at = now(), revision = revision + 1
    where tenant_id = '10000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'an archived tenant cannot retain an active organisation'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set state = 'removal_pending', state_changed_at = now(), revision = revision + 1
    where organization_id = '20000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'a removal-pending parent cannot retain an active child'
);
select throws_ok(
  $$
    update vortex_identity.tenants
    set state = 'removal_pending', state_changed_at = now(), revision = revision + 1
    where tenant_id = '10000000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null::text,
  'a removal-pending tenant cannot retain an active organisation'
);
select lives_ok(
  $$
    update vortex_identity.organizations
    set state = 'suspended', state_changed_at = now(), revision = revision + 1
    where organization_id = '20000000-0000-4000-8000-000000000001'
  $$,
  'suspension does not cascade to children'
);
select is(
  (
    select state
    from vortex_identity.organizations
    where organization_id = '20000000-0000-4000-8000-000000000002'
  ),
  'active',
  'suspending a parent leaves its child state unchanged'
);
select lives_ok(
  $$
    update vortex_identity.tenants
    set state = 'suspended', state_changed_at = now(), revision = revision + 1
    where tenant_id = '10000000-0000-4000-8000-000000000001'
  $$,
  'tenant suspension does not rewrite organisation states'
);
select results_eq(
  $$
    select organization_id, state
    from vortex_identity.organizations
    where tenant_id = '10000000-0000-4000-8000-000000000001'
    order by organization_id
  $$,
  $$
    values
      ('20000000-0000-4000-8000-000000000001'::uuid, 'suspended'::text),
      ('20000000-0000-4000-8000-000000000002'::uuid, 'active'::text),
      ('20000000-0000-4000-8000-000000000003'::uuid, 'active'::text)
  $$,
  'suspending a tenant leaves every organisation state unchanged'
);

set constraints all deferred;
update vortex_identity.organizations
set state = 'archived', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000001';
update vortex_identity.organizations
set state = 'archived', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000002';
update vortex_identity.organizations
set state = 'archived', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000003';
select lives_ok(
  'set constraints all immediate',
  'an explicitly ordered subtree archive is valid at its final transaction state'
);

set constraints all deferred;
update vortex_identity.organizations
set state = 'active', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000003';
update vortex_identity.organizations
set state = 'active', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000002';
update vortex_identity.organizations
set state = 'active', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000001';
update vortex_identity.tenants
set state = 'active', state_changed_at = now(), revision = revision + 1
where tenant_id = '10000000-0000-4000-8000-000000000001';
select lives_ok(
  'set constraints all immediate',
  'final-state validation ignores stale intermediate lifecycle values'
);

set constraints all deferred;
update vortex_identity.organizations
set state = 'archived', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000001';
update vortex_identity.organizations
set state = 'active', state_changed_at = now(), revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000001';
select lives_ok(
  'set constraints all immediate',
  'multiple updates of one row validate only its final stored lifecycle state'
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001',
  null, 'root_two', 'Second root', 'active', now(),
  '90000000-0000-4000-8000-000000000001', now(), 1
);
update vortex_identity.organizations
set parent_organization_id = '20000000-0000-4000-8000-000000000006', revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000002';
select is(
  (
    select parent_organization_id
    from vortex_identity.organizations
    where organization_id = '20000000-0000-4000-8000-000000000003'
  ),
  '20000000-0000-4000-8000-000000000002'::uuid,
  'reparenting one organisation leaves descendant links unchanged'
);
select throws_ok(
  $$
    update vortex_identity.organizations
    set parent_organization_id = '20000000-0000-4000-8000-000000000003'
    where organization_id = '20000000-0000-4000-8000-000000000006'
  $$,
  '23514'::char(5),
  null::text,
  'descendant-parenting after a subtree move is refused'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_trigger
    where tgrelid = 'vortex_identity.organizations'::regclass
      and not tgisinternal
  ),
  4,
  'organisation storage has only identity, serialisation, cycle and lifecycle triggers'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_proc
    where oid = 'vortex_identity.lock_organization_tenant()'::regprocedure
      and pg_catalog.lower(pg_catalog.pg_get_functiondef(oid)) like '%for update%'
  ),
  'every hierarchy or lifecycle change uses the tenant row as its serialisation point'
);

select * from finish();

rollback;
