\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_identity',
  'postgres',
  true,
  false
);

select has_table('vortex_identity', 'identity_projections', 'identity projection storage exists');
select has_table('vortex_identity', 'organization_accounts', 'organisation-account storage exists');
select has_table(
  'vortex_identity',
  'organization_invitations',
  'organisation-invitation storage exists'
);

select columns_are(
  'vortex_identity',
  'identity_projections',
  array[
    'identity_id', 'state', 'created_at', 'state_changed_at', 'state_changed_by',
    'state_change_correlation_id', 'revision'
  ],
  'identity projections contain only cluster-local eligibility and state evidence'
);
select columns_are(
  'vortex_identity',
  'organization_accounts',
  array[
    'organization_account_id', 'organization_id', 'identity_id', 'display_name', 'state',
    'language', 'time_zone', 'originating_invitation_id', 'activated_at', 'suspended_at',
    'closed_at', 'changed_at', 'state_changed_at', 'state_changed_by',
    'state_change_correlation_id', 'revision'
  ],
  'organisation accounts contain explicit local profile and lifecycle evidence'
);
select columns_are(
  'vortex_identity',
  'organization_invitations',
  array[
    'invitation_id', 'organization_id', 'invited_email', 'token_fingerprint',
    'invited_by_organization_account_id', 'created_at', 'invited_at', 'expires_at',
    'revoked_at', 'revoked_by_organization_account_id', 'accepted_at',
    'accepted_organization_account_id', 'changed_at', 'revision'
  ],
  'invitations contain only scope, one-way fingerprint and lifecycle evidence'
);

select has_pk('vortex_identity', 'identity_projections', 'identity projections have a primary key');
select has_pk('vortex_identity', 'organization_accounts', 'organisation accounts have a primary key');
select has_pk('vortex_identity', 'organization_invitations', 'invitations have a primary key');
select has_fk(
  'vortex_identity',
  'organization_accounts',
  'organisation accounts reference their organisation, identity and originating invitation'
);
select has_fk(
  'vortex_identity',
  'organization_invitations',
  'invitation account references carry organisation scope'
);
select has_index(
  'vortex_identity',
  'organization_accounts',
  'organization_accounts_organization_identity_unique',
  'one identity can have only one account in an organisation'
);
select has_index(
  'vortex_identity',
  'organization_accounts',
  'organization_accounts_identity_lookup_idx',
  'launcher lookup starts with identity scope'
);
select has_index(
  'vortex_identity',
  'organization_invitations',
  'organization_invitations_token_fingerprint_unique',
  'acceptance fingerprints are globally unique'
);
select has_index(
  'vortex_identity',
  'organization_invitations',
  'organization_invitations_organization_email_idx',
  'administrative invitation lookup starts with organisation and email'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class
    where oid in (
      'vortex_identity.identity_projections'::regclass,
      'vortex_identity.organization_accounts'::regclass,
      'vortex_identity.organization_invitations'::regclass
    )
      and relrowsecurity
      and relforcerowsecurity
  ),
  3,
  'all three private relations enable and force row security'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'vortex_identity'
      and tablename in (
        'identity_projections', 'organization_accounts', 'organization_invitations'
      )
  ),
  0,
  'private Identity relations expose no direct row policy'
);

