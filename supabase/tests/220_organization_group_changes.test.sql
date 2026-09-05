\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'coordinate_organization_group_change',
  array['text', 'uuid', 'uuid', 'bigint', 'text', 'text', 'uuid', 'uuid'],
  'Access exposes one private organization Group-change composition'
);

select volatility_is(
  'vortex_access', 'coordinate_organization_group_change',
  array['text', 'uuid', 'uuid', 'bigint', 'text', 'text', 'uuid', 'uuid'],
  'volatile',
  'the Group-change composition performs one atomic Group and Access change'
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
      'vortex_access.coordinate_organization_group_change(text,uuid,uuid,bigint,text,text,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres',
    'securityDefiner', false,
    'configuration', array['search_path=""']
  ),
  'the coordinator remains owner-held, security invoker and fixed to an empty search path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_group_change(text,uuid,uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private Group-change coordinator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request role can resolve Access before the function privilege is tested'
);

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_group_change(
      'create_group',
      '22200000-0000-4000-8000-000000000001',
      '32200000-0000-4000-8000-000000000001',
      null, 'review_group', 'Review Group',
      '92200000-0000-4000-8000-000000000001',
      '72200000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_group_change',
  'an actual request-role call cannot invoke Group changes'
);
reset role;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values
  (
    '12200000-0000-4000-8000-000000000001', 'group_changes',
    'Group changes', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '12200000-0000-4000-8000-000000000002', 'inactive_group_changes',
    'Inactive Group changes', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '22200000-0000-4000-8000-000000000001',
    '12200000-0000-4000-8000-000000000001', 'group_changes_one',
    'Group changes one', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22200000-0000-4000-8000-000000000002',
    '12200000-0000-4000-8000-000000000001', 'group_changes_two',
    'Group changes two', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22200000-0000-4000-8000-000000000003',
    '12200000-0000-4000-8000-000000000001', 'group_changes_inactive_org',
    'Inactive Group changes organization', 'active',
    pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22200000-0000-4000-8000-000000000004',
    '12200000-0000-4000-8000-000000000002', 'group_changes_inactive_tenant',
    'Group changes inactive tenant', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22200000-0000-4000-8000-000000000005',
    '12200000-0000-4000-8000-000000000001', 'group_changes_no_access',
    'Group changes without Access', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '22200000-0000-4000-8000-000000000006',
    '12200000-0000-4000-8000-000000000001', 'group_changes_exhaustion',
    'Group changes exhaustion', 'active', pg_catalog.statement_timestamp(),
    '92200000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42200000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '92200000-0000-4000-8000-000000000001',
  '72200000-0000-4000-8000-000000000002', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '52200000-0000-4000-8000-000000000001',
  '22200000-0000-4000-8000-000000000001',
  '42200000-0000-4000-8000-000000000001', 'Group facts person', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(),
  '92200000-0000-4000-8000-000000000001',
  '72200000-0000-4000-8000-000000000003', 1
);

select initialized.*
from vortex_identity.organizations as organization
cross join lateral vortex_access.initialize_organization_access_version(
  organization.organization_id,
  '92200000-0000-4000-8000-000000000001',
  pg_catalog.gen_random_uuid()
) as initialized
where organization.organization_id <>
  '22200000-0000-4000-8000-000000000005';

create temporary table created_group on commit drop as
select * from vortex_access.coordinate_organization_group_change(
  'create_group',
  '22200000-0000-4000-8000-000000000001',
  '32200000-0000-4000-8000-000000000001',
  null, 'review_group', 'Review Group',
  '92200000-0000-4000-8000-000000000002',
  '72200000-0000-4000-8000-000000000004'
);

