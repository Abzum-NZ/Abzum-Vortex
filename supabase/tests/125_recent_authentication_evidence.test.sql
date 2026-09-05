select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

create function pg_temp.human_context(extra jsonb, strength text default 'multi_factor')
returns jsonb
language sql
volatile
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '81000000-0000-4000-8000-000000000001',
    'tenantId', '11000000-0000-4000-8000-000000000001',
    'organizationId', '21000000-0000-4000-8000-000000000001',
    'organizationAccountId', '51000000-0000-4000-8000-000000000001',
    'identityId', '41000000-0000-4000-8000-000000000001',
    'sessionId', '61000000-0000-4000-8000-000000000001',
    'authenticationStrength', strength,
    'issuedAt', pg_catalog.statement_timestamp(),
    'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
    'accessVersion', 1,
    'correlationId', '71000000-0000-4000-8000-000000000001'
  ) || extra
$function$;

grant execute on function pg_temp.human_context(jsonb, text) to vortex_request;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  '12500000-0000-4000-8000-000000000001', 'recent_auth', 'Recent authentication', 'active',
  pg_catalog.statement_timestamp(), '92500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '22500000-0000-4000-8000-000000000001',
  '12500000-0000-4000-8000-000000000001', 'recent_auth', 'Recent authentication', 'active',
  pg_catalog.statement_timestamp(), '92500000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42500000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '42500000-0000-4000-8000-000000000001',
  '72500000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '52500000-0000-4000-8000-000000000001',
  '22500000-0000-4000-8000-000000000001',
  '42500000-0000-4000-8000-000000000001', 'Recent person', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '42500000-0000-4000-8000-000000000001',
  '72500000-0000-4000-8000-000000000002', 1
);

insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by,
  change_correlation_id, change_reason
) values (
  '22500000-0000-4000-8000-000000000001', 7,
  pg_catalog.statement_timestamp(), '52500000-0000-4000-8000-000000000001',
  '72500000-0000-4000-8000-000000000003', 'organization_account_activated'
);

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;

select lives_ok(
  $$select vortex_context.validated(pg_temp.human_context('{}'::jsonb))$$,
  'an ordinary human context remains valid without authentication evidence'
);
select is(
  vortex_context.validated(pg_temp.human_context('{}'::jsonb, 'recent_multi_factor'))
    ? 'multiFactorAuthenticatedAt',
  false,
  'the legacy recent-multi-factor label does not synthesize recency evidence'
);
select lives_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp() + interval '60 seconds',
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp(),
      'multiFactorAuthenticatedAt', pg_catalog.statement_timestamp() - interval '1 minute'
    )))
  $$,
  'verified primary and MFA times survive the exact token-skew boundary'
);
select lives_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'multiFactorAuthenticatedAt', pg_catalog.statement_timestamp() - interval '1 minute'
    ), 'recent_multi_factor'))
  $$,
  'legacy recent-multi-factor strength may carry genuine MFA evidence without producing it'
);

select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence is incomplete',
  'evidence cannot omit its access-token issue-time bound'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp()
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence is incomplete',
  'token issue time alone is not authentication evidence'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'primaryAuthenticatedAt', null
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence has an invalid time',
  'explicit null authentication evidence is malformed'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'multiFactorAuthenticatedAt', null
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence has an invalid time',
  'explicit null MFA evidence is malformed'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'multiFactorAuthenticatedAt', 'not-a-time'
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence has an invalid time',
  'non-time MFA evidence is malformed'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', null,
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence has an invalid time',
  'explicit null token issue time is malformed'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', 'not-a-time',
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence has an invalid time',
  'non-time token issue time is malformed'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'multiFactorAuthenticatedAt', pg_catalog.statement_timestamp() - interval '1 minute'
    ), 'single_factor'))
  $$,
  '22023'::char(5),
  'Vortex human multi-factor evidence conflicts with authentication strength',
  'single-factor strength cannot carry MFA evidence'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence is inconsistent',
  'authentication evidence cannot postdate access-token issuance'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp() + interval '60 seconds',
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp() + interval '1 microsecond'
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence is inconsistent',
  'authentication evidence receives no future clock allowance'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_temp.human_context(pg_catalog.jsonb_build_object(
      'accessTokenIssuedAt', pg_catalog.statement_timestamp() + interval '60.001 seconds',
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
    )))
  $$,
  '22023'::char(5),
  'Vortex human authentication evidence is inconsistent',
  'the token issue-time bound does not exceed the existing 60-second skew'
);