select ok(
  not pg_catalog.has_table_privilege(
    'vortex_runtime', 'vortex_identity.organization_accounts', 'SELECT,INSERT,UPDATE,DELETE'
  ),
  'runtime has no direct organisation-account table privilege'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_identity.organization_invitations', 'SELECT,INSERT,UPDATE,DELETE'
  ),
  'request code has no direct invitation table privilege'
);
select ok(
  not pg_catalog.has_table_privilege(
    'service_role', 'vortex_identity.identity_projections', 'SELECT,INSERT,UPDATE,DELETE'
  ),
  'Supabase service_role cannot bypass identity projection storage'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public', 'vortex_identity.accept_organization_invitation(text,uuid,text,text,uuid)', 'EXECUTE'
  ),
  'PUBLIC cannot execute invitation acceptance'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.accept_organization_invitation(text,uuid,text,text,uuid)',
    'EXECUTE'
  ),
  'runtime cannot bypass Access-owned invitation composition'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.accept_organization_invitation_with_transition(text,uuid,text,text,uuid)',
    'EXECUTE'
  ),
  'the Identity transition classifier remains owner-only'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_identity.create_organization_invitation(text,text,timestamptz)',
    'EXECUTE'
  ),
  'runtime cannot bypass request context to create invitations'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_identity.create_organization_invitation(text,text,timestamptz)',
    'EXECUTE'
  ),
  'request code cannot call the invitation helper before Access authorisation is composed'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc
    where oid in (
      'vortex_identity.ensure_identity_projection(uuid,uuid)'::regprocedure,
      'vortex_identity.list_organization_accounts(uuid)'::regprocedure,
      'vortex_identity.create_organization_invitation(text,text,timestamptz)'::regprocedure,
      'vortex_identity.revoke_organization_invitation(uuid,bigint)'::regprocedure,
      'vortex_identity.change_organization_account_state(uuid,bigint,text)'::regprocedure,
      'vortex_identity.accept_organization_invitation(text,uuid,text,text,uuid)'::regprocedure,
      'vortex_identity.accept_organization_invitation_with_transition(text,uuid,text,text,uuid)'::regprocedure
    ) and prosecdef and proconfig @> array['search_path=""']
  ),
  7,
  'every callable Identity operation is security definer with an empty search path'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values
  (
    '10000000-0000-4000-8000-000000000090', 'account_tenant_one', 'Account tenant one',
    'active', pg_catalog.statement_timestamp(), '90000000-0000-4000-8000-000000000090',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '10000000-0000-4000-8000-000000000091', 'account_tenant_two', 'Account tenant two',
    'active', pg_catalog.statement_timestamp(), '90000000-0000-4000-8000-000000000090',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '20000000-0000-4000-8000-000000000090', '10000000-0000-4000-8000-000000000090',
    null, 'account_org_one', 'Account organisation one', 'active',
    pg_catalog.statement_timestamp(), '90000000-0000-4000-8000-000000000090',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '20000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000091',
    null, 'account_org_two', 'Account organisation two', 'active',
    pg_catalog.statement_timestamp(), '90000000-0000-4000-8000-000000000090',
    pg_catalog.statement_timestamp(), 1
  );

select * from vortex_access.initialize_organization_access_version(
  '20000000-0000-4000-8000-000000000090',
  '90000000-0000-4000-8000-000000000090',
  '70000000-0000-4000-8000-000000000080'
);
select * from vortex_access.initialize_organization_access_version(
  '20000000-0000-4000-8000-000000000091',
  '90000000-0000-4000-8000-000000000090',
  '70000000-0000-4000-8000-000000000081'
);

select lives_ok(
  $$
    set local role vortex_runtime;
    select * from vortex_identity.ensure_identity_projection(
      '40000000-0000-4000-8000-000000000090',
      '70000000-0000-4000-8000-000000000090'
    );
    reset role
  $$,
  'trusted runtime can ensure one minimal identity projection'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.identity_projections
    where identity_id = '40000000-0000-4000-8000-000000000090'
  ),
  1,
  'ensuring the same identity is idempotent'
);
select lives_ok(
  $$
    set local role vortex_runtime;
    select * from vortex_identity.ensure_identity_projection(
      '40000000-0000-4000-8000-000000000090',
      '70000000-0000-4000-8000-000000000091'
    );
    reset role
  $$,
  'a repeated verified identity result does not reactivate or duplicate the projection'
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '40000000-0000-4000-8000-000000000099', 'active', pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '40000000-0000-4000-8000-000000000099',
  '70000000-0000-4000-8000-000000000099', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '50000000-0000-4000-8000-000000000099', '20000000-0000-4000-8000-000000000090',
  '40000000-0000-4000-8000-000000000099', 'Inviter', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '40000000-0000-4000-8000-000000000099',
  '70000000-0000-4000-8000-000000000099', 1
);

