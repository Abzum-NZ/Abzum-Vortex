\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_table(
  'vortex_access', 'organization_invitation_access_intents',
  'Access stores one private immutable invitation intent'
);
select has_function(
  'vortex_access', 'coordinate_organization_invitation_with_access_intent',
  array['text', 'text', 'timestamp with time zone', 'jsonb'],
  'Access exposes one private invitation-and-intent creation composition'
);
select has_function(
  'vortex_access', 'coordinate_organization_invitation_access_acceptance',
  array['text', 'uuid', 'text', 'text', 'uuid'],
  'Access exposes one private intent acceptance composition'
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
      'vortex_access.coordinate_organization_invitation_with_access_intent(text,text,timestamptz,jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'intent creation is owner-held, invoker-security and empty-search-path'
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
      'vortex_access.coordinate_organization_invitation_access_acceptance(text,uuid,text,text,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'intent acceptance is owner-held, invoker-security and empty-search-path'
);

select ok(
  not pg_catalog.has_table_privilege(
    caller.role_name,
    'vortex_access.organization_invitation_access_intents',
    'SELECT'
  )
  and not pg_catalog.has_table_privilege(
    caller.role_name,
    'vortex_access.organization_invitation_access_intents',
    'INSERT'
  )
  and not pg_catalog.has_table_privilege(
    caller.role_name,
    'vortex_access.organization_invitation_access_intents',
    'UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    caller.role_name,
    'vortex_access.organization_invitation_access_intents',
    'DELETE'
  ),
  caller.role_name || ' has no invitation-intent table privileges'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_invitation_with_access_intent(text,text,timestamptz,jsonb)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_invitation_access_acceptance(text,uuid,text,text,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute either private invitation-intent composition'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.accept_organization_invitation(text,uuid,text,text,uuid)',
    'EXECUTE'
  ),
  'the established five-argument invitation acceptance remains runtime-capable'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '12800000-0000-4000-8000-000000000001', 'invitation_access',
  'Invitation access', 'active', pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '22800000-0000-4000-8000-000000000001',
  '12800000-0000-4000-8000-000000000001', 'invitation_access_org',
  'Invitation access organisation', 'active',
  pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42800000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '52800000-0000-4000-8000-000000000001',
  '22800000-0000-4000-8000-000000000001',
  '42800000-0000-4000-8000-000000000001', 'Invitation operator',
  'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000002', 1
);

