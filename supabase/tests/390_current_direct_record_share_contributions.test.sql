begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_table(
  'vortex_access', 'organization_direct_record_shares',
  'Access owns one private current direct-record-share fact table'
);

select has_function(
  'vortex_access', 'read_current_direct_record_share_contributions',
  array[
    'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'text', 'uuid', 'uuid',
    'uuid', 'uuid', 'timestamptz'
  ],
  'Access owns one private exact-record share contribution reader'
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
      'vortex_access.read_current_direct_record_share_contributions(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the reader is owner-held, volatile, invoker-rights and empty-search-path'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'rls', relation.relrowsecurity,
      'forced', relation.relforcerowsecurity
    )
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'vortex_access'
      and relation.relname = 'organization_direct_record_shares'
  ),
  '{"rls":true,"forced":true}'::jsonb,
  'the current-share table is protected by forced deny-by-default RLS'
);

select ok(
  not pg_catalog.has_table_privilege(
    caller.role_name,
    'vortex_access.organization_direct_record_shares',
    'SELECT'
  ),
  caller.role_name || ' cannot read private direct-record-share facts'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not exists (
    select 1
    from (values
      ('public'), ('anon'), ('authenticated'), ('service_role'),
      ('vortex_runtime'), ('vortex_request')
    ) as caller(role_name)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as access(privilege_name)
    where pg_catalog.has_table_privilege(
      caller.role_name,
      'vortex_access.organization_direct_record_shares',
      access.privilege_name
    )
  ),
  'runtime and public roles have no direct current-share mutation privilege'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.read_current_direct_record_share_contributions(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private contribution reader'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not exists (
    select 1
    from (values
      ('public'), ('anon'), ('authenticated'), ('service_role'),
      ('vortex_runtime'), ('vortex_request')
    ) as caller(role_name)
    cross join (values
      ('vortex_access.direct_share_field_ids_are_canonical(uuid[])'),
      ('vortex_access.validate_organization_direct_record_share_insert()'),
      ('vortex_access.protect_organization_direct_record_share()')
    ) as helper(signature)
    where pg_catalog.has_function_privilege(
      caller.role_name, helper.signature, 'EXECUTE'
    )
  ),
  'runtime and public roles cannot execute current-share storage helpers'
);

select is(
  (
    select pg_catalog.pg_get_indexdef(index_row.indexrelid)
    from pg_catalog.pg_index as index_row
    where index_row.indexrelid =
      'vortex_access.organization_direct_record_shares_active_record_idx'::regclass
  ),
  'CREATE INDEX organization_direct_record_shares_active_record_idx ON vortex_access.organization_direct_record_shares USING btree (organization_id, storage_scope, application_root_id, module_root_id, record_type_id, storage_contract_id, record_id) WHERE (state = ''active''::text)',
  'one partial active index covers only the exact stored record identity'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13900000-0000-4000-8000-000000000001', 'direct_share',
  'Direct share', 'active', pg_catalog.clock_timestamp(),
  '93900000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23900000-0000-4000-8000-000000000001',
    '13900000-0000-4000-8000-000000000001', 'direct_share',
    'Direct share', 'active', pg_catalog.clock_timestamp(),
    '93900000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 1
  ),
  (
    '23900000-0000-4000-8000-000000000002',
    '13900000-0000-4000-8000-000000000001', 'foreign_share',
    'Foreign share', 'active', pg_catalog.clock_timestamp(),
    '93900000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43900000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93900000-0000-4000-8000-000000000001',
    'a3900000-0000-4000-8000-000000000001', 1
  ),
  (
    '43900000-0000-4000-8000-000000000002', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93900000-0000-4000-8000-000000000001',
    'a3900000-0000-4000-8000-000000000002', 1
  ),
  (
    '43900000-0000-4000-8000-000000000003', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93900000-0000-4000-8000-000000000001',
    'a3900000-0000-4000-8000-000000000003', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '73900000-0000-4000-8000-000000000001',
    '23900000-0000-4000-8000-000000000001',
    '43900000-0000-4000-8000-000000000001', 'Current recipient', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93900000-0000-4000-8000-000000000001',
    'a3900000-0000-4000-8000-000000000011', 1
  ),
  (
    '73900000-0000-4000-8000-000000000002',
    '23900000-0000-4000-8000-000000000001',
    '43900000-0000-4000-8000-000000000002', 'Other recipient', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93900000-0000-4000-8000-000000000001',
    'a3900000-0000-4000-8000-000000000012', 1
  ),
  (
    '73900000-0000-4000-8000-000000000003',
    '23900000-0000-4000-8000-000000000002',
    '43900000-0000-4000-8000-000000000003', 'Foreign recipient', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93900000-0000-4000-8000-000000000001',
    'a3900000-0000-4000-8000-000000000013', 1
  );

