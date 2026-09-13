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

select ok(
  pg_catalog.pg_get_functiondef(
    'vortex_access.organization_accounts_administration_scope()'::regprocedure
  ) like '%platform.organization.accounts.read%'
  and pg_catalog.pg_get_functiondef(
    'vortex_access.organization_accounts_administration_scope()'::regprocedure
  ) like '%02c772e5-2921-4300-ad90-4f5772a7fa46%'
  and pg_catalog.pg_get_functiondef(
    'vortex_access.organization_accounts_administration_scope()'::regprocedure
  ) not like '%630a980c-0ff5-40b1-a329-7326a2122395%',
  'account reads declare only the fixed accounts.read permission'
);
select ok(
  pg_catalog.pg_get_functiondef(
    'vortex_access.organization_invitations_administration_scope()'::regprocedure
  ) like '%platform.organization.invitations.read%'
  and pg_catalog.pg_get_functiondef(
    'vortex_access.organization_invitations_administration_scope()'::regprocedure
  ) like '%9300e501-6d56-41b1-b203-3361dbace9bc%'
  and pg_catalog.pg_get_functiondef(
    'vortex_access.organization_invitations_administration_scope()'::regprocedure
  ) not like '%c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb%',
  'invitation reads declare only the fixed invitations.read permission'
);
select ok(
  pg_catalog.pg_get_functiondef(
    'vortex_access.organization_runtime_settings_administration_read_scope()'::regprocedure
  ) like '%platform.organization.runtime_settings.read%'
  and pg_catalog.pg_get_functiondef(
    'vortex_access.organization_runtime_settings_administration_read_scope()'::regprocedure
  ) like '%6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5%'
  and pg_catalog.pg_get_functiondef(
    'vortex_access.organization_runtime_settings_administration_read_scope()'::regprocedure
  ) not like '%c658c254-2884-414a-9012-512c0cfe4b34%',
  'settings reads declare only the fixed runtime_settings.read permission'
);

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
  ('45700000-0000-4000-8000-000000000005'::uuid, 'a5700000-0000-4000-8000-000000000005'::uuid)
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

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000001',
  '55700000-0000-4000-8000-000000000001'
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
  'account list returns all lifecycle variants with exact safe fields and a local cursor'
);

select is(
  (
    select accounts
    from vortex_access.list_organization_accounts_for_administration(
      '55700000-0000-4000-8000-000000000003', 10
    )
  )::text,
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'organizationAccountId', '55700000-0000-4000-8000-000000000004'::uuid,
    'displayName', 'No authority', 'state', 'active', 'revision', 1
  ))::text,
  'the next account page continues strictly after its permanent local ID'
);

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
  'invitation list is bounded and never returns private secret or intent fields'
);

select is(
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', item ->> 'invitationId',
        'revoked', item ? 'revokedAt',
        'accepted', item ? 'acceptedAt'
      ) order by item ->> 'invitationId'
    )
    from vortex_access.list_organization_invitations_for_administration(null, 100) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.invitations) as item
  )::text,
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000001',
      'revoked', false, 'accepted', false
    ),
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000002',
      'revoked', true, 'accepted', false
    ),
    pg_catalog.jsonb_build_object(
      'id', '35700000-0000-4000-8000-000000000003',
      'revoked', false, 'accepted', true
    )
  )::text,
  'invitation list retains pending, revoked and accepted lifecycle facts'
);

select results_eq(
  $$select outcome from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000005'
    )$$,
  $$values ('unavailable'::text)$$,
  'a foreign account ID has the same unavailable detail outcome as absence'
);
select results_eq(
  $$select outcome from vortex_access.read_organization_account_for_administration(
      '55700000-0000-4000-8000-000000000099'
    )$$,
  $$values ('unavailable'::text)$$,
  'a missing account ID has the safe unavailable outcome'
);
select results_eq(
  $$select outcome from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000004'
    )$$,
  $$values ('unavailable'::text)$$,
  'a foreign invitation ID has the same unavailable detail outcome as absence'
);
select results_eq(
  $$select outcome from vortex_access.read_organization_invitation_for_administration(
      '35700000-0000-4000-8000-000000000099'
    )$$,
  $$values ('unavailable'::text)$$,
  'a missing invitation ID has the safe unavailable outcome'
);