select * from vortex_access.initialize_organization_access_version(
  '22800000-0000-4000-8000-000000000001',
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000003'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '22800000-0000-4000-8000-000000000001',
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000004'
);

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '22800000-0000-4000-8000-000000000001',
  '52800000-0000-4000-8000-000000000001',
  '62800000-0000-4000-8000-000000000001',
  'organization_steward', 'Organisation steward',
  'Permanent minimum organisation administration.',
  '72800000-0000-4000-8000-000000000001',
  '82800000-0000-4000-8000-000000000001',
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000005'
);

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '22800000-0000-4000-8000-000000000001',
    '32800000-0000-4000-8000-000000000001', 'review_group', 'Review Group',
    'active', 1, '92800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '92800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    'a2800000-0000-4000-8000-000000000006'
  ),
  (
    '22800000-0000-4000-8000-000000000001',
    '32800000-0000-4000-8000-000000000002', 'second_group', 'Second Group',
    'active', 1, '92800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '92800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    'a2800000-0000-4000-8000-000000000007'
  ),
  (
    '22800000-0000-4000-8000-000000000001',
    '32800000-0000-4000-8000-000000000003', 'scheduled_group', 'Scheduled Group',
    'active', 1, '92800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '92800000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    'a2800000-0000-4000-8000-000000000008'
  );

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '22800000-0000-4000-8000-000000000001',
  '62800000-0000-4000-8000-000000000002', 'custom', 'eligible_reviewer',
  null, null, 1, '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision,
  policy_fingerprint, maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at,
  change_correlation_id
) values (
  '22800000-0000-4000-8000-000000000001',
  '62800000-0000-4000-8000-000000000002',
  '63800000-0000-4000-8000-000000000090', 1,
  'sha256:9999999999999999999999999999999999999999999999999999999999999999',
  1800, false, 'none', null, false,
  '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a2800000-0000-4000-8000-000000000009'
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select permission.organization_id,
  '62800000-0000-4000-8000-000000000002'::uuid, 1,
  permission.entry_ordinal, 'custom', null, permission.application_root_id,
  permission.owner_kind, permission.owner_id, permission.permission_id,
  permission.registration_kind, permission.registration_owner_id,
  permission.accepted_registration_revision, permission.catalogue_fingerprint,
  permission.continuity_revision, permission.meaning_fingerprint
from vortex_access.organization_role_permission_entries as permission
where permission.organization_id = '22800000-0000-4000-8000-000000000001'
  and permission.role_id = '62800000-0000-4000-8000-000000000001'
  and permission.role_revision = 1
order by permission.entry_ordinal;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id,
  lifecycle, privilege_classification, assignment_policy,
  policy_continuity_revision, activation_policy_id,
  activation_policy_revision, activation_policy_fingerprint,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '22800000-0000-4000-8000-000000000001',
  '62800000-0000-4000-8000-000000000002', 1, 'custom', null,
  'active', 'privileged', 'activation_required', 1,
  '63800000-0000-4000-8000-000000000090', 1,
  'sha256:9999999999999999999999999999999999999999999999999999999999999999',
  1, 'eligible_reviewer', 'Eligible reviewer',
  'A neutral activation-required role for invitation intent tests.',
  '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a2800000-0000-4000-8000-000000000009'
);

set constraints all immediate;
set constraints all deferred;

select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '32800000-0000-4000-8000-000000000090',
    'tenantId', '12800000-0000-4000-8000-000000000001',
    'organizationId', '22800000-0000-4000-8000-000000000001',
    'sessionId', '62800000-0000-4000-8000-000000000090',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', (
      select current_version
      from vortex_access.organization_access_versions
      where organization_id = '22800000-0000-4000-8000-000000000001'
    ),
    'correlationId', 'a2800000-0000-4000-8000-000000000010',
    'identityId', '42800000-0000-4000-8000-000000000001',
    'organizationAccountId', '52800000-0000-4000-8000-000000000001',
    'authenticationStrength', 'single_factor'
  )
);

create temporary table access_before_intent_creation on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';

create temporary table created_intent_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'invitee@example.test',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000001',
        'groupId', '32800000-0000-4000-8000-000000000001',
        'startsAt', pg_catalog.statement_timestamp() - interval '1 minute',
        'expiresAt', pg_catalog.statement_timestamp() + interval '12 hours'
      )
    ),
    'roleAssignmentIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', '73800000-0000-4000-8000-000000000001',
        'roleId', '62800000-0000-4000-8000-000000000001',
        'expectedRoleRevision', 1,
        'assignmentKind', 'standing',
        'startsAt', pg_catalog.statement_timestamp() - interval '1 minute',
        'expiresAt', pg_catalog.statement_timestamp() + interval '12 hours'
      )
    )
  )
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'organizationId', invitation ->> 'organizationId',
      'invitationId', invitation ->> 'invitationId',
      'intentInvitationId', access_intent ->> 'invitationId',
      'intendedBy', access_intent ->> 'intendedByOrganizationAccountId',
      'membershipCount', pg_catalog.jsonb_array_length(
        access_intent -> 'membershipIntents'
      ),
      'assignmentCount', pg_catalog.jsonb_array_length(
        access_intent -> 'roleAssignmentIntents'
      )
    )
    from created_intent_invitation
  ),
  (
    select pg_catalog.jsonb_build_object(
      'organizationId', '22800000-0000-4000-8000-000000000001',
      'invitationId', invitation ->> 'invitationId',
      'intentInvitationId', invitation ->> 'invitationId',
      'intendedBy', '52800000-0000-4000-8000-000000000001',
      'membershipCount', 1,
      'assignmentCount', 1
    )
    from created_intent_invitation
  ),
  'creation returns one exact invitation-to-intent linkage with both grant kinds'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '22800000-0000-4000-8000-000000000001'
  ),
  (select current_version from access_before_intent_creation),
  'binding an intent grants nothing and does not increment Access'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.organization_accounts
    where organization_id = '22800000-0000-4000-8000-000000000001'
      and identity_id = '42800000-0000-4000-8000-000000000002'
  ),
  0,
  'intent creation does not create a beneficiary account'
);

