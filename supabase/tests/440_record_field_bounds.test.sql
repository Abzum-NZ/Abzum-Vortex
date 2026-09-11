begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- Function shape and ACL assertions for the one new object in
-- 20260910094534_resolve_record_field_bounds.sql. It is owner-only: it takes
-- only the decision and looks each contribution's field policy up from the
-- live permission catalogue itself, so no request/runtime/module-owner/
-- record-owner/record-adapter role may call it, and no caller may supply a
-- declarations parameter of its own.
select has_function(
  'vortex_access', 'resolve_record_field_bounds_internal',
  array['jsonb'],
  'Access owns one private record field-bounds resolver'
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
      'vortex_access.resolve_record_field_bounds_internal(jsonb)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 's',
    'configuration', array['search_path=""']
  ),
  'the field-bounds resolver is owner-held, stable, invoker-rights and empty-search-path'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.resolve_record_field_bounds_internal(jsonb)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private field-bounds resolver'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request'), ('vortex_module_owner'),
  ('vortex_record_owner'), ('vortex_record_adapter')
) as caller(role_name)
order by caller.role_name collate "C";

-- ============================================================================
-- Fixture. One tenant/organisation/Access-version scope and one application
-- registration owning eleven record-scoped read permissions, each with its
-- own field_policy (or, for one permission, a deliberately absent policy).
-- Every decision below this point is a hand-built jsonb value, never routed
-- through eligibility or row-scope composition: this file exercises the
-- field-bounds resolver in isolation, exactly as the brief requires.
-- ============================================================================

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14400000-0000-4000-8000-000000000001', 'record_field_bounds',
  'Record field bounds', 'active', pg_catalog.clock_timestamp(),
  '94400000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '24400000-0000-4000-8000-000000000001',
  '14400000-0000-4000-8000-000000000001', 'record_field_bounds',
  'Record field bounds', 'active', pg_catalog.clock_timestamp(),
  '94400000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '24400000-0000-4000-8000-000000000001',
  '94400000-0000-4000-8000-000000000001',
  'a4400000-0000-4000-8000-000000000001'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '24400000-0000-4000-8000-000000000001',
  '94400000-0000-4000-8000-000000000001',
  'a4400000-0000-4000-8000-000000000002'
);

-- One active application registration owning eleven permissions. Every entry
-- shares one source release (content '1'*64, resolution '2'*64); only
-- meaning_fingerprint varies per permission, matching 425/430's own
-- fixture-seeding style.
create function pg_temp.seed_field_bounds_catalogue()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24400000-0000-4000-8000-000000000001', 'application',
    '34400000-0000-4000-8000-000000000001', 1, 'active', 'register',
    'example.record_field_bounds', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94400000-0000-4000-8000-000000000001',
    'a4400000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '24400000-0000-4000-8000-000000000001', 'application',
    '34400000-0000-4000-8000-000000000001', 'active', 1,
    'example.record_field_bounds', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), operation_at,
    '94400000-0000-4000-8000-000000000001',
    'a4400000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_catalogue_entries (
    organization_id, registration_kind, registration_owner_id,
    registration_revision, application_root_id, owner_kind, owner_id,
    permission_id, permission_key, label, description, record_type_id,
    action_kind, named_action, administrative, source_kind,
    source_definition_key, source_root_id, source_version, source_revision,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_catalogue_fingerprint,
    meaning_fingerprint, record_scope, field_policy
  )
  select
    '24400000-0000-4000-8000-000000000001'::uuid, 'application',
    '34400000-0000-4000-8000-000000000001'::uuid, 1,
    '34400000-0000-4000-8000-000000000001'::uuid, 'application',
    '34400000-0000-4000-8000-000000000001'::uuid,
    permission.permission_id, permission.permission_key,
    permission.label, 'Record field bounds fixture.',
    'd4400000-0000-4000-8000-000000000001'::uuid, 'read', null, false,
    'application', 'example.record_field_bounds',
    '34400000-0000-4000-8000-000000000001'::uuid, '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), null,
    'sha256:' || pg_catalog.repeat(permission.fingerprint_character, 64),
    null, permission.field_policy
  from (values
    ('c4400000-0000-4000-8000-000000000001'::uuid,
      'record_field_bounds.solo', 'Solo', '1',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001","b4400000-0000-4000-8000-000000000002"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000001"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000002'::uuid,
      'record_field_bounds.union_a', 'Union A', '2',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000001"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000003'::uuid,
      'record_field_bounds.union_b', 'Union B', '3',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000002"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000002"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000004'::uuid,
      'record_field_bounds.null_policy', 'Null policy', '4',
      null::jsonb),
    ('c4400000-0000-4000-8000-000000000005'::uuid,
      'record_field_bounds.with_policy', 'With policy', '5',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000003"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000003"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000006'::uuid,
      'record_field_bounds.share_base', 'Share base', '6',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001","b4400000-0000-4000-8000-000000000002","b4400000-0000-4000-8000-000000000004"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000001","b4400000-0000-4000-8000-000000000002"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000007'::uuid,
      'record_field_bounds.share_no_changeable', 'Share no changeable', '7',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000001"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000008'::uuid,
      'record_field_bounds.cross_a', 'Cross A', '8',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001"],"changeableFieldIds":[]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000009'::uuid,
      'record_field_bounds.cross_b', 'Cross B', '9',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000002"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000002"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000010'::uuid,
      'record_field_bounds.canon_1', 'Canon 1', 'a',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001","B4400000-0000-4000-8000-000000000003"],"changeableFieldIds":[]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000011'::uuid,
      'record_field_bounds.canon_2', 'Canon 2', 'b',
      '{"readableFieldIds":["b4400000-0000-4000-8000-000000000001","b4400000-0000-4000-8000-000000000002"],"changeableFieldIds":["b4400000-0000-4000-8000-000000000002"]}'::jsonb),
    ('c4400000-0000-4000-8000-000000000012'::uuid,
      'record_field_bounds.empty_policy', 'Empty policy', 'c',
      '{"readableFieldIds":[],"changeableFieldIds":[]}'::jsonb)
  ) as permission(
    permission_id, permission_key, label, fingerprint_character, field_policy
  );
