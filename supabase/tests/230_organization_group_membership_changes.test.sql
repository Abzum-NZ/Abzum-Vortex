\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'coordinate_organization_group_membership_change',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'uuid',
    'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid', 'uuid'
  ],
  'Access exposes one private Group-membership composition'
);

select volatility_is(
  'vortex_access', 'coordinate_organization_group_membership_change',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'uuid',
    'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid', 'uuid'
  ],
  'volatile',
  'the membership coordinator changes one fact and Access atomically'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', routine.prosecdef,
      'configuration', routine.proconfig
    )
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_roles as owner_role on owner_role.oid = routine.proowner
    where routine.oid =
      'vortex_access.coordinate_organization_group_membership_change(text,uuid,uuid,bigint,uuid,uuid,timestamptz,timestamptz,uuid,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', false,
    'configuration', array['search_path=""']
  ),
  'the coordinator remains owner-held, invoker-security and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_group_membership_change(text,uuid,uuid,bigint,uuid,uuid,timestamptz,timestamptz,uuid,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private membership coordinator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request role can resolve Access before function privilege is tested'
);

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '32300000-0000-4000-8000-000000000001',
      null,
      '42300000-0000-4000-8000-000000000001',
      '52300000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(), null, null,
      '92300000-0000-4000-8000-000000000001',
      '72300000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_group_membership_change',
  'an actual request-role call cannot invoke membership changes'
);
reset role;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '12300000-0000-4000-8000-000000000001', 'membership_changes',
  'Membership changes', 'active', pg_catalog.statement_timestamp(),
  '92300000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '22300000-0000-4000-8000-000000000001',
    '12300000-0000-4000-8000-000000000001', 'membership_changes_one',
    'Membership changes one', 'active', pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22300000-0000-4000-8000-000000000002',
    '12300000-0000-4000-8000-000000000001', 'membership_changes_two',
    'Membership changes two', 'active', pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '42300000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000002', 1
  ),
  (
    '42300000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000003', 1
  ),
  (
    '42300000-0000-4000-8000-000000000003', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000004', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '52300000-0000-4000-8000-000000000001',
    '22300000-0000-4000-8000-000000000001',
    '42300000-0000-4000-8000-000000000001', 'Membership person one', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000005', 1
  ),
  (
    '52300000-0000-4000-8000-000000000002',
    '22300000-0000-4000-8000-000000000001',
    '42300000-0000-4000-8000-000000000002', 'Membership person two', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000006', 1
  ),
  (
    '52300000-0000-4000-8000-000000000003',
    '22300000-0000-4000-8000-000000000001',
    '42300000-0000-4000-8000-000000000003', 'Suspended membership person',
    'suspended', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000007', 1
  ),
  (
    '52300000-0000-4000-8000-000000000020',
    '22300000-0000-4000-8000-000000000002',
    '42300000-0000-4000-8000-000000000003', 'Foreign membership person',
    'active', pg_catalog.statement_timestamp(), null,
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '92300000-0000-4000-8000-000000000001',
    '72300000-0000-4000-8000-000000000013', 1
  );

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '22300000-0000-4000-8000-000000000001',
    '32300000-0000-4000-8000-000000000001', 'review_group', 'Review Group',
    'active', 1, '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '72300000-0000-4000-8000-000000000008'
  ),
  (
    '22300000-0000-4000-8000-000000000001',
    '32300000-0000-4000-8000-000000000002', 'scheduled_group', 'Scheduled Group',
    'active', 1, '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '72300000-0000-4000-8000-000000000009'
  ),
  (
    '22300000-0000-4000-8000-000000000001',
    '32300000-0000-4000-8000-000000000003', 'renewal_group', 'Renewal Group',
    'active', 1, '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '72300000-0000-4000-8000-000000000010'
  ),
  (
    '22300000-0000-4000-8000-000000000001',
    '32300000-0000-4000-8000-000000000004', 'retired_group', 'Retired Group',
    'active', 1, '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '72300000-0000-4000-8000-000000000011'
  ),
  (
    '22300000-0000-4000-8000-000000000002',
    '32300000-0000-4000-8000-000000000005', 'foreign_group', 'Foreign Group',
    'active', 1, '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '92300000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), '72300000-0000-4000-8000-000000000012'
  );

