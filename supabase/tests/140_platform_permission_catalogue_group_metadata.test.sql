\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select has_function(
  'vortex_access', 'revise_platform_permission_catalogue_metadata',
  array['uuid', 'bigint', 'text', 'text', 'uuid', 'uuid'],
  'Access exposes the bounded platform catalogue metadata-revision handoff'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_proc
    where oid in (
      'vortex_access.initialize_platform_permission_catalogue_v1(uuid,uuid,uuid)'::regprocedure,
      'vortex_access.initialize_platform_permission_catalogue(uuid,uuid,uuid)'::regprocedure,
      'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)'::regprocedure
    )
      and prosecdef
      and proconfig @> array['search_path=""']
  ),
  3,
  'historical initialization, compatible initialization and metadata revision remain owner-only functions'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  ),
  'no browser, service, runtime or request role can invoke the catalogue revision'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_roles as role
    cross join pg_catalog.pg_proc as operation
    where role.rolname in (
      'anon', 'authenticated', 'service_role', 'vortex_runtime', 'vortex_request'
    )
      and operation.oid in (
        'vortex_access.initialize_platform_permission_catalogue_v1(uuid,uuid,uuid)'::regprocedure,
        'vortex_access.initialize_platform_permission_catalogue(uuid,uuid,uuid)'::regprocedure,
        'vortex_access.revise_platform_permission_catalogue_metadata(uuid,bigint,text,text,uuid,uuid)'::regprocedure
      )
      and pg_catalog.has_function_privilege(role.oid, operation.oid, 'EXECUTE')
  ),
  0,
  'all historical, compatible and revision functions remain unreachable to non-owner roles'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.accept_organization_invitation(text,uuid,text,text,uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_access.validated_human_request_context()', 'EXECUTE'
  ),
  'the additive migration preserves earlier narrow Access grants'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000140', 'catalogue_revision_tenant',
  'Catalogue revision tenant', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '21000000-0000-4000-8000-000000000140',
  '11000000-0000-4000-8000-000000000140', null, 'catalogue_revision_org',
  'Catalogue revision organisation', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000140',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000140'
);

create temporary table historical_initialization on commit drop as
select * from vortex_access.initialize_platform_permission_catalogue(
  '21000000-0000-4000-8000-000000000140',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000141'
);
select is(
  (select registration_revision from historical_initialization),
  1::bigint,
  'the compatible initializer still creates historical catalogue revision one'
);
select is(
  (select access_version from historical_initialization),
  2::bigint,
  'historical initialization increments Access once'
);
select is(
  (
    select access_version
    from vortex_access.initialize_platform_permission_catalogue(
      '21000000-0000-4000-8000-000000000140',
      '91000000-0000-4000-8000-000000000140',
      '71000000-0000-4000-8000-000000000142'
    )
  ),
  2::bigint,
  'initializer replay before metadata revision does not increment Access'
);

create temporary table historical_evidence_before on commit drop as
select 'registration'::text as evidence_kind, pg_catalog.to_jsonb(revision) as evidence
from vortex_access.permission_registration_revisions as revision
where revision.organization_id = '21000000-0000-4000-8000-000000000140'
  and revision.registration_kind = 'platform'
  and revision.revision = 1
union all
select 'permission'::text, pg_catalog.to_jsonb(entry)
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '21000000-0000-4000-8000-000000000140'
  and entry.registration_kind = 'platform'
  and entry.registration_revision = 1;

