\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_membership_administration_context(
  p_identity_id uuid,
  p_organization_account_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '23350000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83350000-0000-4000-8000-000000000001',
    'tenantId', '13350000-0000-4000-8000-000000000001',
    'organizationId', '23350000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '73350000-0000-4000-8000-000000000001',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3350000-0000-4000-8000-000000000001'
  ));
end
$function$;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access',
  'list_organization_group_memberships_for_administration',
  array['uuid', 'uuid', 'integer'],
  'Access exposes one bounded protected Group membership list'
);
select has_function(
  'vortex_access',
  'read_organization_group_membership_for_administration',
  array['uuid'],
  'Access exposes one exact protected Group membership detail read'
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
      'vortex_access.list_organization_group_memberships_for_administration(uuid,uuid,integer)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', true,
    'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the membership list is a narrow owner-held protected projection'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_group_memberships_for_administration(uuid,uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_group_membership_for_administration(uuid)',
    'EXECUTE'
  ),
  'request role can execute both protected membership projections'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_group_memberships_for_administration(uuid,uuid,integer)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the protected membership list'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_group_membership(uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_group_memberships', 'SELECT'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_identity.organization_accounts', 'SELECT'
  ),
  'request role cannot bypass the safe projection through raw facts'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13350000-0000-4000-8000-000000000001', 'membership_administration',
  'Membership administration', 'active', pg_catalog.clock_timestamp(),
  '93350000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23350000-0000-4000-8000-000000000001',
    '13350000-0000-4000-8000-000000000001', 'membership_administration',
    'Membership administration', 'active', pg_catalog.clock_timestamp(),
    '93350000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  ),
  (
    '23350000-0000-4000-8000-000000000002',
    '13350000-0000-4000-8000-000000000001', 'foreign_membership',
    'Foreign membership', 'active', pg_catalog.clock_timestamp(),
    '93350000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  );
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43350000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000002', 1
  ),
  (
    '43350000-0000-4000-8000-000000000002', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000003', 1
  ),
  (
    '43350000-0000-4000-8000-000000000003', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000004', 1
  ),
  (
    '43350000-0000-4000-8000-000000000004', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000005', 1
  );
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '53350000-0000-4000-8000-000000000001',
    '23350000-0000-4000-8000-000000000001',
    '43350000-0000-4000-8000-000000000001', 'Membership steward', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000006', 1
  ),
  (
    '53350000-0000-4000-8000-000000000002',
    '23350000-0000-4000-8000-000000000001',
    '43350000-0000-4000-8000-000000000002', 'Active member', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000007', 1
  ),
  (
    '53350000-0000-4000-8000-000000000003',
    '23350000-0000-4000-8000-000000000001',
    '43350000-0000-4000-8000-000000000003', 'Scheduled member', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000008', 1
  ),
  (
    '53350000-0000-4000-8000-000000000004',
    '23350000-0000-4000-8000-000000000001',
    '43350000-0000-4000-8000-000000000004', 'Expired member', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93350000-0000-4000-8000-000000000001',
    'a3350000-0000-4000-8000-000000000009', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '23350000-0000-4000-8000-000000000001',
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000010'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '23350000-0000-4000-8000-000000000001',
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000011'
);
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id, state,
  continuity_revision, meaning_fingerprint,
  last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id,
  entry.permission_id, 'platform', entry.registration_owner_id,
  'available', 1, entry.meaning_fingerprint, entry.registration_revision,
  pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '23350000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '23350000-0000-4000-8000-000000000001',
  '53350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000001',
  'membership_administration_steward', 'Membership administration steward',
  'Minimum neutral authority used by the protected membership read fixture.',
  '73350000-0000-4000-8000-000000000001',
  '83350000-0000-4000-8000-000000000001',
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000012'
);
select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000010', null,
  'neutral_group', 'Neutral group',
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000013'
);
insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '23350000-0000-4000-8000-000000000002',
  '63350000-0000-4000-8000-000000000020', 'foreign_group', 'Foreign group',
  'active', 1, '93350000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), '93350000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 'a3350000-0000-4000-8000-000000000014'
);

select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000110', null,
  '63350000-0000-4000-8000-000000000010',
  '53350000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() - interval '1 day', null, null,
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000015'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000110', 1,
  null, null, null, null, null,
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000016'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000120', null,
  '63350000-0000-4000-8000-000000000010',
  '53350000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp() - interval '1 day', null, null,
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000017'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000130', null,
  '63350000-0000-4000-8000-000000000010',
  '53350000-0000-4000-8000-000000000003',
  pg_catalog.clock_timestamp() + interval '1 day', null, null,
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000018'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000140', null,
  '63350000-0000-4000-8000-000000000010',
  '53350000-0000-4000-8000-000000000004',
  pg_catalog.clock_timestamp() - interval '3 days',
  pg_catalog.clock_timestamp() + interval '1 day', null,
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000019'
);

