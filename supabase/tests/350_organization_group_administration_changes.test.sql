\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_group_change_context(
  p_identity_id uuid,
  p_organization_account_id uuid,
  p_correlation_id uuid
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
  perform pg_catalog.set_config('vortex.request_context', '', true);
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '23500000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83500000-0000-4000-8000-000000000001',
    'tenantId', '13500000-0000-4000-8000-000000000001',
    'organizationId', '23500000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '63500000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', p_correlation_id
  ));
end
$function$;

select has_function(
  'vortex_access', 'create_organization_group_for_administration',
  array['uuid', 'text', 'text', 'uuid'],
  'Access exposes one protected empty-Group creation operation'
);
select has_function(
  'vortex_access', 'rename_organization_group_for_administration',
  array['uuid', 'bigint', 'text', 'uuid'],
  'Access exposes one protected Group label-revision operation'
);

select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', procedure_row.proname,
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid in (
      'vortex_access.create_organization_group_for_administration(uuid,text,text,uuid)'::regprocedure,
      'vortex_access.rename_organization_group_for_administration(uuid,bigint,text,uuid)'::regprocedure
    )
  ),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'name', 'create_organization_group_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'rename_organization_group_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    )
  ),
  'both Group changes are narrow owner-held protected compositions'
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.create_organization_group_for_administration(uuid,text,text,uuid)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.rename_organization_group_for_administration(uuid,bigint,text,uuid)',
    'EXECUTE'
  ),
  'request role can execute both protected Group metadata changes'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.create_organization_group_for_administration(uuid,text,text,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.rename_organization_group_for_administration(uuid,bigint,text,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute protected Group metadata changes'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.coordinate_organization_group_change(text,uuid,uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_activity.append_organization_activity_entry(uuid,uuid,timestamptz,text,uuid,text,uuid[],uuid[],text,uuid,text)',
    'EXECUTE'
  ),
  'request role cannot bypass either protected composition'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13500000-0000-4000-8000-000000000001', 'group_admin_changes',
  'Group administration changes', 'active', pg_catalog.clock_timestamp(),
  '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23500000-0000-4000-8000-000000000001',
    '13500000-0000-4000-8000-000000000001', 'group_admin_changes',
    'Group administration changes', 'active', pg_catalog.clock_timestamp(),
    '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  ),
  (
    '23500000-0000-4000-8000-000000000002',
    '13500000-0000-4000-8000-000000000001', 'group_admin_foreign',
    'Foreign Group administration', 'active', pg_catalog.clock_timestamp(),
    '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43500000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93500000-0000-4000-8000-000000000001',
    'a3500000-0000-4000-8000-000000000001', 1
  ),
  (
    '43500000-0000-4000-8000-000000000002', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '93500000-0000-4000-8000-000000000001',
    'a3500000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '53500000-0000-4000-8000-000000000001',
    '23500000-0000-4000-8000-000000000001',
    '43500000-0000-4000-8000-000000000001', 'Group administrator', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93500000-0000-4000-8000-000000000001',
    'a3500000-0000-4000-8000-000000000003', 1
  ),
  (
    '53500000-0000-4000-8000-000000000002',
    '23500000-0000-4000-8000-000000000001',
    '43500000-0000-4000-8000-000000000002', 'No Group authority', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '93500000-0000-4000-8000-000000000001',
    'a3500000-0000-4000-8000-000000000004', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '23500000-0000-4000-8000-000000000001',
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000005'
);
select * from vortex_access.initialize_organization_access_version(
  '23500000-0000-4000-8000-000000000002',
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '23500000-0000-4000-8000-000000000001',
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000007'
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
where entry.organization_id = '23500000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '23500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  '63500000-0000-4000-8000-000000000001',
  'group_administration_steward', 'Group administration steward',
  'Minimum neutral authority for protected Group metadata changes.',
  '73500000-0000-4000-8000-000000000001',
  '83500000-0000-4000-8000-000000000001',
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000008'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group', '23500000-0000-4000-8000-000000000002',
  '63500000-0000-4000-8000-000000000099', null,
  'foreign_group', 'Foreign group',
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000009'
);

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_request;
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000010'
);
set local role vortex_request;
select results_eq(
  $$
    select organization_id, group_summary, access_version
    from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010',
      'review_group', 'Review group',
      'b3500000-0000-4000-8000-000000000010'
    )
  $$,
  $$values (
    '23500000-0000-4000-8000-000000000001'::uuid,
    '{"key": "review_group", "label": "Review group", "state": "active", "groupId": "63500000-0000-4000-8000-000000000010", "revision": 1}'::jsonb,
    4::bigint
  )$$,
  'an authorized request creates one empty Group and increments Access once'
);
reset role;