set local role vortex_runtime;
create temporary table legacy_intent_refusal on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '42800000-0000-4000-8000-000000000002',
  'invitee@example.test', 'Invitee',
  'a2800000-0000-4000-8000-000000000011'
);
reset role;

select is(
  (select outcome from legacy_intent_refusal),
  'unavailable',
  'the established runtime route refuses a pending intent before Identity mutation'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.identity_projections
    where identity_id = '42800000-0000-4000-8000-000000000002'
  ),
  0,
  'legacy refusal creates no Identity projection'
);

create temporary table access_before_intent_acceptance on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';

create temporary table accepted_intent on commit drop as
select *
from vortex_access.coordinate_organization_invitation_access_acceptance(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '42800000-0000-4000-8000-000000000002',
  'invitee@example.test', 'Invitee',
  'a2800000-0000-4000-8000-000000000012'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, invitation_id, membership_ids[1], role_assignment_ids[1],
      access_version, correlation_id
    )
    from accepted_intent
  ),
  (
    select pg_catalog.concat_ws(
      '|', 'accepted', invitation ->> 'invitationId',
      '63800000-0000-4000-8000-000000000001',
      '73800000-0000-4000-8000-000000000001',
      before_version.current_version + 1,
      'a2800000-0000-4000-8000-000000000012'
    )
    from created_intent_invitation
    cross join access_before_intent_acceptance as before_version
  ),
  'intent acceptance returns its exact linkage and one Access increment'
);
select is(
  (
    select pg_catalog.jsonb_build_object(
      'membershipState', membership.state,
      'membershipAccount', membership.organization_account_id,
      'assignmentState', assignment.state,
      'assignmentAccount', assignment.organization_account_id,
      'assigneeKind', assignment.assignee_kind,
      'assignmentKind', assignment.assignment_kind,
      'membershipActor', membership.granted_by,
      'assignmentActor', assignment.granted_by,
      'membershipCorrelation', membership.grant_correlation_id,
      'assignmentCorrelation', assignment.grant_correlation_id
    )
    from vortex_access.organization_group_memberships as membership
    cross join vortex_access.organization_role_assignments as assignment
    where membership.organization_id = '22800000-0000-4000-8000-000000000001'
      and membership.membership_id = '63800000-0000-4000-8000-000000000001'
      and assignment.organization_id = membership.organization_id
      and assignment.role_assignment_id =
        '73800000-0000-4000-8000-000000000001'
  ),
  pg_catalog.jsonb_build_object(
    'membershipState', 'live',
    'membershipAccount', (select (organization_account ->> 'organizationAccountId')::uuid from accepted_intent),
    'assignmentState', 'live',
    'assignmentAccount', (select (organization_account ->> 'organizationAccountId')::uuid from accepted_intent),
    'assigneeKind', 'organization_account',
    'assignmentKind', 'standing',
    'membershipActor', '52800000-0000-4000-8000-000000000001',
    'assignmentActor', '52800000-0000-4000-8000-000000000001',
    'membershipCorrelation', 'a2800000-0000-4000-8000-000000000012',
    'assignmentCorrelation', 'a2800000-0000-4000-8000-000000000012'
  ),
  'acceptance creates exact direct current facts with stored inviter provenance'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', change_reason, changed_by, change_correlation_id
    )
    from vortex_access.organization_access_versions
    where organization_id = '22800000-0000-4000-8000-000000000001'
  ),
  'invitation_access_accepted|52800000-0000-4000-8000-000000000001|a2800000-0000-4000-8000-000000000012',
  'the composite grant records one exact invitation acceptance Access reason'
);

