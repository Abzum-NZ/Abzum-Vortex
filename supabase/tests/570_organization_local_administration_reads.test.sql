\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_request;
select no_plan();

select has_function(
  'vortex_access', 'list_organization_accounts_for_administration',
  array['uuid', 'integer'], 'Access exposes one bounded protected account list'
);
select has_function(
  'vortex_access', 'read_organization_account_for_administration',
  array['uuid'], 'Access exposes one exact protected account detail read'
);
select has_function(
  'vortex_access', 'list_organization_invitations_for_administration',
  array['uuid', 'integer'], 'Access exposes one bounded protected invitation list'
);
select has_function(
  'vortex_access', 'read_organization_invitation_for_administration',
  array['uuid'], 'Access exposes one exact protected invitation detail read'
);
select has_function(
  'vortex_access', 'read_organization_runtime_settings_for_administration',
  array[]::text[], 'Access exposes one protected runtime-settings read'
);

select ok(
  pg_catalog.has_function_privilege('vortex_request', signature, 'execute'),
  'request role can call protected ' || signature
)
from (values
  ('vortex_access.list_organization_accounts_for_administration(uuid,integer)'),
  ('vortex_access.read_organization_account_for_administration(uuid)'),
  ('vortex_access.list_organization_invitations_for_administration(uuid,integer)'),
  ('vortex_access.read_organization_invitation_for_administration(uuid)'),
  ('vortex_access.read_organization_runtime_settings_for_administration()')
) as protected(signature);

select ok(
  not pg_catalog.has_function_privilege(candidate.role_name, signature, 'execute'),
  candidate.role_name || ' cannot call protected ' || signature
)
from (values
  ('public'::name), ('anon'::name), ('authenticated'::name),
  ('service_role'::name), ('vortex_runtime'::name), ('vortex_record_owner'::name)
) as candidate(role_name)
cross join (values
  ('vortex_access.list_organization_accounts_for_administration(uuid,integer)'),
  ('vortex_access.read_organization_account_for_administration(uuid)'),
  ('vortex_access.list_organization_invitations_for_administration(uuid,integer)'),
  ('vortex_access.read_organization_invitation_for_administration(uuid)'),
  ('vortex_access.read_organization_runtime_settings_for_administration()')
) as protected(signature)
order by candidate.role_name collate "C", signature collate "C";

select ok(
  not pg_catalog.has_function_privilege('vortex_request', signature, 'execute'),
  'request role cannot bypass the fixed wrapper through ' || signature
)
from (values
  ('vortex_identity.list_organization_accounts_for_administration_internal(uuid,uuid,integer)'),
  ('vortex_identity.read_organization_account_for_administration_internal(uuid,uuid)'),
  ('vortex_identity.list_organization_invitations_for_administration_internal(uuid,uuid,integer)'),
  ('vortex_identity.read_organization_invitation_for_administration_internal(uuid,uuid)'),
  ('vortex_identity.read_current_organization_runtime_settings_internal(uuid)'),
  ('vortex_access.organization_accounts_administration_scope()'),
  ('vortex_access.organization_invitations_administration_scope()'),
  ('vortex_access.organization_runtime_settings_administration_read_scope()')
) as private_helper(signature);

select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', table_name, 'select,insert,update,delete'
  ),
  'request role has no raw access to ' || table_name
)
from (values
  ('vortex_identity.organization_accounts'),
  ('vortex_identity.organization_invitations'),
  ('vortex_identity.organization_runtime_settings')
) as private_table(table_name);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '15700000-0000-4000-8000-000000000001', 'local_administration',
  'Local administration', 'active', pg_catalog.clock_timestamp(),
  '95700000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '25700000-0000-4000-8000-000000000001',
    '15700000-0000-4000-8000-000000000001', 'local_administration',
    'Local administration', 'active', pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  ),
  (
    '25700000-0000-4000-8000-000000000002',
    '15700000-0000-4000-8000-000000000001', 'foreign_administration',
    'Foreign administration', 'active', pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
)
select identity_id, 'active', pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '95700000-0000-4000-8000-000000000001',
  correlation_id, 1