create temporary table share_times (
  checked_at timestamptz not null,
  short_expiry timestamptz not null,
  membership_expiry timestamptz not null,
  share_expiry timestamptz not null
) on commit drop;

insert into share_times
select
  pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp() + interval '5 minutes',
  pg_catalog.clock_timestamp() + interval '20 minutes',
  pg_catalog.clock_timestamp() + interval '30 minutes';

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
)
select
  '23900000-0000-4000-8000-000000000001', candidate.group_id,
  candidate.group_key, candidate.label, 'active', 1,
  '73900000-0000-4000-8000-000000000001', times.checked_at,
  '73900000-0000-4000-8000-000000000001', times.checked_at,
  candidate.correlation_id
from (values
  ('83900000-0000-4000-8000-000000000001'::uuid, 'expiring_group',
    'Expiring Group', 'a3900000-0000-4000-8000-000000000021'::uuid),
  ('83900000-0000-4000-8000-000000000002'::uuid, 'lasting_group',
    'Lasting Group', 'a3900000-0000-4000-8000-000000000022'::uuid),
  ('83900000-0000-4000-8000-000000000003'::uuid, 'future_group',
    'Future Group', 'a3900000-0000-4000-8000-000000000023'::uuid),
  ('83900000-0000-4000-8000-000000000004'::uuid, 'retired_group',
    'Retired Group', 'a3900000-0000-4000-8000-000000000024'::uuid)
) as candidate(group_id, group_key, label, correlation_id)
cross join share_times as times;

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select
  '23900000-0000-4000-8000-000000000001', candidate.membership_id,
  candidate.group_id, '73900000-0000-4000-8000-000000000001', 1,
  times.checked_at + candidate.start_offset,
  case candidate.expiry_kind
    when 'membership' then times.membership_expiry
    when 'short' then times.short_expiry
    else null
  end,
  'live', '73900000-0000-4000-8000-000000000001', times.checked_at,
  candidate.correlation_id, '73900000-0000-4000-8000-000000000001',
  times.checked_at, candidate.correlation_id
from (values
  ('84900000-0000-4000-8000-000000000001'::uuid,
    '83900000-0000-4000-8000-000000000001'::uuid,
    interval '-1 minute', 'membership',
    'a3900000-0000-4000-8000-000000000031'::uuid),
  ('84900000-0000-4000-8000-000000000002'::uuid,
    '83900000-0000-4000-8000-000000000002'::uuid,
    interval '-1 minute', null,
    'a3900000-0000-4000-8000-000000000032'::uuid),
  ('84900000-0000-4000-8000-000000000003'::uuid,
    '83900000-0000-4000-8000-000000000003'::uuid,
    interval '10 minutes', 'membership',
    'a3900000-0000-4000-8000-000000000033'::uuid),
  ('84900000-0000-4000-8000-000000000004'::uuid,
    '83900000-0000-4000-8000-000000000004'::uuid,
    interval '-1 minute', 'membership',
    'a3900000-0000-4000-8000-000000000034'::uuid)
) as candidate(membership_id, group_id, start_offset, expiry_kind, correlation_id)
cross join share_times as times;

update vortex_access.organization_groups
set state = 'retired', revision = 2,
  changed_at = pg_catalog.clock_timestamp(),
  changed_by = '73900000-0000-4000-8000-000000000001',
  change_correlation_id = 'a3900000-0000-4000-8000-000000000025'
where organization_id = '23900000-0000-4000-8000-000000000001'
  and group_id = '83900000-0000-4000-8000-000000000004';

insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id,
  readable_field_ids, changeable_field_ids, starts_at, expires_at,
  state, revision, granted_by, granted_at, grant_correlation_id,
  reason, changed_at
)
select
  '23900000-0000-4000-8000-000000000001', candidate.direct_share_id,
  candidate.storage_scope,
  case when candidate.storage_scope = 'application_contained'
    then candidate.application_root_id else null end,
  '43900000-0000-4000-8000-000000000101',
  '53900000-0000-4000-8000-000000000101',
  '63900000-0000-4000-8000-000000000101', candidate.record_id,
  candidate.recipient_kind, candidate.organization_account_id,
  candidate.group_id, candidate.readable_field_ids,
  candidate.changeable_field_ids, times.checked_at + candidate.start_offset,
  case candidate.expiry_kind
    when 'short' then times.short_expiry
    when 'share' then times.share_expiry
    else null
  end,
  'active', 1, '73900000-0000-4000-8000-000000000001',
  times.checked_at, candidate.correlation_id, candidate.reason,
  times.checked_at
from (values
  ('93900000-0000-4000-8000-000000000101'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000201','63900000-0000-4000-8000-000000000202']::uuid[],
    array['63900000-0000-4000-8000-000000000202']::uuid[],
    interval '-1 minute', null, 'Current account contribution',
    'a3900000-0000-4000-8000-000000000101'::uuid),
  ('93900000-0000-4000-8000-000000000102'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000203']::uuid[],
    array[]::uuid[], interval '-1 minute', 'share',
    'Independent current account contribution',
    'a3900000-0000-4000-8000-000000000102'::uuid),
  ('93900000-0000-4000-8000-000000000103'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'group', null::uuid, '83900000-0000-4000-8000-000000000001'::uuid,
    array['63900000-0000-4000-8000-000000000204']::uuid[],
    array[]::uuid[], interval '-1 minute', 'share',
    'Membership-bounded Group contribution',
    'a3900000-0000-4000-8000-000000000103'::uuid),
  ('93900000-0000-4000-8000-000000000104'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'group', null::uuid, '83900000-0000-4000-8000-000000000002'::uuid,
    array['63900000-0000-4000-8000-000000000205']::uuid[],
    array[]::uuid[], interval '-1 minute', 'short',
    'Share-bounded Group contribution',
    'a3900000-0000-4000-8000-000000000104'::uuid),
  ('93900000-0000-4000-8000-000000000105'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000002'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000206']::uuid[],
    array[]::uuid[], interval '-1 minute', null,
    'Different account', 'a3900000-0000-4000-8000-000000000105'::uuid),
  ('93900000-0000-4000-8000-000000000106'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'group', null::uuid, '83900000-0000-4000-8000-000000000003'::uuid,
    array['63900000-0000-4000-8000-000000000207']::uuid[],
    array[]::uuid[], interval '-1 minute', null,
    'Future membership', 'a3900000-0000-4000-8000-000000000106'::uuid),
  ('93900000-0000-4000-8000-000000000107'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'group', null::uuid, '83900000-0000-4000-8000-000000000004'::uuid,
    array['63900000-0000-4000-8000-000000000208']::uuid[],
    array[]::uuid[], interval '-1 minute', null,
    'Retired Group', 'a3900000-0000-4000-8000-000000000107'::uuid),
  ('93900000-0000-4000-8000-000000000108'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000002'::uuid,
    'e3900000-0000-4000-8000-000000000001'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000209']::uuid[],
    array[]::uuid[], interval '-1 minute', null,
    'Different source application',
    'a3900000-0000-4000-8000-000000000108'::uuid),
  ('93900000-0000-4000-8000-000000000109'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000002'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000210']::uuid[],
    array[]::uuid[], interval '10 minutes', null,
    'Future share', 'a3900000-0000-4000-8000-000000000109'::uuid),
  ('93900000-0000-4000-8000-000000000110'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000003'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000211']::uuid[],
    array[]::uuid[], interval '-10 minutes', 'short',
    'Later-expired share', 'a3900000-0000-4000-8000-000000000110'::uuid),
  ('93900000-0000-4000-8000-000000000111'::uuid,
    'organization_shared', null::uuid,
    'e3900000-0000-4000-8000-000000000004'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000212']::uuid[],
    array[]::uuid[], interval '-1 minute', null,
    'Organization-shared contribution',
    'a3900000-0000-4000-8000-000000000111'::uuid),
  ('93900000-0000-4000-8000-000000000112'::uuid,
    'application_contained', '33900000-0000-4000-8000-000000000001'::uuid,
    'e3900000-0000-4000-8000-000000000005'::uuid,
    'organization_account', '73900000-0000-4000-8000-000000000001'::uuid,
    null::uuid,
    array['63900000-0000-4000-8000-000000000213']::uuid[],
    array[]::uuid[], interval '-1 minute', null,
    'Revoked contribution', 'a3900000-0000-4000-8000-000000000112'::uuid)
) as candidate(
  direct_share_id, storage_scope, application_root_id, record_id,
  recipient_kind, organization_account_id, group_id, readable_field_ids,
  changeable_field_ids, start_offset, expiry_kind, reason, correlation_id
)
cross join share_times as times;