select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership',
  '22800000-0000-4000-8000-000000000001',
  '63800000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null,
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000013'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke',
  '22800000-0000-4000-8000-000000000001',
  '73800000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null,
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000014'
);

create temporary table access_before_replay on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';

create temporary table accepted_intent_replay on commit drop as
select *
from vortex_access.coordinate_organization_invitation_access_acceptance(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '42800000-0000-4000-8000-000000000002',
  'invitee@example.test', 'Changed name',
  'a2800000-0000-4000-8000-000000000015'
);

select is(
  (
    select outcome || '|' || access_version::text
    from accepted_intent_replay
  ),
  (
    select 'already_accepted|' || current_version::text
    from access_before_replay
  ),
  'accepted replay returns the current Access version without incrementing'
);
select is(
  (
    select membership.state || '|' || membership.revision::text || '|'
      || assignment.state || '|' || assignment.revision::text
    from vortex_access.organization_group_memberships as membership
    cross join vortex_access.organization_role_assignments as assignment
    where membership.organization_id = '22800000-0000-4000-8000-000000000001'
      and membership.membership_id = '63800000-0000-4000-8000-000000000001'
      and assignment.organization_id = membership.organization_id
      and assignment.role_assignment_id =
        '73800000-0000-4000-8000-000000000001'
  ),
  'revoked|2|revoked|2',
  'accepted replay reports original IDs without recreating removed access'
);

set local role vortex_runtime;
create temporary table legacy_accepted_intent_replay on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '42800000-0000-4000-8000-000000000002',
  'invitee@example.test', null,
  'a2800000-0000-4000-8000-000000000031'
);
reset role;
select is(
  (
    select outcome || '|' || access_version::text
    from legacy_accepted_intent_replay
  ),
  (
    select 'already_accepted|' || current_version::text
    from access_before_replay
  ),
  'the legacy runtime route preserves exact accepted-intent replay without regrant'
);

create temporary table second_intent_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'invitee@example.test',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000002',
        'groupId', '32800000-0000-4000-8000-000000000002',
        'startsAt', pg_catalog.statement_timestamp() + interval '1 hour',
        'expiresAt', pg_catalog.statement_timestamp() + interval '12 hours'
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
);
create temporary table access_before_active_acceptance on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';
create temporary table active_account_acceptance on commit drop as
select *
from vortex_access.coordinate_organization_invitation_access_acceptance(
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '42800000-0000-4000-8000-000000000002',
  'invitee@example.test', null,
  'a2800000-0000-4000-8000-000000000016'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', accepted.outcome,
      accepted.organization_account ->> 'organizationAccountId',
      accepted.organization_account ->> 'invitationId',
      accepted.invitation_id,
      accepted.access_version
    )
    from active_account_acceptance as accepted
  ),
  (
    select pg_catalog.concat_ws(
      '|', 'accepted',
      first_acceptance.organization_account ->> 'organizationAccountId',
      first_invitation.invitation ->> 'invitationId',
      second_invitation.invitation ->> 'invitationId',
      before_version.current_version + 1
    )
    from accepted_intent as first_acceptance
    cross join created_intent_invitation as first_invitation
    cross join second_intent_invitation as second_invitation
    cross join access_before_active_acceptance as before_version
  ),
  'an already-active beneficiary gains the new intent without rewriting account provenance'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', membership.state, membership.revision,
      membership.organization_account_id,
      membership.starts_at > pg_catalog.statement_timestamp()
    )
    from vortex_access.organization_group_memberships as membership
    where membership.organization_id = '22800000-0000-4000-8000-000000000001'
      and membership.membership_id = '63800000-0000-4000-8000-000000000002'
  ),
  (
    select pg_catalog.concat_ws(
      '|', 'live', 1,
      organization_account ->> 'organizationAccountId', true
    )
    from active_account_acceptance
  ),
  'a membership-only intent may create one scheduled current fact'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42800000-0000-4000-8000-000000000003', 'active',
  pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '2 days',
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000017', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, suspended_at, changed_at, state_changed_at,
  state_changed_by, state_change_correlation_id, revision
) values (
  '52800000-0000-4000-8000-000000000003',
  '22800000-0000-4000-8000-000000000001',
  '42800000-0000-4000-8000-000000000003', 'Returning invitee',
  'suspended', pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '1 day',
  pg_catalog.statement_timestamp() - interval '1 day',
  pg_catalog.statement_timestamp() - interval '1 day',
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000017', 1
);

