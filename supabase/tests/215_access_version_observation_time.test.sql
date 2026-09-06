begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11215000-0000-4000-8000-000000000001',
  'access_time_tenant', 'Access time tenant', 'active',
  pg_catalog.statement_timestamp(), '91215000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '21215000-0000-4000-8000-000000000001',
    '11215000-0000-4000-8000-000000000001', null,
    'access_time_future', 'Access time future', 'active',
    pg_catalog.statement_timestamp(), '91215000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21215000-0000-4000-8000-000000000002',
    '11215000-0000-4000-8000-000000000001', null,
    'access_time_exhausted', 'Access time exhausted', 'active',
    pg_catalog.statement_timestamp(), '91215000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21215000-0000-4000-8000-000000000001',
  '91215000-0000-4000-8000-000000000001',
  '71215000-0000-4000-8000-000000000001'
);

-- Model a complete prior writer whose observation time is ahead of this
-- statement's wall clock. The protector accepts this ordinary +1 transition;
-- a later shared increment must retain its nondecreasing-time invariant.
update vortex_access.organization_access_versions
set current_version = current_version + 1,
    changed_at = pg_catalog.statement_timestamp() + interval '1 day',
    changed_by = '91215000-0000-4000-8000-000000000002',
    change_correlation_id = '71215000-0000-4000-8000-000000000002',
    change_reason = 'team_membership_changed'
where organization_id = '21215000-0000-4000-8000-000000000001';

create temporary table future_access_before on commit drop as
select *
from vortex_access.organization_access_versions
where organization_id = '21215000-0000-4000-8000-000000000001';

create temporary table future_access_increment on commit drop as
select * from vortex_access.increment_organization_access_version(
  '21215000-0000-4000-8000-000000000001',
  '91215000-0000-4000-8000-000000000003',
  '71215000-0000-4000-8000-000000000003',
  'role_catalogue_changed'
);

select is(
  (select current_version from future_access_increment),
  (select current_version + 1 from future_access_before),
  'a valid increment advances exactly once when the prior observation time is later'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'changedBy', increment_row.changed_by,
      'correlationId', increment_row.change_correlation_id,
      'reason', increment_row.change_reason
    )
    from future_access_increment as increment_row
  ),
  pg_catalog.jsonb_build_object(
    'changedBy', '91215000-0000-4000-8000-000000000003'::uuid,
    'correlationId', '71215000-0000-4000-8000-000000000003'::uuid,
    'reason', 'role_catalogue_changed'
  ),
  'the increment records the exact actor, correlation and reason'
);

select is(
  (select changed_at from future_access_increment),
  (select changed_at from future_access_before),
  'the increment retains the later prior observation time'
);

select is(
  (
    select pg_catalog.to_jsonb(version_row.*)
    from vortex_access.organization_access_versions as version_row
    where version_row.organization_id =
      '21215000-0000-4000-8000-000000000001'
  ),
  (
    select pg_catalog.to_jsonb(increment_row.*)
    from future_access_increment as increment_row
  ),
  'the returned increment is the exact complete stored Access-version row'
);

create temporary table access_before_backwards_update on commit drop as
select *
from vortex_access.organization_access_versions
where organization_id = '21215000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    update vortex_access.organization_access_versions
    set current_version = current_version + 1,
        changed_at = changed_at - interval '1 microsecond',
        changed_by = '91215000-0000-4000-8000-000000000004',
        change_correlation_id = '71215000-0000-4000-8000-000000000004',
        change_reason = 'role_assignment_changed'
    where organization_id = '21215000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  null,
  'the protector still refuses a direct backwards observation time'
);

select is(
  (
    select pg_catalog.to_jsonb(version_row.*)
    from vortex_access.organization_access_versions as version_row
    where version_row.organization_id =
      '21215000-0000-4000-8000-000000000001'
  ),
  (
    select pg_catalog.to_jsonb(snapshot_row.*)
    from access_before_backwards_update as snapshot_row
  ),
  'a refused backwards update preserves the complete Access-version row'
);

insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by,
  change_correlation_id, change_reason
) values (
  '21215000-0000-4000-8000-000000000002', 9007199254740991,
  pg_catalog.statement_timestamp(), '91215000-0000-4000-8000-000000000005',
  '71215000-0000-4000-8000-000000000005', 'organization_initialized'
);

create temporary table exhausted_access_before on commit drop as
select *
from vortex_access.organization_access_versions
where organization_id = '21215000-0000-4000-8000-000000000002';

select throws_ok(
  $$
    select * from vortex_access.increment_organization_access_version(
      '21215000-0000-4000-8000-000000000002',
      '91215000-0000-4000-8000-000000000006',
      '71215000-0000-4000-8000-000000000006',
      'role_catalogue_changed'
    )
  $$,
  '22003'::char(5),
  'Access version is exhausted',
  'safe-integer exhaustion remains explicit'
);

select is(
  (
    select pg_catalog.to_jsonb(version_row.*)
    from vortex_access.organization_access_versions as version_row
    where version_row.organization_id =
      '21215000-0000-4000-8000-000000000002'
  ),
  (
    select pg_catalog.to_jsonb(snapshot_row.*)
    from exhausted_access_before as snapshot_row
  ),
  'an exhausted increment preserves the complete Access-version row'
);

set constraints all immediate;

select * from finish();

rollback;