select is(
  (
    select pg_catalog.to_jsonb(result.*) - array['created_at', 'changed_at']
    from created_group as result
  ),
  pg_catalog.jsonb_build_object(
    'outcome', 'changed',
    'operation', 'create_group',
    'organization_id', '22200000-0000-4000-8000-000000000001'::uuid,
    'group_id', '32200000-0000-4000-8000-000000000001'::uuid,
    'group_key', 'review_group',
    'label', 'Review Group',
    'state', 'active',
    'revision', 1,
    'created_by_actor_id', '92200000-0000-4000-8000-000000000002'::uuid,
    'changed_by_actor_id', '92200000-0000-4000-8000-000000000002'::uuid,
    'change_correlation_id', '72200000-0000-4000-8000-000000000004'::uuid,
    'access_version', 2,
    'correlation_id', '72200000-0000-4000-8000-000000000004'::uuid
  ),
  'creation returns the exact revision-one Group and one Access increment'
);

select is(
  (select created_at = changed_at from created_group),
  true,
  'creation and current change evidence share one database observation time'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', current_version, changed_by, change_correlation_id, change_reason
    )
    from vortex_access.organization_access_versions
    where organization_id = '22200000-0000-4000-8000-000000000001'
  ),
  '2|92200000-0000-4000-8000-000000000002|72200000-0000-4000-8000-000000000004|team_membership_changed',
  'creation records the exact legacy-compatible Group Access reason and evidence'
);

select is(
  (
    select pg_catalog.to_jsonb(organization_group.*)
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id =
      '22200000-0000-4000-8000-000000000001'
      and organization_group.group_id =
        '32200000-0000-4000-8000-000000000001'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'organization_id', result.organization_id,
      'group_id', result.group_id,
      'group_key', result.group_key,
      'label', result.label,
      'state', result.state,
      'revision', result.revision,
      'created_by', result.created_by_actor_id,
      'created_at', result.created_at,
      'changed_by', result.changed_by_actor_id,
      'changed_at', result.changed_at,
      'change_correlation_id', result.change_correlation_id
    )
    from created_group as result
  ),
  'creation returns the actual complete stored Group row'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group',
  '22200000-0000-4000-8000-000000000002',
  '32200000-0000-4000-8000-000000000001',
  null, 'review_group', 'Review Group',
  '92200000-0000-4000-8000-000000000002',
  '72200000-0000-4000-8000-000000000005'
);

select results_eq(
  $$
    select organization_id, group_id, group_key, label, revision
    from vortex_access.organization_groups
    where group_id = '32200000-0000-4000-8000-000000000001'
    order by organization_id
  $$,
  $$ values
    (
      '22200000-0000-4000-8000-000000000001'::uuid,
      '32200000-0000-4000-8000-000000000001'::uuid,
      'review_group'::text, 'Review Group'::text, 1::bigint
    ),
    (
      '22200000-0000-4000-8000-000000000002'::uuid,
      '32200000-0000-4000-8000-000000000001'::uuid,
      'review_group'::text, 'Review Group'::text, 1::bigint
    )
  $$,
  'matching Group identities, keys and labels remain organization-scoped'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group',
  '22200000-0000-4000-8000-000000000002',
  '32200000-0000-4000-8000-000000000004',
  null, 'foreign_group', 'Foreign Group',
  '92200000-0000-4000-8000-000000000002',
  '72200000-0000-4000-8000-000000000031'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000004', 1, null,
    'Cross-scope Group', '92200000-0000-4000-8000-000000000002',
    '72200000-0000-4000-8000-000000000032') $$,
  '40001'::char(5), null,
  'a Group visible only in another organization cannot be revised'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000001', null,
    'other_group', 'Other Group',
    '92200000-0000-4000-8000-000000000002',
    '72200000-0000-4000-8000-000000000006') $$,
  '40001'::char(5), null,
  'a duplicate same-organization Group identity is stale'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000002', null,
    'review_group', 'Duplicate key Group',
    '92200000-0000-4000-8000-000000000002',
    '72200000-0000-4000-8000-000000000007') $$,
  '23505'::char(5), null,
  'the existing same-organization Group key uniqueness remains authoritative'
);

create temporary table revised_group on commit drop as
select * from vortex_access.coordinate_organization_group_change(
  'revise_group_label',
  '22200000-0000-4000-8000-000000000001',
  '32200000-0000-4000-8000-000000000001',
  1, null, 'Renamed Group',
  '92200000-0000-4000-8000-000000000003',
  '72200000-0000-4000-8000-000000000008'
);

