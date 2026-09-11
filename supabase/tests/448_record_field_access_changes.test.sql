begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

\ir helpers/definition-release-writer.psql
\ir helpers/record-field-access-fixture.psql

-- ============================================================================
-- #37: access changes reach the next request's field set, and the protected
-- share path's remaining gaps. Every change under test goes through its
-- owning writer, and every field set is observed through the fixed neutral
-- projection and change adapters under the real restricted request role.
--
-- One organisation, one application. Each viewer account holds three
-- independent contributions to the same neutral record:
--   F1 through a direct standing role (all_records read/update, F1 only),
--   F2 through a Group membership whose Group holds a role (F2 only),
--   F3 through a direct share from GRANTOR (readable and changeable F3),
--        which a direct_share-routed permission lets the viewer use.
-- So each viewer reads and changes F1, F2 and F3, and each change removes
-- exactly one contribution while the other two remain.
--
-- Part 1 (item 2): account closed, role assignment revoked and expired,
-- Group membership revoked and expired, share revoked, Access version changed.
-- Each case projects and changes before, applies the change, then projects
-- and changes again.
-- Part 2 (item 3): Activity-append failure through the protected grant;
-- the protected revoke's single Activity entry and Access change; two shares
-- for one recipient, one revoked, beside an independent ownership authority.
-- ============================================================================

\set tenant '14480000-0000-4000-8000-000000000001'
\set org '24480000-0000-4000-8000-00000000000c'
\set admin '54480000-0000-4000-8000-0000000000a0'
\set app '34480000-0000-4000-8000-0000000000c1'
\set group_g '84480000-0000-4000-8000-000000000001'
\set f1 'b4470000-0000-4000-8000-000000000a01'
\set f2 'b4470000-0000-4000-8000-000000000a02'
\set f3 'b4470000-0000-4000-8000-000000000a03'

-- Permissions (application-owned, over the neutral 'app' record type).
\set p_role_read 'c4480000-0000-4000-8000-000000000001'
\set p_role_update 'c4480000-0000-4000-8000-000000000002'
\set p_group_read 'c4480000-0000-4000-8000-000000000003'
\set p_group_update 'c4480000-0000-4000-8000-000000000004'
\set p_share_read 'c4480000-0000-4000-8000-000000000005'
\set p_share_update 'c4480000-0000-4000-8000-000000000006'
\set p_admin_read 'c4480000-0000-4000-8000-000000000007'
\set p_admin_update 'c4480000-0000-4000-8000-000000000008'
\set p_admin_share 'c4480000-0000-4000-8000-000000000009'
\set p_own_read 'c4480000-0000-4000-8000-00000000000a'
\set p_own_update 'c4480000-0000-4000-8000-00000000000b'

-- Roles.
\set r_role '64480000-0000-4000-8000-000000000001'
\set r_group '64480000-0000-4000-8000-000000000002'
\set r_share '64480000-0000-4000-8000-000000000003'
\set r_admin '64480000-0000-4000-8000-000000000004'
\set r_own '64480000-0000-4000-8000-000000000005'

-- One neutral record per case.
\set rec_close 'e4480000-0000-4000-8000-000000000001'
\set rec_role 'e4480000-0000-4000-8000-000000000002'
\set rec_role_exp 'e4480000-0000-4000-8000-000000000003'
\set rec_group 'e4480000-0000-4000-8000-000000000004'
\set rec_group_exp 'e4480000-0000-4000-8000-000000000005'
\set rec_share 'e4480000-0000-4000-8000-000000000006'
\set rec_version 'e4480000-0000-4000-8000-000000000007'
\set rec_3a 'e4480000-0000-4000-8000-00000000003a'
\set rec_3b 'e4480000-0000-4000-8000-00000000003b'
\set rec_3c 'e4480000-0000-4000-8000-00000000003c'

-- ============================================================================
-- Fixture.
-- ============================================================================

select pg_temp.rfa_organization(:'tenant', :'org', 'field_changes');
select pg_temp.rfa_bootstrap_account(:'org', :'admin', '44480000-0000-4000-8000-0000000000a0', 'Admin');

select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000001', 'Grantor') as grantor \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000011', 'Viewer closed') as v_close \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000012', 'Viewer role revoked') as v_role \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000013', 'Viewer role expired') as v_role_exp \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000014', 'Viewer group revoked') as v_group \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000015', 'Viewer group expired') as v_group_exp \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000016', 'Viewer share revoked') as v_share \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000017', 'Viewer version changed') as v_version \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000031', 'Recipient 3') as recipient_3 \gset
select pg_temp.rfa_invited_account(:'org', :'admin', '44480000-0000-4000-8000-000000000032', 'Recipient 3C') as recipient_3c \gset