create temporary table eligible_intent_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'returning@example.test',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', '[]'::jsonb,
    'roleAssignmentIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', '73800000-0000-4000-8000-000000000002',
        'roleId', '62800000-0000-4000-8000-000000000002',
        'expectedRoleRevision', 1,
        'assignmentKind', 'eligible',
        'startsAt', pg_catalog.statement_timestamp() - interval '1 minute',
        'expiresAt', pg_catalog.statement_timestamp() + interval '6 hours'
      )
    )
  )
);
create temporary table access_before_reactivation on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';
create temporary table reactivated_intent on commit drop as
select *
from vortex_access.coordinate_organization_invitation_access_acceptance(
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '42800000-0000-4000-8000-000000000003',
  'returning@example.test', 'Returning invitee',
  'a2800000-0000-4000-8000-000000000018'
);

select is(
  (
    select pg_catalog.concat_ws(
      '|', outcome, organization_account ->> 'state',
      organization_account ->> 'revision', access_version,
      pg_catalog.array_length(membership_ids, 1),
      pg_catalog.array_length(role_assignment_ids, 1)
    )
    from reactivated_intent
  ),
  (
    select pg_catalog.concat_ws(
      '|', 'accepted', 'active', 2, current_version + 1,
      null, 1
    )
    from access_before_reactivation
  ),
  'an assignment-only eligible intent reactivates its beneficiary with one Access change'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', assignment.assignment_kind, assignment.assignee_kind,
      assignment.organization_account_id, assignment.state
    )
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = '22800000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id =
        '73800000-0000-4000-8000-000000000002'
  ),
  'eligible|organization_account|52800000-0000-4000-8000-000000000003|live',
  'the eligible intent creates one exact direct-account assignment'
);

create temporary table no_intent_invitation on commit drop as
select * from vortex_identity.create_organization_invitation(
  'plain@example.test',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  pg_catalog.statement_timestamp() + interval '1 day'
);
create temporary table access_before_plain_acceptance on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';
set local role vortex_runtime;
create temporary table plain_acceptance on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '42800000-0000-4000-8000-000000000004',
  'plain@example.test', 'Plain invitee',
  'a2800000-0000-4000-8000-000000000019'
);
create temporary table plain_replay on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '42800000-0000-4000-8000-000000000004',
  'plain@example.test', 'Changed plain name',
  'a2800000-0000-4000-8000-000000000020'
);
reset role;

