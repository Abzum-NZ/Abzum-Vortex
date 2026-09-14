begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

\ir helpers/definition-release-writer.psql
\ir helpers/record-field-access-fixture.psql

-- ============================================================================
-- #37: organisation and application isolation for field projection, field
-- change, protected share grant and protected share revocation, both
-- directions, through the #35 fixed neutral-adapter handoff under the real
-- restricted request role. Every authority fact is built by its owning writer
-- (see helpers/record-field-access-fixture.psql for the writers used and the
-- few labelled direct inserts).
--
-- Two organisations in one tenant. One identity holds an account in each, so
-- identity alone is proven to carry no authority across organisations:
--   ORG A: application X and application Y, account A1 holding both
--          applications' permissions, recipient AR.
--   ORG B: its own application X (an application root belongs to exactly one
--          organisation), account B1 holding its permissions, recipient BR.
-- Each application declares, over two neutral record types, an all_records
-- read (readable F1, F2), update (readable F1, F2; changeable F1) and share
-- permission:
--   'app' storage is application_contained -- a row belongs to one
--         application, so a foreign application's row is refused;
--   'org' storage is organization_shared -- a row belongs to the organisation
--         only, so the organisation comparison (made in the decision's
--         target-row check and again in ownership visibility) is the only
--         thing separating ORG A's rows from ORG B's.
-- An application-contained row of ORG B also names ORG B's own application,
-- so crossing organisations there also crosses applications and is refused
-- by the application comparison even without the organisation one. The
-- organisation-shared rows are what isolate the organisation boundary itself.
-- ============================================================================

\set tenant '14470000-0000-4000-8000-000000000001'
\set org_a '24470000-0000-4000-8000-00000000000a'
\set org_b '24470000-0000-4000-8000-00000000000b'
\set admin_a '54470000-0000-4000-8000-0000000000a0'
\set admin_b '54470000-0000-4000-8000-0000000000b0'
\set app_xa '34470000-0000-4000-8000-0000000000c1'
\set app_ya '34470000-0000-4000-8000-0000000000c2'
\set app_xb '34470000-0000-4000-8000-0000000000c3'
\set identity_one '44470000-0000-4000-8000-000000000001'

-- Neutral rows. 'ax' = ORG A / application X, 'ay' = ORG A / application Y,
-- 'bx' = ORG B / its application X, 'as'/'bs' = organisation-shared rows of
-- ORG A / ORG B. Rows ending 1 are read, granted and shared; rows ending 2 are
-- changed.
\set ax1 'e4470000-0000-4000-8000-0000000000a1'
\set ax2 'e4470000-0000-4000-8000-0000000000a2'
\set ay1 'e4470000-0000-4000-8000-0000000000a3'
\set ay2 'e4470000-0000-4000-8000-0000000000a4'
\set bx1 'e4470000-0000-4000-8000-0000000000b1'
\set bx2 'e4470000-0000-4000-8000-0000000000b2'
\set as1 'e4470000-0000-4000-8000-0000000000c1'
\set as2 'e4470000-0000-4000-8000-0000000000c2'
\set bs1 'e4470000-0000-4000-8000-0000000000d1'
\set bs2 'e4470000-0000-4000-8000-0000000000d2'

-- Neutral field identifiers (helpers/record-field-access-fixture.psql).
\set app_f1 'b4470000-0000-4000-8000-000000000a01'
\set app_f2 'b4470000-0000-4000-8000-000000000a02'
\set org_f1 'b4470000-0000-4000-8000-000000000b01'
\set org_f2 'b4470000-0000-4000-8000-000000000b02'

-- Fixture shares, created through the protected grant below.
\set share_ax '94471000-0000-4000-8000-0000000000a1'
\set share_ay '94471000-0000-4000-8000-0000000000a2'
\set share_as '94471000-0000-4000-8000-0000000000a3'
\set share_bx '94471000-0000-4000-8000-0000000000b1'
\set share_bs '94471000-0000-4000-8000-0000000000b2'

-- ============================================================================
-- Fixture.
-- ============================================================================