select pg_temp.rfa_register_application(:'org', :'app', 'example.field_changes', pg_catalog.jsonb_build_array(
  pg_temp.rfa_permission(:'p_role_read', 'field_changes.role_read', 'app', 'read', 'all_records', array[1], array[]::integer[]),
  pg_temp.rfa_permission(:'p_role_update', 'field_changes.role_update', 'app', 'update', 'all_records', array[1], array[1]),
  pg_temp.rfa_permission(:'p_group_read', 'field_changes.group_read', 'app', 'read', 'all_records', array[2], array[]::integer[]),
  pg_temp.rfa_permission(:'p_group_update', 'field_changes.group_update', 'app', 'update', 'all_records', array[2], array[2]),
  pg_temp.rfa_permission(:'p_share_read', 'field_changes.share_read', 'app', 'read', 'direct_share', array[1, 2, 3], array[]::integer[]),
  pg_temp.rfa_permission(:'p_share_update', 'field_changes.share_update', 'app', 'update', 'direct_share', array[1, 2, 3], array[1, 2, 3]),
  pg_temp.rfa_permission(:'p_admin_read', 'field_changes.admin_read', 'app', 'read', 'all_records', array[1, 2, 3], array[]::integer[]),
  pg_temp.rfa_permission(:'p_admin_update', 'field_changes.admin_update', 'app', 'update', 'all_records', array[1, 2, 3], array[1, 2, 3]),
  pg_temp.rfa_permission(:'p_admin_share', 'field_changes.admin_share', 'app', 'share', 'all_records', array[]::integer[], array[]::integer[]),
  pg_temp.rfa_permission(:'p_own_read', 'field_changes.own_read', 'app', 'read', 'ownership', array[3], array[]::integer[]),
  pg_temp.rfa_permission(:'p_own_update', 'field_changes.own_update', 'app', 'update', 'ownership', array[3], array[3])
));

select pg_temp.rfa_custom_role(:'org', :'app', :'r_role', 'role_fields', array[:'p_role_read', :'p_role_update']::uuid[]);
select pg_temp.rfa_custom_role(:'org', :'app', :'r_group', 'group_fields', array[:'p_group_read', :'p_group_update']::uuid[]);
select pg_temp.rfa_custom_role(:'org', :'app', :'r_share', 'share_route', array[:'p_share_read', :'p_share_update']::uuid[]);
select pg_temp.rfa_custom_role(:'org', :'app', :'r_admin', 'administrator', array[:'p_admin_read', :'p_admin_update', :'p_admin_share']::uuid[]);
select pg_temp.rfa_custom_role(:'org', :'app', :'r_own', 'owner_fields', array[:'p_own_read', :'p_own_update']::uuid[]);

select pg_temp.rfa_group(:'org', :'group_g', 'field_group');
select pg_temp.rfa_assign(:'org', '74480000-0000-4000-8000-0000000000f1', :'r_group', null, :'group_g');
select pg_temp.rfa_assign(:'org', '74480000-0000-4000-8000-0000000000f2', :'r_admin', :'grantor');

-- The application's published read and update declarations: every
-- alternative of that action on the record type.
insert into vortex_access.test_rfa_declarations (application_root_id, record_type_id, action_kind, permission_ids)
values
  (:'app', 'd4470000-0000-4000-8000-0000000000a1', 'read',
    array[:'p_role_read', :'p_group_read', :'p_share_read', :'p_admin_read', :'p_own_read']::uuid[]),
  (:'app', 'd4470000-0000-4000-8000-0000000000a1', 'update',
    array[:'p_role_update', :'p_group_update', :'p_share_update', :'p_admin_update', :'p_own_update']::uuid[]);

-- Neutral rows (test-owned storage). rec_3c is owned by recipient_3c; every
-- other row by the administrator, so ownership admits nobody else.
select pg_temp.rfa_row('app', :'org', :'app', :'rec_close', :'admin', 'close');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_role', :'admin', 'role');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_role_exp', :'admin', 'role-exp');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_group', :'admin', 'group');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_group_exp', :'admin', 'group-exp');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_share', :'admin', 'share');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_version', :'admin', 'version');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_3a', :'admin', 'r3a');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_3b', :'admin', 'r3b');
select pg_temp.rfa_row('app', :'org', :'app', :'rec_3c', :'recipient_3c', 'r3c');

grant usage on schema extensions to vortex_request;