select is(
  (
    select pg_catalog.to_jsonb(result.*) - array['created_at', 'changed_at']
    from revised_group as result
  ),
  pg_catalog.jsonb_build_object(
    'outcome', 'changed',
    'operation', 'revise_group_label',
    'organization_id', '22200000-0000-4000-8000-000000000001'::uuid,
    'group_id', '32200000-0000-4000-8000-000000000001'::uuid,
    'group_key', 'review_group',
    'label', 'Renamed Group',
    'state', 'active',
    'revision', 2,
    'created_by_actor_id', '92200000-0000-4000-8000-000000000002'::uuid,
    'changed_by_actor_id', '92200000-0000-4000-8000-000000000003'::uuid,
    'change_correlation_id', '72200000-0000-4000-8000-000000000008'::uuid,
    'access_version', 3,
    'correlation_id', '72200000-0000-4000-8000-000000000008'::uuid
  ),
  'label revision preserves identity and creation evidence and increments once'
);

select cmp_ok(
  (select changed_at from revised_group), '>=',
  (select changed_at from created_group),
  'label revision keeps Group change time nondecreasing'
);

select is(
  (
    select label
    from vortex_access.organization_groups
    where organization_id = '22200000-0000-4000-8000-000000000002'
      and group_id = '32200000-0000-4000-8000-000000000001'
  ),
  'Review Group',
  'renaming one organization Group does not change its foreign counterpart'
);

create temporary table stable_group_state on commit drop as
select pg_catalog.jsonb_build_object(
  'group', (
    select pg_catalog.to_jsonb(organization_group.*)
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id =
      '22200000-0000-4000-8000-000000000001'
      and organization_group.group_id =
        '32200000-0000-4000-8000-000000000001'
  ),
  'access', (
    select pg_catalog.to_jsonb(version.*)
    from vortex_access.organization_access_versions as version
    where version.organization_id =
      '22200000-0000-4000-8000-000000000001'
  )
) as snapshot;

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000001', 2, null,
    'Renamed Group', '92200000-0000-4000-8000-000000000003',
    '72200000-0000-4000-8000-000000000009') $$,
  '40001'::char(5), null,
  'an unchanged Group label is not a successful replay'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000001', 1, null,
    'Stale label', '92200000-0000-4000-8000-000000000003',
    '72200000-0000-4000-8000-000000000010') $$,
  '40001'::char(5), null,
  'a stale Group revision is refused'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'group', (
        select pg_catalog.to_jsonb(organization_group.*)
        from vortex_access.organization_groups as organization_group
        where organization_group.organization_id =
          '22200000-0000-4000-8000-000000000001'
          and organization_group.group_id =
            '32200000-0000-4000-8000-000000000001'
      ),
      'access', (
        select pg_catalog.to_jsonb(version.*)
        from vortex_access.organization_access_versions as version
        where version.organization_id =
          '22200000-0000-4000-8000-000000000001'
      )
    )
  ),
  (select snapshot from stable_group_state),
  'unchanged and stale changes preserve the complete Group and Access rows'
);

-- These controlled rows are preservation sentinels. C2 independently proves
-- their insertion validators; this slice proves Group retirement never rewrites
-- related protected facts.
select * from vortex_access.coordinate_organization_group_change(
  'create_group',
  '22200000-0000-4000-8000-000000000001',
  '32200000-0000-4000-8000-000000000003',
  null, 'retirement_group', 'Retirement Group',
  '92200000-0000-4000-8000-000000000002',
  '72200000-0000-4000-8000-000000000011'
);

