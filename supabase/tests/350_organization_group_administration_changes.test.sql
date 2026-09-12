\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_group_change_context(
  p_identity_id uuid,
  p_organization_account_id uuid,
  p_correlation_id uuid,
  p_delegated boolean default false
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  current_access_version bigint;
  candidate jsonb;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '23500000-0000-4000-8000-000000000001';

  candidate := pg_catalog.jsonb_build_object(
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
  );
  if p_delegated then
    candidate := candidate || pg_catalog.jsonb_build_object(
      'delegatedContext', pg_catalog.jsonb_build_object(
        'delegatedByOrganizationAccountId',
          '53500000-0000-4000-8000-000000000001',
        'reason', 'Neutral Group-administration exclusion fixture.',
        'expiresAt', operation_at + interval '10 minutes'
      )
    );
  end if;
  perform vortex_context.initialize(candidate);
end
$function$;

create function pg_temp.current_platform_permissions(
  p_organization_id uuid,
  p_count integer
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(candidate.permission order by candidate.ordinality)
  from (
    select pg_catalog.jsonb_build_object(
      'kind', 'exact', 'ownerKind', entry.owner_kind,
      'ownerId', entry.owner_id, 'permissionId', entry.permission_id,
      'acceptedRegistrationRevision', entry.registration_revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', entry.meaning_fingerprint
    ) as permission,
    pg_catalog.row_number() over (
      order by entry.application_root_id asc nulls last,
        entry.owner_kind collate "C", entry.owner_id, entry.permission_id
    ) as ordinality
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = entry.organization_id
      and continuity.application_root_id is not distinct from entry.application_root_id
      and continuity.owner_kind = entry.owner_kind and continuity.owner_id = entry.owner_id
      and continuity.permission_id = entry.permission_id and continuity.state = 'available'
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
    order by entry.application_root_id asc nulls last,
      entry.owner_kind collate "C", entry.owner_id, entry.permission_id
    limit p_count
  ) as candidate;
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

set local session_replication_role = replica;
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
) values (
  '23500000-0000-4000-8000-000000000002',
  '63500000-0000-4000-8000-000000000098', 'custom', 'foreign_assignment_role', 1,
  '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp()
);
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description, changed_by,
  changed_at, change_correlation_id
) values (
  '23500000-0000-4000-8000-000000000002',
  '63500000-0000-4000-8000-000000000098', 1, 'custom', 'active',
  'standard', 'standing', 1, 1, 'foreign_assignment_role',
  'Foreign assignment role', 'Real cross-organization assignment target.',
  '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3500000-0000-4000-8000-000000000071'
);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision, starts_at,
  expires_at, state, granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id
) values (
  '23500000-0000-4000-8000-000000000002',
  '73500000-0000-4000-8000-000000000099',
  '63500000-0000-4000-8000-000000000098', 'group', null,
  '63500000-0000-4000-8000-000000000099', 'standing', 1,
  pg_catalog.clock_timestamp(), null, 'live',
  '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3500000-0000-4000-8000-000000000072',
  '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a3500000-0000-4000-8000-000000000072'
);
set local session_replication_role = origin;

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
    select outcome, organization_id, group_summary, access_version
    from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010',
      'review_group', 'Review group',
      'b3500000-0000-4000-8000-000000000010'
    )
  $$,
  $$values (
    'completed'::text,
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
    select outcome, group_summary, access_version
    from vortex_access.rename_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010', 1,
      'Review group renamed',
      'b3500000-0000-4000-8000-000000000011'
    )
  $$,
  $$values (
    'completed'::text,
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
select results_eq(
  $$
    select outcome, organization_id, group_summary, access_version
    from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000012',
      'unauthorized_group', 'Unauthorized group',
      'b3500000-0000-4000-8000-000000000012'
    )
  $$,
  $$values (
    'refused'::text,
    '23500000-0000-4000-8000-000000000001'::uuid,
    null::jsonb,
    5::bigint
  )$$,
  'an active account without teams-manage authority receives one clean creation refusal'
);
select results_eq(
  $$
    select outcome, organization_id, group_summary, access_version
    from vortex_access.rename_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000010', 2,
      'Refused rename',
      'b3500000-0000-4000-8000-000000000016'
    )
  $$,
  $$values (
    'refused'::text,
    '23500000-0000-4000-8000-000000000001'::uuid,
    null::jsonb,
    5::bigint
  )$$,
  'an active account without teams-manage authority receives one clean rename refusal'
);
reset role;