update vortex_access.organization_direct_record_shares
set state = 'revoked', revision = 2,
  revoked_by = '73900000-0000-4000-8000-000000000001',
  revoked_at = (select checked_at from share_times),
  revocation_correlation_id = 'a3900000-0000-4000-8000-000000000113',
  revocation_reason = 'No longer required',
  changed_at = (select checked_at from share_times)
where organization_id = '23900000-0000-4000-8000-000000000001'
  and direct_share_id = '93900000-0000-4000-8000-000000000112';

create function pg_temp.share_contributions(
  p_record_id uuid,
  p_storage_scope text default 'application_contained',
  p_binding_application_root_id uuid default '33900000-0000-4000-8000-000000000001',
  p_current_application_root_id uuid default '33900000-0000-4000-8000-000000000001',
  p_binding_module_root_id uuid default '43900000-0000-4000-8000-000000000101',
  p_checked_at timestamptz default null
)
returns table (
  direct_share_id uuid,
  direct_share_revision bigint,
  recipient_kind text,
  organization_account_id uuid,
  group_id uuid,
  readable_field_ids uuid[],
  changeable_field_ids uuid[],
  valid_until timestamptz
)
language sql
volatile
set search_path = ''
as $function$
  select contribution.*
  from share_times as times
  cross join lateral vortex_access.read_current_direct_record_share_contributions(
    '23900000-0000-4000-8000-000000000001',
    p_binding_application_root_id,
    p_binding_module_root_id,
    '53900000-0000-4000-8000-000000000101',
    '63900000-0000-4000-8000-000000000101',
    p_storage_scope,
    p_record_id,
    '23900000-0000-4000-8000-000000000001',
    p_current_application_root_id,
    '73900000-0000-4000-8000-000000000001',
    coalesce(p_checked_at, times.checked_at)
  ) as contribution
$function$;

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000001'
  )),
  4::bigint,
  'two direct and two current Group shares remain independent contributions'
);

select is(
  (
    select pg_catalog.array_agg(direct_share_id order by direct_share_id)
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
  ),
  array[
    '93900000-0000-4000-8000-000000000101',
    '93900000-0000-4000-8000-000000000102',
    '93900000-0000-4000-8000-000000000103',
    '93900000-0000-4000-8000-000000000104'
  ]::uuid[],
  'another account, future membership, retired Group and another source app add no contribution'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'readable', readable_field_ids,
      'changeable', changeable_field_ids
    )
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
    where direct_share_id = '93900000-0000-4000-8000-000000000101'
  ),
  '{"readable":["63900000-0000-4000-8000-000000000201","63900000-0000-4000-8000-000000000202"],"changeable":["63900000-0000-4000-8000-000000000202"]}'::jsonb,
  'the reader preserves exact canonical readable and changeable field identities'
);

select is(
  (
    select valid_until
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
    where direct_share_id = '93900000-0000-4000-8000-000000000101'
  ),
  null::timestamptz,
  'an unbounded direct-account contribution has no artificial deadline'
);

select is(
  (
    select valid_until
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
    where direct_share_id = '93900000-0000-4000-8000-000000000103'
  ),
  (select membership_expiry from share_times),
  'a Group contribution uses its earlier membership expiry'
);