-- GRANTOR shares F3 (readable and changeable) of one record with one account,
-- through the fixed grant adapter and the protected grant, as vortex_request.
create function pg_temp.grantor_shares(
  p_share_id uuid,
  p_record_id uuid,
  p_recipient_id uuid,
  p_readable uuid[],
  p_changeable uuid[],
  p_activity_id uuid default null
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  result jsonb;
begin
  perform pg_temp.rfa_context(
    '24480000-0000-4000-8000-00000000000c', '34480000-0000-4000-8000-0000000000c1',
    (select account.organization_account_id from vortex_identity.organization_accounts as account
     where account.organization_id = '24480000-0000-4000-8000-00000000000c'
       and account.display_name = 'Grantor')
  );
  set local role vortex_request;
  result := vortex_access.test_rfa_grant(
    p_share_id, p_record_id, 'organization_account', p_recipient_id, null,
    p_readable, p_changeable, pg_catalog.clock_timestamp(), null,
    'Fixture share', 'web', coalesce(p_activity_id, pg_catalog.gen_random_uuid())
  );
  reset role;
  return result;
end
$function$;

-- The three contributions every Part 1 viewer holds on its own record.
create function pg_temp.viewer_authority(
  p_viewer uuid,
  p_record_id uuid,
  p_case integer,
  p_role_expires_at timestamptz default null,
  p_membership_expires_at timestamptz default null
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
begin
  perform pg_temp.rfa_assign('24480000-0000-4000-8000-00000000000c',
    ('74480000-0000-4000-8000-0000000001' || pg_catalog.lpad(p_case::text, 2, '0'))::uuid,
    '64480000-0000-4000-8000-000000000001', p_viewer, null, p_role_expires_at);
  perform pg_temp.rfa_assign('24480000-0000-4000-8000-00000000000c',
    ('74480000-0000-4000-8000-0000000002' || pg_catalog.lpad(p_case::text, 2, '0'))::uuid,
    '64480000-0000-4000-8000-000000000003', p_viewer);
  perform pg_temp.rfa_membership('24480000-0000-4000-8000-00000000000c',
    ('84480000-0000-4000-8000-0000000001' || pg_catalog.lpad(p_case::text, 2, '0'))::uuid,
    '84480000-0000-4000-8000-000000000001', p_viewer, p_membership_expires_at);
  perform pg_temp.grantor_shares(
    ('94481000-0000-4000-8000-0000000000' || pg_catalog.lpad(p_case::text, 2, '0'))::uuid,
    p_record_id, p_viewer,
    array['b4470000-0000-4000-8000-000000000a03']::uuid[],
    array['b4470000-0000-4000-8000-000000000a03']::uuid[]
  );
  perform pg_temp.rfa_clear_context();
end
$function$;

-- Waits, in bounded 100 ms steps, until the database clock has passed p_instant.
create function pg_temp.wait_past(p_instant timestamptz)
returns boolean
language plpgsql
volatile
set search_path = ''
as $function$
begin
  for step in 1 .. 200 loop
    exit when pg_catalog.clock_timestamp() > p_instant;
    perform pg_catalog.pg_sleep(0.1);
  end loop;
  return pg_catalog.clock_timestamp() > p_instant;
end
$function$;

create temporary table change_checkpoint (
  checkpoint_key text primary key,
  access_version bigint not null,
  activity_count bigint not null,
  observed_at timestamptz not null
) on commit drop;

create function pg_temp.change_mark(p_key text)
returns void
language sql
volatile
set search_path = ''
as $function$
  insert into pg_temp.change_checkpoint
  select p_key, pg_temp.rfa_access_version('24480000-0000-4000-8000-00000000000c'),
    (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
     where organization_id = '24480000-0000-4000-8000-00000000000c'),
    pg_catalog.clock_timestamp()
$function$;

create function pg_temp.change_version(p_key text)
returns bigint
language sql
stable
set search_path = ''
as $function$
  select access_version from pg_temp.change_checkpoint where checkpoint_key = p_key
$function$;

create function pg_temp.change_activity(p_key text)
returns bigint
language sql
stable
set search_path = ''
as $function$
  select activity_count from pg_temp.change_checkpoint where checkpoint_key = p_key
$function$;

-- ============================================================================
-- PART 1 (a): the acting account's own state. Closing the account refuses
-- its next request outright, although its role, Group and share are unchanged.
-- ============================================================================

select pg_temp.viewer_authority(:'v_close', :'rec_close', 1);

select pg_temp.rfa_context(:'org', :'app', :'v_close');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_close'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'close-f1', :'f2', 'close-f2', :'f3', 'close-f3'),
  'account closed, before: the viewer reads F1 (role), F2 (Group) and F3 (share)'
);
select is(
  vortex_access.test_rfa_change(:'rec_close', pg_catalog.jsonb_build_object(:'f1', 'close-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'account closed, before: the viewer changes F1'
);
reset role;

select pg_temp.rfa_context(:'org', :'app', :'admin');
select is(
  (select changed.state from vortex_access.change_organization_account_state(
     :'v_close',
     (select revision from vortex_identity.organization_accounts
      where organization_id = :'org' and organization_account_id = :'v_close'),
     'closed') as changed),
  'closed',
  'account closed: the administrator closes the viewer''s account through the account-lifecycle writer'
);

select pg_temp.rfa_context(:'org', :'app', :'v_close');
set local role vortex_request;
select throws_ok(
  format('select vortex_access.test_rfa_project(%L)', :'rec_close'),
  '42501', 'Organisation-account context is inactive or unavailable',
  'account closed, after: the next projection returns no field at all'
);
select throws_ok(
  format('select vortex_access.test_rfa_change(%L, %L::jsonb)', :'rec_close',
    pg_catalog.jsonb_build_object(:'f1', 'close-after')),
  '42501', 'Organisation-account context is inactive or unavailable',
  'account closed, after: the next change is refused'
);
reset role;
select is(
  pg_temp.rfa_values(:'rec_close'),
  '{"f1":"close-before","f2":"close-f2","f3":"close-f3"}'::jsonb,
  'account closed, after: the row keeps the value the viewer set before closure'
);
select is(
  (select pg_catalog.jsonb_build_array(
     (select pg_catalog.count(*) from vortex_access.organization_role_assignments
      where organization_id = :'org' and organization_account_id = :'v_close' and state = 'live'),
     (select pg_catalog.count(*) from vortex_access.organization_group_memberships
      where organization_id = :'org' and organization_account_id = :'v_close' and state = 'live'),
     (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
      where organization_id = :'org' and organization_account_id = :'v_close' and state = 'active'))),
  '[2, 1, 1]'::jsonb,
  'account closed: the viewer''s two role assignments, Group membership and share are all still current -- only the account state changed'
);

-- ============================================================================
-- PART 1 (b): a role assignment revoked. The next request loses F1 only.
-- ============================================================================

select pg_temp.viewer_authority(:'v_role', :'rec_role', 2);

select pg_temp.rfa_context(:'org', :'app', :'v_role');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_role'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'role-f1', :'f2', 'role-f2', :'f3', 'role-f3'),
  'role revoked, before: the viewer reads F1, F2 and F3'
);
select is(
  vortex_access.test_rfa_change(:'rec_role', pg_catalog.jsonb_build_object(:'f1', 'role-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'role revoked, before: the viewer changes F1'
);
reset role;

select pg_temp.rfa_revoke_assignment(:'org', '74480000-0000-4000-8000-000000000102');

select pg_temp.rfa_context(:'org', :'app', :'v_role');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_role'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f2', 'role-f2', :'f3', 'role-f3'),
  'role revoked, after: the next projection holds F2 and F3 only -- F1 is absent, not blank'
);
select is(
  vortex_access.test_rfa_change(:'rec_role', pg_catalog.jsonb_build_object(:'f1', 'role-after')),
  '{"outcome":"refused"}'::jsonb,
  'role revoked, after: F1 is no longer changeable'
);
select is(
  vortex_access.test_rfa_change(:'rec_role', pg_catalog.jsonb_build_object(:'f2', 'role-f2-after')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'role revoked, after: F2 is still changeable through the Group'
);
reset role;
select is(
  pg_temp.rfa_values(:'rec_role'),
  '{"f1":"role-before","f2":"role-f2-after","f3":"role-f3"}'::jsonb,
  'role revoked: the refused F1 change left F1 as it was'
);

-- ============================================================================
-- PART 1 (c): a role assignment expired. No writer runs and the Access
-- version does not change; the same context still loses F1 on its next
-- request once the assignment's own expiry has passed.
-- ============================================================================

select pg_catalog.clock_timestamp() + interval '3 seconds' as role_expires_at \gset
select pg_temp.viewer_authority(:'v_role_exp', :'rec_role_exp', 3, :'role_expires_at'::timestamptz);

select pg_temp.rfa_context(:'org', :'app', :'v_role_exp');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_role_exp'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'role-exp-f1', :'f2', 'role-exp-f2', :'f3', 'role-exp-f3'),
  'role expired, before: the viewer reads F1, F2 and F3 while the assignment is current'
);
select is(
  vortex_access.test_rfa_change(:'rec_role_exp', pg_catalog.jsonb_build_object(:'f1', 'role-exp-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'role expired, before: the viewer changes F1'
);
reset role;
select pg_temp.change_mark('role_expiry');
select ok(
  (select observed_at < :'role_expires_at'::timestamptz from pg_temp.change_checkpoint
   where checkpoint_key = 'role_expiry'),
  'role expired: the before-checks ran while the assignment was still current'
);
select ok(pg_temp.wait_past(:'role_expires_at'::timestamptz), 'role expired: the database clock has passed the assignment''s expiry');

set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_role_exp'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f2', 'role-exp-f2', :'f3', 'role-exp-f3'),
  'role expired, after: the same context''s next projection holds F2 and F3 only'
);
select is(
  vortex_access.test_rfa_change(:'rec_role_exp', pg_catalog.jsonb_build_object(:'f1', 'role-exp-after')),
  '{"outcome":"refused"}'::jsonb,
  'role expired, after: F1 is no longer changeable'
);
reset role;
select is(
  pg_temp.rfa_access_version(:'org'),
  pg_temp.change_version('role_expiry'),
  'role expired: no Access version change was needed -- an unchanged version does not keep an expired assignment alive'
);
select is(
  pg_temp.rfa_values(:'rec_role_exp') ->> 'f1',
  'role-exp-before',
  'role expired: the refused F1 change left F1 as it was'
);

-- ============================================================================
-- PART 1 (d): a Group membership revoked. The next request loses F2 only.
-- ============================================================================

select pg_temp.viewer_authority(:'v_group', :'rec_group', 4);

select pg_temp.rfa_context(:'org', :'app', :'v_group');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_group'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'group-f1', :'f2', 'group-f2', :'f3', 'group-f3'),
  'Group membership revoked, before: the viewer reads F1, F2 and F3'
);
select is(
  vortex_access.test_rfa_change(:'rec_group', pg_catalog.jsonb_build_object(:'f2', 'group-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'Group membership revoked, before: the viewer changes F2'
);
reset role;

select pg_temp.rfa_remove_membership(:'org', '84480000-0000-4000-8000-000000000104');

select pg_temp.rfa_context(:'org', :'app', :'v_group');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_group'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'group-f1', :'f3', 'group-f3'),
  'Group membership revoked, after: the next projection holds F1 and F3 only'
);
select is(
  vortex_access.test_rfa_change(:'rec_group', pg_catalog.jsonb_build_object(:'f2', 'group-after')),
  '{"outcome":"refused"}'::jsonb,
  'Group membership revoked, after: F2 is no longer changeable'
);
select is(
  vortex_access.test_rfa_change(:'rec_group', pg_catalog.jsonb_build_object(:'f1', 'group-f1-after')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'Group membership revoked, after: F1 is still changeable through the direct role'
);
reset role;
select is(
  pg_temp.rfa_values(:'rec_group'),
  '{"f1":"group-f1-after","f2":"group-before","f3":"group-f3"}'::jsonb,
  'Group membership revoked: the refused F2 change left F2 as it was'
);

-- ============================================================================
-- PART 1 (e): a Group membership expired, with no writer and no Access change.
-- ============================================================================

select pg_catalog.clock_timestamp() + interval '3 seconds' as membership_expires_at \gset
select pg_temp.viewer_authority(:'v_group_exp', :'rec_group_exp', 5, null, :'membership_expires_at'::timestamptz);

select pg_temp.rfa_context(:'org', :'app', :'v_group_exp');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_group_exp'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'group-exp-f1', :'f2', 'group-exp-f2', :'f3', 'group-exp-f3'),
  'Group membership expired, before: the viewer reads F1, F2 and F3 while the membership is current'
);
select is(
  vortex_access.test_rfa_change(:'rec_group_exp', pg_catalog.jsonb_build_object(:'f2', 'group-exp-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'Group membership expired, before: the viewer changes F2'
);
reset role;
select pg_temp.change_mark('membership_expiry');
select ok(
  (select observed_at < :'membership_expires_at'::timestamptz from pg_temp.change_checkpoint
   where checkpoint_key = 'membership_expiry'),
  'Group membership expired: the before-checks ran while the membership was still current'
);
select ok(pg_temp.wait_past(:'membership_expires_at'::timestamptz), 'Group membership expired: the database clock has passed the membership''s expiry');

set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_group_exp'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'group-exp-f1', :'f3', 'group-exp-f3'),
  'Group membership expired, after: the same context''s next projection holds F1 and F3 only'
);
select is(
  vortex_access.test_rfa_change(:'rec_group_exp', pg_catalog.jsonb_build_object(:'f2', 'group-exp-after')),
  '{"outcome":"refused"}'::jsonb,
  'Group membership expired, after: F2 is no longer changeable'
);
reset role;
select is(
  pg_temp.rfa_access_version(:'org'),
  pg_temp.change_version('membership_expiry'),
  'Group membership expired: no Access version change was needed'
);
select is(
  pg_temp.rfa_values(:'rec_group_exp') ->> 'f2',
  'group-exp-before',
  'Group membership expired: the refused F2 change left F2 as it was'
);

-- ============================================================================
-- PART 1 (f): a share revoked through the protected revoke. The next request
-- loses F3 only.
-- ============================================================================

select pg_temp.viewer_authority(:'v_share', :'rec_share', 6);

select pg_temp.rfa_context(:'org', :'app', :'v_share');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_share'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'share-f1', :'f2', 'share-f2', :'f3', 'share-f3'),
  'share revoked, before: the viewer reads F1, F2 and F3'
);
select is(
  vortex_access.test_rfa_change(:'rec_share', pg_catalog.jsonb_build_object(:'f3', 'share-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'share revoked, before: the viewer changes F3 through the share'
);
reset role;

select pg_temp.rfa_context(:'org', :'app', :'grantor');
set local role vortex_request;
select lives_ok(
  $$select vortex_access.test_rfa_revoke('94481000-0000-4000-8000-000000000006', 1,
    'Share withdrawn', 'web', pg_catalog.gen_random_uuid())$$,
  'share revoked: the grantor revokes the share through the protected revoke'
);
reset role;

select pg_temp.rfa_context(:'org', :'app', :'v_share');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_share'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'share-f1', :'f2', 'share-f2'),
  'share revoked, after: the next projection holds F1 and F2 only'
);
select is(
  vortex_access.test_rfa_change(:'rec_share', pg_catalog.jsonb_build_object(:'f3', 'share-after')),
  '{"outcome":"refused"}'::jsonb,
  'share revoked, after: F3 is no longer changeable'
);
select is(
  vortex_access.test_rfa_change(:'rec_share', pg_catalog.jsonb_build_object(:'f1', 'share-f1-after')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'share revoked, after: F1 is still changeable through the direct role'
);
reset role;
select is(
  pg_temp.rfa_values(:'rec_share'),
  '{"f1":"share-f1-after","f2":"share-f2","f3":"share-before"}'::jsonb,
  'share revoked: the refused F3 change left F3 as it was'
);

-- ============================================================================
-- PART 1 (g): an Access-version change. An unrelated Access change (a new
-- Group) leaves the viewer's authority as it was, but a request still
-- carrying the earlier version gets no field at all. The next request, at the
-- current version, is evaluated again and reads the same fields.
-- ============================================================================

select pg_temp.viewer_authority(:'v_version', :'rec_version', 7);

select pg_temp.rfa_context(:'org', :'app', :'v_version');
select pg_temp.change_mark('version_change');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_version'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'version-f1', :'f2', 'version-f2', :'f3', 'version-f3'),
  'Access version changed, before: the viewer reads F1, F2 and F3'
);
select is(
  vortex_access.test_rfa_change(:'rec_version', pg_catalog.jsonb_build_object(:'f1', 'version-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'Access version changed, before: the viewer changes F1'
);
reset role;

-- The unrelated change runs through its own writer; the viewer's context
-- (captured at the earlier version) stays installed.
select pg_temp.rfa_group(:'org', '84480000-0000-4000-8000-000000000099', 'unrelated_group');
select is(
  pg_temp.rfa_access_version(:'org'),
  pg_temp.change_version('version_change') + 1,
  'Access version changed: the unrelated Group creation advanced the organisation''s Access version once'
);

set local role vortex_request;
select throws_ok(
  format('select vortex_access.test_rfa_project(%L)', :'rec_version'),
  '42501', 'Request access version is stale or unavailable',
  'Access version changed, after: a request still carrying the earlier version gets no field at all'
);
select throws_ok(
  format('select vortex_access.test_rfa_change(%L, %L::jsonb)', :'rec_version',
    pg_catalog.jsonb_build_object(:'f1', 'version-stale')),
  '42501', 'Request access version is stale or unavailable',
  'Access version changed, after: a change carrying the earlier version is refused'
);
reset role;
select is(
  pg_temp.rfa_values(:'rec_version') ->> 'f1',
  'version-before',
  'Access version changed: the refused stale change left F1 as it was'
);

select pg_temp.rfa_context(:'org', :'app', :'v_version');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_version'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'version-before', :'f2', 'version-f2', :'f3', 'version-f3'),
  'Access version changed, next request: evaluated again at the current version, the unchanged authority reads F1, F2 and F3'
);
reset role;

-- ============================================================================
-- PART 2 (a): an Activity-append failure inside the protected grant rolls the
-- share and its Access change back together. The colliding Activity entry is
-- one the protected grant itself wrote for an earlier share.
-- ============================================================================

select is(
  pg_temp.grantor_shares('94481000-0000-4000-8000-0000000003a1', :'rec_3a', :'recipient_3',
    array[:'f1']::uuid[], array[]::uuid[], 'a4480000-0000-4000-8000-0000000003a1') ->> 'state',
  'active',
  'Activity failure: a first protected grant succeeds and records Activity a...3a1'
);

select pg_temp.change_mark('activity_failure');
select pg_temp.rfa_context(:'org', :'app', :'grantor');
set local role vortex_request;
select throws_ok(
  format($sql$select vortex_access.test_rfa_grant('94481000-0000-4000-8000-0000000003a2', %L,
    'organization_account', %L, null, array[%L]::uuid[], array[]::uuid[],
    pg_catalog.clock_timestamp(), null, 'Second share reusing an Activity identity', 'web',
    'a4480000-0000-4000-8000-0000000003a1')$sql$, :'rec_3a', :'recipient_3', :'f2'),
  '22023', 'Activity identity already records different evidence',
  'Activity failure: a second protected grant whose Activity append collides is refused'
);
reset role;
select is(
  (select pg_catalog.count(*) from vortex_access.organization_direct_record_shares
   where organization_id = :'org' and direct_share_id = '94481000-0000-4000-8000-0000000003a2'),
  0::bigint,
  'Activity failure: the refused grant''s share row was rolled back'
);
select is(
  pg_temp.rfa_access_version(:'org'),
  pg_temp.change_version('activity_failure'),
  'Activity failure: its Access-version change was rolled back with it'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries where organization_id = :'org'),
  pg_temp.change_activity('activity_failure'),
  'Activity failure: no Activity entry was added'
);
select is(
  (select subject_ids from vortex_activity.organization_activity_entries
   where organization_id = :'org' and activity_id = 'a4480000-0000-4000-8000-0000000003a1'),
  array['94481000-0000-4000-8000-0000000003a1']::uuid[],
  'Activity failure: the colliding Activity entry still records only the first share'
);

-- ============================================================================
-- PART 2 (b): a successful protected revoke produces exactly one Activity
-- entry and exactly one Access change.
-- ============================================================================

select is(
  pg_temp.grantor_shares('94481000-0000-4000-8000-0000000003b1', :'rec_3b', :'recipient_3',
    array[:'f1']::uuid[], array[]::uuid[]) ->> 'state',
  'active',
  'single revoke effect: the grantor shares a record'
);

select pg_temp.change_mark('single_revoke');
select pg_temp.rfa_context(:'org', :'app', :'grantor', 0, 'a4480000-0000-4000-8000-0000000003b9');
set local role vortex_request;
select is(
  vortex_access.test_rfa_revoke('94481000-0000-4000-8000-0000000003b1', 1,
    'Single-effect revocation', 'interface', 'a4480000-0000-4000-8000-0000000003b2') ->> 'state',
  'revoked',
  'single revoke effect: the grantor revokes it through the protected revoke'
);
reset role;
select is(
  (select pg_catalog.jsonb_build_array(current_version, change_reason, changed_by, change_correlation_id)
   from vortex_access.organization_access_versions where organization_id = :'org'),
  pg_catalog.jsonb_build_array(pg_temp.change_version('single_revoke') + 1, 'direct_share_changed',
    :'grantor', 'a4480000-0000-4000-8000-0000000003b9'),
  'single revoke effect: exactly one Access change, attributed to the grantor and its request correlation'
);
select is(
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries where organization_id = :'org'),
  pg_temp.change_activity('single_revoke') + 1,
  'single revoke effect: exactly one Activity entry was added'
);
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
     activity_id, action, subject_ids, actor_kind, actor_id, source, correlation_id, outcome))
   from vortex_activity.organization_activity_entries
   where organization_id = :'org' and '94481000-0000-4000-8000-0000000003b1' = any (subject_ids)
     and action = 'revoke_direct_record_share'),
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(
    'a4480000-0000-4000-8000-0000000003b2', 'revoke_direct_record_share',
    array['94481000-0000-4000-8000-0000000003b1']::uuid[], 'organization_account', :'grantor',
    'interface', 'a4480000-0000-4000-8000-0000000003b9', 'completed')),
  'single revoke effect: that one entry is the revocation, by the grantor, with its own Activity identity and correlation'
);
select is(
  (select state || '|' || revision || '|' || (revoked_by = :'grantor')
   from vortex_access.organization_direct_record_shares
   where organization_id = :'org' and direct_share_id = '94481000-0000-4000-8000-0000000003b1'),
  'revoked|2|true',
  'single revoke effect: the share moved from revision 1 to revoked revision 2, revoked by the grantor'
);