select vortex_context.initialize(
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'tenantId', '10000000-0000-4000-8000-000000000090',
    'organizationId', '20000000-0000-4000-8000-000000000090',
    'sessionId', '60000000-0000-4000-8000-000000000090',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '10 minutes',
    'accessVersion', 1,
    'correlationId', '70000000-0000-4000-8000-000000000098',
    'identityId', '40000000-0000-4000-8000-000000000099',
    'organizationAccountId', '50000000-0000-4000-8000-000000000099',
    'authenticationStrength', 'single_factor'
  )
);
create temporary table created_invitation on commit drop as
select * from vortex_identity.create_organization_invitation(
  'person@example.test',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pg_catalog.statement_timestamp() + interval '1 day'
);

select is(
  (select count(*)::integer from vortex_identity.organization_accounts),
  1,
  'issuing an invitation creates no placeholder organisation account'
);
select is(
  (select invited_email from created_invitation),
  'person@example.test',
  'invitation creation stores the exact normalized email'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'vortex_identity'
      and table_name in ('identity_projections', 'organization_accounts', 'organization_invitations')
      and column_name ~ '(password|secret|raw_token|refresh_token|mfa|provider_metadata|access_version)'
  ),
  'Identity persistence contains no credential, raw token, MFA or Access-version column'
);

set local role vortex_runtime;
create temporary table wrong_email_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '40000000-0000-4000-8000-000000000090',
  'other@example.test',
  'Person',
  '70000000-0000-4000-8000-000000000092'
);
reset role;
select is(
  (select outcome from wrong_email_result),
  'unavailable',
  'a token without exact verified-email control cannot accept an invitation'
);
select is(
  (select count(*)::integer from vortex_identity.organization_accounts),
  1,
  'wrong-email refusal creates no organisation account'
);

set local role vortex_runtime;
create temporary table accepted_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '40000000-0000-4000-8000-000000000090',
  'person@example.test',
  'Person',
  '70000000-0000-4000-8000-000000000093'
);
reset role;
select is((select outcome from accepted_result), 'accepted', 'the matching identity accepts once');
select is(
  (select access_version from accepted_result),
  2::bigint,
  'first account activation increments the Access-owned version once'
);
select is(
  (
    select count(*)::integer
    from vortex_identity.organization_accounts
    where organization_id = '20000000-0000-4000-8000-000000000090'
      and identity_id = '40000000-0000-4000-8000-000000000090'
  ),
  1,
  'acceptance creates exactly one account for the identity and organisation'
);
select ok(
  exists (
    select 1
    from vortex_identity.organization_invitations as invitation
    join accepted_result as accepted
      on accepted.organization_account_id = invitation.accepted_organization_account_id
    where invitation.accepted_at is not null
  ),
  'acceptance binds the invitation to the same-organisation account'
);

set local role vortex_runtime;
create temporary table replay_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '40000000-0000-4000-8000-000000000090',
  'person@example.test',
  'Changed name',
  '70000000-0000-4000-8000-000000000094'
);
reset role;
select is(
  (select outcome from replay_result),
  'already_accepted',
  'the same verified identity receives an idempotent replay result'
);
select is(
  (select display_name from replay_result),
  'Person',
  'an invitation replay cannot overwrite the existing local profile'
);
select is(
  (select access_version from replay_result),
  2::bigint,
  'an invitation replay returns the unchanged current access version'
);

