begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_function(
  'vortex_access', 'evaluate_current_record_ownership_visibility',
  array[
    'jsonb', 'text', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'text',
    'jsonb', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'timestamptz'
  ],
  'Access owns one private current record ownership predicate'
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
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.evaluate_current_record_ownership_visibility(jsonb,text,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid,uuid,uuid,timestamptz)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the ownership predicate is owner-held, volatile, invoker-rights and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.evaluate_current_record_ownership_visibility(jsonb,text,uuid,uuid,uuid,uuid,uuid,text,jsonb,uuid,uuid,uuid,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private ownership predicate'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

create function pg_temp.record_identity(
  p_record_id uuid,
  p_storage_scope text default 'application_contained',
  p_organization_id uuid default '23800000-0000-4000-8000-000000000001',
  p_application_root_id uuid default '33800000-0000-4000-8000-000000000001',
  p_module_root_id uuid default '43800000-0000-4000-8000-000000000001',
  p_record_type_id uuid default '53800000-0000-4000-8000-000000000001',
  p_storage_contract_id uuid default '63800000-0000-4000-8000-000000000001'
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'storageScope', p_storage_scope,
    'organizationId', p_organization_id,
    'moduleRootId', p_module_root_id,
    'recordTypeId', p_record_type_id,
    'storageContractId', p_storage_contract_id,
    'recordId', p_record_id,
    'applicationRootId', case
      when p_storage_scope = 'application_contained' then p_application_root_id
      else null
    end
  ))
$function$;

create function pg_temp.ownership_result(
  p_permission_scope jsonb,
  p_ownership_mode text,
  p_record_scope jsonb,
  p_owner_account_id uuid default null,
  p_owner_group_id uuid default null,
  p_current_account_id uuid default '73800000-0000-4000-8000-000000000001',
  p_checked_at timestamptz default pg_catalog.clock_timestamp(),
  p_binding_storage_scope text default 'application_contained',
  p_current_organization_id uuid default '23800000-0000-4000-8000-000000000001',
  p_current_application_root_id uuid default '33800000-0000-4000-8000-000000000001'
)
returns table (admitted boolean, valid_until timestamptz)
language sql
volatile
set search_path = ''
as $function$
  select result.admitted, result.valid_until
  from vortex_access.evaluate_current_record_ownership_visibility(
    p_permission_scope,
    p_ownership_mode,
    '23800000-0000-4000-8000-000000000001',
    '33800000-0000-4000-8000-000000000001',
    '43800000-0000-4000-8000-000000000001',
    '53800000-0000-4000-8000-000000000001',
    '63800000-0000-4000-8000-000000000001',
    p_binding_storage_scope,
    p_record_scope,
    p_owner_account_id,
    p_owner_group_id,
    p_current_organization_id,
    p_current_application_root_id,
    p_current_account_id,
    p_checked_at
  ) as result
$function$;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13800000-0000-4000-8000-000000000001', 'record_ownership',
  'Record ownership', 'active', pg_catalog.clock_timestamp(),
  '93800000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23800000-0000-4000-8000-000000000001',
    '13800000-0000-4000-8000-000000000001', 'record_ownership',
    'Record ownership', 'active', pg_catalog.clock_timestamp(),
    '93800000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 1
  ),
  (
    '23800000-0000-4000-8000-000000000002',
    '13800000-0000-4000-8000-000000000001', 'foreign_records',
    'Foreign records', 'active', pg_catalog.clock_timestamp(),
    '93800000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43800000-0000-4000-8000-000000000101', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93800000-0000-4000-8000-000000000001',
    'a3800000-0000-4000-8000-000000000001', 1
  ),
  (
    '43800000-0000-4000-8000-000000000102', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93800000-0000-4000-8000-000000000001',
    'a3800000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '73800000-0000-4000-8000-000000000001',
    '23800000-0000-4000-8000-000000000001',
    '43800000-0000-4000-8000-000000000101', 'Record reader', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93800000-0000-4000-8000-000000000001',
    'a3800000-0000-4000-8000-000000000003', 1
  ),
  (
    '73800000-0000-4000-8000-000000000002',
    '23800000-0000-4000-8000-000000000001',
    '43800000-0000-4000-8000-000000000102', 'Other owner', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93800000-0000-4000-8000-000000000001',
    'a3800000-0000-4000-8000-000000000004', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '23800000-0000-4000-8000-000000000001',
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000005'
);