select is(
  (
    select valid_until
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
    where direct_share_id = '93900000-0000-4000-8000-000000000104'
  ),
  (select short_expiry from share_times),
  'a Group contribution uses its earlier share expiry'
);

select is(
  (
    select pg_catalog.count(*)
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001',
      p_checked_at => (select checked_at + interval '25 minutes' from share_times)
    )
    where direct_share_id = '93900000-0000-4000-8000-000000000103'
  ),
  0::bigint,
  'an expired Group membership removes its contribution at the later checked time'
);

update vortex_access.organization_group_memberships
set state = 'revoked', revision = 2,
  changed_by = '73900000-0000-4000-8000-000000000001',
  changed_at = (select checked_at from share_times),
  change_correlation_id = 'a3900000-0000-4000-8000-000000000035',
  revoked_by = '73900000-0000-4000-8000-000000000001',
  revoked_at = (select checked_at from share_times),
  revocation_correlation_id = 'a3900000-0000-4000-8000-000000000036'
where organization_id = '23900000-0000-4000-8000-000000000001'
  and membership_id = '84900000-0000-4000-8000-000000000002';

select is(
  (
    select pg_catalog.count(*)
    from pg_temp.share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
    where direct_share_id = '93900000-0000-4000-8000-000000000104'
  ),
  0::bigint,
  'a revoked Group membership removes its contribution at the next read'
);

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000002'
  )),
  0::bigint,
  'a not-started share contributes nothing at the checked time'
);

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000003',
    p_checked_at => (select checked_at + interval '10 minutes' from share_times)
  )),
  0::bigint,
  'an expired share contributes nothing at a later checked time'
);

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000005'
  )),
  0::bigint,
  'a terminal revoked share contributes nothing'
);

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000004', 'organization_shared'
  )),
  1::bigint,
  'organization-shared storage contributes through the trusted consuming binding'
);

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000001',
    p_binding_module_root_id => '43900000-0000-4000-8000-000000000102'
  )),
  0::bigint,
  'a different installed module binding cannot read the stored record share'
);

select is(
  (select pg_catalog.count(*) from pg_temp.share_contributions(
    'e3900000-0000-4000-8000-000000000001',
    p_binding_application_root_id => '33900000-0000-4000-8000-000000000002',
    p_current_application_root_id => '33900000-0000-4000-8000-000000000002'
  )),
  1::bigint,
  'application-contained contributions remain bound to their exact source application'
);

select throws_ok(
  $$select * from vortex_access.read_current_direct_record_share_contributions(
    '23900000-0000-4000-8000-000000000001',
    '33900000-0000-4000-8000-000000000001',
    '43900000-0000-4000-8000-000000000101',
    '53900000-0000-4000-8000-000000000101',
    '63900000-0000-4000-8000-000000000101',
    'application_contained', 'e3900000-0000-4000-8000-000000000001',
    '23900000-0000-4000-8000-000000000002',
    '33900000-0000-4000-8000-000000000001',
    '73900000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp()
  )$$,
  '22023',
  'Direct record-share contribution evidence is invalid',
  'foreign verified context evidence is refused instead of treated as a nonmatch'
);

select throws_ok(
  $$insert into vortex_access.organization_direct_record_shares
    select organization_id, '93900000-0000-4000-8000-000000000201',
      storage_scope, application_root_id, module_root_id, record_type_id,
      storage_contract_id, record_id, recipient_kind, organization_account_id,
      group_id,
      array['63900000-0000-4000-8000-000000000202','63900000-0000-4000-8000-000000000201']::uuid[],
      changeable_field_ids, starts_at, expires_at, state, revision, granted_by,
      granted_at, grant_correlation_id, reason, revoked_by, revoked_at,
      revocation_correlation_id, revocation_reason, changed_at
    from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  null,
  'field identities must retain canonical UUID order'
);