create temporary table active_account_invitation on commit drop as
select * from vortex_identity.create_organization_invitation(
  'person@example.test',
  'sha256:abababababababababababababababababababababababababababababababab',
  pg_catalog.statement_timestamp() + interval '1 day'
);
set local role vortex_runtime;
create temporary table active_account_acceptance on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:abababababababababababababababababababababababababababababababab',
  '40000000-0000-4000-8000-000000000090',
  'person@example.test',
  null,
  '70000000-0000-4000-8000-000000000096'
);
reset role;
select is(
  (select outcome from active_account_acceptance),
  'accepted',
  'a fresh valid invitation may bind to an already-active account'
);
select is(
  (select access_version from active_account_acceptance),
  2::bigint,
  'binding a fresh invitation to an already-active account does not invalidate access'
);
select is(
  (
    select revision from vortex_identity.organization_accounts
    where organization_account_id = (select organization_account_id from accepted_result)
  ),
  1::bigint,
  'the no-op account binding leaves the account revision unchanged'
);

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at,
  accepted_at, accepted_organization_account_id, changed_at, revision
) values (
  '80000000-0000-4000-8000-000000000094',
  '20000000-0000-4000-8000-000000000090',
  'person@example.test',
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '50000000-0000-4000-8000-000000000099',
  pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '1 day',
  pg_catalog.statement_timestamp() - interval '36 hours',
  (select organization_account_id from accepted_result),
  pg_catalog.statement_timestamp() - interval '36 hours',
  2
);
set local role vortex_runtime;
create temporary table expired_accepted_replay_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '40000000-0000-4000-8000-000000000090',
  'person@example.test',
  null,
  '70000000-0000-4000-8000-000000000094'
);
reset role;
select is(
  (select outcome from expired_accepted_replay_result),
  'already_accepted',
  'the accepting identity can replay an already accepted link after its original expiry'
);

set local role vortex_runtime;
create temporary table other_identity_replay on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '40000000-0000-4000-8000-000000000098',
  'person@example.test',
  null,
  '70000000-0000-4000-8000-000000000095'
);
reset role;
select is(
  (select outcome from other_identity_replay),
  'unavailable',
  'another identity cannot reuse an accepted invitation'
);

select throws_ok(
  $$
    insert into vortex_identity.organization_accounts (
      organization_account_id, organization_id, identity_id, state, activated_at, changed_at,
      state_changed_at, state_changed_by, state_change_correlation_id, revision
    ) values (
      '50000000-0000-4000-8000-000000000090',
      '20000000-0000-4000-8000-000000000090',
      '40000000-0000-4000-8000-000000000090',
      'active', now(), now(), now(),
      '40000000-0000-4000-8000-000000000090',
      '70000000-0000-4000-8000-000000000096', 1
    )
  $$,
  '23505'::char(5),
  null,
  'a second account for the same identity and organisation is refused'
);
select throws_ok(
  $$
    update vortex_identity.organization_invitations
    set organization_id = '20000000-0000-4000-8000-000000000091', revision = revision + 1
    where token_fingerprint =
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  $$,
  '23514'::char(5),
  null,
  'an invitation cannot move to another organisation'
);
select throws_ok(
  $$
    update vortex_identity.organization_accounts
    set organization_id = '20000000-0000-4000-8000-000000000091', revision = revision + 1
    where identity_id = '40000000-0000-4000-8000-000000000090'
  $$,
  '23514'::char(5),
  null,
  'an organisation account cannot move to another organisation'
);

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at, changed_at, revision
) values (
  '80000000-0000-4000-8000-000000000090',
  '20000000-0000-4000-8000-000000000090',
  'expired@example.test',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '50000000-0000-4000-8000-000000000099',
  pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '2 days',
  pg_catalog.statement_timestamp() - interval '1 day',
  pg_catalog.statement_timestamp() - interval '2 days',
  1
);
set local role vortex_runtime;
create temporary table expired_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '40000000-0000-4000-8000-000000000098',
  'expired@example.test',
  null,
  '70000000-0000-4000-8000-000000000097'
);
reset role;
select is((select outcome from expired_result), 'unavailable', 'expiry is enforced at first acceptance');

create temporary table original_activation on commit drop as
select organization_account_id, activated_at
from accepted_result;

update vortex_identity.organization_accounts
set state = 'suspended', suspended_at = pg_catalog.statement_timestamp(),
    changed_at = pg_catalog.statement_timestamp(),
    state_changed_at = pg_catalog.statement_timestamp(),
    state_changed_by = '40000000-0000-4000-8000-000000000090',
    state_change_correlation_id = '70000000-0000-4000-8000-000000000097',
    revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000090'
  and identity_id = '40000000-0000-4000-8000-000000000090';
select pg_catalog.pg_sleep(0.01);