-- ============================================================================
-- PART 2 (c): two shares for the same recipient on one record, beside an
-- independent ownership authority. recipient_3c owns rec_3c (ownership-routed
-- F3 read and change) and receives share 3c1 (readable and changeable F1)
-- and share 3c2 (readable F2 only). Revoking 3c1 removes only that share's
-- contribution.
-- ============================================================================

select pg_temp.rfa_assign(:'org', '74480000-0000-4000-8000-0000000003c1', :'r_share', :'recipient_3c');
select pg_temp.rfa_assign(:'org', '74480000-0000-4000-8000-0000000003c2', :'r_own', :'recipient_3c');
select is(
  pg_temp.grantor_shares('94481000-0000-4000-8000-0000000003c1', :'rec_3c', :'recipient_3c',
    array[:'f1']::uuid[], array[:'f1']::uuid[]) ->> 'state',
  'active',
  'two shares: the grantor shares F1 (readable and changeable) with the recipient'
);
select is(
  pg_temp.grantor_shares('94481000-0000-4000-8000-0000000003c2', :'rec_3c', :'recipient_3c',
    array[:'f2']::uuid[], array[]::uuid[]) ->> 'state',
  'active',
  'two shares: the grantor separately shares F2 (readable only) with the same recipient on the same record'
);