select pg_temp.rfa_organization(:'tenant', :'org_a', 'field_isolation_a');
select pg_temp.rfa_organization(:'tenant', :'org_b', 'field_isolation_b');
select pg_temp.rfa_bootstrap_account(:'org_a', :'admin_a', '44470000-0000-4000-8000-0000000000a0', 'Admin A');
select pg_temp.rfa_bootstrap_account(:'org_b', :'admin_b', '44470000-0000-4000-8000-0000000000b0', 'Admin B');

select pg_temp.rfa_invited_account(:'org_a', :'admin_a', :'identity_one', 'Account A1') as a1 \gset
select pg_temp.rfa_invited_account(:'org_a', :'admin_a', '44470000-0000-4000-8000-000000000002', 'Recipient AR') as ar \gset
select pg_temp.rfa_invited_account(:'org_b', :'admin_b', :'identity_one', 'Account B1') as b1 \gset
select pg_temp.rfa_invited_account(:'org_b', :'admin_b', '44470000-0000-4000-8000-000000000003', 'Recipient BR') as br \gset

-- Each application's six permissions: permission id c447...0000000000<app><n>.
create function pg_temp.isolation_permissions(p_app_code text, p_key text)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_array(
    pg_temp.rfa_permission(('c4470000-0000-4000-8000-0000000000' || p_app_code || '1')::uuid,
      p_key || '.app_read', 'app', 'read', 'all_records', array[1, 2], array[]::integer[]),
    pg_temp.rfa_permission(('c4470000-0000-4000-8000-0000000000' || p_app_code || '2')::uuid,
      p_key || '.app_update', 'app', 'update', 'all_records', array[1, 2], array[1]),
    pg_temp.rfa_permission(('c4470000-0000-4000-8000-0000000000' || p_app_code || '3')::uuid,
      p_key || '.app_share', 'app', 'share', 'all_records', array[]::integer[], array[]::integer[]),
    pg_temp.rfa_permission(('c4470000-0000-4000-8000-0000000000' || p_app_code || '4')::uuid,
      p_key || '.org_read', 'org', 'read', 'all_records', array[1, 2], array[]::integer[]),
    pg_temp.rfa_permission(('c4470000-0000-4000-8000-0000000000' || p_app_code || '5')::uuid,
      p_key || '.org_update', 'org', 'update', 'all_records', array[1, 2], array[1]),
    pg_temp.rfa_permission(('c4470000-0000-4000-8000-0000000000' || p_app_code || '6')::uuid,
      p_key || '.org_share', 'org', 'share', 'all_records', array[]::integer[], array[]::integer[])
  )
$function$;

select pg_temp.rfa_register_application(:'org_a', :'app_xa', 'example.field_isolation_x',
  pg_temp.isolation_permissions('1', 'field_isolation_x'));
select pg_temp.rfa_register_application(:'org_a', :'app_ya', 'example.field_isolation_y',
  pg_temp.isolation_permissions('2', 'field_isolation_y'));
select pg_temp.rfa_register_application(:'org_b', :'app_xb', 'example.field_isolation_x',
  pg_temp.isolation_permissions('3', 'field_isolation_x'));

-- One standing custom role per application, over all six of its permissions.
select pg_temp.rfa_custom_role(:'org_a', :'app_xa', '64470000-0000-4000-8000-0000000000c1', 'isolation_x',
  (select pg_catalog.array_agg(('c4470000-0000-4000-8000-00000000001' || n)::uuid) from pg_catalog.generate_series(1, 6) as n));
select pg_temp.rfa_custom_role(:'org_a', :'app_ya', '64470000-0000-4000-8000-0000000000c2', 'isolation_y',
  (select pg_catalog.array_agg(('c4470000-0000-4000-8000-00000000002' || n)::uuid) from pg_catalog.generate_series(1, 6) as n));
select pg_temp.rfa_custom_role(:'org_b', :'app_xb', '64470000-0000-4000-8000-0000000000c3', 'isolation_x',
  (select pg_catalog.array_agg(('c4470000-0000-4000-8000-00000000003' || n)::uuid) from pg_catalog.generate_series(1, 6) as n));