select initialized.*
from vortex_identity.organizations as organization
cross join lateral vortex_access.initialize_organization_access_version(
  organization.organization_id,
  '92300000-0000-4000-8000-000000000001',
  pg_catalog.gen_random_uuid()
) as initialized;

create temporary table added_membership on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'add_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000001', null,
  '32300000-0000-4000-8000-000000000001',
  '52300000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '1 hour',
  pg_catalog.statement_timestamp() + interval '2 hours', null,
  '92300000-0000-4000-8000-000000000002',
  '72300000-0000-4000-8000-000000000020'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, operation, membership ->> 'membershipId',
      membership ->> 'state', membership ->> 'revision', access_version,
      correlation_id
    )
    from added_membership
  ),
  'changed|add_membership|62300000-0000-4000-8000-000000000001|live|1|2|72300000-0000-4000-8000-000000000020',
  'addition returns the exact live revision-one membership and one Access increment'
);

select is(
  (
    select pg_catalog.to_jsonb(stored.*) - array['granted_at', 'changed_at']
    from vortex_access.organization_group_memberships as stored
    where stored.organization_id = '22300000-0000-4000-8000-000000000001'
      and stored.membership_id = '62300000-0000-4000-8000-000000000001'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'organization_id', (membership ->> 'organizationId')::uuid,
      'membership_id', (membership ->> 'membershipId')::uuid,
      'group_id', (membership ->> 'groupId')::uuid,
      'organization_account_id', (membership ->> 'organizationAccountId')::uuid,
      'revision', (membership ->> 'revision')::bigint,
      'starts_at', (membership ->> 'startsAt')::timestamptz,
      'expires_at', (membership ->> 'expiresAt')::timestamptz,
      'state', membership ->> 'state',
      'granted_by', (membership ->> 'grantedByActorId')::uuid,
      'grant_correlation_id', (membership ->> 'grantCorrelationId')::uuid,
      'changed_by', (membership ->> 'changedByActorId')::uuid,
      'change_correlation_id', (membership ->> 'changeCorrelationId')::uuid,
      'revoked_by', null,
      'revoked_at', null,
      'revocation_correlation_id', null
    )
    from added_membership
  ),
  'addition returns the complete actual stored membership projection'
);

select is(
  (
    select granted_at = changed_at
    from vortex_access.organization_group_memberships
    where organization_id = '22300000-0000-4000-8000-000000000001'
      and membership_id = '62300000-0000-4000-8000-000000000001'
  ),
  true,
  'addition records one database-owned grant observation'
);

-- A pinned historical activation proves membership transitions never mutate
-- old activation evidence or retarget its source identity/revision.
set local session_replication_role = replica;
insert into vortex_access.organization_role_activations (
  organization_id, role_activation_id, organization_account_id, role_id,
  revision, historical_role_revision, authority_continuity_revision,
  policy_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  eligibility_source_kind, role_assignment_id, role_assignment_revision,
  membership_id, membership_revision, state, activated_by, activated_at,
  expires_at, activation_correlation_id, changed_by, changed_at,
  change_correlation_id
) values (
  '22300000-0000-4000-8000-000000000001',
  '82300000-0000-4000-8000-000000000001',
  '52300000-0000-4000-8000-000000000001',
  'a2300000-0000-4000-8000-000000000001', 1, 1, 1, 1,
  'b2300000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('a', 64), 'group',
  'c2300000-0000-4000-8000-000000000001', 1,
  '62300000-0000-4000-8000-000000000001', 1, 'live',
  '92300000-0000-4000-8000-000000000003',
  pg_catalog.statement_timestamp() - interval '30 minutes',
  pg_catalog.statement_timestamp() + interval '30 minutes',
  '72300000-0000-4000-8000-000000000021',
  '92300000-0000-4000-8000-000000000003',
  pg_catalog.statement_timestamp() - interval '30 minutes',
  '72300000-0000-4000-8000-000000000021'
);
set local session_replication_role = origin;

create temporary table activation_before on commit drop as
select pg_catalog.to_jsonb(activation.*) as snapshot
from vortex_access.organization_role_activations as activation
where activation.organization_id = '22300000-0000-4000-8000-000000000001'
  and activation.role_activation_id = '82300000-0000-4000-8000-000000000001';