select is(
  (
    select pg_catalog.string_agg(
      activity.activity_id::text || '|' || activity.action || '|' ||
      activity.actor_kind || '|' || activity.actor_id::text || '|' ||
      activity.subject_ids::text || '|' || activity.changed_field_ids::text || '|' ||
      activity.source || '|' || activity.correlation_id::text || '|' ||
      activity.outcome || '|' ||
      (activity.occurred_at not in (
        '-infinity'::timestamptz, 'infinity'::timestamptz
      ))::text,
      ',' order by activity.activity_id
    )
    from vortex_activity.organization_activity_entries as activity
    where activity.organization_id = '23500000-0000-4000-8000-000000000001'
      and activity.activity_id in (
        'b3500000-0000-4000-8000-000000000012',
        'b3500000-0000-4000-8000-000000000016'
      )
  ),
  'b3500000-0000-4000-8000-000000000012|create_group|organization_account|53500000-0000-4000-8000-000000000002|{23500000-0000-4000-8000-000000000001}|{}|web|a3500000-0000-4000-8000-000000000012|refused|true,' ||
  'b3500000-0000-4000-8000-000000000016|revise_group_label|organization_account|53500000-0000-4000-8000-000000000002|{23500000-0000-4000-8000-000000000001}|{}|web|a3500000-0000-4000-8000-000000000012|refused|true',
  'clean Group refusals commit one fixed content-free entry for local organization scope'
);

select is(
  (
    select version.current_version::text || '|' ||
      pg_catalog.count(unauthorized_group.group_id)::text || '|' ||
      reviewed_group.revision::text || '|' || reviewed_group.label
    from vortex_access.organization_access_versions as version
    left join vortex_access.organization_groups as unauthorized_group
      on unauthorized_group.organization_id = version.organization_id
      and unauthorized_group.group_id = '63500000-0000-4000-8000-000000000012'
    join vortex_access.organization_groups as reviewed_group
      on reviewed_group.organization_id = version.organization_id
      and reviewed_group.group_id = '63500000-0000-4000-8000-000000000010'
    where version.organization_id = '23500000-0000-4000-8000-000000000001'
    group by version.current_version, reviewed_group.revision, reviewed_group.label
  ),
  '5|0|2|Review group renamed',
  'refused Group changes leave business state and Access version unchanged'
);

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
  '5|2|Review group renamed|4',
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

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000031',
  true
);
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000031',
      'delegated_group', 'Delegated group',
      'b3500000-0000-4000-8000-000000000031'
    )
  $$,
  '42501'::char(5),
  'Organization Group creation is unavailable',
  'an excluded delegated context keeps target-policy refusal outside Activity'
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
      and organization_group.group_id = '63500000-0000-4000-8000-000000000031'
    left join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = version.organization_id
      and activity.activity_id = 'b3500000-0000-4000-8000-000000000031'
    where version.organization_id = '23500000-0000-4000-8000-000000000001'
    group by version.current_version
  ),
  '5|0|0',
  'target-policy refusal leaves Group, Access version and Activity unchanged'
);

select vortex_activity.append_organization_activity_entry(
  '23500000-0000-4000-8000-000000000001',
  'b3500000-0000-4000-8000-000000000032',
  pg_catalog.clock_timestamp(), 'organization_account',
  '53500000-0000-4000-8000-000000000002', 'conflicting_activity',
  array['23500000-0000-4000-8000-000000000001'::uuid], array[]::uuid[],
  'web', 'a3500000-0000-4000-8000-000000000032', 'completed'
);
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000002',
  '53500000-0000-4000-8000-000000000002',
  'a3500000-0000-4000-8000-000000000032'
);
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.create_organization_group_for_administration(
      '63500000-0000-4000-8000-000000000032',
      'refusal_conflict_group', 'Refusal conflict group',
      'b3500000-0000-4000-8000-000000000032'
    )
  $$,
  '22023'::char(5),
  'Activity identity already records different evidence',
  'a conflicting refusal Activity aborts the refused Group request'
);
reset role;

