select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select has_function(
  'vortex_access', 'coordinate_assignment_change_without_stewardship_v1_internal',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'bigint', 'text', 'uuid',
    'uuid', 'text', 'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid'
  ],
  'the private assignment coordinator remains available to its public stewardship composition'
);

select volatility_is(
  'vortex_access', 'coordinate_assignment_change_without_stewardship_v1_internal',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'uuid', 'bigint', 'text', 'uuid',
    'uuid', 'text', 'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid'
  ], 'volatile',
  'the private assignment coordinator remains a volatile atomic writer'
);

select is(
  (
    select prosecdef
    from pg_catalog.pg_proc
    where oid = 'vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure
  ),
  false,
  'the private assignment coordinator remains security invoker'
);

select is(
  (
    select proconfig
    from pg_catalog.pg_proc
    where oid = 'vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure
  ),
  array['search_path=""'],
  'the private assignment coordinator retains an empty fixed search path'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values ('public'::name), ('anon'::name), ('authenticated'::name),
        ('service_role'::name), ('vortex_runtime'::name), ('vortex_request'::name)
    ) as denied(role_name)
    where pg_catalog.has_function_privilege(
      denied.role_name,
      'vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(text,uuid,uuid,bigint,uuid,bigint,text,uuid,uuid,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure,
      'EXECUTE'
    )
  ),
  0,
  'the private assignment coordinator grants no browser, service, runtime or request execution'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11800000-0000-4000-8000-000000000318', 'assignment_audit_time',
  'Assignment audit time', 'active', pg_catalog.clock_timestamp(),
  '91800000-0000-4000-8000-000000000318', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '21800000-0000-4000-8000-000000000318',
  '11800000-0000-4000-8000-000000000318', 'assignment_audit_time',
  'Assignment audit time', 'active', pg_catalog.clock_timestamp(),
  '91800000-0000-4000-8000-000000000318', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '41800000-0000-4000-8000-000000000318', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '91800000-0000-4000-8000-000000000318',
  '71800000-0000-4000-8000-000000000318', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '51800000-0000-4000-8000-000000000318',
  '21800000-0000-4000-8000-000000000318',
  '41800000-0000-4000-8000-000000000318', 'Assignment audit person', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '91800000-0000-4000-8000-000000000318',
  '71800000-0000-4000-8000-000000000319', 1
);

select * from vortex_access.initialize_organization_access_version(
  '21800000-0000-4000-8000-000000000318',
  '91800000-0000-4000-8000-000000000318',
  '71800000-0000-4000-8000-000000000320'
);

select * from vortex_access.initialize_platform_permission_catalogue(
  '21800000-0000-4000-8000-000000000318',
  '91800000-0000-4000-8000-000000000318',
  '71800000-0000-4000-8000-000000000321'
);

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  'available', 1, entry.meaning_fingerprint, entry.registration_revision,
  pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '21800000-0000-4000-8000-000000000318'
  and entry.registration_kind = 'platform'
  and entry.permission_id = '687d5649-62ee-43dd-b684-b8af3a5394c1';

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '21800000-0000-4000-8000-000000000318',
  '61800000-0000-4000-8000-000000000318', 'custom', 'audit_reader', 1,
  '91800000-0000-4000-8000-000000000318', pg_catalog.clock_timestamp()
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select '21800000-0000-4000-8000-000000000318'::uuid,
  '61800000-0000-4000-8000-000000000318'::uuid, 1, 1, 'custom', null,
  entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.registration_kind, entry.registration_owner_id,
  entry.registration_revision, registration.permission_catalogue_fingerprint,
  continuity.continuity_revision, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
join vortex_access.permission_continuities as continuity
  on continuity.organization_id = entry.organization_id
  and continuity.application_root_id is not distinct from entry.application_root_id
  and continuity.owner_kind = entry.owner_kind
  and continuity.owner_id = entry.owner_id
  and continuity.permission_id = entry.permission_id
where entry.organization_id = '21800000-0000-4000-8000-000000000318'
  and entry.registration_kind = 'platform'
  and entry.permission_id = '687d5649-62ee-43dd-b684-b8af3a5394c1';

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '21800000-0000-4000-8000-000000000318',
  '61800000-0000-4000-8000-000000000318', 1, 'custom', 'active',
  'privileged', 'standing', 1, 1, 'audit_reader', 'Audit reader',
  'Deterministic role-assignment audit-time regression fixture.',
  '91800000-0000-4000-8000-000000000318', pg_catalog.clock_timestamp(),
  '71800000-0000-4000-8000-000000000322'
);

set constraints all immediate;
set constraints all deferred;

