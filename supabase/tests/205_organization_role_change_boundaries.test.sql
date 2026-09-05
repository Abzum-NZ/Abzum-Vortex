begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select is(
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)'::regprocedure
  ),
  1::bigint,
  'the exact role-change coordinator signature is present'
);

select ok(
  not (
    select routine.prosecdef
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)'::regprocedure
  ),
  'the role-change coordinator remains security invoker'
);

select is(
  (
    select routine.provolatile
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)'::regprocedure
  ),
  'v'::"char",
  'the role-change coordinator remains volatile'
);

select is(
  (
    select routine.proconfig
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)'::regprocedure
  ),
  array['search_path=""']::text[],
  'the role-change coordinator has an exact empty search path'
);

select ok(
  pg_catalog.has_function_privilege(
    current_user,
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  ),
  'the migration owner can execute the private role-change coordinator'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private role-change coordinator'
)
from (values
  ('public'),
  ('anon'),
  ('authenticated'),
  ('service_role'),
  ('vortex_runtime'),
  ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  pg_catalog.has_schema_privilege('vortex_request', 'vortex_access', 'USAGE'),
  'request role can resolve the Access schema before function execution is denied'
);

-- This test-only schema grant is rolled back and does not change any private
-- function or table privilege.
grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      null::jsonb,
      '92050000-0000-4000-8000-000000000001'::uuid,
      '72050000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_role_change',
  'an actual request-role call cannot invoke the owner-only coordinator'
);
reset role;

create temporary table role_change_boundary_inputs on commit drop as
with permission_value as (
  select pg_catalog.jsonb_build_object(
    'kind', 'exact',
    'ownerKind', 'platform',
    'ownerId', '12050000-0000-4000-8000-000000000001'::uuid,
    'permissionId', '42050000-0000-4000-8000-000000000001'::uuid,
    'acceptedRegistrationRevision', 1,
    'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
    'continuityRevision', 1,
    'meaningFingerprint', 'sha256:' || pg_catalog.repeat('b', 64)
  ) as value
), configuration as (
  select pg_catalog.jsonb_build_object(
    'key', 'boundary_role',
    'label', 'Boundary role',
    'description', 'Neutral malformed-input boundary fixture.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
  ) as value
), candidates as (
  select
    pg_catalog.jsonb_build_object(
      'operation', 'create_custom',
      'organizationId', '22050000-0000-4000-8000-000000000001'::uuid,
      'roleId', '52050000-0000-4000-8000-000000000001'::uuid
    ) || configuration.value || pg_catalog.jsonb_build_object(
      'permissions', pg_catalog.jsonb_build_array(permission_value.value)
    ) as create_candidate,
    pg_catalog.jsonb_build_object(
      'operation', 'revise_metadata_policy',
      'organizationId', '22050000-0000-4000-8000-000000000001'::uuid,
      'roleId', '52050000-0000-4000-8000-000000000001'::uuid,
      'expectedRoleRevision', 1
    ) || configuration.value as metadata_candidate
  from permission_value, configuration
)
select
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'candidate', create_candidate,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('c', 64)
  ) as create_evidence,
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'candidate', metadata_candidate,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
  ) as metadata_evidence
from candidates;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      null::jsonb,
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'null evidence is refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      '[]'::jsonb,
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'non-object evidence is refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select create_evidence - 'candidate' from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'missing required top-level evidence is refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select create_evidence || '{"unexpected":true}'::jsonb
       from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'unknown top-level evidence keys are refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select pg_catalog.jsonb_set(
        create_evidence,
        '{candidate,operation}',
        '"unknown_intent"'::jsonb
      ) from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'unknown role-change intents are refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select pg_catalog.jsonb_set(
        create_evidence,
        '{candidate}',
        (create_evidence -> 'candidate') || '{"unexpected":true}'::jsonb
      ) from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'unknown candidate keys are refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_catalog.jsonb_build_object(
        'contractVersion', '1.0.0',
        'candidate', pg_catalog.jsonb_build_object(
          'operation', 'retire_role',
          'organizationId', '22050000-0000-4000-8000-000000000001'::uuid,
          'roleId', '52050000-0000-4000-8000-000000000001'::uuid,
          'expectedRoleRevision', 1,
          'label', 'Extraneous label'
        ),
        'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('e', 64)
      ),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'branch-extraneous fields are refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select pg_catalog.jsonb_set(
        create_evidence,
        '{candidate}',
        (create_evidence -> 'candidate') || '{"expectedRoleRevision":1}'::jsonb
      ) from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'a creation intent cannot carry a prohibited expected revision'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select pg_catalog.jsonb_set(
        create_evidence,
        '{candidate,organizationId}',
        '"not-a-uuid"'::jsonb
      ) from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'malformed UUID evidence is safely normalized to 22023 before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select metadata_evidence from role_change_boundary_inputs),
      null::uuid,
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'a null actor is refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select metadata_evidence from role_change_boundary_inputs),
      '00000000-0000-0000-0000-000000000000',
      '72050000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'the nil actor is refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select metadata_evidence from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      null::uuid
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'a null correlation is refused before organization lookup'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      (select metadata_evidence from role_change_boundary_inputs),
      '92050000-0000-4000-8000-000000000001',
      '00000000-0000-0000-0000-000000000000'
    )
  $$,
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  'the nil correlation is refused before organization lookup'
);

select throws_ok(
  pg_catalog.format(
    $test$
      select * from vortex_access.coordinate_organization_role_change(
        (select pg_catalog.jsonb_set(
          metadata_evidence,
          '{candidate,expectedRoleRevision}',
          %L::jsonb
        ) from role_change_boundary_inputs),
        '92050000-0000-4000-8000-000000000001',
        '72050000-0000-4000-8000-000000000001'
      )
    $test$,
    invalid_revision.value::text
  ),
  '22023'::char(5),
  'Organization role-change evidence is invalid',
  invalid_revision.description
)
from (values
  ('null'::jsonb, 'a null expected revision is refused before organization lookup'),
  ('"1"'::jsonb, 'a string expected revision is refused before organization lookup'),
  ('0'::jsonb, 'a zero expected revision is refused before organization lookup'),
  ('1.5'::jsonb, 'a fractional expected revision is refused before organization lookup'),
  (
    '9007199254740992'::jsonb,
    'an unsafe expected revision is refused before organization lookup'
  )
) as invalid_revision(value, description);

select * from finish();

rollback;