select is(
  (
    select version.current_version::text || '|' ||
      pg_catalog.count(organization_group.group_id)::text || '|' ||
      pg_catalog.count(activity.activity_id)::text || '|' ||
      pg_catalog.min(activity.action)
    from vortex_access.organization_access_versions as version
    left join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = version.organization_id
      and organization_group.group_id = '63500000-0000-4000-8000-000000000032'
    left join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = version.organization_id
      and activity.activity_id = 'b3500000-0000-4000-8000-000000000032'
    where version.organization_id = '23500000-0000-4000-8000-000000000001'
    group by version.current_version
  ),
  '5|0|1|conflicting_activity',
  'refusal Activity conflict leaves no Group or Access mutation and preserves its fixture'
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

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23500000-0000-4000-8000-000000000001',
  '73500000-0000-4000-8000-000000000010', null,
  '63500000-0000-4000-8000-000000000001', 1,
  'organization_account', '53500000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000040'
);

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000041'
);
set local role vortex_request;
select results_eq(
  $$
    select organization_id, assignment_summary ->> 'state', access_version
    from vortex_access.revoke_organization_role_assignment_for_administration(
      '73500000-0000-4000-8000-000000000010', 1,
      'b3500000-0000-4000-8000-000000000041'
    )
  $$,
  $$values (
    '23500000-0000-4000-8000-000000000001'::uuid, 'revoked'::text, 7::bigint
  )$$,
  'an assignments manager with catalogue delegation revokes one exact assignment'
);
reset role;

select is(
  (
    select assignment.revision::text || '|' || assignment.state || '|' ||
      activity.action || '|' || (activity.occurred_at = assignment.changed_at)::text
    from vortex_access.organization_role_assignments as assignment
    join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = assignment.organization_id
      and activity.activity_id = 'b3500000-0000-4000-8000-000000000041'
    where assignment.organization_id = '23500000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id = '73500000-0000-4000-8000-000000000010'
  ),
  '2|revoked|revoke_role_assignment|true',
  'assignment, single Access increment and content-free Activity commit together'
);

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000002',
  '53500000-0000-4000-8000-000000000002',
  'a3500000-0000-4000-8000-000000000042'
);
set local role vortex_request;
select results_eq(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000001', 1,
    'b3500000-0000-4000-8000-000000000042')$$,
  $$values (
    'refused'::text, '23500000-0000-4000-8000-000000000001'::uuid,
    null::jsonb, 7::bigint
  )$$,
  'an account without assignment management authority records and returns one clean refusal'
);
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000010', 1,
    'b3500000-0000-4000-8000-000000000043')$$,
  '40001'::char(5), 'Organization role-assignment revocation is stale or unavailable',
  'a stale or already revoked assignment refuses without another change'
);
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000099', 1,
    'b3500000-0000-4000-8000-000000000099')$$,
  '40001'::char(5), 'Organization role-assignment revocation is stale or unavailable',
  'a real foreign assignment is unavailable within the selected organization'
);
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000097', 1,
    'b3500000-0000-4000-8000-000000000097')$$,
  '40001'::char(5), 'Organization role-assignment revocation is stale or unavailable',
  'an unknown assignment is unavailable within the selected organization'
);
reset role;