create temporary table ownership_times (
  key text primary key,
  value timestamptz not null
) on commit drop;
insert into ownership_times (key, value) values
  ('now', pg_catalog.clock_timestamp()),
  ('current_expiry', pg_catalog.clock_timestamp() + interval '20 minutes'),
  ('short_expiry', pg_catalog.clock_timestamp() + interval '5 minutes');

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
)
select '23800000-0000-4000-8000-000000000001', candidate.group_id,
  candidate.group_key, candidate.label, 'active', 1,
  '93800000-0000-4000-8000-000000000001', times.value,
  '93800000-0000-4000-8000-000000000001', times.value,
  candidate.correlation_id
from (values
  ('83800000-0000-4000-8000-000000000001'::uuid, 'current_group',
    'Current Group', 'a3800000-0000-4000-8000-000000000011'::uuid),
  ('83800000-0000-4000-8000-000000000002'::uuid, 'second_group',
    'Second Group', 'a3800000-0000-4000-8000-000000000012'::uuid),
  ('83800000-0000-4000-8000-000000000003'::uuid, 'future_group',
    'Future Group', 'a3800000-0000-4000-8000-000000000013'::uuid),
  ('83800000-0000-4000-8000-000000000004'::uuid, 'expired_group',
    'Expired Group', 'a3800000-0000-4000-8000-000000000014'::uuid),
  ('83800000-0000-4000-8000-000000000005'::uuid, 'revoked_group',
    'Revoked Group', 'a3800000-0000-4000-8000-000000000015'::uuid),
  ('83800000-0000-4000-8000-000000000006'::uuid, 'retired_group',
    'Retired Group', 'a3800000-0000-4000-8000-000000000016'::uuid)
) as candidate(group_id, group_key, label, correlation_id)
cross join ownership_times as times
where times.key = 'now';

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select '23800000-0000-4000-8000-000000000001', candidate.membership_id,
  candidate.group_id, '73800000-0000-4000-8000-000000000001', 1,
  now_time.value + candidate.start_offset,
  case when candidate.expiry_key is null then null else expiry.value end,
  'live', '93800000-0000-4000-8000-000000000001', now_time.value,
  candidate.correlation_id, '93800000-0000-4000-8000-000000000001',
  now_time.value, candidate.correlation_id
from (values
  ('84800000-0000-4000-8000-000000000001'::uuid,
    '83800000-0000-4000-8000-000000000001'::uuid,
    interval '-1 minute', 'current_expiry',
    'a3800000-0000-4000-8000-000000000021'::uuid),
  ('84800000-0000-4000-8000-000000000002'::uuid,
    '83800000-0000-4000-8000-000000000002'::uuid,
    interval '-1 minute', null,
    'a3800000-0000-4000-8000-000000000022'::uuid),
  ('84800000-0000-4000-8000-000000000003'::uuid,
    '83800000-0000-4000-8000-000000000003'::uuid,
    interval '10 minutes', 'current_expiry',
    'a3800000-0000-4000-8000-000000000023'::uuid),
  ('84800000-0000-4000-8000-000000000004'::uuid,
    '83800000-0000-4000-8000-000000000004'::uuid,
    interval '-1 minute', 'short_expiry',
    'a3800000-0000-4000-8000-000000000024'::uuid),
  ('84800000-0000-4000-8000-000000000005'::uuid,
    '83800000-0000-4000-8000-000000000005'::uuid,
    interval '-1 minute', 'current_expiry',
    'a3800000-0000-4000-8000-000000000025'::uuid),
  ('84800000-0000-4000-8000-000000000006'::uuid,
    '83800000-0000-4000-8000-000000000006'::uuid,
    interval '-1 minute', 'current_expiry',
    'a3800000-0000-4000-8000-000000000026'::uuid)
) as candidate(membership_id, group_id, start_offset, expiry_key, correlation_id)
cross join ownership_times as now_time
left join ownership_times as expiry on expiry.key = candidate.expiry_key
where now_time.key = 'now';

select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '23800000-0000-4000-8000-000000000001',
  '84800000-0000-4000-8000-000000000005', 1,
  null, null, null, null, null,
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000027'
);
select * from vortex_access.coordinate_organization_group_change(
  'retire_group', '23800000-0000-4000-8000-000000000001',
  '83800000-0000-4000-8000-000000000006', 1,
  null, null, '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000028'
);