set local session_replication_role = replica;
insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '22200000-0000-4000-8000-000000000001',
  '33200000-0000-4000-8000-000000000001',
  '32200000-0000-4000-8000-000000000003',
  '52200000-0000-4000-8000-000000000001', 1,
  pg_catalog.statement_timestamp(), null, 'live',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000012',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000012'
);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision, starts_at,
  expires_at, state, granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id
) values (
  '22200000-0000-4000-8000-000000000001',
  '63200000-0000-4000-8000-000000000001',
  '62200000-0000-4000-8000-000000000001', 'group', null,
  '32200000-0000-4000-8000-000000000003', 'eligible', 1,
  pg_catalog.statement_timestamp(), null, 'live',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000013',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000013'
);
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
  '22200000-0000-4000-8000-000000000001',
  '64200000-0000-4000-8000-000000000001',
  '52200000-0000-4000-8000-000000000001',
  '62200000-0000-4000-8000-000000000001', 1, 1, 1, 1,
  '65200000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('a', 64), 'group',
  '63200000-0000-4000-8000-000000000001', 1,
  '33200000-0000-4000-8000-000000000001', 1, 'live',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp() + interval '30 minutes',
  '72200000-0000-4000-8000-000000000014',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000014'
);
insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
  granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
) values (
  '22200000-0000-4000-8000-000000000001',
  '66200000-0000-4000-8000-000000000001', 'group', null,
  '32200000-0000-4000-8000-000000000003', 'organization_catalogue',
  null, null, 1, pg_catalog.statement_timestamp(), null, 'live',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000015',
  '92200000-0000-4000-8000-000000000002',
  pg_catalog.statement_timestamp(),
  '72200000-0000-4000-8000-000000000015'
);
set local session_replication_role = origin;

create temporary table related_facts_before on commit drop as
select pg_catalog.jsonb_build_object(
  'membership', (
    select pg_catalog.to_jsonb(membership.*)
    from vortex_access.organization_group_memberships as membership
    where membership.organization_id =
      '22200000-0000-4000-8000-000000000001'
      and membership.membership_id =
        '33200000-0000-4000-8000-000000000001'
  ),
  'assignment', (
    select pg_catalog.to_jsonb(assignment.*)
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id =
      '22200000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id =
        '63200000-0000-4000-8000-000000000001'
  ),
  'activation', (
    select pg_catalog.to_jsonb(activation.*)
    from vortex_access.organization_role_activations as activation
    where activation.organization_id =
      '22200000-0000-4000-8000-000000000001'
      and activation.role_activation_id =
        '64200000-0000-4000-8000-000000000001'
  ),
  'delegation', (
    select pg_catalog.to_jsonb(delegation.*)
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id =
      '22200000-0000-4000-8000-000000000001'
      and delegation.delegation_authority_id =
        '66200000-0000-4000-8000-000000000001'
  )
) as snapshot;

create temporary table retired_group on commit drop as
select * from vortex_access.coordinate_organization_group_change(
  'retire_group',
  '22200000-0000-4000-8000-000000000001',
  '32200000-0000-4000-8000-000000000003',
  1, null, null,
  '92200000-0000-4000-8000-000000000004',
  '72200000-0000-4000-8000-000000000016'
);

select is(
  (
    select pg_catalog.to_jsonb(result.*) - array['created_at', 'changed_at']
    from retired_group as result
  ),
  pg_catalog.jsonb_build_object(
    'outcome', 'changed',
    'operation', 'retire_group',
    'organization_id', '22200000-0000-4000-8000-000000000001'::uuid,
    'group_id', '32200000-0000-4000-8000-000000000003'::uuid,
    'group_key', 'retirement_group',
    'label', 'Retirement Group',
    'state', 'retired',
    'revision', 2,
    'created_by_actor_id', '92200000-0000-4000-8000-000000000002'::uuid,
    'changed_by_actor_id', '92200000-0000-4000-8000-000000000004'::uuid,
    'change_correlation_id', '72200000-0000-4000-8000-000000000016'::uuid,
    'access_version', 5,
    'correlation_id', '72200000-0000-4000-8000-000000000016'::uuid
  ),
  'retirement returns one exact terminal successor and Access increment'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'membership', (
        select pg_catalog.to_jsonb(membership.*)
        from vortex_access.organization_group_memberships as membership
        where membership.organization_id =
          '22200000-0000-4000-8000-000000000001'
          and membership.membership_id =
            '33200000-0000-4000-8000-000000000001'
      ),
      'assignment', (
        select pg_catalog.to_jsonb(assignment.*)
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id =
          '22200000-0000-4000-8000-000000000001'
          and assignment.role_assignment_id =
            '63200000-0000-4000-8000-000000000001'
      ),
      'activation', (
        select pg_catalog.to_jsonb(activation.*)
        from vortex_access.organization_role_activations as activation
        where activation.organization_id =
          '22200000-0000-4000-8000-000000000001'
          and activation.role_activation_id =
            '64200000-0000-4000-8000-000000000001'
      ),
      'delegation', (
        select pg_catalog.to_jsonb(delegation.*)
        from vortex_access.organization_delegation_authorities as delegation
        where delegation.organization_id =
          '22200000-0000-4000-8000-000000000001'
          and delegation.delegation_authority_id =
            '66200000-0000-4000-8000-000000000001'
      )
    )
  ),
  (select snapshot from related_facts_before),
  'retirement preserves membership, assignment, activation and delegation evidence'
);