select is(
  (
    select assignment.state || '|' || assignment.revision::text
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = '23500000-0000-4000-8000-000000000002'
      and assignment.role_assignment_id = '73500000-0000-4000-8000-000000000099'
  ),
  'live|1',
  'the refused cross-organization target remains unchanged'
);

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000044'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000001', 1,
    'b3500000-0000-4000-8000-000000000044')$$,
  '23514'::char(5), 'An adopted organization requires a permanent steward',
  'the protected composition cannot revoke the final permanent steward assignment'
);
reset role;

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23500000-0000-4000-8000-000000000001',
  '73500000-0000-4000-8000-000000000020', null,
  '63500000-0000-4000-8000-000000000001', 1,
  'organization_account', '53500000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000045'
);
select vortex_activity.append_organization_activity_entry(
  '23500000-0000-4000-8000-000000000001',
  'b3500000-0000-4000-8000-000000000045', pg_catalog.clock_timestamp(),
  'organization_account', '53500000-0000-4000-8000-000000000001',
  'conflicting_activity', array['73500000-0000-4000-8000-000000000020'::uuid],
  array[]::uuid[], 'web', 'a3500000-0000-4000-8000-000000000045', 'completed'
);
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000045'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000020', 1,
    'b3500000-0000-4000-8000-000000000045')$$,
  '22023'::char(5), 'Activity identity already records different evidence',
  'Activity collision rolls back assignment revocation and Access increment'
);
reset role;
select is(
  (select assignment.revision::text || '|' || assignment.state || '|' ||
      version.current_version::text
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_access_versions as version
      on version.organization_id = assignment.organization_id
    where assignment.organization_id = '23500000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id = '73500000-0000-4000-8000-000000000020'),
  '1|live|8',
  'failed Activity composition leaves the assignment and Access version unchanged'
);

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation', '23500000-0000-4000-8000-000000000001',
  '83500000-0000-4000-8000-000000000020', null,
  'organization_account', '53500000-0000-4000-8000-000000000002', null,
  'bounded', pg_temp.current_platform_permissions(
    '23500000-0000-4000-8000-000000000001', 1
  ), 'sha256:' || pg_catalog.repeat('f', 64), pg_catalog.clock_timestamp(), null,
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000046'
);
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000002',
  '53500000-0000-4000-8000-000000000002',
  'a3500000-0000-4000-8000-000000000047'
);
set local role vortex_request;
select results_eq(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000020', 1,
    'b3500000-0000-4000-8000-000000000047')$$,
  $$values (
    'refused'::text, '23500000-0000-4000-8000-000000000001'::uuid,
    null::jsonb, 9::bigint
  )$$,
  'a partial bounded delegation records and returns one clean refusal'
);
reset role;

select is(
  (
    select pg_catalog.string_agg(
      activity.activity_id::text || '|' || activity.action || '|' ||
      activity.actor_id::text || '|' || activity.subject_ids::text || '|' ||
      activity.changed_field_ids::text || '|' || activity.source || '|' ||
      activity.correlation_id::text || '|' || activity.outcome,
      ',' order by activity.activity_id
    )
    from vortex_activity.organization_activity_entries as activity
    where activity.organization_id = '23500000-0000-4000-8000-000000000001'
      and activity.activity_id in (
        'b3500000-0000-4000-8000-000000000042',
        'b3500000-0000-4000-8000-000000000047'
      )
  ),
  'b3500000-0000-4000-8000-000000000042|revoke_role_assignment|' ||
    '53500000-0000-4000-8000-000000000002|{23500000-0000-4000-8000-000000000001}|{}|' ||
    'web|a3500000-0000-4000-8000-000000000042|refused,' ||
  'b3500000-0000-4000-8000-000000000047|revoke_role_assignment|' ||
    '53500000-0000-4000-8000-000000000002|{23500000-0000-4000-8000-000000000001}|{}|' ||
    'web|a3500000-0000-4000-8000-000000000047|refused',
  'assignment refusals keep only fixed organization-scoped content-free Activity evidence'
);

set constraints all deferred;
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
) values (
  '23500000-0000-4000-8000-000000000001',
  '63500000-0000-4000-8000-000000000030', 'custom', 'cleanup_role', 1,
  '93500000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp()
);
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description, changed_by,
  changed_at, change_correlation_id
) values (
  '23500000-0000-4000-8000-000000000001',
  '63500000-0000-4000-8000-000000000030', 1, 'custom', 'active',
  'privileged', 'standing', 1, 1, 'cleanup_role', 'Cleanup role',
  'Cleanup-only role fixture.', '93500000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 'a3500000-0000-4000-8000-000000000049'
);
set local session_replication_role = replica;
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select permission.organization_id,
  '63500000-0000-4000-8000-000000000030', permission.role_revision,
  permission.entry_ordinal, 'custom', permission.application_root_id,
  permission.owner_kind, permission.owner_id, permission.permission_id,
  permission.registration_kind, permission.registration_owner_id,
  permission.accepted_registration_revision, permission.catalogue_fingerprint,
  permission.continuity_revision, permission.meaning_fingerprint
from vortex_access.organization_role_permission_entries as permission
where permission.organization_id = '23500000-0000-4000-8000-000000000001'
  and permission.role_id = '63500000-0000-4000-8000-000000000001'
  and permission.role_revision = 1;