create temporary table removed_membership on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000004',
  '72300000-0000-4000-8000-000000000022'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', membership ->> 'state', membership ->> 'revision',
      membership ->> 'grantedByActorId', membership ->> 'grantCorrelationId',
      membership ->> 'revokedByActorId',
      membership ->> 'revocationCorrelationId', access_version
    )
    from removed_membership
  ),
  'revoked|2|92300000-0000-4000-8000-000000000002|72300000-0000-4000-8000-000000000020|92300000-0000-4000-8000-000000000004|72300000-0000-4000-8000-000000000022|3',
  'removal preserves the original grant and records exact revocation evidence once'
);

create temporary table restored_membership on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'restore_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000001', 2,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000005',
  '72300000-0000-4000-8000-000000000023'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', membership ->> 'state', membership ->> 'revision',
      membership ->> 'grantedByActorId', membership ->> 'grantCorrelationId',
      membership ? 'revokedAt', access_version
    )
    from restored_membership
  ),
  'live|3|92300000-0000-4000-8000-000000000002|72300000-0000-4000-8000-000000000020|f|4',
  'restoration preserves identity, window and grant provenance while clearing revocation'
);

select *
from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000001', 3,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000006',
  '72300000-0000-4000-8000-000000000024'
);

select *
from vortex_access.coordinate_organization_group_membership_change(
  'add_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000002', null,
  '32300000-0000-4000-8000-000000000001',
  '52300000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), null, null,
  '92300000-0000-4000-8000-000000000007',
  '72300000-0000-4000-8000-000000000025'
);

select is(
  (
    select pg_catalog.string_agg(membership_id::text || ':' || state, ',' order by membership_id)
    from vortex_access.organization_group_memberships
    where organization_id = '22300000-0000-4000-8000-000000000001'
      and group_id = '32300000-0000-4000-8000-000000000001'
      and organization_account_id = '52300000-0000-4000-8000-000000000001'
  ),
  '62300000-0000-4000-8000-000000000001:revoked,62300000-0000-4000-8000-000000000002:live',
  'a revoked predecessor permits a fresh independently identified membership'
);

select *
from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000002', 1,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000008',
  '72300000-0000-4000-8000-000000000026'
);

create temporary table scheduled_add on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'add_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000003', null,
  '32300000-0000-4000-8000-000000000002',
  '52300000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() + interval '1 hour',
  pg_catalog.statement_timestamp() + interval '2 hours', null,
  '92300000-0000-4000-8000-000000000009',
  '72300000-0000-4000-8000-000000000027'
);

select *
from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000003', 1,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000010',
  '72300000-0000-4000-8000-000000000028'
);

create temporary table scheduled_restore on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'restore_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000003', 2,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000011',
  '72300000-0000-4000-8000-000000000029'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', membership ->> 'state', membership ->> 'revision',
      ((membership ->> 'startsAt')::timestamptz =
        (select (membership ->> 'startsAt')::timestamptz from scheduled_add)),
      access_version
    )
    from scheduled_restore
  ),
  'live|3|t|10',
  'restoring a scheduled fixed window keeps it scheduled without inventing new time state'
);

-- Controlled persisted facts exercise natural expiry and future audit metadata
-- without sleeping or treating an audit timestamp as an authorization clock.
set local session_replication_role = replica;
insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id,
  revoked_by, revoked_at, revocation_correlation_id
) values
  (
    '22300000-0000-4000-8000-000000000001',
    '62300000-0000-4000-8000-000000000004',
    '32300000-0000-4000-8000-000000000003',
    '52300000-0000-4000-8000-000000000002', 1,
    pg_catalog.statement_timestamp() - interval '2 hours',
    pg_catalog.statement_timestamp() - interval '1 hour', 'live',
    '92300000-0000-4000-8000-000000000012',
    pg_catalog.statement_timestamp() - interval '2 hours',
    '72300000-0000-4000-8000-000000000030',
    '92300000-0000-4000-8000-000000000012',
    pg_catalog.statement_timestamp() - interval '2 hours',
    '72300000-0000-4000-8000-000000000030', null, null, null
  ),
  (
    '22300000-0000-4000-8000-000000000001',
    '62300000-0000-4000-8000-000000000005',
    '32300000-0000-4000-8000-000000000002',
    '52300000-0000-4000-8000-000000000002', 2,
    pg_catalog.statement_timestamp() - interval '1 hour',
    pg_catalog.statement_timestamp() + interval '2 hours', 'revoked',
    '92300000-0000-4000-8000-000000000013',
    pg_catalog.statement_timestamp() - interval '1 hour',
    '72300000-0000-4000-8000-000000000031',
    '92300000-0000-4000-8000-000000000013',
    pg_catalog.statement_timestamp() + interval '4 hours',
    '72300000-0000-4000-8000-000000000032',
    '92300000-0000-4000-8000-000000000013',
    pg_catalog.statement_timestamp() + interval '4 hours',
    '72300000-0000-4000-8000-000000000032'
  );