select pg_temp.rfa_assign(:'org_a', '74470000-0000-4000-8000-0000000000c1', '64470000-0000-4000-8000-0000000000c1', :'a1');
select pg_temp.rfa_assign(:'org_a', '74470000-0000-4000-8000-0000000000c2', '64470000-0000-4000-8000-0000000000c2', :'a1');
select pg_temp.rfa_assign(:'org_b', '74470000-0000-4000-8000-0000000000c3', '64470000-0000-4000-8000-0000000000c3', :'b1');

-- Each application's published read and update declarations on each record
-- type: its one matching permission alternative.
insert into vortex_access.test_rfa_declarations (application_root_id, record_type_id, action_kind, permission_ids)
select declared.app_root, binding.record_type_id, declared.action_kind,
  array[('c4470000-0000-4000-8000-0000000000' || declared.app_code
    || case when binding.binding_key = 'app' then declared.app_n else declared.org_n end)::uuid]
from (values
  (:'app_xa'::uuid, '1', 'read', '1', '4'), (:'app_xa'::uuid, '1', 'update', '2', '5'),
  (:'app_ya'::uuid, '2', 'read', '1', '4'), (:'app_ya'::uuid, '2', 'update', '2', '5'),
  (:'app_xb'::uuid, '3', 'read', '1', '4'), (:'app_xb'::uuid, '3', 'update', '2', '5')
) as declared(app_root, app_code, action_kind, app_n, org_n)
cross join vortex_access.test_rfa_bindings as binding;

-- Neutral rows (test-owned storage; see the helper header).
select pg_temp.rfa_row('app', :'org_a', :'app_xa', :'ax1', :'admin_a', 'ax1');
select pg_temp.rfa_row('app', :'org_a', :'app_xa', :'ax2', :'admin_a', 'ax2');
select pg_temp.rfa_row('app', :'org_a', :'app_ya', :'ay1', :'admin_a', 'ay1');
select pg_temp.rfa_row('app', :'org_a', :'app_ya', :'ay2', :'admin_a', 'ay2');
select pg_temp.rfa_row('app', :'org_b', :'app_xb', :'bx1', :'admin_b', 'bx1');
select pg_temp.rfa_row('app', :'org_b', :'app_xb', :'bx2', :'admin_b', 'bx2');
select pg_temp.rfa_row('org', :'org_a', null, :'as1', :'admin_a', 'as1');
select pg_temp.rfa_row('org', :'org_a', null, :'as2', :'admin_a', 'as2');
select pg_temp.rfa_row('org', :'org_b', null, :'bs1', :'admin_b', 'bs1');
select pg_temp.rfa_row('org', :'org_b', null, :'bs2', :'admin_b', 'bs2');

-- Test-only pgTAP visibility while vortex_request is active.
grant usage on schema extensions to vortex_request;

-- Cross-statement checkpoints for "wrote nothing" proofs.
create temporary table isolation_checkpoint (
  checkpoint_key text primary key,
  org_a_version bigint not null,
  org_b_version bigint not null,
  activity_count bigint not null
) on commit drop;

create function pg_temp.isolation_mark(p_key text)
returns void
language sql
volatile
set search_path = ''
as $function$
  insert into pg_temp.isolation_checkpoint
  select p_key,
    pg_temp.rfa_access_version('24470000-0000-4000-8000-00000000000a'),
    pg_temp.rfa_access_version('24470000-0000-4000-8000-00000000000b'),
    (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
     where organization_id in (
       '24470000-0000-4000-8000-00000000000a', '24470000-0000-4000-8000-00000000000b'))
$function$;