select pg_temp.rfa_context(:'org', :'app', :'recipient_3c');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_3c'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f1', 'r3c-f1', :'f2', 'r3c-f2', :'f3', 'r3c-f3'),
  'two shares, before: F1 from one share, F2 from the other and F3 from ownership combine'
);
select is(
  vortex_access.test_rfa_change(:'rec_3c', pg_catalog.jsonb_build_object(:'f1', 'r3c-f1-before')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'two shares, before: F1 is changeable through share 3c1'
);
reset role;
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
     contribution.value #>> '{permission,permissionId}', contribution.value #>> '{route,kind}',
     contribution.value #>> '{route,directShareId}') order by contribution.ordinality)
   from vortex_access.test_rfa_decisions as captured
   cross join lateral pg_catalog.jsonb_array_elements(captured.decision -> 'matchedContributions')
     with ordinality as contribution(value, ordinality)
   where captured.decision_id = (select max(decision_id) from vortex_access.test_rfa_decisions
     where operation = 'project' and record_id = :'rec_3c')),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(:'p_share_read', 'direct_share', '94481000-0000-4000-8000-0000000003c1'),
    pg_catalog.jsonb_build_array(:'p_share_read', 'direct_share', '94481000-0000-4000-8000-0000000003c2'),
    pg_catalog.jsonb_build_array(:'p_own_read', 'ownership', null)
  ),
  'two shares, before: the #35 decision carries both shares as distinct contributions beside the ownership contribution'
);