from (values
  ('45700000-0000-4000-8000-000000000001'::uuid, 'a5700000-0000-4000-8000-000000000001'::uuid),
  ('45700000-0000-4000-8000-000000000002'::uuid, 'a5700000-0000-4000-8000-000000000002'::uuid),
  ('45700000-0000-4000-8000-000000000003'::uuid, 'a5700000-0000-4000-8000-000000000003'::uuid),
  ('45700000-0000-4000-8000-000000000004'::uuid, 'a5700000-0000-4000-8000-000000000004'::uuid),
  ('45700000-0000-4000-8000-000000000005'::uuid, 'a5700000-0000-4000-8000-000000000005'::uuid),
  ('45700000-0000-4000-8000-000000000006'::uuid, 'a5700000-0000-4000-8000-000000000006'::uuid),
  ('45700000-0000-4000-8000-000000000007'::uuid, 'a5700000-0000-4000-8000-000000000007'::uuid),
  ('45700000-0000-4000-8000-000000000008'::uuid, 'a5700000-0000-4000-8000-000000000008'::uuid),
  ('45700000-0000-4000-8000-000000000009'::uuid, 'a5700000-0000-4000-8000-000000000009'::uuid)
) as fixture(identity_id, correlation_id);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, language, time_zone, activated_at, suspended_at, closed_at,
  changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '55700000-0000-4000-8000-000000000001',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000001', 'Reader', 'active',
    'en-NZ', 'Pacific/Auckland', pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000011', 1
  ),
  (
    '55700000-0000-4000-8000-000000000002',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000002', 'Suspended local', 'suspended',
    null, null, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000012', 2
  ),
  (
    '55700000-0000-4000-8000-000000000003',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000003', null, 'closed',
    null, null, pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000013', 3
  ),
  (
    '55700000-0000-4000-8000-000000000004',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000004', 'No authority', 'active',
    null, null, pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000014', 1
  ),
  (
    '55700000-0000-4000-8000-000000000005',
    '25700000-0000-4000-8000-000000000002',
    '45700000-0000-4000-8000-000000000005', 'Foreign local', 'active',
    null, null, pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000015', 1
  ),
  (
    '55700000-0000-4000-8000-000000000006',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000006', 'Accounts read only', 'active',
    null, null, pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000016', 1
  ),
  (
    '55700000-0000-4000-8000-000000000007',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000007', 'Invitations read only', 'active',
    null, null, pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000017', 1
  ),
  (
    '55700000-0000-4000-8000-000000000008',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000008', 'Settings read only', 'active',
    null, null, pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000018', 1
  ),
  (
    '55700000-0000-4000-8000-000000000009',
    '25700000-0000-4000-8000-000000000001',
    '45700000-0000-4000-8000-000000000009', 'Manage only', 'active',
    null, null, pg_catalog.clock_timestamp(), null, null,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '95700000-0000-4000-8000-000000000001',
    'a5700000-0000-4000-8000-000000000019', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '25700000-0000-4000-8000-000000000001',
  '95700000-0000-4000-8000-000000000001',
  'a5700000-0000-4000-8000-000000000021'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '25700000-0000-4000-8000-000000000001',
  '95700000-0000-4000-8000-000000000001',
  'a5700000-0000-4000-8000-000000000022'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '25700000-0000-4000-8000-000000000001',
  '55700000-0000-4000-8000-000000000001',
  '65700000-0000-4000-8000-000000000001',
  'organization_steward', 'Organisation steward',
  'Permanent minimum organisation administration.',
  '75700000-0000-4000-8000-000000000001',
  '85700000-0000-4000-8000-000000000001',
  '95700000-0000-4000-8000-000000000001',
  'a5700000-0000-4000-8000-000000000023'
);