set local session_replication_role = origin;

create temporary table renewed_membership on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'renew_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000004', 1,
  null, null, pg_catalog.statement_timestamp(), null,
  '62300000-0000-4000-8000-000000000006',
  '92300000-0000-4000-8000-000000000014',
  '72300000-0000-4000-8000-000000000033'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', closed_predecessor ->> 'membershipId',
      closed_predecessor ->> 'state', closed_predecessor ->> 'revision',
      membership ->> 'membershipId', membership ->> 'state',
      membership ->> 'revision', access_version
    )
    from renewed_membership
  ),
  '62300000-0000-4000-8000-000000000004|revoked|2|62300000-0000-4000-8000-000000000006|live|1|11',
  'renewal closes one naturally expired predecessor and creates one distinct grant in one Access change'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', old_member.group_id = new_member.group_id,
      old_member.organization_account_id = new_member.organization_account_id,
      old_member.granted_by,
      new_member.granted_by,
      old_member.revoked_at >= old_member.changed_at,
      new_member.granted_at = new_member.changed_at
    )
    from vortex_access.organization_group_memberships as old_member
    join vortex_access.organization_group_memberships as new_member
      on new_member.organization_id = old_member.organization_id
    where old_member.organization_id = '22300000-0000-4000-8000-000000000001'
      and old_member.membership_id = '62300000-0000-4000-8000-000000000004'
      and new_member.membership_id = '62300000-0000-4000-8000-000000000006'
  ),
  't|t|92300000-0000-4000-8000-000000000012|92300000-0000-4000-8000-000000000014|t|t',
  'renewal derives the source pair, preserves predecessor provenance and records a new grant'
);

create temporary table future_audit_restore on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'restore_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000005', 2,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000015',
  '72300000-0000-4000-8000-000000000034'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', membership ->> 'state', membership ->> 'revision',
      ((membership ->> 'changedAt')::timestamptz > pg_catalog.clock_timestamp()),
      access_version
    )
    from future_audit_restore
  ),
  'live|3|t|12',
  'restore authorizes against the post-lock database clock while retaining monotonic future audit evidence'
);

set local session_replication_role = replica;
insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000007',
  '32300000-0000-4000-8000-000000000003',
  '52300000-0000-4000-8000-000000000001', 1,
  pg_catalog.statement_timestamp() - interval '1 hour',
  pg_catalog.statement_timestamp() + interval '2 hours', 'live',
  '92300000-0000-4000-8000-000000000016',
  pg_catalog.statement_timestamp() - interval '1 hour',
  '72300000-0000-4000-8000-000000000035',
  '92300000-0000-4000-8000-000000000016',
  pg_catalog.statement_timestamp() + interval '4 hours',
  '72300000-0000-4000-8000-000000000035'
);
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'renew_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000007', 1,
      null, null, pg_catalog.statement_timestamp(), null,
      '62300000-0000-4000-8000-000000000008',
      '92300000-0000-4000-8000-000000000017',
      '72300000-0000-4000-8000-000000000036'
    )
  $$,
  '40001'::char(5),
  'Only a naturally expired live Group membership can be renewed',
  'future audit evidence cannot make a still-current membership renewable early'
);

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '22300000-0000-4000-8000-000000000001'
  ),
  12::bigint,
  'refused early renewal does not change Access'
);

select is(
  (
    select pg_catalog.bool_and(
      snapshot = pg_catalog.to_jsonb(activation.*)
    )
    from activation_before
    cross join vortex_access.organization_role_activations as activation
    where activation.organization_id = '22300000-0000-4000-8000-000000000001'
      and activation.role_activation_id = '82300000-0000-4000-8000-000000000001'
  ),
  true,
  'membership changes never mutate or retarget an existing activation revision'
);

-- Retire one source through the actual Group writer. Removal remains a safe
-- reduction, while restoration and addition require current active sources.
select *
from vortex_access.coordinate_organization_group_membership_change(
  'add_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000009', null,
  '32300000-0000-4000-8000-000000000004',
  '52300000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), null, null,
  '92300000-0000-4000-8000-000000000018',
  '72300000-0000-4000-8000-000000000037'
);