select pg_temp.rfa_context(:'org', :'app', :'grantor');
set local role vortex_request;
select lives_ok(
  $$select vortex_access.test_rfa_revoke('94481000-0000-4000-8000-0000000003c1', 1,
    'Withdraw the F1 share only', 'web', pg_catalog.gen_random_uuid())$$,
  'two shares: the grantor revokes share 3c1 through the protected revoke'
);
reset role;

select pg_temp.rfa_context(:'org', :'app', :'recipient_3c');
set local role vortex_request;
select is(
  vortex_access.test_rfa_project(:'rec_3c'),
  pg_catalog.jsonb_build_object('outcome', 'allowed', :'f2', 'r3c-f2', :'f3', 'r3c-f3'),
  'two shares, after: the surviving share still contributes F2 and ownership still contributes F3; F1 is gone'
);
select is(
  vortex_access.test_rfa_change(:'rec_3c', pg_catalog.jsonb_build_object(:'f1', 'r3c-f1-after')),
  '{"outcome":"refused"}'::jsonb,
  'two shares, after: F1 is no longer changeable'
);
select is(
  vortex_access.test_rfa_change(:'rec_3c', pg_catalog.jsonb_build_object(:'f2', 'r3c-f2-after')),
  '{"outcome":"refused"}'::jsonb,
  'two shares, after: F2 was never changeable -- the surviving share grants read only'
);
select is(
  vortex_access.test_rfa_change(:'rec_3c', pg_catalog.jsonb_build_object(:'f3', 'r3c-f3-after')),
  '{"outcome":"allowed","rowsChanged":1}'::jsonb,
  'two shares, after: F3 is still changeable through the independent ownership authority'
);
reset role;
select is(
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
     contribution.value #>> '{permission,permissionId}', contribution.value #>> '{route,kind}',
     contribution.value #>> '{route,directShareId}') order by contribution.ordinality)
   from vortex_access.test_rfa_decisions as captured
   cross join lateral pg_catalog.jsonb_array_elements(captured.decision -> 'matchedContributions')
     with ordinality as contribution(value, ordinality)
   where captured.decision_id = (select max(decision_id) from vortex_access.test_rfa_decisions
     where operation = 'project' and record_id = :'rec_3c')),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(:'p_share_read', 'direct_share', '94481000-0000-4000-8000-0000000003c2'),
    pg_catalog.jsonb_build_array(:'p_own_read', 'ownership', null)
  ),
  'two shares, after: the decision carries the surviving share and the ownership contribution only'
);
select is(
  pg_temp.rfa_values(:'rec_3c'),
  '{"f1":"r3c-f1-before","f2":"r3c-f2","f3":"r3c-f3-after"}'::jsonb,
  'two shares: refused F1 and F2 changes left both fields as they were'
);
select is(
  (select pg_catalog.jsonb_object_agg(direct_share_id, state || '|' || revision)
   from vortex_access.organization_direct_record_shares
   where organization_id = :'org' and record_id = :'rec_3c'),
  '{"94481000-0000-4000-8000-0000000003c1":"revoked|2","94481000-0000-4000-8000-0000000003c2":"active|1"}'::jsonb,
  'two shares: only the revoked share changed state'
);

select pg_temp.rfa_clear_context();

set constraints all immediate;

select * from finish();

rollback;