select throws_ok(
  $$insert into vortex_access.organization_direct_record_shares
    select organization_id, '93900000-0000-4000-8000-000000000202',
      storage_scope, application_root_id, module_root_id, record_type_id,
      storage_contract_id, record_id, recipient_kind, organization_account_id,
      group_id, readable_field_ids,
      array['63900000-0000-4000-8000-000000000299']::uuid[],
      starts_at, expires_at, state, revision, granted_by, granted_at,
      grant_correlation_id, reason, revoked_by, revoked_at,
      revocation_correlation_id, revocation_reason, changed_at
    from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  null,
  'changeable field identities must be a readable subset'
);

select throws_ok(
  $$insert into vortex_access.organization_direct_record_shares
    select organization_id, '93900000-0000-4000-8000-000000000203',
      storage_scope, application_root_id, module_root_id, record_type_id,
      storage_contract_id, record_id, recipient_kind, organization_account_id,
      group_id, array[]::uuid[], changeable_field_ids, starts_at, expires_at,
      state, revision, granted_by, granted_at, grant_correlation_id, reason,
      revoked_by, revoked_at, revocation_correlation_id, revocation_reason,
      changed_at
    from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  null,
  'a share must retain at least one readable field'
);

select throws_ok(
  $$insert into vortex_access.organization_direct_record_shares
    select organization_id, '93900000-0000-4000-8000-000000000204',
      'organization_shared', application_root_id, module_root_id, record_type_id,
      storage_contract_id, record_id, recipient_kind, organization_account_id,
      group_id, readable_field_ids, changeable_field_ids, starts_at, expires_at,
      state, revision, granted_by, granted_at, grant_correlation_id, reason,
      revoked_by, revoked_at, revocation_correlation_id, revocation_reason,
      changed_at
    from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  null,
  'organization-shared facts cannot retain a source application'
);

select throws_ok(
  $$insert into vortex_access.organization_direct_record_shares
    select organization_id, '93900000-0000-4000-8000-000000000205',
      storage_scope, application_root_id, module_root_id, record_type_id,
      storage_contract_id, record_id, 'group', organization_account_id,
      '83900000-0000-4000-8000-000000000001', readable_field_ids,
      changeable_field_ids, starts_at, expires_at, state, revision, granted_by,
      granted_at, grant_correlation_id, reason, revoked_by, revoked_at,
      revocation_correlation_id, revocation_reason, changed_at
    from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  null,
  'a share stores exactly one account or Group recipient'
);

select throws_ok(
  $$insert into vortex_access.organization_direct_record_shares
    select organization_id, '93900000-0000-4000-8000-000000000206',
      storage_scope, application_root_id, module_root_id, record_type_id,
      storage_contract_id, record_id, recipient_kind, organization_account_id,
      group_id, readable_field_ids, changeable_field_ids, starts_at, expires_at,
      'revoked', 2, granted_by, granted_at, grant_correlation_id, reason,
      granted_by, changed_at, 'a3900000-0000-4000-8000-000000000206',
      'Already revoked', changed_at
    from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  'Initial direct record-share evidence is invalid',
  'a current share cannot be inserted directly as a later revoked revision'
);

select throws_ok(
  $$update vortex_access.organization_direct_record_shares
    set readable_field_ids = array['63900000-0000-4000-8000-000000000201']::uuid[],
      state = 'revoked', revision = 2,
      revoked_by = '73900000-0000-4000-8000-000000000001',
      revoked_at = pg_catalog.clock_timestamp(),
      revocation_correlation_id = 'a3900000-0000-4000-8000-000000000207',
      revocation_reason = 'Attempted mutation',
      changed_at = pg_catalog.clock_timestamp()
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  'Direct record-share identity, grant evidence or lifecycle is immutable',
  'revocation cannot alter the original field bounds'
);

select throws_ok(
  $$delete from vortex_access.organization_direct_record_shares
    where direct_share_id = '93900000-0000-4000-8000-000000000101'$$,
  '23514',
  'Direct record shares cannot be deleted',
  'current share facts cannot be deleted'
);

select throws_ok(
  $$update vortex_access.organization_direct_record_shares
    set revision = 3, changed_at = pg_catalog.clock_timestamp()
    where direct_share_id = '93900000-0000-4000-8000-000000000112'$$,
  '23514',
  'Direct record-share identity, grant evidence or lifecycle is immutable',
  'a revoked share is terminal'
);