select is(
  (
    select first.outcome || '|' || first.access_version::text || '|'
      || replay.outcome || '|' || replay.access_version::text
    from plain_acceptance as first
    cross join plain_replay as replay
  ),
  (
    select 'accepted|' || (current_version + 1)::text
      || '|already_accepted|' || (current_version + 1)::text
    from access_before_plain_acceptance
  ),
  'the established no-intent route still accepts once and replays without another increment'
);
select is(
  (
    select count(*)::integer
    from vortex_access.organization_invitation_access_intents as intent
    where intent.invitation_id = (
      select invitation_id from no_intent_invitation
    )
  ),
  0,
  'ordinary invitation acceptance does not synthesize an access intent'
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '22800000-0000-4000-8000-000000000002',
  '12800000-0000-4000-8000-000000000001', 'foreign_invitation_access',
  'Foreign invitation access organisation', 'active',
  pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '22800000-0000-4000-8000-000000000002',
  '32800000-0000-4000-8000-000000000090', 'foreign_group', 'Foreign Group',
  'active', 1, '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(),
  'a2800000-0000-4000-8000-000000000021'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_with_access_intent(
      'duplicate-group@example.test',
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      pg_catalog.statement_timestamp() + interval '1 day',
      pg_catalog.jsonb_build_object(
        'membershipIntents', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'membershipId', '63800000-0000-4000-8000-000000000010',
            'groupId', '32800000-0000-4000-8000-000000000003',
            'startsAt', pg_catalog.statement_timestamp()
          ),
          pg_catalog.jsonb_build_object(
            'membershipId', '63800000-0000-4000-8000-000000000011',
            'groupId', '32800000-0000-4000-8000-000000000003',
            'startsAt', pg_catalog.statement_timestamp()
          )
        ),
        'roleAssignmentIntents', '[]'::jsonb
      )
    )
  $$,
  '22023'::char(5),
  'Organization invitation membership intent is invalid',
  'one intent cannot contain two membership identities for the same Group'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.organization_invitations
    where token_fingerprint =
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ),
  0,
  'malformed intent refusal occurs before invitation creation'
);

create temporary table stale_source_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'stale-source@example.test',
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000012',
        'groupId', '32800000-0000-4000-8000-000000000003',
        'startsAt', pg_catalog.statement_timestamp()
      )
    ),
    'roleAssignmentIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', '73800000-0000-4000-8000-000000000012',
        'roleId', '62800000-0000-4000-8000-000000000001',
        'expectedRoleRevision', 2,
        'assignmentKind', 'standing',
        'startsAt', pg_catalog.statement_timestamp()
      )
    )
  )
);
create temporary table access_before_stale_source on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      '42800000-0000-4000-8000-000000000005',
      'stale-source@example.test', null,
      'a2800000-0000-4000-8000-000000000022'
    )
  $$,
  '40001'::char(5),
  'Organization invitation role-assignment intent is stale or unavailable',
  'a stale reviewed role revision refuses the whole mixed intent'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', invitation.accepted_at is null,
      not exists (
        select 1 from vortex_identity.identity_projections
        where identity_id = '42800000-0000-4000-8000-000000000005'
      ),
      not exists (
        select 1 from vortex_access.organization_group_memberships
        where organization_id = invitation.organization_id
          and membership_id = '63800000-0000-4000-8000-000000000012'
      ),
      not exists (
        select 1 from vortex_access.organization_role_assignments
        where organization_id = invitation.organization_id
          and role_assignment_id = '73800000-0000-4000-8000-000000000012'
      ),
      version.current_version = before_version.current_version
    )
    from vortex_identity.organization_invitations as invitation
    join stale_source_invitation as created
      on invitation.invitation_id = (created.invitation ->> 'invitationId')::uuid
    join vortex_access.organization_access_versions as version
      on version.organization_id = invitation.organization_id
    cross join access_before_stale_source as before_version
  ),
  't|t|t|t|t',
  'stale mixed-intent refusal leaves Identity, every fact and Access unchanged'
);

create temporary table foreign_group_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'foreign-group@example.test',
  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000013',
        'groupId', '32800000-0000-4000-8000-000000000090',
        'startsAt', pg_catalog.statement_timestamp()
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      '42800000-0000-4000-8000-000000000006',
      'foreign-group@example.test', null,
      'a2800000-0000-4000-8000-000000000023'
    )
  $$,
  '40001'::char(5),
  'Organization invitation Group intent is stale or unavailable',
  'a Group from another organization cannot satisfy an intent'
);