select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'organization_account', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000001'
    ), '73800000-0000-4000-8000-000000000002'
  )),
  true,
  'all-record scope admits a valid row independently of its owner'
);
select is(
  (select valid_until from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000002'
    ), null, '83800000-0000-4000-8000-000000000001'
  )),
  null::timestamptz,
  'all-record admission has no artificial Group deadline'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'organization_account', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000003'
    ), '73800000-0000-4000-8000-000000000001'
  )),
  true,
  'the exact current account owner is admitted'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'organization_account', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000004'
    ), '73800000-0000-4000-8000-000000000002'
  )),
  false,
  'another account owner is not admitted'
);
select is(
  (select pg_catalog.concat_ws('|', admitted, valid_until)
   from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000005'
    ), null, '83800000-0000-4000-8000-000000000001',
    '73800000-0000-4000-8000-000000000001',
    (select value from ownership_times where key = 'now')
  )),
  't|' || (select value::text from ownership_times where key = 'current_expiry'),
  'current Group ownership is admitted with the membership expiry deadline'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000006'
    ), null, '83800000-0000-4000-8000-000000000002',
    '73800000-0000-4000-8000-000000000001',
    (select value from ownership_times where key = 'now')
  )),
  true,
  'one account may own through another independently current Group'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000007'
    ), null, '83800000-0000-4000-8000-000000000003',
    '73800000-0000-4000-8000-000000000001',
    (select value from ownership_times where key = 'now')
  )),
  false,
  'future Group membership supplies no ownership route'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000008'
    ), null, '83800000-0000-4000-8000-000000000004',
    '73800000-0000-4000-8000-000000000001',
    (select value + interval '10 minutes' from ownership_times where key = 'now')
  )),
  false,
  'expired Group membership supplies no ownership route at the checked time'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000009'
    ), null, '83800000-0000-4000-8000-000000000005'
  )),
  false,
  'revoked Group membership supplies no ownership route'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000010'
    ), null, '83800000-0000-4000-8000-000000000006'
  )),
  false,
  'a retired owner Group supplies no ownership route'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'team', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000027'
    ), null, '83800000-0000-4000-8000-000000000001',
    '73800000-0000-4000-8000-000000000002'
  )),
  false,
  'a different current account cannot consume another account membership'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"},{"kind":"direct_share"}]}'::jsonb,
    'organization_account', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000011'
    ), '73800000-0000-4000-8000-000000000001'
  )),
  true,
  'an unsupported valid route does not invalidate a complete ownership route'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"direct_share"}]}'::jsonb,
    'organization_account', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000012'
    ), '73800000-0000-4000-8000-000000000001'
  )),
  false,
  'an unsupported direct-share route adds no authority'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    'inherited', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000013'
    )
  )),
  false,
  'inherited ownership adds no direct ownership route in this checkpoint'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'inherited', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000014'
    )
  )),
  true,
  'a valid inherited row remains visible through explicit all-record scope'
);

select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000015',
      'application_contained', '23800000-0000-4000-8000-000000000002'
    )
  )),
  false,
  'foreign organization identity is refused'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000016',
      'application_contained', '23800000-0000-4000-8000-000000000001',
      '33800000-0000-4000-8000-000000000002'
    )
  )),
  false,
  'another source application is refused for application-contained storage'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000017', 'organization_shared'
    ), null, null, '73800000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 'organization_shared'
  )),
  true,
  'organization-shared storage omits a row application while retaining the consuming binding'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000028', 'organization_shared'
    ), null, null, '73800000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 'organization_shared',
    '23800000-0000-4000-8000-000000000001',
    '33800000-0000-4000-8000-000000000002'
  )),
  false,
  'organization-shared storage still requires the exact consuming application binding'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000018',
      'application_contained', '23800000-0000-4000-8000-000000000001',
      '33800000-0000-4000-8000-000000000001',
      '43800000-0000-4000-8000-000000000002'
    )
  )),
  false,
  'another module identity is refused'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000019',
      'application_contained', '23800000-0000-4000-8000-000000000001',
      '33800000-0000-4000-8000-000000000001',
      '43800000-0000-4000-8000-000000000001',
      '53800000-0000-4000-8000-000000000002'
    )
  )),
  false,
  'another record-type identity is refused'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity(
      'e3800000-0000-4000-8000-000000000020',
      'application_contained', '23800000-0000-4000-8000-000000000001',
      '33800000-0000-4000-8000-000000000001',
      '43800000-0000-4000-8000-000000000001',
      '53800000-0000-4000-8000-000000000001',
      '63800000-0000-4000-8000-000000000002'
    )
  )),
  false,
  'another storage-contract identity is refused'
);