select *
from vortex_access.coordinate_organization_group_change(
  'retire_group',
  '22300000-0000-4000-8000-000000000001',
  '32300000-0000-4000-8000-000000000004', 1,
  null, null,
  '92300000-0000-4000-8000-000000000019',
  '72300000-0000-4000-8000-000000000038'
);

create temporary table removed_after_source_retirement on commit drop as
select *
from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership',
  '22300000-0000-4000-8000-000000000001',
  '62300000-0000-4000-8000-000000000009', 1,
  null, null, null, null, null,
  '92300000-0000-4000-8000-000000000020',
  '72300000-0000-4000-8000-000000000039'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', membership ->> 'state', membership ->> 'revision', access_version
    )
    from removed_after_source_retirement
  ),
  'revoked|2|15',
  'removal remains available after its Group source becomes inactive'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'restore_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000009', 2,
      null, null, null, null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000040'
    )
  $$,
  '40001'::char(5), null,
  'restoration refuses after its Group source retires'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000010', null,
      '32300000-0000-4000-8000-000000000004',
      '52300000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(), null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000041'
    )
  $$,
  '40001'::char(5), null,
  'addition refuses a retired Group source'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000011', null,
      '32300000-0000-4000-8000-000000000001',
      '52300000-0000-4000-8000-000000000003',
      pg_catalog.statement_timestamp(), null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000042'
    )
  $$,
  '40001'::char(5), null,
  'addition refuses an inactive account source'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000012', null,
      '32300000-0000-4000-8000-000000000005',
      '52300000-0000-4000-8000-000000000001',
      pg_catalog.statement_timestamp(), null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000043'
    )
  $$,
  '40001'::char(5), null,
  'addition refuses a foreign Group source'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000014', null,
      '32300000-0000-4000-8000-000000000001',
      '52300000-0000-4000-8000-000000000020',
      pg_catalog.statement_timestamp(), null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000043'
    )
  $$,
  '40001'::char(5), null,
  'addition refuses a foreign organization account with a valid local Group'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000013', null,
      '32300000-0000-4000-8000-000000000001',
      '52300000-0000-4000-8000-000000000002',
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000044'
    )
  $$,
  '22023'::char(5), null,
  'malformed and already-expired addition windows are rejected before mutation'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'remove_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000001', 3,
      null, null, null, null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000045'
    )
  $$,
  '40001'::char(5), null,
  'a stale membership revision is refused'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'remove_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000001', 4,
      '32300000-0000-4000-8000-000000000001',
      null, null, null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000046'
    )
  $$,
  '22023'::char(5), null,
  'closed branch shapes reject fields prohibited for a removal'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'unknown',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000001', 4,
      null, null, null, null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000047'
    )
  $$,
  '22023'::char(5), null,
  'unknown operations are rejected before organization lookup'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'restore_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000004', 2,
      null, null, null, null, null,
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000048'
    )
  $$,
  '40001'::char(5), null,
  'an expired predecessor cannot be restored under its old identity'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'renew_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000004', 2,
      null, null, pg_catalog.statement_timestamp(), null,
      '62300000-0000-4000-8000-000000000006',
      '92300000-0000-4000-8000-000000000021',
      '72300000-0000-4000-8000-000000000049'
    )
  $$,
  '40001'::char(5), null,
  'renewal refuses a revoked predecessor and an already-used replacement identity'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'add_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000002', null,
      '32300000-0000-4000-8000-000000000001',
      '52300000-0000-4000-8000-000000000002',
      pg_catalog.statement_timestamp(), null, null,
      '92300000-0000-4000-8000-000000000022',
      '72300000-0000-4000-8000-000000000053'
    )
  $$,
  '40001'::char(5), null,
  'an existing membership identity is refused even for an otherwise free pair'
);

savepoint permanent_restore_proof;

select is(
  (
    select pg_catalog.concat_ws(
      '|', result.membership ->> 'state', result.membership ->> 'revision',
      not (result.membership ? 'expiresAt'),
      result.membership ->> 'grantedByActorId',
      result.membership ->> 'grantCorrelationId', result.access_version
    )
    from vortex_access.coordinate_organization_group_membership_change(
      'restore_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000002', 2,
      null, null, null, null, null,
      '92300000-0000-4000-8000-000000000023',
      '72300000-0000-4000-8000-000000000054'
    ) as result
  ),
  'live|3|t|92300000-0000-4000-8000-000000000007|72300000-0000-4000-8000-000000000025|16',
  'a permanent revoked membership restores under the same identity and original grant'
);