end
$function$;

select pg_temp.seed_field_bounds_catalogue();

-- ============================================================================
-- Decision/contribution helpers. Every field the resolver itself never reads
-- (recordBinding, checkedAt, validUntil, ...) is a fixed realistic placeholder:
-- only outcome, organizationId and matchedContributions (permission, source,
-- route, field_policy behaviour) are under test.
-- ============================================================================

create function pg_temp.correct_source()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', 'application',
    'definitionKey', 'example.record_field_bounds',
    'rootId', '34400000-0000-4000-8000-000000000001'::uuid,
    'releaseRevision', 1,
    'releaseVersion', '1.0.0',
    'validationContractVersion', '1.0.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
  )
$function$;

create function pg_temp.permission_ref(p_permission_id uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'applicationRootId', '34400000-0000-4000-8000-000000000001'::uuid,
    'ownerKind', 'application',
    'ownerId', '34400000-0000-4000-8000-000000000001'::uuid,
    'permissionId', p_permission_id
  )
$function$;

create function pg_temp.route_ownership()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select '{"kind":"ownership"}'::jsonb
$function$;

create function pg_temp.route_share(p_readable jsonb, p_changeable jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', 'direct_share',
    'directShareId', '74400000-0000-4000-8000-000000000001'::uuid,
    'directShareRevision', 1,
    'readableFieldIds', p_readable,
    'changeableFieldIds', p_changeable
  )
$function$;

-- p_source defaults to the catalogue's own real source release; tests that
-- need a superseded source pass their own mismatched value explicitly.
create function pg_temp.contribution(
  p_permission_id uuid,
  p_route jsonb,
  p_source jsonb default null
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permission', pg_temp.permission_ref(p_permission_id),
    'recordScope', '{"routes":[{"kind":"all_records"}]}'::jsonb,
    'source', coalesce(p_source, pg_temp.correct_source()),
    'route', p_route,
    'validUntil', '2099-01-01T00:00:00.000000Z'
  )
$function$;