create temporary table future_assignment_audit as
select pg_catalog.clock_timestamp() + interval '1 day' as changed_at;

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision, starts_at,
  expires_at, state, granted_by, granted_at, grant_correlation_id,
  changed_by, changed_at, change_correlation_id, revoked_by, revoked_at,
  revocation_correlation_id
)
select '21800000-0000-4000-8000-000000000318',
  '63800000-0000-4000-8000-000000000318',
  '61800000-0000-4000-8000-000000000318', 'organization_account',
  '51800000-0000-4000-8000-000000000318', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 day', null, 'live',
  '91800000-0000-4000-8000-000000000318', future.changed_at,
  '71800000-0000-4000-8000-000000000323',
  '91800000-0000-4000-8000-000000000318', future.changed_at,
  '71800000-0000-4000-8000-000000000323', null, null, null
from future_assignment_audit as future;

create temporary table assignment_before as
select pg_catalog.to_jsonb(snapshot.*) as snapshot
from (
  select assignment.organization_id, assignment.role_assignment_id,
    assignment.role_id, assignment.assignee_kind,
    assignment.organization_account_id, assignment.group_id,
    assignment.assignment_kind, assignment.starts_at, assignment.expires_at,
    assignment.granted_by as granted_by_actor_id, assignment.granted_at,
    assignment.grant_correlation_id
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = '21800000-0000-4000-8000-000000000318'
    and assignment.role_assignment_id = '63800000-0000-4000-8000-000000000318'
) as snapshot;

create temporary table access_before as
select current_version
from vortex_access.organization_access_versions
where organization_id = '21800000-0000-4000-8000-000000000318';

create temporary table revoke_result as
select *
from vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(
  'revoke', '21800000-0000-4000-8000-000000000318',
  '63800000-0000-4000-8000-000000000318', 1,
  null, null, null, null, null, null, null, null,
  '91800000-0000-4000-8000-000000000319',
  '71800000-0000-4000-8000-000000000324'
);

select is(
  (
    select outcome || ':' || operation || ':' || revision::text || ':' || state
    from revoke_result
  ),
  'changed:revoke:2:revoked',
  'a correctly revisioned revoke succeeds for a future-audit predecessor'
);

select results_eq(
  $$ select changed_at, revoked_at from revoke_result $$,
  $$ select changed_at, changed_at from future_assignment_audit $$,
  'the result clamps both audit timestamps to the valid predecessor time'
);

select is(
  (
    select pg_catalog.to_jsonb(result.*) - array[
      'outcome', 'operation', 'revision', 'state', 'changed_by_actor_id',
      'changed_at', 'change_correlation_id', 'revoked_by_actor_id', 'revoked_at',
      'revocation_correlation_id', 'access_version', 'correlation_id'
    ]::text[]
    from revoke_result as result
  ),
  (select snapshot from assignment_before),
  'revocation preserves every immutable assignment and grant fact'
);

select results_eq(
  $$
    select assignment.changed_at, assignment.revoked_at,
      assignment.changed_by, assignment.change_correlation_id,
      assignment.revoked_by, assignment.revocation_correlation_id
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = '21800000-0000-4000-8000-000000000318'
      and assignment.role_assignment_id = '63800000-0000-4000-8000-000000000318'
  $$,
  $$
    select future.changed_at, future.changed_at,
      '91800000-0000-4000-8000-000000000319'::uuid,
      '71800000-0000-4000-8000-000000000324'::uuid,
      '91800000-0000-4000-8000-000000000319'::uuid,
      '71800000-0000-4000-8000-000000000324'::uuid
    from future_assignment_audit as future
  $$,
  'the stored transition carries coherent clamped change and revocation evidence'
);

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21800000-0000-4000-8000-000000000318'
  ),
  (select current_version + 1 from access_before),
  'the successful revoke increments Access exactly once'
);

select results_eq(
  $$
    select change_reason, changed_by, change_correlation_id
    from vortex_access.organization_access_versions
    where organization_id = '21800000-0000-4000-8000-000000000318'
  $$,
  $$ values (
    'role_assignment_changed'::text,
    '91800000-0000-4000-8000-000000000319'::uuid,
    '71800000-0000-4000-8000-000000000324'::uuid
  ) $$,
  'the Access increment retains its existing reason and trusted evidence'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_assignment_change_without_stewardship_v1_internal(
      'revoke', '21800000-0000-4000-8000-000000000318',
      '63800000-0000-4000-8000-000000000318', 1,
      null, null, null, null, null, null, null, null,
      '91800000-0000-4000-8000-000000000319',
      '71800000-0000-4000-8000-000000000325'
    )
  $$,
  '40001'::char(5), null,
  'the audit clamp does not weaken expected-revision replay refusal'
);

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21800000-0000-4000-8000-000000000318'
  ),
  (select current_version + 1 from access_before),
  'the refused stale retry does not increment Access again'
);

select * from finish();

rollback;
