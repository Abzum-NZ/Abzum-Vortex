begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_function(
  'vortex_identity',
  'accept_organization_invitation',
  array['text', 'uuid', 'text', 'text', 'uuid'],
  'Identity retains the existing invitation acceptance signature'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_identity.accept_organization_invitation(text,uuid,text,text,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot call the owner-only Identity acceptance writer'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13550000-0000-4000-8000-000000000001', 'invitation_audit_time',
  'Invitation audit time', 'active', '2026-09-06 00:00:00+00',
  '93550000-0000-4000-8000-000000000001',
  '2026-09-06 00:00:00+00', 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '23550000-0000-4000-8000-000000000001',
  '13550000-0000-4000-8000-000000000001', 'invitation_audit_time',
  'Invitation audit time', 'active', '2026-09-06 00:00:00+00',
  '93550000-0000-4000-8000-000000000001',
  '2026-09-06 00:00:00+00', 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43550000-0000-4000-8000-000000000001', 'active',
    '2026-09-06 00:00:00+00', '2026-09-06 00:00:00+00',
    '93550000-0000-4000-8000-000000000001',
    '73550000-0000-4000-8000-000000000001', 1
  ),
  (
    '43550000-0000-4000-8000-000000000002', 'active',
    '2026-09-06 00:00:00+00', '2026-09-06 00:00:00+00',
    '93550000-0000-4000-8000-000000000001',
    '73550000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, suspended_at, changed_at, state_changed_at,
  state_changed_by, state_change_correlation_id, revision
) values
  (
    '53550000-0000-4000-8000-000000000001',
    '23550000-0000-4000-8000-000000000001',
    '43550000-0000-4000-8000-000000000001', 'Inviter', 'active',
    '2026-09-06 00:00:00+00', null, '2026-09-06 00:00:00+00',
    '2026-09-06 00:00:00+00',
    '93550000-0000-4000-8000-000000000001',
    '73550000-0000-4000-8000-000000000003', 1
  ),
  (
    '53550000-0000-4000-8000-000000000002',
    '23550000-0000-4000-8000-000000000001',
    '43550000-0000-4000-8000-000000000002', 'Returning person',
    'suspended', '2026-09-06 00:00:00+00', '2099-01-01 00:00:00+00',
    '2099-01-01 00:00:00+00', '2099-01-01 00:00:00+00',
    '93550000-0000-4000-8000-000000000001',
    '73550000-0000-4000-8000-000000000004', 2
  );

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at,
  changed_at, revision
) values (
  '63550000-0000-4000-8000-000000000001',
  '23550000-0000-4000-8000-000000000001',
  'returning@example.test',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '53550000-0000-4000-8000-000000000001',
  '2099-01-02 00:00:00+00', '2099-01-02 00:00:00+00',
  '2099-02-01 00:00:00+00', '2099-03-01 00:00:00+00', 1
);

create temporary table future_audit_acceptance on commit drop as
select *
from vortex_identity.accept_organization_invitation_with_transition(
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '43550000-0000-4000-8000-000000000002',
  'returning@example.test', 'Returning person',
  '73550000-0000-4000-8000-000000000010'
);

select is(
  (
    select outcome || '|' || access_transition || '|' || state || '|' ||
      revision::text || '|' || changed_at::text || '|' ||
      state_changed_at::text
    from future_audit_acceptance
  ),
  'accepted|reactivated|active|3|2099-03-01 00:00:00+00|2099-03-01 00:00:00+00',
  'future audit evidence after expiry permits the exact next account revision without becoming the expiry clock'
);

select is(
  (
    select invitation.revision::text || '|' || invitation.accepted_at::text ||
      '|' || invitation.changed_at::text || '|' ||
      invitation.accepted_organization_account_id::text
    from vortex_identity.organization_invitations as invitation
    where invitation.invitation_id = '63550000-0000-4000-8000-000000000001'
  ),
  '2|2099-03-01 00:00:00+00|2099-03-01 00:00:00+00|53550000-0000-4000-8000-000000000002',
  'the accepted invitation advances exactly once at its nondecreasing audit time'
);

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at,
  changed_at, revision
) values (
  '63550000-0000-4000-8000-000000000002',
  '23550000-0000-4000-8000-000000000001',
  'expired-first-use@example.test',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '53550000-0000-4000-8000-000000000001',
  '2026-09-01 00:00:00+00', '2026-09-01 00:00:00+00',
  '2026-09-02 00:00:00+00', '2026-09-01 00:00:00+00', 1
);

create temporary table expired_first_use on commit drop as
select *
from vortex_identity.accept_organization_invitation_with_transition(
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '43550000-0000-4000-8000-000000000003',
  'expired-first-use@example.test', 'Expired person',
  '73550000-0000-4000-8000-000000000020'
);

select is(
  (select outcome || '|' || access_transition from expired_first_use),
  'unavailable|unchanged',
  'actual database time still refuses an expired first use'
);
select is(
  (
    select invitation.revision::text || '|' ||
      case when invitation.accepted_at is null then 'pending' else 'accepted' end ||
      '|' || (
        select pg_catalog.count(*)
        from vortex_identity.identity_projections as projection
        where projection.identity_id = '43550000-0000-4000-8000-000000000003'
      )::text
    from vortex_identity.organization_invitations as invitation
    where invitation.invitation_id = '63550000-0000-4000-8000-000000000002'
  ),
  '1|pending|0',
  'expired first use leaves the invitation and beneficiary Identity unchanged'
);

insert into vortex_identity.organization_invitations (
  invitation_id, organization_id, invited_email, token_fingerprint,
  invited_by_organization_account_id, created_at, invited_at, expires_at,
  accepted_at, accepted_organization_account_id, changed_at, revision
) values (
  '63550000-0000-4000-8000-000000000003',
  '23550000-0000-4000-8000-000000000001',
  'accepted-replay@example.test',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '53550000-0000-4000-8000-000000000001',
  '2026-08-01 00:00:00+00', '2026-08-01 00:00:00+00',
  '2026-08-02 00:00:00+00', '2026-08-03 00:00:00+00',
  '53550000-0000-4000-8000-000000000002',
  '2026-08-03 00:00:00+00', 2
);

create temporary table accepted_expired_replay on commit drop as
select *
from vortex_identity.accept_organization_invitation_with_transition(
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '43550000-0000-4000-8000-000000000002',
  'accepted-replay@example.test', 'Returning person',
  '73550000-0000-4000-8000-000000000030'
);

select is(
  (
    select outcome || '|' || access_transition || '|' || revision::text
    from accepted_expired_replay
  ),
  'already_accepted|unchanged|3',
  'accepted replay remains available after the invitation expiry'
);
select is(
  (
    select invitation.revision::text || '|' || invitation.accepted_at::text ||
      '|' || account.revision::text || '|' || account.changed_at::text
    from vortex_identity.organization_invitations as invitation
    join vortex_identity.organization_accounts as account
      on account.organization_id = invitation.organization_id
      and account.organization_account_id = invitation.accepted_organization_account_id
    where invitation.invitation_id = '63550000-0000-4000-8000-000000000003'
  ),
  '2|2026-08-03 00:00:00+00|3|2099-03-01 00:00:00+00',
  'accepted replay mutates neither the terminal invitation nor current account'
);

set constraints all immediate;

select * from finish();

rollback;