-- True when neither organisation's Access version nor Activity changed since
-- the named checkpoint and no share row with p_share_id exists anywhere.
create function pg_temp.isolation_unchanged(p_key text, p_share_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select checkpoint.org_a_version = pg_temp.rfa_access_version('24470000-0000-4000-8000-00000000000a')
    and checkpoint.org_b_version = pg_temp.rfa_access_version('24470000-0000-4000-8000-00000000000b')
    and checkpoint.activity_count = (
      select pg_catalog.count(*) from vortex_activity.organization_activity_entries
      where organization_id in (
        '24470000-0000-4000-8000-00000000000a', '24470000-0000-4000-8000-00000000000b'))
    and not exists (
      select 1 from vortex_access.organization_direct_record_shares as share
      where share.direct_share_id = p_share_id)
  from pg_temp.isolation_checkpoint as checkpoint
  where checkpoint.checkpoint_key = p_key
$function$;

create function pg_temp.share_state(p_share_id uuid)
returns text
language sql
stable
set search_path = ''
as $function$
  select share.state || '|' || share.revision
  from vortex_access.organization_direct_record_shares as share
  where share.direct_share_id = p_share_id
$function$;

-- ============================================================================
-- PROJECTION. Positive controls first: each account reads its own
-- organisation's rows through the same adapter that refuses the foreign ones.
-- ============================================================================

select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;

select is(
  vortex_access.test_rfa_project(:'ax1'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'app_f1', 'ax1-f1', :'app_f2', 'ax1-f2'),
  'control: A1 in application X reads its own organisation''s application-X row -- exactly F1 and F2'
);
select is(
  vortex_access.test_rfa_project(:'as1'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'org_f1', 'as1-f1', :'org_f2', 'as1-f2'),
  'control: A1 in application X reads its own organisation''s organisation-shared row'
);
select is(
  vortex_access.test_rfa_project(:'bs1'),
  '{"outcome":"refused"}'::jsonb,
  'ORG A to ORG B: A1 cannot project ORG B''s organisation-shared row -- no field at all'
);
select is(
  vortex_access.test_rfa_project(:'bx1'),
  '{"outcome":"refused"}'::jsonb,
  'ORG A to ORG B: A1 cannot project ORG B''s application-contained row'
);
select is(
  vortex_access.test_rfa_project(:'ay1'),
  '{"outcome":"refused"}'::jsonb,
  'application X to application Y: A1, acting in X, cannot project Y''s application-contained row'
);
reset role;

select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'ay1'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'app_f1', 'ay1-f1', :'app_f2', 'ay1-f2'),
  'control: the same A1, acting in application Y, reads Y''s own row'
);
select is(
  vortex_access.test_rfa_project(:'ax1'),
  '{"outcome":"refused"}'::jsonb,
  'application Y to application X: A1, acting in Y, cannot project X''s application-contained row'
);
select is(
  vortex_access.test_rfa_project(:'as1'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'org_f1', 'as1-f1', :'org_f2', 'as1-f2'),
  'control: an organisation-shared row belongs to no application, so A1 reads it from application Y as well'
);
reset role;

select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'bx1'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'app_f1', 'bx1-f1', :'app_f2', 'bx1-f2'),
  'control: B1 reads its own organisation''s row'
);
select is(
  vortex_access.test_rfa_project(:'bs1'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'org_f1', 'bs1-f1', :'org_f2', 'bs1-f2'),
  'control: B1 reads its own organisation''s organisation-shared row'
);
select is(
  vortex_access.test_rfa_project(:'as1'),
  '{"outcome":"refused"}'::jsonb,
  'ORG B to ORG A: B1 -- the same identity as A1 -- cannot project ORG A''s organisation-shared row'
);
select is(
  vortex_access.test_rfa_project(:'ax1'),
  '{"outcome":"refused"}'::jsonb,
  'ORG B to ORG A: B1 cannot project ORG A''s application-contained row'
);
reset role;

-- Why each projection was refused: every refusal above is #35's own
-- record-scope refusal of the real row, taken after the account's permission
-- was found eligible -- not a missing declaration or permission, and not this
-- test's adapter.
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
     decision ->> 'organizationAccountId', decision #>> '{target,applicationRootId}',
     record_id, decision ->> 'outcome', decision ->> 'reasonCode') order by decision_id)
   from vortex_access.test_rfa_decisions where operation = 'project'),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'ax1', 'allowed', null),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'as1', 'allowed', null),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'bs1', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'bx1', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'ay1', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_ya', :'ay1', 'allowed', null),
    pg_catalog.jsonb_build_array(:'a1', :'app_ya', :'ax1', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_ya', :'as1', 'allowed', null),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'bx1', 'allowed', null),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'bs1', 'allowed', null),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'as1', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'ax1', 'refused', 'record_scope_refused')
  ),
  'each projection decision: every cross-organisation and cross-application refusal is the decision''s record-scope refusal of the real row'
);

-- ============================================================================
-- CHANGE. A refused change must leave the row exactly as it was.
-- ============================================================================