create function pg_temp.seed_local_administration_role(
  p_role_id uuid,
  p_role_key text,
  p_organization_account_id uuid,
  p_role_assignment_id uuid,
  p_permission_ids uuid[]
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  inserted_permission_count integer;
begin
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision,
    created_by, created_at
  ) values (
    '25700000-0000-4000-8000-000000000001', p_role_id, 'custom',
    p_role_key, 1, '95700000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, p_role_id, 1,
    pg_catalog.row_number() over (order by entry.permission_id), 'custom', null,
    entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id is not distinct from
      entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from
      entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '25700000-0000-4000-8000-000000000001'
    and entry.permission_id = any(p_permission_ids);

  get diagnostics inserted_permission_count = row_count;
  if inserted_permission_count <> pg_catalog.cardinality(p_permission_ids) then
    raise exception 'local administration permission fixture was incomplete';
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '25700000-0000-4000-8000-000000000001', p_role_id, 1, 'custom',
    'active', 'privileged', 'standing', 1, 1, null, null, null,
    p_role_key, 'Slice 5 permission proof',
    'Exact permission wrapper execution fixture.',
    '95700000-0000-4000-8000-000000000001', operation_at, p_role_id
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    '25700000-0000-4000-8000-000000000001', p_role_assignment_id,
    p_role_id, 'organization_account', p_organization_account_id, null,
    'standing', 1, operation_at - interval '1 minute', null, 'live',
    '95700000-0000-4000-8000-000000000001', operation_at,
    p_role_assignment_id,
    '95700000-0000-4000-8000-000000000001', operation_at,
    p_role_assignment_id
  );
end
$function$;

select pg_temp.seed_local_administration_role(
  '65700000-0000-4000-8000-000000000006', 'accounts_read_only',
  '55700000-0000-4000-8000-000000000006',
  '75700000-0000-4000-8000-000000000006',
  array['02c772e5-2921-4300-ad90-4f5772a7fa46'::uuid]
);
select pg_temp.seed_local_administration_role(
  '65700000-0000-4000-8000-000000000007', 'invitations_read_only',
  '55700000-0000-4000-8000-000000000007',
  '75700000-0000-4000-8000-000000000007',
  array['9300e501-6d56-41b1-b203-3361dbace9bc'::uuid]
);
select pg_temp.seed_local_administration_role(
  '65700000-0000-4000-8000-000000000008', 'settings_read_only',
  '55700000-0000-4000-8000-000000000008',
  '75700000-0000-4000-8000-000000000008',
  array['6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5'::uuid]
);
select pg_temp.seed_local_administration_role(
  '65700000-0000-4000-8000-000000000009', 'manage_only',
  '55700000-0000-4000-8000-000000000009',
  '75700000-0000-4000-8000-000000000009',
  array[
    '630a980c-0ff5-40b1-a329-7326a2122395'::uuid,
    'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb'::uuid,
    'c658c254-2884-414a-9012-512c0cfe4b34'::uuid
  ]
);

insert into vortex_identity.tenant_administrator_assignments (
  assignment_id, tenant_id, identity_id, capability_keys, starts_at, expires_at,
  revision, granted_at, granted_by_actor_id, grant_correlation_id, changed_at,
  changed_by_actor_id, change_correlation_id
) values (
  'b5700000-0000-4000-8000-000000000004',
  '15700000-0000-4000-8000-000000000001',
  '45700000-0000-4000-8000-000000000004',
  array[
    'platform.tenant.administrators.manage',
    'platform.tenant.administrators.read',
    'platform.tenant.hierarchy.read',
    'platform.tenant.organizations.create',
    'platform.tenant.organizations.lifecycle',
    'platform.tenant.organizations.rename',
    'platform.tenant.organizations.reparent'
  ],
  pg_catalog.clock_timestamp() - interval '1 minute', null, 1,
  pg_catalog.clock_timestamp(), '95700000-0000-4000-8000-000000000001',
  'a5700000-0000-4000-8000-000000000024', pg_catalog.clock_timestamp(),
  '95700000-0000-4000-8000-000000000001',
  'a5700000-0000-4000-8000-000000000024'
);

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at,
  revoked_at, revoked_by_organization_account_id, accepted_at,
  accepted_organization_account_id, changed_at, revision
) values
  (
    '35700000-0000-4000-8000-000000000001',
    '25700000-0000-4000-8000-000000000001', 'pending@example.test',
    'sha256:' || pg_catalog.repeat('1', 64),
    '55700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() - interval '1 hour',
    pg_catalog.clock_timestamp() - interval '1 hour',
    pg_catalog.clock_timestamp() + interval '1 day', null, null, null, null,
    pg_catalog.clock_timestamp() - interval '1 hour', 1
  ),
  (
    '35700000-0000-4000-8000-000000000002',
    '25700000-0000-4000-8000-000000000001', 'revoked@example.test',
    'sha256:' || pg_catalog.repeat('2', 64),
    '55700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() + interval '1 day',
    pg_catalog.clock_timestamp() - interval '1 hour',
    '55700000-0000-4000-8000-000000000001', null, null,
    pg_catalog.clock_timestamp() - interval '1 hour', 2
  ),
  (
    '35700000-0000-4000-8000-000000000003',
    '25700000-0000-4000-8000-000000000001', 'accepted@example.test',
    'sha256:' || pg_catalog.repeat('3', 64),
    '55700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() + interval '1 day', null, null,
    pg_catalog.clock_timestamp() - interval '1 hour',
    '55700000-0000-4000-8000-000000000002',
    pg_catalog.clock_timestamp() - interval '1 hour', 2
  ),
  (
    '35700000-0000-4000-8000-000000000004',
    '25700000-0000-4000-8000-000000000002', 'foreign@example.test',
    'sha256:' || pg_catalog.repeat('4', 64),
    '55700000-0000-4000-8000-000000000005',
    pg_catalog.clock_timestamp() - interval '1 hour',
    pg_catalog.clock_timestamp() - interval '1 hour',
    pg_catalog.clock_timestamp() + interval '1 day', null, null, null, null,
    pg_catalog.clock_timestamp() - interval '1 hour', 1
  ),
  (
    '35700000-0000-4000-8000-000000000005',
    '25700000-0000-4000-8000-000000000001', 'expired@example.test',
    'sha256:' || pg_catalog.repeat('5', 64),
    '55700000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() - interval '2 hours',
    pg_catalog.clock_timestamp() - interval '1 hour', null, null, null, null,
    pg_catalog.clock_timestamp() - interval '2 hours', 1
  );