select throws_ok(
  $$select * from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'organization_account',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000021'),
    '73800000-0000-4000-8000-000000000001',
    '83800000-0000-4000-8000-000000000001'
  )$$,
  '22023', 'Record ownership evidence is invalid',
  'malformed direct-owner evidence refuses before all-record routing'
);
-- The six shape-refusal cases formerly asserted here (an all_records route
-- plus another route, an unrecognised route kind, a relationship route with
-- a null identity, duplicate routes, noncanonical route order, and a
-- relationship route with a non-platform UUID identity) exercised this
-- function's own re-validation of `p_permission_record_scope`. That
-- re-validation is now the store's job
-- (vortex_access.permission_record_scope_is_valid,
-- permission_catalogue_entries_record_scope_value,
-- 20260911101613_constrain_permission_record_scope_shape.sql): none of
-- those shapes can reach this function through any real caller any more,
-- because inserting a catalogue row with one of them is refused first (see
-- 340_permission_registry_record_scope.test.sql for the store refusals and
-- 470_permission_record_scope_parity.test.sql for the full shared corpus).
-- Calling this owner-only function directly with such a shape -- which no
-- real caller does -- no longer raises; it now reads only the two route
-- kinds this function's row-dependent logic consumes and falls through to
-- an ordinary admitted/not-admitted verdict, demonstrated below.
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"},{"kind":"ownership"}]}'::jsonb,
    'none', pg_temp.record_identity('e3800000-0000-4000-8000-000000000022')
  )),
  true,
  'a shape the store now refuses no longer reaches a re-validation here; an all-record route still admits unconditionally'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"future_route"}]}'::jsonb,
    'none', pg_temp.record_identity('e3800000-0000-4000-8000-000000000023')
  )),
  false,
  'an unrecognised route kind no longer raises; it simply contributes no admission flag'
);
select is(
  (select admitted from pg_temp.ownership_result(
    '{"routes":[{"kind":"ownership"},{"kind":"direct_share"},{"kind":"direct_share"}]}'::jsonb,
    'organization_account',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000029'),
    '73800000-0000-4000-8000-000000000001'
  )),
  true,
  'duplicate and noncanonically ordered routes no longer raise; a present ownership route still admits the matching current account'
);
select throws_ok(
  $$select * from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity('123e4567-e89b-02d3-a456-426614174000')
  )$$,
  '22023', 'Record identity is invalid',
  'a RecordScope identity rejected by the stable-ID contract refuses'
);
select throws_ok(
  $$select * from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    null, pg_temp.record_identity('e3800000-0000-4000-8000-000000000025')
  )$$,
  '22023', 'Record visibility context is invalid',
  'a missing compiled ownership mode refuses before all-record admission'
);
select throws_ok(
  $$select * from pg_temp.ownership_result(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'none', pg_temp.record_identity('e3800000-0000-4000-8000-000000000026'),
    null, null, '73800000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), null
  )$$,
  '22023', 'Record visibility context is invalid',
  'a missing installed storage scope refuses before all-record admission'
);

-- Seed one current application operation permission for the existing Access
-- evaluator and separate current record-scope catalogue evidence for this
-- test-owned pre-#35 seam. #35 must bind one eligible record-permission
-- alternative to its own scope; this fixture does not claim that later pairing.
insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001', 1, 'active', 'register',
  'example.record_ownership', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000031'
);
insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state,
  revision, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001', 'active', 1,
  'example.record_ownership', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
  '93800000-0000-4000-8000-000000000001',
  'a3800000-0000-4000-8000-000000000031'
);
insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint, record_scope
) values (
  '23800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001', 1,
  '33800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000101',
  'example.record_ownership.read', 'Read owned records',
  'Authorizes the protected neutral read seam.',
  null, 'read', null, false,
  'application', 'example.record_ownership',
  '33800000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('5', 64), null
);
insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint, record_scope
) values (
  '23800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001', 1,
  '33800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000102',
  'example.record_ownership.scope', 'Owned record scope',
  'Supplies the trusted record visibility declaration for the neutral fixture.',
  '53800000-0000-4000-8000-000000000001', 'read', null, false,
  'application', 'example.record_ownership',
  '33800000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('8', 64),
  '{"routes":[{"kind":"ownership"}],"savedCondition":{"conditionId":"c3800000-0000-4000-8000-000000000001","publishedRevision":1,"contractFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parameterBindings":[{"key":"actor","source":"current_organization_account_id"}]}}'::jsonb
);
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id, state,
  continuity_revision, meaning_fingerprint,
  last_processed_registration_revision, changed_at
) select entry.organization_id, entry.application_root_id, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, 'available', 1, entry.meaning_fingerprint,
  1, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '23800000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'application'
  and entry.registration_owner_id =
    '33800000-0000-4000-8000-000000000001';