select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select is(
  vortex_access.test_rfa_change(:'bs2', pg_catalog.jsonb_build_object(:'org_f1', 'a1-was-here')),
  '{"outcome":"refused"}'::jsonb,
  'ORG A to ORG B: A1 cannot change ORG B''s organisation-shared row'
);
select is(
  vortex_access.test_rfa_change(:'bx2', pg_catalog.jsonb_build_object(:'app_f1', 'a1-was-here')),
  '{"outcome":"refused"}'::jsonb,
  'ORG A to ORG B: A1 cannot change ORG B''s application-contained row'
);
select is(
  vortex_access.test_rfa_change(:'ay2', pg_catalog.jsonb_build_object(:'app_f1', 'a1-in-x-was-here')),
  '{"outcome":"refused"}'::jsonb,
  'application X to application Y: A1, acting in X, cannot change Y''s row'
);
select is(
  vortex_access.test_rfa_change(:'ax2', pg_catalog.jsonb_build_object(:'app_f1', 'changed-by-a1-in-x')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'control: A1 in application X changes its own row''s changeable field'
);
select is(
  vortex_access.test_rfa_change(:'as2', pg_catalog.jsonb_build_object(:'org_f1', 'changed-by-a1-in-x')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'control: A1 in application X changes its own organisation-shared row'
);
reset role;

select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select is(
  vortex_access.test_rfa_change(:'ax2', pg_catalog.jsonb_build_object(:'app_f1', 'a1-in-y-was-here')),
  '{"outcome":"refused"}'::jsonb,
  'application Y to application X: A1, acting in Y, cannot change X''s row'
);
select is(
  vortex_access.test_rfa_change(:'ay2', pg_catalog.jsonb_build_object(:'app_f1', 'changed-by-a1-in-y')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'control: A1 in application Y changes Y''s own row'
);
reset role;

select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select is(
  vortex_access.test_rfa_change(:'as2', pg_catalog.jsonb_build_object(:'org_f1', 'b1-was-here')),
  '{"outcome":"refused"}'::jsonb,
  'ORG B to ORG A: B1 cannot change ORG A''s organisation-shared row'
);
select is(
  vortex_access.test_rfa_change(:'ax2', pg_catalog.jsonb_build_object(:'app_f1', 'b1-was-here')),
  '{"outcome":"refused"}'::jsonb,
  'ORG B to ORG A: B1 cannot change ORG A''s application-contained row'
);
select is(
  vortex_access.test_rfa_change(:'bx2', pg_catalog.jsonb_build_object(:'app_f1', 'changed-by-b1')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'control: B1 changes its own row'
);
select is(
  vortex_access.test_rfa_change(:'bs2', pg_catalog.jsonb_build_object(:'org_f1', 'changed-by-b1')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'control: B1 changes its own organisation-shared row'
);
reset role;

-- Ground truth: every refused change left its row exactly as the last
-- permitted change (or the fixture) set it.
select is(
  (select pg_catalog.jsonb_object_agg(record_id, pg_temp.rfa_values(record_id) ->> 'f1')
   from vortex_access.test_rfa_rows),
  pg_catalog.jsonb_build_object(
    :'ax1', 'ax1-f1', :'ax2', 'changed-by-a1-in-x',
    :'ay1', 'ay1-f1', :'ay2', 'changed-by-a1-in-y',
    :'bx1', 'bx1-f1', :'bx2', 'changed-by-b1',
    :'as1', 'as1-f1', :'as2', 'changed-by-a1-in-x',
    :'bs1', 'bs1-f1', :'bs2', 'changed-by-b1'
  ),
  'every row holds only its own organisation and application''s permitted changes; no refused change reached any row'
);
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
     decision ->> 'organizationAccountId', decision #>> '{target,applicationRootId}',
     record_id, decision ->> 'outcome', decision ->> 'reasonCode') order by decision_id)
   from vortex_access.test_rfa_decisions where operation = 'change'),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'bs2', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'bx2', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'ay2', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'ax2', 'allowed', null),
    pg_catalog.jsonb_build_array(:'a1', :'app_xa', :'as2', 'allowed', null),
    pg_catalog.jsonb_build_array(:'a1', :'app_ya', :'ax2', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'a1', :'app_ya', :'ay2', 'allowed', null),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'as2', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'ax2', 'refused', 'record_scope_refused'),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'bx2', 'allowed', null),
    pg_catalog.jsonb_build_array(:'b1', :'app_xb', :'bs2', 'allowed', null)
  ),
  'each change decision: every cross-organisation and cross-application refusal is the decision''s record-scope refusal of the real row'
);