create function pg_temp.install_local_administration_context(
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
  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '25700000-0000-4000-8000-000000000001';
  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'b5700000-0000-4000-8000-000000000001',
    'tenantId', '15700000-0000-4000-8000-000000000001',
    'organizationId', '25700000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', 'c5700000-0000-4000-8000-000000000001',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a5700000-0000-4000-8000-000000000099'
  ));
end
$function$;

create function pg_temp.local_administration_state()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'tenantFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.tenant_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.tenants
        where tenant_id = '15700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'organizationFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.organization_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.organizations
        where tenant_id = '15700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'identityFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.identity_id),
        '[]'::jsonb
      )
      from (
        select projection.* from vortex_identity.identity_projections as projection
        where exists (
          select 1 from vortex_identity.organization_accounts as account
          join vortex_identity.organizations as organization
            on organization.organization_id = account.organization_id
          where organization.tenant_id = '15700000-0000-4000-8000-000000000001'
            and account.identity_id = projection.identity_id
        )
      ) as fact
    ),
    'accountFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.organization_account_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.organization_accounts
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'invitationFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.invitation_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.organization_invitations
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'settingsFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.organization_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.organization_runtime_settings
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'tenantAdministratorFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.assignment_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.tenant_administrator_assignments
        where tenant_id = '15700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'roleFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.role_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_access.organization_roles
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'roleRevisionFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(fact) order by fact.role_id, fact.revision
        ), '[]'::jsonb
      )
      from (
        select * from vortex_access.organization_role_revisions
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'rolePermissionFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(fact)
          order by fact.role_id, fact.role_revision, fact.entry_ordinal
        ), '[]'::jsonb
      )
      from (
        select * from vortex_access.organization_role_permission_entries
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'roleAssignmentFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(fact) order by fact.role_assignment_id
        ), '[]'::jsonb
      )
      from (
        select * from vortex_access.organization_role_assignments
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'accessVersionFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.organization_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_access.organization_access_versions
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'administrationReceipts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.receipt_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_identity.accepted_administration_receipts
        where tenant_id = '15700000-0000-4000-8000-000000000001'
      ) as fact
    ),
    'activityFacts', (
      select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(fact) order by fact.activity_id),
        '[]'::jsonb
      )
      from (
        select * from vortex_activity.organization_activity_entries
        where organization_id = '25700000-0000-4000-8000-000000000001'
      ) as fact
    )
  )
$function$;