select is(
  (
    select pg_catalog.count(*)::text || '|' ||
      activity.action || '|' || activity.actor_kind || '|' ||
      activity.actor_id::text || '|' || activity.subject_ids::text || '|' ||
      activity.changed_field_ids::text || '|' || activity.source || '|' ||
      activity.correlation_id::text || '|' || activity.outcome || '|' ||
      (activity.occurred_at = organization_group.changed_at)::text
    from vortex_access.organization_groups as organization_group
    join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = organization_group.organization_id
      and activity.activity_id = 'b3500000-0000-4000-8000-000000000010'
    where organization_group.organization_id =
      '23500000-0000-4000-8000-000000000001'
      and organization_group.group_id =
        '63500000-0000-4000-8000-000000000010'
    group by activity.action, activity.actor_kind, activity.actor_id,
      activity.subject_ids, activity.changed_field_ids, activity.source,
      activity.correlation_id, activity.outcome, activity.occurred_at,
      organization_group.changed_at
  ),
  '1|create_group|organization_account|53500000-0000-4000-8000-000000000001|{63500000-0000-4000-8000-000000000010}|{}|web|a3500000-0000-4000-8000-000000000010|completed|true',
  'creation records exactly one bound content-free Activity entry'
);

select is(
  (
    select pg_catalog.count(*)
    from (
      select membership.membership_id
      from vortex_access.organization_group_memberships as membership
      where membership.organization_id = '23500000-0000-4000-8000-000000000001'
        and membership.group_id = '63500000-0000-4000-8000-000000000010'
      union all
      select assignment.role_assignment_id
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = '23500000-0000-4000-8000-000000000001'
        and assignment.group_id = '63500000-0000-4000-8000-000000000010'
      union all
      select delegation.delegation_authority_id
      from vortex_access.organization_delegation_authorities as delegation
      where delegation.organization_id = '23500000-0000-4000-8000-000000000001'
        and delegation.group_id = '63500000-0000-4000-8000-000000000010'
    ) as affected
  ),
  0::bigint,
  'empty Group creation invents no membership, role assignment or delegation'
);

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000011'
);
set local role vortex_request;
select results_eq(
  $$
    select group_summary, access_version
    from vortex_access.rename_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010', 1,
      'Review group renamed',
      'b3500000-0000-4000-8000-000000000011'
    )
  $$,
  $$values (
    '{"key": "review_group", "label": "Review group renamed", "state": "active", "groupId": "63500000-0000-4000-8000-000000000010", "revision": 2}'::jsonb,
    5::bigint
  )$$,
  'an authorized request revises only the reviewed Group label'
);
reset role;