-- ============================================================================
-- GRANT. Control grants create the fixture shares the revocation matrix
-- needs, through the protected grant itself.
-- ============================================================================

select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_grant(%L, %L, 'organization_account', %L, null,
    array[%L]::uuid[], array[]::uuid[], pg_catalog.clock_timestamp(), null,
    'Control share of an application-X row', 'web', pg_catalog.gen_random_uuid())$sql$,
    :'share_ax', :'ax1', :'ar', :'app_f1'),
  'control: A1 in application X shares its own row with a recipient in its own organisation'
);
reset role;
select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_grant(%L, %L, 'organization_account', %L, null,
    array[%L]::uuid[], array[]::uuid[], pg_catalog.clock_timestamp(), null,
    'Control share of an organisation-shared row', 'web', pg_catalog.gen_random_uuid())$sql$,
    :'share_as', :'as1', :'ar', :'org_f1'),
  'control: A1 in application X shares its own organisation-shared row'
);
reset role;
select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_grant(%L, %L, 'organization_account', %L, null,
    array[%L]::uuid[], array[]::uuid[], pg_catalog.clock_timestamp(), null,
    'Control share of an application-Y row', 'web', pg_catalog.gen_random_uuid())$sql$,
    :'share_ay', :'ay1', :'ar', :'app_f1'),
  'control: A1 in application Y shares Y''s own row'
);
reset role;
select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_grant(%L, %L, 'organization_account', %L, null,
    array[%L]::uuid[], array[]::uuid[], pg_catalog.clock_timestamp(), null,
    'Control share in ORG B', 'web', pg_catalog.gen_random_uuid())$sql$,
    :'share_bx', :'bx1', :'br', :'app_f1'),
  'control: B1 shares its own row'
);
reset role;
select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_grant(%L, %L, 'organization_account', %L, null,
    array[%L]::uuid[], array[]::uuid[], pg_catalog.clock_timestamp(), null,
    'Control organisation-shared share in ORG B', 'web', pg_catalog.gen_random_uuid())$sql$,
    :'share_bs', :'bs1', :'br', :'org_f1'),
  'control: B1 shares its own organisation-shared row'
);
reset role;

select is(
  (select pg_catalog.jsonb_object_agg(direct_share_id, pg_catalog.jsonb_build_array(
     organization_id, application_root_id, record_id, state))
   from vortex_access.organization_direct_record_shares
   where organization_id in (:'org_a', :'org_b')),
  pg_catalog.jsonb_build_object(
    :'share_ax', pg_catalog.jsonb_build_array(:'org_a', :'app_xa', :'ax1', 'active'),
    :'share_as', pg_catalog.jsonb_build_array(:'org_a', null, :'as1', 'active'),
    :'share_ay', pg_catalog.jsonb_build_array(:'org_a', :'app_ya', :'ay1', 'active'),
    :'share_bx', pg_catalog.jsonb_build_array(:'org_b', :'app_xb', :'bx1', 'active'),
    :'share_bs', pg_catalog.jsonb_build_array(:'org_b', null, :'bs1', 'active')
  ),
  'the control shares carry exactly their own organisation, application and record'
);

-- Refused grant targets: foreign organisation (both storage kinds, both
-- directions) and foreign application (both directions). Each writes no share
-- row, no Activity entry and no Access-version change in either organisation.
select pg_temp.isolation_mark('grant_a_to_bs');
select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000011', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-organisation target', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'bs1', :'ar', :'org_f1'),
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'ORG A to ORG B grant: A1 cannot share ORG B''s organisation-shared row'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_a_to_bs', '94471000-0000-4000-8000-000000000011'),
  'the foreign-organisation grant wrote no share, Activity or Access change in either organisation'
);