create function pg_temp.allowed_decision(p_contributions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'operationKey', 'record.read',
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '34400000-0000-4000-8000-000000000001'::uuid
    ),
    'organizationId', '24400000-0000-4000-8000-000000000001'::uuid,
    'organizationAccountId', '54400000-0000-4000-8000-000000000001'::uuid,
    'accessVersion', 1,
    'checkedAt', '2026-01-01T00:00:00.000000Z',
    'correlationId', 'a4400000-0000-4000-8000-000000000099'::uuid,
    'recordBinding', pg_catalog.jsonb_build_object(
      'moduleRootId', '34400000-0000-4000-8000-000000000002'::uuid,
      'recordTypeId', 'd4400000-0000-4000-8000-000000000001'::uuid,
      'storageContractId', 'b4400000-0000-4000-8000-000000000201'::uuid,
      'storageScope', 'organization_shared'
    ),
    'recordId', 'e4400000-0000-4000-8000-000000000001'::uuid,
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'validUntil', '2099-01-01T00:00:00.000000Z',
    'matchedContributions', p_contributions
  )
$function$;

create function pg_temp.refused_decision()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_temp.allowed_decision('[]'::jsonb)
    || pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_scope_refused')
    - 'validUntil' - 'matchedContributions'
$function$;

-- ============================================================================
-- Cases.
-- ============================================================================

-- A single contribution returns exactly its permission's own field policy.
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000001'::uuid, pg_temp.route_ownership()
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array(
      'b4400000-0000-4000-8000-000000000001', 'b4400000-0000-4000-8000-000000000002'
    ),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000001')
  ),
  'a single contribution returns exactly its permission''s field policy'
);

-- Two contributions union their readable and changeable sets.
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000002'::uuid, pg_temp.route_ownership()
      ),
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000003'::uuid, pg_temp.route_ownership()
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array(
      'b4400000-0000-4000-8000-000000000001', 'b4400000-0000-4000-8000-000000000002'
    ),
    'changeableFieldIds', pg_catalog.jsonb_build_array(
      'b4400000-0000-4000-8000-000000000001', 'b4400000-0000-4000-8000-000000000002'
    )
  ),
  'two contributions union their readable and changeable sets'
);

-- A null field_policy contributes no fields and does not veto a second
-- contribution that has one, in either declared order.
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000004'::uuid, pg_temp.route_ownership()
      ),
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000005'::uuid, pg_temp.route_ownership()
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000003'),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000003')
  ),
  'a null field policy contributes no fields and does not veto a second contribution'
);
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000005'::uuid, pg_temp.route_ownership()
      ),
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000004'::uuid, pg_temp.route_ownership()
      )
    ))
  ) -> 'readableFieldIds',
  pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000003'),
  'the null-policy contribution still does not veto when it is declared first'
);

-- An explicit-empty field_policy ({"readableFieldIds":[],"changeableFieldIds":[]})
-- is a different fact from an absent one -- a policy author's explicit "this
-- permission names no fields" rather than field_policy never having been
-- set -- but resolves the same way: it contributes no fields of its own and
-- does not veto a second contribution that has some.
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000012'::uuid, pg_temp.route_ownership()
      ),
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000005'::uuid, pg_temp.route_ownership()
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000003'),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000003')
  ),
  'an explicit-empty field policy, distinct from an absent one, also contributes no fields and does not veto a second contribution'
);

-- A direct_share contribution is intersected with the share's own bounds in
-- both directions: a field in the policy but not the share is absent (fld
-- ...0002 and ...0004), and a field in the share but not the policy is absent
-- (...0003).
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000006'::uuid,
        pg_temp.route_share(
          pg_catalog.jsonb_build_array(
            'b4400000-0000-4000-8000-000000000001', 'b4400000-0000-4000-8000-000000000003'
          ),
          pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000001')
        )
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000001'),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000001')
  ),
  'a direct_share contribution intersects both readable and changeable with the share''s own bounds'
);

-- A share whose changeableFieldIds is empty contributes readable fields but
-- no changeable ones.
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000007'::uuid,
        pg_temp.route_share(
          pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000001'), '[]'::jsonb
        )
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000001'),
    'changeableFieldIds', '[]'::jsonb
  ),
  'a share with an empty changeableFieldIds contributes readable fields but no changeable ones'
);

