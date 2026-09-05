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
select * from finish();

rollback;