-- Prove the pre-#35 protected seam without publishing a permissive record
-- reader. The test-owned wrapper accepts only a record identity; it derives
-- the recipient account from the validated request context and the storage
-- identity from a controlled installed binding. #35 must still bind its own
-- eligible record-permission alternative to the same scope.
select * from vortex_access.initialize_organization_access_version(
  '23900000-0000-4000-8000-000000000001',
  '73900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000300'
);

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '23900000-0000-4000-8000-000000000001', 'application',
  '33900000-0000-4000-8000-000000000001', 1, 'active', 'register',
  'example.direct_share', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
  '73900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000301'
);
insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state,
  revision, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '23900000-0000-4000-8000-000000000001', 'application',
  '33900000-0000-4000-8000-000000000001', 'active', 1,
  'example.direct_share', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
  '73900000-0000-4000-8000-000000000001',
  'a3900000-0000-4000-8000-000000000301'
);

create table vortex_access.test_installed_direct_share_bindings (
  organization_id uuid not null,
  application_root_id uuid not null,
  module_root_id uuid not null,
  record_type_id uuid not null,
  storage_contract_id uuid not null,
  storage_scope text not null,
  primary key (organization_id, application_root_id, record_type_id)
);
revoke all on table vortex_access.test_installed_direct_share_bindings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
insert into vortex_access.test_installed_direct_share_bindings values (
  '23900000-0000-4000-8000-000000000001',
  '33900000-0000-4000-8000-000000000001',
  '43900000-0000-4000-8000-000000000101',
  '53900000-0000-4000-8000-000000000101',
  '63900000-0000-4000-8000-000000000101',
  'application_contained'
);

create function vortex_access.test_current_direct_share_contributions(
  p_record_id uuid
)
returns table (
  direct_share_id uuid,
  direct_share_revision bigint,
  recipient_kind text,
  organization_account_id uuid,
  group_id uuid,
  readable_field_ids uuid[],
  changeable_field_ids uuid[],
  valid_until timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  binding record;
  checked_at timestamptz;
begin
  context_value := vortex_access.validated_human_request_context();

  select * into strict binding
  from vortex_access.test_installed_direct_share_bindings as stored_binding
  where stored_binding.organization_id =
      (context_value ->> 'organizationId')::uuid
    and stored_binding.application_root_id =
      (context_value ->> 'applicationRootId')::uuid
    and stored_binding.record_type_id =
      '53900000-0000-4000-8000-000000000101';

  checked_at := pg_catalog.clock_timestamp();

  return query
  select contribution.*
  from vortex_access.read_current_direct_record_share_contributions(
    binding.organization_id,
    binding.application_root_id,
    binding.module_root_id,
    binding.record_type_id,
    binding.storage_contract_id,
    binding.storage_scope,
    p_record_id,
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    checked_at
  ) as contribution;
end
$function$;

revoke execute on function vortex_access.test_current_direct_share_contributions(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_current_direct_share_contributions(uuid)
  to vortex_request;
grant usage on schema extensions to vortex_request;

select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '83900000-0000-4000-8000-000000000101',
  'tenantId', scope.tenant_id,
  'organizationId', scope.organization_id,
  'organizationAccountId', scope.organization_account_id,
  'identityId', '43900000-0000-4000-8000-000000000001',
  'applicationRootId', scope.application_root_id,
  'sessionId', '63900000-0000-4000-8000-000000000199',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '1 hour',
  'accessVersion', scope.access_version,
  'correlationId', 'a3900000-0000-4000-8000-000000000399'
))
from vortex_access.resolve_human_application_scope(
  '43900000-0000-4000-8000-000000000001',
  '23900000-0000-4000-8000-000000000001',
  '33900000-0000-4000-8000-000000000001'
) as scope;

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select results_eq(
  $$select direct_share_id
    from vortex_access.test_current_direct_share_contributions(
      'e3900000-0000-4000-8000-000000000001'
    )
    order by direct_share_id$$,
  $$values
    ('93900000-0000-4000-8000-000000000101'::uuid),
    ('93900000-0000-4000-8000-000000000102'::uuid),
    ('93900000-0000-4000-8000-000000000103'::uuid)$$,
  'the actual request role receives only current contributions for its validated account'
);
reset role;

select * from finish();

rollback;