select pg_temp.isolation_mark('grant_a_to_bx');
select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000012', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-organisation target', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'bx1', :'ar', :'app_f1'),
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'ORG A to ORG B grant: A1 cannot share ORG B''s application-contained row'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_a_to_bx', '94471000-0000-4000-8000-000000000012'),
  'that refusal wrote nothing either'
);

select pg_temp.isolation_mark('grant_b_to_as');
select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000013', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-organisation target', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'as1', :'br', :'org_f1'),
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'ORG B to ORG A grant: B1 cannot share ORG A''s organisation-shared row'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_b_to_as', '94471000-0000-4000-8000-000000000013'),
  'the reverse foreign-organisation grant wrote nothing'
);

select pg_temp.isolation_mark('grant_b_to_ax');
select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000014', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-organisation target', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'ax1', :'br', :'app_f1'),
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'ORG B to ORG A grant: B1 cannot share ORG A''s application-contained row'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_b_to_ax', '94471000-0000-4000-8000-000000000014'),
  'that refusal wrote nothing either'
);

select pg_temp.isolation_mark('grant_x_to_ay');
select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000015', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-application target', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'ay1', :'ar', :'app_f1'),
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'application X to application Y grant: A1, acting in X, cannot share Y''s row'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_x_to_ay', '94471000-0000-4000-8000-000000000015'),
  'the foreign-application grant wrote no share, Activity or Access change'
);

select pg_temp.isolation_mark('grant_y_to_ax');
select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000016', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-application target', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'ax1', :'ar', :'app_f1'),
  '42501', 'Protected record-share grant target record is not within your current share authority',
  'application Y to application X grant: A1, acting in Y, cannot share X''s row'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_y_to_ax', '94471000-0000-4000-8000-000000000016'),
  'the reverse foreign-application grant wrote nothing'
);

-- A recipient in the foreign organisation is refused before any authority is
-- evaluated.
select pg_temp.isolation_mark('grant_to_br');
select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94471000-0000-4000-8000-000000000017', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Foreign-organisation recipient', 'web',
    pg_catalog.gen_random_uuid())$sql$, :'ax1', :'br', :'app_f1'),
  '42501', 'Protected record-share recipient is unavailable',
  'A1 cannot share its own row with a recipient account in ORG B'
);
reset role;
select ok(
  pg_temp.isolation_unchanged('grant_to_br', '94471000-0000-4000-8000-000000000017'),
  'the foreign-recipient grant wrote nothing'
);

-- ============================================================================
-- REVOKE. Refusals first; every refused share must still be active at
-- revision 1. A1 granted share_ay and share_ax itself, so for the application
-- cases identity alone would admit -- the application boundary is what
-- refuses. B1 is the same identity as A1, which never crosses organisations.
-- ============================================================================

select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Foreign-organisation revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_bs'),
  '42501', 'Protected record-share revocation is unavailable',
  'ORG A to ORG B revoke: A1 cannot revoke ORG B''s organisation-shared share'
);
select throws_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Foreign-organisation revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_bx'),
  '42501', 'Protected record-share revocation is unavailable',
  'ORG A to ORG B revoke: A1 cannot revoke ORG B''s application-contained share'
);
select throws_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Foreign-application revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_ay'),
  '42501', 'Protected record-share revocation is unavailable',
  'application X to application Y revoke: A1, acting in X, cannot revoke the Y share it granted itself'
);
reset role;

select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Foreign-application revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_ax'),
  '42501', 'Protected record-share revocation is unavailable',
  'application Y to application X revoke: A1, acting in Y, cannot revoke the X share it granted itself'
);
reset role;

select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Foreign-organisation revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_as'),
  '42501', 'Protected record-share revocation is unavailable',
  'ORG B to ORG A revoke: B1 cannot revoke ORG A''s organisation-shared share, though its grantor is the same identity'
);
select throws_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Foreign-organisation revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_ax'),
  '42501', 'Protected record-share revocation is unavailable',
  'ORG B to ORG A revoke: B1 cannot revoke ORG A''s application-contained share'
);
reset role;

select is(
  array[
    pg_temp.share_state(:'share_ax'), pg_temp.share_state(:'share_as'),
    pg_temp.share_state(:'share_ay'), pg_temp.share_state(:'share_bx'),
    pg_temp.share_state(:'share_bs')
  ],
  array['active|1', 'active|1', 'active|1', 'active|1', 'active|1'],
  'every share survives every refused cross-organisation and cross-application revocation unchanged'
);