select is(
  (
    select revision::text || ':' || state || ':' || group_key || ':' || label
    from vortex_access.organization_groups
    where organization_id = '22200000-0000-4000-8000-000000000001'
      and group_id = '32200000-0000-4000-8000-000000000003'
  ),
  '2:retired:retirement_group:Retirement Group',
  'retirement is one terminal Group successor without metadata loss'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'retire_group', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000003', 2, null, null,
    '92200000-0000-4000-8000-000000000004',
    '72200000-0000-4000-8000-000000000017') $$,
  '40001'::char(5), null,
  'Group retirement cannot be repeated'
);

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000001',
    '32200000-0000-4000-8000-000000000003', 2, null,
    'Restored Group', '92200000-0000-4000-8000-000000000004',
    '72200000-0000-4000-8000-000000000018') $$,
  '40001'::char(5), null,
  'a retired Group cannot be edited or restored'
);

-- Closed branch input validation happens before organization lookup.
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'unknown', '22200000-0000-4000-8000-000000000099',
    '32200000-0000-4000-8000-000000000099', null, null, null,
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000019') $$,
  '22023'::char(5), null, 'unknown Group operations are invalid'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000099',
    '00000000-0000-0000-0000-000000000000', null,
    'review_group', 'Review Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000020') $$,
  '22023'::char(5), null, 'nil Group identity is invalid before scope lookup'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000099',
    '32200000-0000-4000-8000-000000000099', 1,
    'review_group', 'Review Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000021') $$,
  '22023'::char(5), null, 'creation refuses an expected revision'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000099',
    '32200000-0000-4000-8000-000000000099', 1,
    'unexpected_key', 'Review Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000022') $$,
  '22023'::char(5), null, 'label revision refuses a key payload'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'retire_group', '22200000-0000-4000-8000-000000000099',
    '32200000-0000-4000-8000-000000000099', 1, null,
    'Unexpected label', '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000023') $$,
  '22023'::char(5), null, 'retirement refuses a label payload'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000099',
    '32200000-0000-4000-8000-000000000099', 9007199254740992,
    null, 'Review Group', '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000024') $$,
  '22023'::char(5), null, 'unsafe reviewed Group revision is invalid'
);

update vortex_identity.organizations
set state = 'suspended', revision = 2,
  state_changed_at = pg_catalog.clock_timestamp()
where organization_id = '22200000-0000-4000-8000-000000000003';
update vortex_identity.tenants
set state = 'suspended', revision = 2,
  state_changed_at = pg_catalog.clock_timestamp()