set local session_replication_role = origin;
set constraints all immediate;
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23500000-0000-4000-8000-000000000001',
  '73500000-0000-4000-8000-000000000030', null,
  '63500000-0000-4000-8000-000000000030', 1,
  'organization_account', '53500000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '93500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000050'
);
set local session_replication_role = replica;
update vortex_access.organization_role_revisions
set lifecycle = 'retired'
where organization_id = '23500000-0000-4000-8000-000000000001'
  and role_id = '63500000-0000-4000-8000-000000000030' and revision = 1;
update vortex_identity.organization_accounts
set state = 'suspended', suspended_at = pg_catalog.clock_timestamp()
where organization_id = '23500000-0000-4000-8000-000000000001'
  and organization_account_id = '53500000-0000-4000-8000-000000000002';
update vortex_access.organization_role_assignments
set starts_at = pg_catalog.clock_timestamp() - interval '2 hours',
  expires_at = pg_catalog.clock_timestamp() - interval '1 hour'
where organization_id = '23500000-0000-4000-8000-000000000001'
  and role_assignment_id = '73500000-0000-4000-8000-000000000030';
set local session_replication_role = origin;
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000051'
);
set local role vortex_request;
select lives_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000030', 1,
    'b3500000-0000-4000-8000-000000000051')$$,
  'retired-role, expired-window and inactive-subject facts remain removable'
);
reset role;

-- The withdrawal cleanup exception is deliberately narrower than an empty-role
-- fallback. Seed retained assignments while the role is still valid, then prove
-- that only the exact unavailable/current-empty state plus catalogue delegation
-- can remove one.
set local session_replication_role = replica;
update vortex_access.organization_role_revisions
set lifecycle = 'active'
where organization_id = '23500000-0000-4000-8000-000000000001'
  and role_id = '63500000-0000-4000-8000-000000000030' and revision = 1;
update vortex_identity.organization_accounts
set state = 'active', suspended_at = null
where organization_id = '23500000-0000-4000-8000-000000000001'
  and organization_account_id = '53500000-0000-4000-8000-000000000002';
set local session_replication_role = origin;

select assignment_change.*
from (values
  ('73500000-0000-4000-8000-000000000040'::uuid, 'a3500000-0000-4000-8000-000000000060'::uuid),
  ('73500000-0000-4000-8000-000000000041'::uuid, 'a3500000-0000-4000-8000-000000000061'::uuid)
) as candidate(assignment_id, correlation_id)
cross join lateral vortex_access.coordinate_organization_role_assignment_change(
  'grant', '23500000-0000-4000-8000-000000000001', candidate.assignment_id, null,
  '63500000-0000-4000-8000-000000000030', 1,
  'organization_account', '53500000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '93500000-0000-4000-8000-000000000001', candidate.correlation_id
) as assignment_change;

set local session_replication_role = replica;
delete from vortex_access.organization_role_permission_entries
where organization_id = '23500000-0000-4000-8000-000000000001'
  and role_id = '63500000-0000-4000-8000-000000000030' and role_revision = 1;
set local session_replication_role = origin;

select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000065'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000040', 1,
    'b3500000-0000-4000-8000-000000000060')$$,
  '40001'::char(5), 'Organization role-assignment authority is stale or unavailable',
  'an active empty role cannot use the withdrawal cleanup exception'
);
reset role;

set local session_replication_role = replica;
update vortex_access.organization_role_revisions set lifecycle = 'retired'
where organization_id = '23500000-0000-4000-8000-000000000001'
  and role_id = '63500000-0000-4000-8000-000000000030' and revision = 1;
set local session_replication_role = origin;
select pg_temp.install_group_change_context(
  '43500000-0000-4000-8000-000000000001',
  '53500000-0000-4000-8000-000000000001',
  'a3500000-0000-4000-8000-000000000066'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.revoke_organization_role_assignment_for_administration(
    '73500000-0000-4000-8000-000000000041', 1,
    'b3500000-0000-4000-8000-000000000061')$$,
  '40001'::char(5), 'Organization role-assignment authority is stale or unavailable',
  'a retired empty role cannot use the withdrawal cleanup exception'
);
reset role;

set constraints all immediate;

select * from finish();

rollback;