select throws_ok(
  $$
    select vortex_context.validated(
      pg_temp.human_context('{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'callerKind', 'federated',
        'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
        'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
      )
    )
  $$,
  '22023'::char(5),
  'Vortex request context has an unknown field',
  'federated context cannot receive human authentication evidence'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_catalog.jsonb_build_object(
      'callerKind', 'public',
      'tenantId', '11000000-0000-4000-8000-000000000001',
      'organizationId', '21000000-0000-4000-8000-000000000001',
      'sessionId', '61000000-0000-4000-8000-000000000001',
      'authenticationStrength', 'anonymous',
      'issuedAt', pg_catalog.statement_timestamp(),
      'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
      'accessVersion', 1,
      'correlationId', '71000000-0000-4000-8000-000000000001',
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
    ))
  $$,
  '22023'::char(5),
  'Vortex request context has an unknown field',
  'public context cannot inject human authentication evidence'
);
select throws_ok(
  $$
    select vortex_context.validated(pg_catalog.jsonb_build_object(
      'callerKind', 'system',
      'tenantId', '11000000-0000-4000-8000-000000000001',
      'organizationId', '21000000-0000-4000-8000-000000000001',
      'sessionId', '61000000-0000-4000-8000-000000000001',
      'systemActorId', '91000000-0000-4000-8000-000000000001',
      'authenticationStrength', 'service',
      'issuedAt', pg_catalog.statement_timestamp(),
      'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
      'accessVersion', 1,
      'correlationId', '71000000-0000-4000-8000-000000000001',
      'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
      'multiFactorAuthenticatedAt', pg_catalog.statement_timestamp()
    ))
  $$,
  '22023'::char(5),
  'Vortex request context has an unknown field',
  'system context cannot inject human authentication evidence'
);

reset role;

set local role vortex_runtime;
set local search_path = pg_catalog, extensions, public;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '82500000-0000-4000-8000-000000000001',
  'tenantId', '12500000-0000-4000-8000-000000000001',
  'organizationId', '22500000-0000-4000-8000-000000000001',
  'organizationAccountId', '52500000-0000-4000-8000-000000000001',
  'identityId', '42500000-0000-4000-8000-000000000001',
  'sessionId', '62500000-0000-4000-8000-000000000001',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.transaction_timestamp(),
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 7,
  'correlationId', '72500000-0000-4000-8000-000000000004',
  'accessTokenIssuedAt', pg_catalog.transaction_timestamp(),
  'primaryAuthenticatedAt', pg_catalog.transaction_timestamp() - interval '2 minutes',
  'multiFactorAuthenticatedAt', pg_catalog.transaction_timestamp() - interval '1 minute'
));

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select is(
  vortex_context.current_context() ->> 'primaryAuthenticatedAt',
  pg_catalog.jsonb_build_object(
    'value', pg_catalog.transaction_timestamp() - interval '2 minutes'
  ) ->> 'value',
  'trusted initialization preserves the exact primary-authentication time'
);
select is(
  vortex_context.current_context() ->> 'multiFactorAuthenticatedAt',
  pg_catalog.jsonb_build_object(
    'value', pg_catalog.transaction_timestamp() - interval '1 minute'
  ) ->> 'value',
  'trusted initialization preserves the exact MFA time'
);
select is(
  vortex_access.validated_human_request_context() ->> 'primaryAuthenticatedAt',
  pg_catalog.jsonb_build_object(
    'value', pg_catalog.transaction_timestamp() - interval '2 minutes'
  ) ->> 'value',
  'live Access validation preserves the exact primary-authentication time'
);
select is(
  vortex_access.validated_human_request_context() ->> 'multiFactorAuthenticatedAt',
  pg_catalog.jsonb_build_object(
    'value', pg_catalog.transaction_timestamp() - interval '1 minute'
  ) ->> 'value',
  'live Access validation preserves the exact MFA time'
);

reset role;
update vortex_identity.organization_accounts
set state = 'suspended',
    suspended_at = pg_catalog.statement_timestamp(),
    changed_at = pg_catalog.statement_timestamp(),
    state_changed_at = pg_catalog.statement_timestamp(),
    state_changed_by = '42500000-0000-4000-8000-000000000001',
    state_change_correlation_id = '72500000-0000-4000-8000-000000000005',
    revision = revision + 1
where organization_account_id = '52500000-0000-4000-8000-000000000001';
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select vortex_access.validated_human_request_context()$$,
  '42501'::char(5),
  'Organisation-account context is inactive or unavailable',
  'live account validation still rejects an inactive account'
);

reset role;
update vortex_identity.organization_accounts
set state = 'active',
    changed_at = pg_catalog.statement_timestamp(),
    state_changed_at = pg_catalog.statement_timestamp(),
    state_changed_by = '42500000-0000-4000-8000-000000000001',
    state_change_correlation_id = '72500000-0000-4000-8000-000000000006',
    revision = revision + 1
where organization_account_id = '52500000-0000-4000-8000-000000000001';
update vortex_access.organization_access_versions
set current_version = 8,
    changed_at = pg_catalog.statement_timestamp(),
    changed_by = '52500000-0000-4000-8000-000000000001',
    change_correlation_id = '72500000-0000-4000-8000-000000000007',
    change_reason = 'role_assignment_changed'
where organization_id = '22500000-0000-4000-8000-000000000001';
set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select throws_ok(
  $$select vortex_access.validated_human_request_context()$$,
  '42501'::char(5),
  'Request access version is stale or unavailable',
  'live Access-version validation still rejects stale context'
);

reset role;
select * from finish();

rollback;