where tenant_id = '12200000-0000-4000-8000-000000000002';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000003',
    '32200000-0000-4000-8000-000000000010', null,
    'inactive_org_group', 'Inactive organization Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000025') $$,
  '42501'::char(5), null, 'inactive organization scope is unavailable'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000004',
    '32200000-0000-4000-8000-000000000011', null,
    'inactive_tenant_group', 'Inactive tenant Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000026') $$,
  '42501'::char(5), null, 'inactive tenant scope is unavailable'
);
select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'create_group', '22200000-0000-4000-8000-000000000005',
    '32200000-0000-4000-8000-000000000012', null,
    'missing_access_group', 'Missing Access Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000027') $$,
  '42501'::char(5), null, 'missing governance state is unavailable'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group', '22200000-0000-4000-8000-000000000006',
  '32200000-0000-4000-8000-000000000013', null,
  'exhaustion_group', 'Exhaustion Group',
  '92200000-0000-4000-8000-000000000001',
  '72200000-0000-4000-8000-000000000028'
);

set local session_replication_role = replica;
update vortex_access.organization_groups
set revision = 9007199254740991
where organization_id = '22200000-0000-4000-8000-000000000006'
  and group_id = '32200000-0000-4000-8000-000000000013';
set local session_replication_role = origin;

create temporary table group_exhaustion_before on commit drop as
select pg_catalog.jsonb_build_object(
  'group', pg_catalog.to_jsonb(organization_group.*),
  'access', pg_catalog.to_jsonb(version.*)
) as snapshot
from vortex_access.organization_groups as organization_group
join vortex_access.organization_access_versions as version
  on version.organization_id = organization_group.organization_id
where organization_group.organization_id =
  '22200000-0000-4000-8000-000000000006'
  and organization_group.group_id =
    '32200000-0000-4000-8000-000000000013';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000006',
    '32200000-0000-4000-8000-000000000013', 9007199254740991,
    null, 'Exhausted Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000029') $$,
  '22003'::char(5), 'Organization Group revision is exhausted',
  'Group revision exhaustion is explicit'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'group', pg_catalog.to_jsonb(organization_group.*),
      'access', pg_catalog.to_jsonb(version.*)
    )
    from vortex_access.organization_groups as organization_group
    join vortex_access.organization_access_versions as version
      on version.organization_id = organization_group.organization_id
    where organization_group.organization_id =
      '22200000-0000-4000-8000-000000000006'
      and organization_group.group_id =
        '32200000-0000-4000-8000-000000000013'
  ),
  (select snapshot from group_exhaustion_before),
  'Group revision exhaustion preserves Group and Access state'
);

set local session_replication_role = replica;
update vortex_access.organization_groups
set revision = 1
where organization_id = '22200000-0000-4000-8000-000000000006'
  and group_id = '32200000-0000-4000-8000-000000000013';
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '22200000-0000-4000-8000-000000000006';
set local session_replication_role = origin;

create temporary table access_exhaustion_before on commit drop as
select pg_catalog.jsonb_build_object(
  'group', pg_catalog.to_jsonb(organization_group.*),
  'access', pg_catalog.to_jsonb(version.*)
) as snapshot
from vortex_access.organization_groups as organization_group
join vortex_access.organization_access_versions as version
  on version.organization_id = organization_group.organization_id
where organization_group.organization_id =
  '22200000-0000-4000-8000-000000000006'
  and organization_group.group_id =
    '32200000-0000-4000-8000-000000000013';

select throws_ok(
  $$ select * from vortex_access.coordinate_organization_group_change(
    'revise_group_label', '22200000-0000-4000-8000-000000000006',
    '32200000-0000-4000-8000-000000000013', 1, null,
    'Access exhausted Group',
    '92200000-0000-4000-8000-000000000001',
    '72200000-0000-4000-8000-000000000030') $$,
  '22003'::char(5), 'Access version is exhausted',
  'Access exhaustion refuses the complete Group change'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'group', pg_catalog.to_jsonb(organization_group.*),
      'access', pg_catalog.to_jsonb(version.*)
    )
    from vortex_access.organization_groups as organization_group
    join vortex_access.organization_access_versions as version
      on version.organization_id = organization_group.organization_id
    where organization_group.organization_id =
      '22200000-0000-4000-8000-000000000006'
      and organization_group.group_id =
        '32200000-0000-4000-8000-000000000013'
  ),
  (select snapshot from access_exhaustion_before),
  'Access exhaustion rolls back Group and preserves the complete before-state'
);

set constraints all immediate;

select * from finish();

rollback;
