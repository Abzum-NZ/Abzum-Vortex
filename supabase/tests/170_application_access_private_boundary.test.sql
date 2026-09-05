begin;

set local search_path = pg_catalog, extensions, public;

select plan(50);

-- Exact B2 helper list: a missing signature fails rather than silently reducing
-- the tested surface. These checks do not grant execution to any caller.
select ok(
  not pg_catalog.has_function_privilege(caller.role_name, helper.signature, 'EXECUTE'),
  caller.role_name || ' cannot execute ' || helper.signature
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
cross join (values
  ('vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)'),
  ('vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid)'),
  ('vortex_access.lock_role_and_refuse_sealed_permission_append()'),
  ('vortex_access.lock_role_before_revision_seal()'),
  ('vortex_access.application_access_current_transition_is_complete(uuid,uuid,bigint,text)'),
  ('vortex_access.application_permission_registration_matches_candidate(uuid,uuid,bigint,jsonb)'),
  ('vortex_access.application_access_current_state_matches_candidate(uuid,uuid,bigint,jsonb)'),
  ('vortex_access.coordinate_application_access_change(text,bigint,jsonb,uuid,uuid,uuid,uuid)')
) as helper(signature)
order by caller.role_name, helper.signature;

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request role can reach the Access schema, so invocation proof tests function denial'
);

-- Only expose the test assertion library within this rolled-back transaction.
-- No privilege on the private Access functions or data is changed.
grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '21700000-0000-4000-8000-000000000170'::uuid,
      '31700000-0000-4000-8000-000000000170'::uuid,
      '91700000-0000-4000-8000-000000000170'::uuid,
      '71700000-0000-4000-8000-000000000170'::uuid
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_application_access_change',
  'an actual request-role call cannot invoke the owner-only coordinator'
);
reset role;

select * from finish();
rollback;