rollback to savepoint permanent_restore_proof;

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '22300000-0000-4000-8000-000000000001'
  ),
  15::bigint,
  'refused source, stale, malformed, identity and terminal paths add no Access change'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', current_version, changed_by, change_correlation_id, change_reason
    )
    from vortex_access.organization_access_versions
    where organization_id = '22300000-0000-4000-8000-000000000001'
  ),
  '15|92300000-0000-4000-8000-000000000020|72300000-0000-4000-8000-000000000039|team_membership_changed',
  'the latest durable removal keeps the stable stored Access reason'
);

-- Membership revision exhaustion is checked before any state change.
set local session_replication_role = replica;
update vortex_access.organization_group_memberships
set revision = 9007199254740991,
  state = 'live', revoked_by = null, revoked_at = null,
  revocation_correlation_id = null
where organization_id = '22300000-0000-4000-8000-000000000001'
  and membership_id = '62300000-0000-4000-8000-000000000001';
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'remove_membership',
      '22300000-0000-4000-8000-000000000001',
      '62300000-0000-4000-8000-000000000001', 9007199254740991,
      null, null, null, null, null,
      '92300000-0000-4000-8000-000000000022',
      '72300000-0000-4000-8000-000000000050'
    )
  $$,
  '22003'::char(5),
  'Organization Group membership revision is exhausted',
  'membership revision exhaustion refuses before mutation'
);

select is(
  (
    select revision || ':' || state
    from vortex_access.organization_group_memberships
    where organization_id = '22300000-0000-4000-8000-000000000001'
      and membership_id = '62300000-0000-4000-8000-000000000001'
  ),
  '9007199254740991:live',
  'membership exhaustion preserves the complete current fact'
);

-- Access exhaustion after a renewal has tentatively closed and inserted must
-- roll the whole statement back, leaving neither a split pair nor a new row.
set local session_replication_role = replica;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '22300000-0000-4000-8000-000000000002';
insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '22300000-0000-4000-8000-000000000002',
  '62300000-0000-4000-8000-000000000020',
  '32300000-0000-4000-8000-000000000005',
  '52300000-0000-4000-8000-000000000020', 1,
  pg_catalog.statement_timestamp() - interval '2 hours',
  pg_catalog.statement_timestamp() - interval '1 hour', 'live',
  '92300000-0000-4000-8000-000000000020',
  pg_catalog.statement_timestamp() - interval '2 hours',
  '72300000-0000-4000-8000-000000000051',
  '92300000-0000-4000-8000-000000000020',
  pg_catalog.statement_timestamp() - interval '2 hours',
  '72300000-0000-4000-8000-000000000051'
);
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_group_membership_change(
      'renew_membership',
      '22300000-0000-4000-8000-000000000002',
      '62300000-0000-4000-8000-000000000020', 1,
      null, null, pg_catalog.statement_timestamp(), null,
      '62300000-0000-4000-8000-000000000021',
      '92300000-0000-4000-8000-000000000022',
      '72300000-0000-4000-8000-000000000052'
    )
  $$,
  '22003'::char(5), null,
  'Access exhaustion rolls back both halves of renewal'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', predecessor.revision, predecessor.state,
      (select pg_catalog.count(*)
       from vortex_access.organization_group_memberships as replacement
       where replacement.organization_id = predecessor.organization_id
         and replacement.membership_id =
           '62300000-0000-4000-8000-000000000021')
    )
    from vortex_access.organization_group_memberships as predecessor
    where predecessor.organization_id = '22300000-0000-4000-8000-000000000002'
      and predecessor.membership_id = '62300000-0000-4000-8000-000000000020'
  ),
  '1|live|0',
  'failed renewal leaves the predecessor live and creates no replacement'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', current_version, change_reason
    )
    from vortex_access.organization_access_versions
    where organization_id = '22300000-0000-4000-8000-000000000002'
  ),
  '9007199254740991|organization_initialized',
  'Access exhaustion preserves the prior version and evidence'
);

set constraints all immediate;

select * from finish();

rollback;