select is(
  (
    select organization_group.group_key || '|' || organization_group.label || '|' ||
      organization_group.state || '|' || organization_group.revision::text || '|' ||
      activity.action || '|' || activity.correlation_id::text || '|' ||
      (activity.occurred_at = organization_group.changed_at)::text
    from vortex_access.organization_groups as organization_group
    join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = organization_group.organization_id
      and activity.activity_id = 'b3500000-0000-4000-8000-000000000011'
    where organization_group.organization_id =
      '23500000-0000-4000-8000-000000000001'
      and organization_group.group_id =
        '63500000-0000-4000-8000-000000000010'
  ),
  'review_group|Review group renamed|active|2|revise_group_label|a3500000-0000-4000-8000-000000000011|true',
  'rename preserves the permanent key and records its exact Activity evidence'
);

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000002',
  '53500000-0000-4000-8000-000000000002',
  'a3500000-0000-4000-8000-000000000012'
);
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000012',
      'unauthorized_group', 'Unauthorized group',
      'b3500000-0000-4000-8000-000000000012'
    )
  $$,
  '42501'::char(5),
  'Organization Group creation is unavailable',
  'an active account without teams-manage authority cannot create a Group'
);
reset role;

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000013'
);
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.rename_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010', 1,
      'Stale rename', 'b3500000-0000-4000-8000-000000000013'
    )
  $$,
  '40001'::char(5),
  'Organization Group change is stale or unavailable',
  'a stale reviewed Group revision refuses'
);
select throws_ok(
  $$
    select * from vortex_access.rename_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000099', 1,
      'Foreign rename', 'b3500000-0000-4000-8000-000000000014'
    )
  $$,
  '40001'::char(5),
  'Organization Group change is stale or unavailable',
  'a Group belonging to another organization is unavailable'
);
select throws_ok(
  $$
    select * from vortex_access.rename_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010', 2,
      'Review group renamed', 'b3500000-0000-4000-8000-000000000015'
    )
  $$,
  '40001'::char(5),
  'Organization Group label is unchanged',
  'an unchanged label refuses without another mutation'
);
reset role;

select is(
  (
    select version.current_version::text || '|' || organization_group.revision::text || '|' ||
      organization_group.label || '|' || pg_catalog.count(activity.activity_id)::text
    from vortex_access.organization_access_versions as version
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = version.organization_id
      and organization_group.group_id = '63500000-0000-4000-8000-000000000010'
    left join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = version.organization_id
    where version.organization_id = '23500000-0000-4000-8000-000000000001'
    group by version.current_version, organization_group.revision,
      organization_group.label
  ),
  '5|2|Review group renamed|2',
  'permission, stale, foreign and unchanged refusals leave Group, Access and Activity exact'
);

select vortex_activity.append_organization_activity_entry(
  '23500000-0000-4000-8000-000000000001',
  'b3500000-0000-4000-8000-000000000020',
  pg_catalog.clock_timestamp(), 'organization_account',
  '53500000-0000-4000-8000-000000000001', 'conflicting_activity',
  array['63500000-0000-4000-8000-000000000020'::uuid], array[]::uuid[],
  'web', 'a3500000-0000-4000-8000-000000000020', 'completed'
);
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000020'
);
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000020',
      'rolled_back_group', 'Rolled back group',
      'b3500000-0000-4000-8000-000000000020'
    )
  $$,
  '22023'::char(5),
  'Activity identity already records different evidence',
  'Activity failure rolls back the Group and Access mutations'
);
reset role;

select is(
  (
    select version.current_version::text || '|' ||
      pg_catalog.count(organization_group.group_id)::text || '|' ||
      pg_catalog.count(activity.activity_id)::text
    from vortex_access.organization_access_versions as version
    left join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = version.organization_id
      and organization_group.group_id = '63500000-0000-4000-8000-000000000020'
    left join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = version.organization_id
      and activity.activity_id = 'b3500000-0000-4000-8000-000000000020'
    where version.organization_id = '23500000-0000-4000-8000-000000000001'
    group by version.current_version
  ),
  '5|0|1',
  'the failed Activity composition leaves only its pre-existing fixture row'
);

set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.create_organization_group_for_administration(
      null, 'invalid_group', 'Invalid group',
      'b3500000-0000-4000-8000-000000000030'
    )
  $$,
  '22023'::char(5),
  'Organization Group creation input is invalid',
  'malformed protected creation input refuses before authority evaluation'
);
reset role;

set constraints all immediate;

select * from finish();

rollback;