create temporary table absent_settings_read_before on commit drop as
select pg_temp.local_administration_state() as state;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000008',
  '55700000-0000-4000-8000-000000000008'
);
set local role vortex_request;
select results_eq(
  $$select outcome from vortex_access.read_organization_runtime_settings_for_administration()$$,
  $$values ('unavailable'::text)$$,
  'runtime_settings.read alone allows the settings wrapper and reports explicit absence'
);
reset role;
select is(
  pg_temp.local_administration_state()::text,
  (select state::text from absent_settings_read_before),
  'an authorized absent settings read changes no scoped fact, receipt, Activity or Access version'
);

select * from vortex_identity.initialize_organization_runtime_settings(
  '25700000-0000-4000-8000-000000000001',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
);

create temporary table successful_reads_before on commit drop as
select pg_temp.local_administration_state() as state;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000006',
  '55700000-0000-4000-8000-000000000006'
);
set local role vortex_request;
select is(
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.jsonb_array_length(accounts),
      'next', next_after_organization_account_id,
      'states', (
        select pg_catalog.jsonb_agg(item ->> 'state' order by item ->> 'organizationAccountId')
        from pg_catalog.jsonb_array_elements(accounts) as item
      ),
      'safeKeys', (
        select pg_catalog.bool_and(
          (item - array[
            'organizationAccountId', 'displayName', 'state', 'language',
            'timeZone', 'revision'
          ]) = '{}'::jsonb
        )
        from pg_catalog.jsonb_array_elements(accounts) as item
      )
    )
    from vortex_access.list_organization_accounts_for_administration(null, 3)
  )::text,
  pg_catalog.jsonb_build_object(
    'count', 3,
    'next', '55700000-0000-4000-8000-000000000003'::uuid,
    'states', pg_catalog.jsonb_build_array('active', 'suspended', 'closed'),
    'safeKeys', true
  )::text,
  'accounts.read alone allows the account list wrapper with exact safe fields'
);
select results_eq(
  $$select outcome || '|' || (account_summary ->> 'organizationAccountId')
    from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000002'
    )$$,
  $$values ('available|55700000-0000-4000-8000-000000000002'::text)$$,
  'accounts.read alone allows the account detail wrapper'
);
select results_eq(
  $$select item ->> 'organizationAccountId'
    from vortex_access.list_organization_accounts_for_administration(
      '55700000-0000-4000-8000-000000000005', 100
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.accounts) as item
    order by item ->> 'organizationAccountId'$$,
  $$values
    ('55700000-0000-4000-8000-000000000006'::text),
    ('55700000-0000-4000-8000-000000000007'::text),
    ('55700000-0000-4000-8000-000000000008'::text),
    ('55700000-0000-4000-8000-000000000009'::text)$$,
  'a foreign account cursor remains an opaque ordering boundary without widening scope'
);
select results_eq(
  $$select outcome from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000005'
    )$$,
  $$values ('unavailable'::text)$$,
  'a foreign account detail has the same unavailable outcome as absence'
);
select throws_ok(
  $$select * from vortex_access.list_organization_accounts_for_administration(null, 0)$$,
  '22023'::char(5), 'Organization account administration page input is invalid',
  'account page size zero is rejected inside the protected SQL path'
);
reset role;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000007',
  '55700000-0000-4000-8000-000000000007'
);
set local role vortex_request;
select is(
  (
    select pg_catalog.jsonb_build_object(
      'count', pg_catalog.jsonb_array_length(invitations),
      'next', next_after_invitation_id,
      'safeKeys', (
        select pg_catalog.bool_and(
          not item ? 'tokenFingerprint'
          and not item ? 'accessIntent'
          and not item ? 'providerProfile'
        )
        from pg_catalog.jsonb_array_elements(invitations) as item
      )
    )
    from vortex_access.list_organization_invitations_for_administration(null, 2)
  )::text,
  pg_catalog.jsonb_build_object(
    'count', 2,
    'next', '35700000-0000-4000-8000-000000000002'::uuid,
    'safeKeys', true
  )::text,
  'invitations.read alone allows the bounded invitation list wrapper'
);
select results_eq(
  $$select outcome || '|' || (invitation ->> 'invitationId')
    from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000001'
    )$$,
  $$values ('available|35700000-0000-4000-8000-000000000001'::text)$$,
  'invitations.read alone allows the invitation detail wrapper'
);
select is(
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', item ->> 'invitationId',
        'revoked', item ? 'revokedAt',
        'accepted', item ? 'acceptedAt',
        'expired', not item ? 'revokedAt' and not item ? 'acceptedAt'
          and (item ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp()
      ) order by item ->> 'invitationId'
    )
    from vortex_access.list_organization_invitations_for_administration(null, 100) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.invitations) as item
  )::text,
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000001',
      'revoked', false, 'accepted', false, 'expired', false
    ),
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000002',
      'revoked', true, 'accepted', false, 'expired', false
    ),
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000003',
      'revoked', false, 'accepted', true, 'expired', false
    ),
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000005',
      'revoked', false, 'accepted', false, 'expired', true
    )
  )::text,
  'invitation list retains pending, revoked, accepted and expired lifecycle facts'
);
select results_eq(
  $$select item ->> 'invitationId'
    from vortex_access.list_organization_invitations_for_administration(
      '35700000-0000-4000-8000-000000000004', 100
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.invitations) as item$$,
  $$values ('35700000-0000-4000-8000-000000000005'::text)$$,
  'a foreign invitation cursor remains an opaque ordering boundary without widening scope'
);
select results_eq(
  $$select outcome from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000004'
    )$$,
  $$values ('unavailable'::text)$$,
  'a foreign invitation detail has the same unavailable outcome as absence'
);
select throws_ok(
  $$select * from vortex_access.list_organization_invitations_for_administration(
      '00000000-0000-0000-0000-000000000000', 10
    )$$,
  '22023'::char(5), 'Organization invitation administration page input is invalid',
  'nil invitation cursors are rejected inside the protected SQL path'
);
reset role;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000008',
  '55700000-0000-4000-8000-000000000008'
);
set local role vortex_request;
select is(
  (
    select settings
    from vortex_access.read_organization_runtime_settings_for_administration()
  )::text,
  pg_catalog.jsonb_build_object(
    'organizationId', '25700000-0000-4000-8000-000000000001'::uuid,
    'language', 'en-NZ', 'timeZone', 'Pacific/Auckland', 'currency', 'NZD',
    'dateFormat', 'medium', 'numberFormat', 'auto', 'revision', 1
  )::text,
  'runtime_settings.read alone allows the settings wrapper'
);
reset role;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000009',
  '55700000-0000-4000-8000-000000000009'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_accounts_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'accounts.manage does not substitute for accounts.read on the list wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000001'
    )$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'accounts.manage does not substitute for accounts.read on the detail wrapper'
);
select throws_ok(
  $$select * from vortex_access.list_organization_invitations_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'invitations.manage does not substitute for invitations.read on the list wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000001'
    )$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'invitations.manage does not substitute for invitations.read on the detail wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_runtime_settings_for_administration()$$,
  '42501'::char(5),
  'Organization runtime settings administration read is unavailable',
  'runtime_settings.manage does not substitute for runtime_settings.read'
);
reset role;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000007',
  '55700000-0000-4000-8000-000000000007'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_accounts_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'invitations.read does not substitute for accounts.read on the list wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000001'
    )$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'invitations.read does not substitute for accounts.read on the detail wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_runtime_settings_for_administration()$$,
  '42501'::char(5),
  'Organization runtime settings administration read is unavailable',
  'invitations.read does not substitute for runtime_settings.read'
);
reset role;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000006',
  '55700000-0000-4000-8000-000000000006'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_invitations_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'accounts.read does not substitute for invitations.read on the list wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000001'
    )$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'accounts.read does not substitute for invitations.read on the detail wrapper'
);
reset role;

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000004',
  '55700000-0000-4000-8000-000000000004'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_accounts_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'tenant authority does not substitute for accounts.read on the list wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000001'
    )$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'tenant authority does not substitute for accounts.read on the detail wrapper'
);
select throws_ok(
  $$select * from vortex_access.list_organization_invitations_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'tenant authority does not substitute for invitations.read on the list wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000001'
    )$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'tenant authority does not substitute for invitations.read on the detail wrapper'
);
select throws_ok(
  $$select * from vortex_access.read_organization_runtime_settings_for_administration()$$,
  '42501'::char(5),
  'Organization runtime settings administration read is unavailable',
  'tenant authority does not substitute for runtime_settings.read'
);
reset role;

select is(
  pg_temp.local_administration_state()::text,
  (select state::text from successful_reads_before),
  'all five authorized reads and refusal paths change no scoped fact, receipt, Activity or Access version'
);

select * from finish();
rollback;