insert into vortex_access.application_role_template_continuities (
  organization_id, application_root_id, source_role_id, state,
  continuity_revision, source_template_fingerprint,
  last_processed_registration_revision, changed_at
) values (
  '23800000-0000-4000-8000-000000000001',
  '33800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000102', 'available', 1,
  'sha256:' || pg_catalog.repeat('6', 64), 1,
  pg_catalog.clock_timestamp()
);
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000103', 'application',
  'record_reader', '33800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000102', 1,
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
) values (
  '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000103', 1, 1, 'application',
  '33800000-0000-4000-8000-000000000001',
  '33800000-0000-4000-8000-000000000001', 'application',
  '33800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000101', 'application',
  '33800000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 1,
  'sha256:' || pg_catalog.repeat('5', 64)
);
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, source_definition_key,
  source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000103', 1, 'application',
  '33800000-0000-4000-8000-000000000001', 'active', 'standard',
  'standing', 1, 1, 'record_reader', 'Record reader',
  'Neutral record-read role.', 'example.record_ownership', 1, '1.0.0',
  '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('6', 64),
  'sha256:' || pg_catalog.repeat('3', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('7', 64),
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3800000-0000-4000-8000-000000000032'
);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '23800000-0000-4000-8000-000000000001',
  '73800000-0000-4000-8000-000000000103',
  '63800000-0000-4000-8000-000000000103', 'organization_account',
  '73800000-0000-4000-8000-000000000001', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.clock_timestamp() + interval '30 minutes', 'live',
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3800000-0000-4000-8000-000000000033',
  '93800000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3800000-0000-4000-8000-000000000033'
);

create table vortex_access.test_installed_record_storage_bindings (
  organization_id uuid not null,
  application_root_id uuid not null,
  module_root_id uuid not null,
  record_type_id uuid not null,
  storage_contract_id uuid not null,
  storage_scope text not null,
  primary key (organization_id, application_root_id, record_type_id)
);
revoke all on table vortex_access.test_installed_record_storage_bindings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
insert into vortex_access.test_installed_record_storage_bindings values (
  '23800000-0000-4000-8000-000000000001',
  '33800000-0000-4000-8000-000000000001',
  '43800000-0000-4000-8000-000000000001',
  '53800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000001',
  'application_contained'
);

create table vortex_access.test_current_record_ownership_rows (
  record_id uuid primary key,
  record_scope jsonb not null,
  ownership_mode text not null,
  owner_organization_account_id uuid,
  owner_group_id uuid,
  lifecycle_state text not null,
  field_values jsonb not null
);
revoke all on table vortex_access.test_current_record_ownership_rows
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
insert into vortex_access.test_current_record_ownership_rows values
  (
    'e3800000-0000-4000-8000-000000000101',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000101'),
    'organization_account', '73800000-0000-4000-8000-000000000001', null,
    'active',
    '{"f3800000-0000-4000-8000-000000000001":"73800000-0000-4000-8000-000000000001"}'
  ),
  (
    'e3800000-0000-4000-8000-000000000102',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000102'),
    'organization_account', '73800000-0000-4000-8000-000000000001', null,
    'active',
    '{"f3800000-0000-4000-8000-000000000001":"73800000-0000-4000-8000-000000000002"}'
  ),
  (
    'e3800000-0000-4000-8000-000000000103',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000103'),
    'team', null, '83800000-0000-4000-8000-000000000001', 'active',
    '{"f3800000-0000-4000-8000-000000000001":"73800000-0000-4000-8000-000000000001"}'
  ),
  (
    'e3800000-0000-4000-8000-000000000104',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000104'),
    'organization_account', '73800000-0000-4000-8000-000000000002', null,
    'active',
    '{"f3800000-0000-4000-8000-000000000001":"73800000-0000-4000-8000-000000000001"}'
  ),
  (
    'e3800000-0000-4000-8000-000000000105',
    pg_temp.record_identity('e3800000-0000-4000-8000-000000000105'),
    'organization_account', '73800000-0000-4000-8000-000000000001', null,
    'soft_deleted',
    '{"f3800000-0000-4000-8000-000000000001":"73800000-0000-4000-8000-000000000001"}'
  );