-- Overall changeable never exceeds readable: permission cross_a supplies
-- field ...0002 to nothing (its own readable set is only ...0001), while
-- cross_b supplies both ...0002 readable and ...0002 changeable. The final
-- changeable set must still land inside the fully unioned readable set.
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000008'::uuid, pg_temp.route_ownership()
      ),
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000009'::uuid, pg_temp.route_ownership()
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array(
      'b4400000-0000-4000-8000-000000000001', 'b4400000-0000-4000-8000-000000000002'
    ),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000002')
  ),
  'overall changeable never exceeds readable, including a changeable field only another contribution''s readable set covers'
);

-- Results are canonical: lowercase (canon_1 stores field ...0003 uppercase),
-- unique across contributions (...0001 is declared by both canon_1 and
-- canon_2), and ascending regardless of declared order (canon_2 is listed
-- before canon_1 here).
select is(
  vortex_access.resolve_record_field_bounds_internal(
    pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000011'::uuid, pg_temp.route_ownership()
      ),
      pg_temp.contribution(
        'c4400000-0000-4000-8000-000000000010'::uuid, pg_temp.route_ownership()
      )
    ))
  ),
  pg_catalog.jsonb_build_object(
    'readableFieldIds', pg_catalog.jsonb_build_array(
      'b4400000-0000-4000-8000-000000000001',
      'b4400000-0000-4000-8000-000000000002',
      'b4400000-0000-4000-8000-000000000003'
    ),
    'changeableFieldIds', pg_catalog.jsonb_build_array('b4400000-0000-4000-8000-000000000002')
  ),
  'results are canonical: lowercase, deduplicated across contributions, and ascending regardless of declared order'
);

-- A refused decision raises 22023; field bounds are meaningless otherwise.
select throws_ok(
  $$ select vortex_access.resolve_record_field_bounds_internal(pg_temp.refused_decision()) $$,
  '22023'::char(5), 'Record field bounds require an allowed decision',
  'a refused decision raises 22023'
);

-- A contribution naming a permission with no catalogue entry raises 22023:
-- the decision just used it, so its absence is an internal inconsistency.
select throws_ok(
  $$
    select vortex_access.resolve_record_field_bounds_internal(
      pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
        pg_temp.contribution(
          'c4400000-0000-4000-8000-000000000099'::uuid, pg_temp.route_ownership()
        )
      ))
    )
  $$,
  '22023'::char(5), 'Record field bounds found no catalogue entry',
  'a contribution naming a permission with no catalogue entry raises 22023'
);

-- A contribution whose source does not match the catalogue entry's release
-- raises 22023: a superseded release would otherwise silently supply the
-- policy.
select throws_ok(
  $$
    select vortex_access.resolve_record_field_bounds_internal(
      pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
        pg_temp.contribution(
          'c4400000-0000-4000-8000-000000000001'::uuid,
          pg_temp.route_ownership(),
          pg_temp.correct_source() || pg_catalog.jsonb_build_object('releaseRevision', 99)
        )
      ))
    )
  $$,
  '22023'::char(5), 'Record field bounds found a superseded permission source',
  'a contribution whose source does not match the catalogue entry''s release raises 22023'
);

-- The same superseded-source refusal fires on a mismatch in any of the three
-- evidence fields compared beyond the five identity/release fields (F5):
-- validationContractVersion, contentFingerprint and resolutionFingerprint. A
-- release that changed only its content or resolution evidence, with revision
-- and version unchanged, must still be caught -- exercised here via
-- validationContractVersion. This resolver is the only owner of field bounds.
-- The TypeScript engine (contracts/src/record-field-access.ts) that the
-- migration's own comment still calls it "at parity" with was deleted by PR
-- #388; that migration comment is immutable history, not a parity claim.
select throws_ok(
  $$
    select vortex_access.resolve_record_field_bounds_internal(
      pg_temp.allowed_decision(pg_catalog.jsonb_build_array(
        pg_temp.contribution(
          'c4400000-0000-4000-8000-000000000001'::uuid,
          pg_temp.route_ownership(),
          pg_temp.correct_source() || pg_catalog.jsonb_build_object('validationContractVersion', '9.9.9')
        )
      ))
    )
  $$,
  '22023'::char(5), 'Record field bounds found a superseded permission source',
  'a contribution whose validationContractVersion does not match the catalogue entry''s release raises 22023, even with revision and version unchanged'
);

set constraints all immediate;

select * from finish();

rollback;