select results_eq(
  $$select outcome from vortex_access.read_organization_runtime_settings_for_administration()$$,
  $$values ('unavailable'::text)$$,
  'administrative settings read reports explicit absence before setup'
);

select throws_ok(
  $$select * from vortex_access.list_organization_accounts_for_administration(null, 0)$$,
  '22023'::char(5), 'Organization account administration page input is invalid',
  'account page size zero is rejected inside the protected SQL path'
);
select throws_ok(
  $$select * from vortex_access.list_organization_invitations_for_administration(
      '00000000-0000-0000-0000-000000000000', 10
    )$$,
  '22023'::char(5), 'Organization invitation administration page input is invalid',
  'nil invitation cursors are rejected inside the protected SQL path'
);
select throws_ok(
  $$select * from vortex_access.read_organization_account_for_administration(
      '00000000-0000-0000-0000-000000000000'
    )$$,
  '22023'::char(5), 'Organization account administration detail input is invalid',
  'nil account detail IDs are rejected inside the protected SQL path'
);
reset role;

select * from vortex_identity.initialize_organization_runtime_settings(
  '25700000-0000-4000-8000-000000000001',
  'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
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
  'settings administration reuses the existing Identity-owned whole-row reader'
);
reset role;

create temporary table read_side_effects_before on commit drop as
select
  (select current_version from vortex_access.organization_access_versions
    where organization_id = '25700000-0000-4000-8000-000000000001') as access_version,
  (select pg_catalog.count(*) from vortex_identity.organization_accounts
    where organization_id = '25700000-0000-4000-8000-000000000001') as accounts,
  (select pg_catalog.count(*) from vortex_identity.organization_invitations
    where organization_id = '25700000-0000-4000-8000-000000000001') as invitations,
  (select revision from vortex_identity.organization_runtime_settings
    where organization_id = '25700000-0000-4000-8000-000000000001') as settings_revision,
  (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
    where organization_id = '25700000-0000-4000-8000-000000000001') as activities;

select is(
  (
    select pg_catalog.jsonb_build_object(
      'accessVersion', version.current_version,
      'accounts', (select pg_catalog.count(*) from vortex_identity.organization_accounts
        where organization_id = version.organization_id),
      'invitations', (select pg_catalog.count(*) from vortex_identity.organization_invitations
        where organization_id = version.organization_id),
      'settingsRevision', (select revision from vortex_identity.organization_runtime_settings
        where organization_id = version.organization_id),
      'activities', (select pg_catalog.count(*) from vortex_activity.organization_activity_entries
        where organization_id = version.organization_id)
    )
    from vortex_access.organization_access_versions as version
    where version.organization_id = '25700000-0000-4000-8000-000000000001'
  )::text,
  (
    select pg_catalog.jsonb_build_object(
      'accessVersion', access_version, 'accounts', accounts,
      'invitations', invitations, 'settingsRevision', settings_revision,
      'activities', activities
    )
    from read_side_effects_before
  )::text,
  'administrative reads create no mutation, Activity entry or Access increment'
);

select pg_temp.install_local_administration_context(
  '45700000-0000-4000-8000-000000000004',
  '55700000-0000-4000-8000-000000000004'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_accounts_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization account administration is unavailable',
  'membership without the exact account-read permission does not authorize the read'
);
select throws_ok(
  $$select * from vortex_access.list_organization_invitations_for_administration(null, 10)$$,
  '42501'::char(5), 'Organization invitation administration is unavailable',
  'membership without the exact invitation-read permission does not authorize the read'
);
select throws_ok(
  $$select * from vortex_access.read_organization_runtime_settings_for_administration()$$,
  '42501'::char(5),
  'Organization runtime settings administration read is unavailable',
  'membership without the exact settings-read permission does not authorize the read'
);
reset role;

select * from finish();
rollback;