create temporary table elapsed_intent_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'elapsed-intent@example.test',
  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000014',
        'groupId', '32800000-0000-4000-8000-000000000003',
        'startsAt', pg_catalog.statement_timestamp() - interval '2 minutes',
        'expiresAt', pg_catalog.statement_timestamp() - interval '1 minute'
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      '42800000-0000-4000-8000-000000000007',
      'elapsed-intent@example.test', null,
      'a2800000-0000-4000-8000-000000000024'
    )
  $$,
  '40001'::char(5),
  'Organization invitation access intent window is no longer current',
  'an elapsed intended fact refuses before Identity mutation'
);

create temporary table live_pair_conflict_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'invitee@example.test',
  'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000015',
        'groupId', '32800000-0000-4000-8000-000000000002',
        'startsAt', pg_catalog.statement_timestamp()
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
);
create temporary table access_before_live_pair_conflict on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '22800000-0000-4000-8000-000000000001';
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      '42800000-0000-4000-8000-000000000002',
      'invitee@example.test', null,
      'a2800000-0000-4000-8000-000000000025'
    )
  $$,
  '23505'::char(5), null,
  'a second live membership for the derived account and Group is refused atomically'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', invitation.accepted_at is null,
      not exists (
        select 1 from vortex_access.organization_group_memberships
        where organization_id = invitation.organization_id
          and membership_id = '63800000-0000-4000-8000-000000000015'
      ),
      version.current_version = before_version.current_version
    )
    from vortex_identity.organization_invitations as invitation
    join live_pair_conflict_invitation as created
      on invitation.invitation_id = (created.invitation ->> 'invitationId')::uuid
    join vortex_access.organization_access_versions as version
      on version.organization_id = invitation.organization_id
    cross join access_before_live_pair_conflict as before_version
  ),
  't|t|t',
  'a fact conflict rolls back the invitation transition and Access together'
);

create temporary table permanent_id_conflict_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'id-conflict@example.test',
  'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', '[]'::jsonb,
    'roleAssignmentIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', '72800000-0000-4000-8000-000000000001',
        'roleId', '62800000-0000-4000-8000-000000000001',
        'expectedRoleRevision', 1,
        'assignmentKind', 'standing',
        'startsAt', pg_catalog.statement_timestamp()
      )
    )
  )
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      '42800000-0000-4000-8000-000000000008',
      'id-conflict@example.test', null,
      'a2800000-0000-4000-8000-000000000026'
    )
  $$,
  '40001'::char(5),
  'Organization invitation access intent identities are unavailable',
  'an existing permanent assignment identity refuses before Identity mutation'
);

create temporary table wrong_mode_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'wrong-mode@example.test',
  'sha256:8888888888888888888888888888888888888888888888888888888888888888',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', '[]'::jsonb,
    'roleAssignmentIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', '73800000-0000-4000-8000-000000000018',
        'roleId', '62800000-0000-4000-8000-000000000001',
        'expectedRoleRevision', 1,
        'assignmentKind', 'eligible',
        'startsAt', pg_catalog.statement_timestamp()
      )
    )
  )
);
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:8888888888888888888888888888888888888888888888888888888888888888',
      '42800000-0000-4000-8000-000000000012',
      'wrong-mode@example.test', null,
      'a2800000-0000-4000-8000-000000000032'
    )
  $$,
  '40001'::char(5),
  'Organization invitation role-assignment intent is stale or unavailable',
  'a reviewed standing role cannot satisfy an eligible assignment intent'
);