create function pg_temp.record_read_declaration()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '33800000-0000-4000-8000-000000000001'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '33800000-0000-4000-8000-000000000001',
      'ownerKind', 'application',
      'ownerId', '33800000-0000-4000-8000-000000000001',
      'permissionId', '63800000-0000-4000-8000-000000000101'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
$function$;

create function vortex_access.test_visible_current_record_ownership_rows()
returns table (record_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  binding record;
  permission_scope jsonb;
begin
  select * into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_temp.record_read_declaration()
  );
  if decision.outcome <> 'eligible' then
    raise exception using errcode = '42501', message = 'Record read is unavailable';
  end if;
  select entry.record_scope into strict permission_scope
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = decision.organization_id
    and entry.application_root_id = decision.target_application_root_id
    and entry.owner_kind = 'application'
    and entry.owner_id = '33800000-0000-4000-8000-000000000001'
    and entry.permission_id = '63800000-0000-4000-8000-000000000102';
  select * into strict binding
  from vortex_access.test_installed_record_storage_bindings as stored_binding
  where stored_binding.organization_id = decision.organization_id
    and stored_binding.application_root_id = decision.target_application_root_id
    and stored_binding.record_type_id =
      '53800000-0000-4000-8000-000000000001';

  return query
  select candidate.record_id
  from vortex_access.test_current_record_ownership_rows as candidate
  cross join lateral vortex_access.evaluate_current_record_ownership_visibility(
    permission_scope, candidate.ownership_mode,
    binding.organization_id, binding.application_root_id,
    binding.module_root_id, binding.record_type_id,
    binding.storage_contract_id, binding.storage_scope, candidate.record_scope,
    candidate.owner_organization_account_id, candidate.owner_group_id,
    decision.organization_id, decision.target_application_root_id,
    decision.organization_account_id, decision.checked_at
  ) as visibility
  where candidate.lifecycle_state = 'active'
    and visibility.admitted
    and vortex_access.evaluate_permission_saved_condition(
      permission_scope,
      '{"conditionId":"c3800000-0000-4000-8000-000000000001","sourceRecordTypeId":"53800000-0000-4000-8000-000000000001","publishedRevision":1,"contractFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parameters":[{"key":"actor","type":"text"}],"condition":{"kind":"comparison","operator":"equals","left":{"source":"field","fieldId":"f3800000-0000-4000-8000-000000000001"},"right":{"source":"parameter","key":"actor"}},"declaredFieldIds":["f3800000-0000-4000-8000-000000000001"]}'::jsonb,
      '{"recordTypeId":"53800000-0000-4000-8000-000000000001","fields":[{"fieldId":"f3800000-0000-4000-8000-000000000001","type":"text"}]}'::jsonb,
      candidate.field_values,
      decision.organization_account_id
    )
  order by candidate.record_id;
end
$function$;

revoke execute on function vortex_access.test_visible_current_record_ownership_rows()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_visible_current_record_ownership_rows()
  to vortex_request;
grant execute on function pg_temp.record_read_declaration() to vortex_request;
grant usage on schema extensions to vortex_request;

select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '83800000-0000-4000-8000-000000000101',
  'tenantId', '13800000-0000-4000-8000-000000000001',
  'organizationId', '23800000-0000-4000-8000-000000000001',
  'organizationAccountId', '73800000-0000-4000-8000-000000000001',
  'identityId', '43800000-0000-4000-8000-000000000101',
  'applicationRootId', '33800000-0000-4000-8000-000000000001',
  'sessionId', '63800000-0000-4000-8000-000000000199',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '1 hour',
  'accessVersion', (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '23800000-0000-4000-8000-000000000001'
  ),
  'correlationId', 'a3800000-0000-4000-8000-000000000099'
));

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select results_eq(
  $$select record_id from vortex_access.test_visible_current_record_ownership_rows()$$,
  $$values
    ('e3800000-0000-4000-8000-000000000101'::uuid),
    ('e3800000-0000-4000-8000-000000000103'::uuid)$$,
  'the actual request role sees only current owned rows satisfying the saved condition'
);
select is(
  (select pg_catalog.count(*)
   from vortex_access.test_visible_current_record_ownership_rows()),
  2::bigint,
  'the protected count is narrowed in PostgreSQL before rows leave the database'
);
reset role;

set constraints all immediate;

select * from finish();

rollback;