-- Control revocations: each share is revocable from its own organisation and,
-- where application-contained, its own application; an organisation-shared
-- share is revocable from the organisation's other application too.
select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Control revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_as'),
  'control: A1, acting in application Y, revokes the organisation-shared share it granted from X'
);
reset role;
select pg_temp.rfa_context(:'org_a', :'app_ya', :'a1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Control revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_ay'),
  'control: A1 revokes the application-Y share from application Y'
);
reset role;
select pg_temp.rfa_context(:'org_a', :'app_xa', :'a1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Control revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_ax'),
  'control: A1 revokes the application-X share from application X'
);
reset role;
select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Control revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_bx'),
  'control: B1 revokes its own organisation''s share'
);
reset role;
select pg_temp.rfa_context(:'org_b', :'app_xb', :'b1');
set local role vortex_request;
select lives_ok(
  format($sql$select vortex_access.test_rfa_revoke(%L, 1, 'Control revocation',
    'web', pg_catalog.gen_random_uuid())$sql$, :'share_bs'),
  'control: B1 revokes its own organisation-shared share'
);
reset role;

select is(
  array[
    pg_temp.share_state(:'share_ax'), pg_temp.share_state(:'share_as'),
    pg_temp.share_state(:'share_ay'), pg_temp.share_state(:'share_bx'),
    pg_temp.share_state(:'share_bs')
  ],
  array['revoked|2', 'revoked|2', 'revoked|2', 'revoked|2', 'revoked|2'],
  'each control revocation revoked exactly its own share once'
);

-- ============================================================================
-- Boundary.
-- ============================================================================

select pg_temp.rfa_clear_context();

select ok(
  not pg_catalog.has_table_privilege('vortex_request', relation.name, privilege.kind),
  'vortex_request has no ' || privilege.kind || ' privilege on ' || relation.name
)
from (values
  ('vortex_access.test_rfa_rows'), ('vortex_access.test_rfa_bindings'),
  ('vortex_access.test_rfa_declarations'), ('vortex_access.test_rfa_decisions')
) as relation(name)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as privilege(kind)
order by relation.name collate "C", privilege.kind collate "C";

select ok(
  pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request can execute the fixed adapter ' || target.signature
)
from (values
  ('vortex_access.test_rfa_project(uuid)'),
  ('vortex_access.test_rfa_change(uuid,jsonb)'),
  ('vortex_access.test_rfa_grant(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid)'),
  ('vortex_access.test_rfa_revoke(uuid,bigint,text,text,uuid)')
) as target(signature)
order by target.signature collate "C";

select ok(
  not pg_catalog.has_function_privilege('vortex_request', target.signature, 'EXECUTE'),
  'vortex_request cannot execute ' || target.signature
)
from (values
  ('vortex_access.test_rfa_facts(vortex_access.test_rfa_rows,vortex_access.test_rfa_bindings)'),
  ('vortex_access.test_rfa_declaration(text,vortex_access.test_rfa_bindings)'),
  ('vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'),
  ('vortex_access.resolve_record_field_bounds_internal(jsonb)'),
  ('vortex_access.grant_record_share_for_administration(uuid,uuid,text,uuid,uuid,uuid[],uuid[],timestamptz,timestamptz,text,text,uuid,jsonb)'),
  ('vortex_access.revoke_record_share_for_administration(uuid,bigint,text,text,uuid)')
) as target(signature)
order by target.signature collate "C";

select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname, 'securityDefiner', procedure_row.prosecdef,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.pronamespace = 'vortex_access'::regnamespace
      and procedure_row.proname in (
        'test_rfa_change', 'test_rfa_grant', 'test_rfa_project', 'test_rfa_revoke'
      )
  ),
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'owner', 'postgres', 'securityDefiner', true, 'configuration', array['search_path=""']
    ))
    from pg_catalog.generate_series(1, 4)
  ),
  'the four fixed adapters are owner-held, security definer and empty-search-path'
);

set constraints all immediate;

select * from finish();

rollback;