create temporary table revoked_intent_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'revoked-intent@example.test',
  'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000016',
        'groupId', '32800000-0000-4000-8000-000000000003',
        'startsAt', pg_catalog.statement_timestamp()
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
);
select * from vortex_identity.revoke_organization_invitation(
  (select (invitation ->> 'invitationId')::uuid from revoked_intent_invitation),
  1
);
create temporary table revoked_intent_result on commit drop as
select *
from vortex_access.coordinate_organization_invitation_access_acceptance(
  'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  '42800000-0000-4000-8000-000000000009',
  'revoked-intent@example.test', null,
  'a2800000-0000-4000-8000-000000000027'
);
select is(
  (select outcome from revoked_intent_result),
  'unavailable',
  'a revoked invitation cannot apply its immutable intent'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42800000-0000-4000-8000-000000000010', 'suspended',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '92800000-0000-4000-8000-000000000001',
  'a2800000-0000-4000-8000-000000000028', 1
);
create temporary table inactive_identity_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'inactive-identity@example.test',
  'sha256:6666666666666666666666666666666666666666666666666666666666666666',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', '[]'::jsonb,
    'roleAssignmentIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', '73800000-0000-4000-8000-000000000016',
        'roleId', '62800000-0000-4000-8000-000000000001',
        'expectedRoleRevision', 1,
        'assignmentKind', 'standing',
        'startsAt', pg_catalog.statement_timestamp()
      )
    )
  )
);
create temporary table inactive_identity_result on commit drop as
select *
from vortex_access.coordinate_organization_invitation_access_acceptance(
  'sha256:6666666666666666666666666666666666666666666666666666666666666666',
  '42800000-0000-4000-8000-000000000010',
  'inactive-identity@example.test', null,
  'a2800000-0000-4000-8000-000000000029'
);
select is(
  (select outcome from inactive_identity_result),
  'identity_inactive',
  'an inactive verified identity receives the established closed refusal outcome'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', invitation.accepted_at is null,
      not exists (
        select 1 from vortex_access.organization_role_assignments
        where organization_id = invitation.organization_id
          and role_assignment_id = '73800000-0000-4000-8000-000000000016'
      )
    )
    from vortex_identity.organization_invitations as invitation
    join inactive_identity_invitation as created
      on invitation.invitation_id = (created.invitation ->> 'invitationId')::uuid
  ),
  't|t',
  'identity refusal leaves the invitation pending and creates no assignment'
);

create temporary table exhausted_intent_invitation on commit drop as
select *
from vortex_access.coordinate_organization_invitation_with_access_intent(
  'exhausted@example.test',
  'sha256:7777777777777777777777777777777777777777777777777777777777777777',
  pg_catalog.statement_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '63800000-0000-4000-8000-000000000017',
        'groupId', '32800000-0000-4000-8000-000000000003',
        'startsAt', pg_catalog.statement_timestamp()
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
);

set constraints all immediate;
set constraints all deferred;
savepoint before_access_exhaustion;
alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '22800000-0000-4000-8000-000000000001';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_invitation_access_acceptance(
      'sha256:7777777777777777777777777777777777777777777777777777777777777777',
      '42800000-0000-4000-8000-000000000011',
      'exhausted@example.test', null,
      'a2800000-0000-4000-8000-000000000030'
    )
  $$,
  '22003'::char(5),
  'Access version is exhausted',
  'Access exhaustion rolls back Identity acceptance and intended facts'
);
select is(
  (
    select pg_catalog.concat_ws(
      '|', invitation.accepted_at is null,
      not exists (
        select 1 from vortex_identity.identity_projections
        where identity_id = '42800000-0000-4000-8000-000000000011'
      ),
      not exists (
        select 1 from vortex_access.organization_group_memberships
        where organization_id = invitation.organization_id
          and membership_id = '63800000-0000-4000-8000-000000000017'
      )
    )
    from vortex_identity.organization_invitations as invitation
    join exhausted_intent_invitation as created
      on invitation.invitation_id = (created.invitation ->> 'invitationId')::uuid
  ),
  't|t|t',
  'exhaustion refusal leaves the invitation, Identity and access facts untouched'
);
rollback to savepoint before_access_exhaustion;

select throws_ok(
  $$
    update vortex_access.organization_invitation_access_intents
    set intent_correlation_id = 'a2800000-0000-4000-8000-000000000099'
    where invitation_id = (
      select (invitation ->> 'invitationId')::uuid
      from created_intent_invitation
    )
  $$,
  '23514'::char(5),
  'Organization invitation access intents are immutable',
  'an invitation intent cannot be edited after issue'
);

set constraints all immediate;
set constraints all deferred;

select * from finish();

rollback;