create temporary table reactivation_invitation on commit drop as
select * from vortex_identity.create_organization_invitation(
  'person@example.test',
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  pg_catalog.statement_timestamp() + interval '1 day'
);
set local role vortex_runtime;
create temporary table invitation_reactivation_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '40000000-0000-4000-8000-000000000090',
  'person@example.test',
  null,
  '70000000-0000-4000-8000-000000000097'
);
reset role;
select is(
  (select outcome from invitation_reactivation_result),
  'accepted',
  'a fresh invitation can reactivate its matching inactive account'
);
select is(
  (select activated_at from invitation_reactivation_result),
  (select activated_at from original_activation),
  'invitation reactivation preserves the account original activation time'
);
select is(
  (select access_version from invitation_reactivation_result),
  3::bigint,
  'invitation reactivation increments the Access-owned version once'
);

create temporary table administrative_suspension on commit drop as
select * from vortex_identity.change_organization_account_state(
  (select organization_account_id from accepted_result),
  (select revision from invitation_reactivation_result),
  'suspended'
);
create temporary table administrative_reactivation on commit drop as
select * from vortex_identity.change_organization_account_state(
  (select organization_account_id from accepted_result),
  (select revision from administrative_suspension),
  'active'
);
select is(
  (select activated_at from administrative_reactivation),
  (select activated_at from original_activation),
  'administrative reactivation preserves the account original activation time'
);

update vortex_identity.organization_accounts
set state = 'suspended', suspended_at = pg_catalog.statement_timestamp(),
    changed_at = pg_catalog.statement_timestamp(),
    state_changed_at = pg_catalog.statement_timestamp(),
    state_changed_by = '40000000-0000-4000-8000-000000000090',
    state_change_correlation_id = '70000000-0000-4000-8000-000000000097',
    revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000090'
  and identity_id = '40000000-0000-4000-8000-000000000090';
set local role vortex_runtime;
create temporary table suspended_account_list_result on commit drop as
select *
from vortex_identity.list_organization_accounts(
  '40000000-0000-4000-8000-000000000090'
);
reset role;
select is(
  (select count(*)::integer from suspended_account_list_result),
  0,
  'the launcher list omits an inactive organisation account'
);

update vortex_identity.identity_projections
set state = 'suspended', state_changed_at = pg_catalog.statement_timestamp(),
    state_changed_by = '90000000-0000-4000-8000-000000000090',
    state_change_correlation_id = '70000000-0000-4000-8000-000000000097',
    revision = revision + 1
where identity_id = '40000000-0000-4000-8000-000000000090';
set local role vortex_runtime;
create temporary table suspended_list_result on commit drop as
select *
from vortex_identity.list_organization_accounts(
  '40000000-0000-4000-8000-000000000090'
);
reset role;
select is(
  (select count(*)::integer from suspended_list_result),
  0,
  'a suspended local projection cannot enter any local organisation account'
);

set local role vortex_runtime;
create temporary table suspended_replay_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '40000000-0000-4000-8000-000000000090',
  'person@example.test',
  null,
  '70000000-0000-4000-8000-000000000097'
);
reset role;
select is(
  (select outcome from suspended_replay_result),
  'identity_inactive',
  'an accepted secret cannot bypass later cluster-local identity suspension'
);

create temporary table inactive_scope_invitation on commit drop as
select * from vortex_identity.create_organization_invitation(
  'inactive-scope@example.test',
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  pg_catalog.statement_timestamp() + interval '1 day'
);
update vortex_identity.organizations
set state = 'suspended', state_changed_at = pg_catalog.statement_timestamp(),
    revision = revision + 1
where organization_id = '20000000-0000-4000-8000-000000000090';
set local role vortex_runtime;
create temporary table inactive_scope_result on commit drop as
select * from vortex_access.accept_organization_invitation(
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '40000000-0000-4000-8000-000000000097',
  'inactive-scope@example.test',
  null,
  '70000000-0000-4000-8000-000000000097'
);
reset role;
select is(
  (select outcome from inactive_scope_result),
  'unavailable',
  'an inactive organisation refuses first acceptance'
);
select is(
  (
    select count(*)::integer from vortex_identity.identity_projections
    where identity_id = '40000000-0000-4000-8000-000000000097'
  ),
  0,
  'inactive-scope refusal creates no identity projection'
);

select * from finish();

rollback;