create temporary table metadata_revision on commit drop as
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  '21000000-0000-4000-8000-000000000140', 1, '1.0.0', '1.0.1',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000143'
);
select is(
  (select registration_revision from metadata_revision),
  2::bigint,
  'the explicit metadata operation creates revision two'
);
select is(
  (select access_version from metadata_revision),
  3::bigint,
  'the explicit metadata operation increments Access exactly once'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.permission_registration_revisions
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and registration_kind = 'platform'
  ),
  2::bigint,
  'platform registration history retains both immutable revisions'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and registration_kind = 'platform'
  ),
  26::bigint,
  'both complete thirteen-entry catalogue snapshots are retained'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.permission_catalogue_entries as historical
    join vortex_access.permission_catalogue_entries as current
      on current.organization_id = historical.organization_id
      and current.registration_kind = historical.registration_kind
      and current.registration_owner_id = historical.registration_owner_id
      and current.registration_revision = 2
      and current.owner_kind = historical.owner_kind
      and current.owner_id = historical.owner_id
      and current.permission_id = historical.permission_id
    where historical.organization_id = '21000000-0000-4000-8000-000000000140'
      and historical.registration_kind = 'platform'
      and historical.registration_revision = 1
      and current.permission_key = historical.permission_key
      and current.action_kind = historical.action_kind
      and current.administrative = historical.administrative
      and current.meaning_fingerprint = historical.meaning_fingerprint
  ),
  13::bigint,
  'every permanent permission identity, key and authority meaning remains continuous'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.permission_catalogue_entries as historical
    join vortex_access.permission_catalogue_entries as current
      on current.organization_id = historical.organization_id
      and current.registration_kind = historical.registration_kind
      and current.registration_owner_id = historical.registration_owner_id
      and current.registration_revision = 2
      and current.owner_kind = historical.owner_kind
      and current.owner_id = historical.owner_id
      and current.permission_id = historical.permission_id
    where historical.organization_id = '21000000-0000-4000-8000-000000000140'
      and historical.registration_kind = 'platform'
      and historical.registration_revision = 1
      and (current.label, current.description) is distinct from
        (historical.label, historical.description)
  ),
  2::bigint,
  'only the two Group-facing display entries change metadata'
);
select is(
  (
    select pg_catalog.count(*)
    from (
      select evidence_kind, evidence from historical_evidence_before
      except all
      (
        select 'registration', pg_catalog.to_jsonb(revision)
        from vortex_access.permission_registration_revisions as revision
        where revision.organization_id = '21000000-0000-4000-8000-000000000140'
          and revision.registration_kind = 'platform'
          and revision.revision = 1
        union all
        select 'permission', pg_catalog.to_jsonb(entry)
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = '21000000-0000-4000-8000-000000000140'
          and entry.registration_kind = 'platform'
          and entry.registration_revision = 1
      )
    ) as difference
  ),
  0::bigint,
  'the forward revision does not rewrite any historical registration or permission row'
);

select is(
  (
    select access_version
    from vortex_access.revise_platform_permission_catalogue_metadata(
      '21000000-0000-4000-8000-000000000140', 1, '1.0.0', '1.0.1',
      '91000000-0000-4000-8000-000000000140',
      '71000000-0000-4000-8000-000000000144'
    )
  ),
  3::bigint,
  'exact explicit metadata-revision replay does not increment Access'
);
select is(
  (
    select registration_revision
    from vortex_access.initialize_platform_permission_catalogue(
      '21000000-0000-4000-8000-000000000140',
      '91000000-0000-4000-8000-000000000140',
      '71000000-0000-4000-8000-000000000145'
    )
  ),
  2::bigint,
  'initializer replay recognizes the exact current revision without upgrading'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000140'
  ),
  3::bigint,
  'all successful replays leave the Access version unchanged'
);

select throws_ok(
  $$
    select * from vortex_access.revise_platform_permission_catalogue_metadata(
      '21000000-0000-4000-8000-000000000140', 2, '1.0.0', '1.0.1',
      '91000000-0000-4000-8000-000000000140',
      '71000000-0000-4000-8000-000000000146'
    )
  $$,
  '22023'::char(5), null,
  'a replay with a broadened expected source revision is refused'
);
select throws_ok(
  $$
    select * from vortex_access.revise_platform_permission_catalogue_metadata(
      '21000000-0000-4000-8000-000000000140', 1, '1.0.1', '1.0.1',
      '91000000-0000-4000-8000-000000000140',
      '71000000-0000-4000-8000-000000000147'
    )
  $$,
  '22023'::char(5), null,
  'a replay without the exact historical source version is refused'
);
select throws_ok(
  $$
    select * from vortex_access.revise_platform_permission_catalogue_metadata(
      '21000000-0000-4000-8000-000000000140', 1, null, '1.0.1',
      '91000000-0000-4000-8000-000000000140',
      '71000000-0000-4000-8000-000000000148'
    )
  $$,
  '22023'::char(5), null,
  'a replay with missing source evidence is refused'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000140'
  ),
  3::bigint,
  'refused metadata-revision calls do not increment Access'
);

select * from finish();

rollback;