-- A constrained test fixture moves only the finite expiry into the past so
-- the read boundary proves its post-authorization temporal classification.
set local session_replication_role = replica;
update vortex_access.organization_group_memberships
set expires_at = pg_catalog.clock_timestamp() - interval '1 day'
where organization_id = '23350000-0000-4000-8000-000000000001'
  and membership_id = '63350000-0000-4000-8000-000000000140';
set local session_replication_role = origin;

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_request;
select pg_temp.install_membership_administration_context(
  '43350000-0000-4000-8000-000000000001',
  '53350000-0000-4000-8000-000000000001'
);
set local role vortex_request;

select is(
  (
    select group_id::text || '|' || pg_catalog.jsonb_array_length(memberships)::text
      || '|' || next_after_membership_id::text || '|' || access_version::text
    from vortex_access.list_organization_group_memberships_for_administration(
      '63350000-0000-4000-8000-000000000010', null, 2
    )
  ),
  '63350000-0000-4000-8000-000000000010|2|63350000-0000-4000-8000-000000000120|9',
  'authorized request receives one bounded membership page and stable cursor'
);
select results_eq(
  $$
    select item ->> 'membershipId', item ->> 'accountDisplayName',
      item ->> 'state', item ->> 'temporalState'
    from vortex_access.list_organization_group_memberships_for_administration(
      '63350000-0000-4000-8000-000000000010', null, 2
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.memberships) as item
    order by item ->> 'membershipId'
  $$,
  $$values
    ('63350000-0000-4000-8000-000000000110', 'Active member', 'revoked', 'revoked'),
    ('63350000-0000-4000-8000-000000000120', 'Active member', 'live', 'active')$$,
  'the first page exposes only retained membership state and safe account labels'
);
select results_eq(
  $$
    select item ->> 'membershipId', item ->> 'temporalState'
    from vortex_access.list_organization_group_memberships_for_administration(
      '63350000-0000-4000-8000-000000000010',
      '63350000-0000-4000-8000-000000000120', 2
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.memberships) as item
    order by item ->> 'membershipId'
  $$,
  $$values
    ('63350000-0000-4000-8000-000000000130', 'scheduled'),
    ('63350000-0000-4000-8000-000000000140', 'expired')$$,
  'the next page reports scheduled and expired temporal state after authorization'
);
select is(
  (
    select outcome || '|' || (membership_summary ->> 'membershipId')
      || '|' || (membership_summary ->> 'temporalState')
      || '|' || access_version::text
    from vortex_access.read_organization_group_membership_for_administration(
      '63350000-0000-4000-8000-000000000140'
    )
  ),
  'available|63350000-0000-4000-8000-000000000140|expired|9',
  'authorized request reads one exact membership with descriptive temporal state'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_organization_group_membership_for_administration(
      '63350000-0000-4000-8000-000000000120'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.membership_summary) as key
  ),
  '{accountDisplayName,groupId,membershipId,organizationAccountId,revision,startsAt,state,temporalState}',
  'membership detail omits stored audit evidence and absent expiry'
);
select is(
  (
    select outcome || '|' || case
      when membership_summary is null then 'missing' else 'present' end
    from vortex_access.read_organization_group_membership_for_administration(
      '63350000-0000-4000-8000-000000000999'
    )
  ),
  'unavailable|missing',
  'unknown or foreign membership identity is unavailable without leakage'
);
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_group_memberships_for_administration(
      '63350000-0000-4000-8000-000000000020', null, 25
    )
  $$,
  '42501'::char(5),
  'Organization Group membership administration is unavailable',
  'foreign Group membership list is unavailable'
);
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_group_memberships_for_administration(
      '63350000-0000-4000-8000-000000000010', null, 101
    )
  $$,
  '22023'::char(5),
  'Organization Group membership page input is invalid',
  'unbounded membership page is refused before authorization'
);
reset role;

select pg_temp.install_membership_administration_context(
  '43350000-0000-4000-8000-000000000004',
  '53350000-0000-4000-8000-000000000004'
);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.list_organization_group_memberships_for_administration(
      '63350000-0000-4000-8000-000000000010', null, 25
    )
  $$,
  '42501'::char(5),
  'Organization Group administration is unavailable',
  'active member without teams-read authority cannot list memberships'
);
reset role;

select pg_temp.install_membership_administration_context(
  '43350000-0000-4000-8000-000000000001',
  '53350000-0000-4000-8000-000000000001'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '23350000-0000-4000-8000-000000000001',
  '63350000-0000-4000-8000-000000000120', 1,
  null, null, null, null, null,
  '93350000-0000-4000-8000-000000000001',
  'a3350000-0000-4000-8000-000000000020'
);
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.read_organization_group_membership_for_administration(
      '63350000-0000-4000-8000-000000000120'
    )
  $$,
  '42501'::char(5),
  'Request access version is stale or unavailable',
  'stale protected context cannot read after a membership change'
);
reset role;

set constraints all immediate;
select * from finish();
rollback;
