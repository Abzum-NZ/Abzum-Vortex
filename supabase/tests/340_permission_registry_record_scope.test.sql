\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select has_column(
  'vortex_access', 'permission_catalogue_entries', 'record_scope',
  'catalogue entries preserve an optional Definition-owned record scope'
);
select col_type_is(
  'vortex_access', 'permission_catalogue_entries', 'record_scope', 'jsonb',
  'record scope uses lossless JSON storage'
);
select is(
  (
    select column_row.is_nullable
    from information_schema.columns as column_row
    where column_row.table_schema = 'vortex_access'
      and column_row.table_name = 'permission_catalogue_entries'
      and column_row.column_name = 'record_scope'
  ),
  'YES',
  'historical catalogue entries retain an absent record scope'
);
select ok(
  (
    select
      pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        , 'registration_kind = ''application'''
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        , 'record_type_id is not null'
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        , 'jsonb_typeof(record_scope)'
      ) > 0
      and pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.pg_get_constraintdef(constraint_row.oid))
        , '''object'''
      ) > 0
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid =
      'vortex_access.permission_catalogue_entries'::regclass
      and constraint_row.conname =
        'permission_catalogue_entries_record_scope_shape'
  ),
  'stored scope is restricted to application-supplied record permissions'
);
select is(
  (
    select procedure_row.prorettype = 'record'::regtype
      and procedure_row.prosecdef
      and procedure_row.provolatile = 's'
      and procedure_row.proconfig @> array['search_path=""']
    from pg_catalog.pg_proc as procedure_row
    where procedure_row.oid =
      'vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid)'::regprocedure
  ),
  true,
  'the expanded permission reader preserves its private stable security boundary'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.application_permission_registration_matches_candidate(uuid,uuid,bigint,jsonb)',
    'EXECUTE'
  ),
  'the changed read and comparison helpers remain owner-only'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13400000-0000-4000-8000-000000000001', 'scope_tenant',
  'Scope tenant', 'active', pg_catalog.statement_timestamp(),
  '93400000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  '23400000-0000-4000-8000-000000000001',
  '13400000-0000-4000-8000-000000000001', 'scope_org',
  'Scope organisation', 'active', pg_catalog.statement_timestamp(),
  '93400000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '23400000-0000-4000-8000-000000000001',
  '93400000-0000-4000-8000-000000000001',
  '73400000-0000-4000-8000-000000000001'
);

create function pg_temp.scope_permission(p_scope jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'permissionId', '43400000-0000-4000-8000-000000000001'::uuid,
    'key', 'neutral.records.read',
    'label', 'View records',
    'description', 'View neutral records.',
    'recordTypeId', '63400000-0000-4000-8000-000000000001'::uuid,
    'recordScope', p_scope,
    'actionKind', 'read',
    'namedAction', null,
    'administrative', false
  ))
$function$;

create function pg_temp.scope_candidate(
  p_release_revision bigint,
  p_release_version text,
  p_scope jsonb,
  p_content_character text,
  p_resolution_character text,
  p_catalogue_character text,
  p_candidate_character text,
  p_meaning_character text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with release_value as (
    select pg_catalog.jsonb_build_object(
      'kind', 'application',
      'definitionKey', 'neutral.scope_application',
      'rootId', '33400000-0000-4000-8000-000000000001'::uuid,
      'releaseRevision', p_release_revision,
      'releaseVersion', p_release_version,
      'validationContractVersion', '2.18.0',
      'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
      'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
    ) as value
  ), entry_value as (
    select pg_catalog.jsonb_build_object(
      'applicationRootId', '33400000-0000-4000-8000-000000000001'::uuid,
      'ownerKind', 'application',
      'ownerId', '33400000-0000-4000-8000-000000000001'::uuid,
      'permission', pg_temp.scope_permission(p_scope),
      'sourceRelease', release_value.value,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat(p_meaning_character, 64)
    ) as value
    from release_value
  )
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '23400000-0000-4000-8000-000000000001'::uuid,
    'applicationRootId', '33400000-0000-4000-8000-000000000001'::uuid,
    'applicationRelease', release_value.value,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(p_catalogue_character, 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array(
      '43400000-0000-4000-8000-000000000001'::uuid
    ),
    'entries', pg_catalog.jsonb_build_array(entry_value.value),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat(p_candidate_character, 64)
  )
  from release_value, entry_value
$function$;

create function pg_temp.scope_templates(
  p_candidate jsonb,
  p_registration_revision bigint,
  p_template_character text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object(
      'kind', 'current_active_registration',
      'registrationRevision', p_registration_revision
    ),
    'permissionRegistration', p_candidate,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '53400000-0000-4000-8000-000000000001'::uuid,
        'key', 'neutral_reader',
        'name', 'Neutral reader',
        'homePageId', '63400000-0000-4000-8000-000000000002'::uuid,
        'permissionKeys', pg_catalog.jsonb_build_array('neutral.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint',
        'sha256:' || pg_catalog.repeat(p_template_character, 64),
      'sourcePermissions', p_candidate -> 'entries',
      'livePermissions', p_candidate -> 'entries'
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('0', 64)
  )
$function$;

create function pg_temp.scope_registration_preparation(
  p_candidate jsonb,
  p_template_character text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_set(
    pg_temp.scope_templates(p_candidate, 1, p_template_character),
    '{preparationBasis}',
    '{"kind":"registration_candidate"}'::jsonb
  )
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '33400000-0000-4000-8000-000000000001',
  '23400000-0000-4000-8000-000000000001', 'application',
  'neutral.scope_application', pg_catalog.statement_timestamp(),
  '93400000-0000-4000-8000-000000000001'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '33400000-0000-4000-8000-000000000001', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"neutral.scope_application","body":{}}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_permission(null))
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('3', 64), '[]', 'Legacy scope release',
    pg_catalog.statement_timestamp(), '93400000-0000-4000-8000-000000000001'
  ),
  (
    '33400000-0000-4000-8000-000000000001', 2, '1.1.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"neutral.scope_application","body":{}}',
    'sha256:' || pg_catalog.repeat('4', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_permission(
            '{"routes":[{"kind":"ownership"}]}'::jsonb
          ))
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('5', 64)),
    'sha256:' || pg_catalog.repeat('4', 64),
    'sha256:' || pg_catalog.repeat('5', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('6', 64), '[]', 'Scoped release',
    pg_catalog.statement_timestamp(), '93400000-0000-4000-8000-000000000001'
  );

create temporary table scope_candidates as
select
  pg_temp.scope_candidate(1, '1.0.0', null, '1', '2', '3', '4', '5') as legacy,
  pg_temp.scope_candidate(
    2, '1.1.0', '{"routes":[{"kind":"ownership"}]}'::jsonb,
    '4', '5', '6', '7', '8'
  ) as scoped;

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.scope_registration_preparation(
        (select legacy from scope_candidates), 'a'
      ),
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001',
      '93400000-0000-4000-8000-000000000001',
      '73400000-0000-4000-8000-000000000002'
    )
  $$,
  $$ values ('changed'::text, 'register'::text, 1::bigint, 2::bigint) $$,
  'a legacy prepared declaration registers without synthesizing scope'
);
select is(
  (
    select record_scope
    from vortex_access.permission_catalogue_entries
    where organization_id = '23400000-0000-4000-8000-000000000001'
      and registration_owner_id = '33400000-0000-4000-8000-000000000001'
      and registration_revision = 1
  ),
  null::jsonb,
  'legacy storage preserves absent scope as SQL null'
);
select is(
  (
    select record_scope
    from vortex_access.read_available_permission(
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001',
      '43400000-0000-4000-8000-000000000001'
    )
  ),
  null::jsonb,
  'the available-permission reader preserves historical omission'
);

select is(
  vortex_access.application_permission_registration_matches_candidate(
    '23400000-0000-4000-8000-000000000001',
    '33400000-0000-4000-8000-000000000001', 1,
    (select legacy from scope_candidates)
  ),
  true,
  'candidate matching reconstructs an absent legacy scope exactly'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.apply_application_permission_registration_v1_internal(''update'',1,%L::jsonb,%L,%L)',
    pg_catalog.jsonb_set(
      (select scoped from scope_candidates),
      '{entries,0,permission,recordScope}',
      '{"routes":[{"kind":"direct_share"}]}'::jsonb
    )::text,
    '93400000-0000-4000-8000-000000000001',
    '73400000-0000-4000-8000-000000000005'
  ),
  '40001',
  'Application permission declarations are stale or unavailable',
  'a recomputed-looking candidate cannot replace sealed Definition scope'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '23400000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'scope-evidence refusal leaves Access unchanged'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.scope_registration_preparation(
        (select scoped from scope_candidates), 'a'
      ),
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001',
      '93400000-0000-4000-8000-000000000001',
      '73400000-0000-4000-8000-000000000006'
    )
  $$,
  $$ values ('changed'::text, 'update'::text, 2::bigint, 3::bigint) $$,
  'a sealed scoped declaration advances registration and Access once'
);
select is(
  (
    select record_scope
    from vortex_access.permission_catalogue_entries
    where organization_id = '23400000-0000-4000-8000-000000000001'
      and registration_owner_id = '33400000-0000-4000-8000-000000000001'
      and registration_revision = 2
  ),
  '{"routes":[{"kind":"ownership"}]}'::jsonb,
  'the canonical scope is stored without loss'
);
select is(
  (
    select record_scope
    from vortex_access.read_available_permission(
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001',
      '43400000-0000-4000-8000-000000000001'
    )
  ),
  '{"routes":[{"kind":"ownership"}]}'::jsonb,
  'the private reader returns the exact stored scope'
);
select is(
  vortex_access.application_permission_registration_matches_candidate(
    '23400000-0000-4000-8000-000000000001',
    '33400000-0000-4000-8000-000000000001', 2,
    (select scoped from scope_candidates)
  ),
  true,
  'candidate matching reconstructs the exact non-null stored scope'
);
select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'withdraw', 2, null,
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001',
      '93400000-0000-4000-8000-000000000001',
      '73400000-0000-4000-8000-000000000007'
    )
  $$,
  $$ values ('changed'::text, 'withdraw'::text, 3::bigint, 4::bigint) $$,
  'withdrawal advances registration and Access once'
);
select is(
  (
    select record_scope
    from vortex_access.permission_catalogue_entries
    where organization_id = '23400000-0000-4000-8000-000000000001'
      and registration_owner_id = '33400000-0000-4000-8000-000000000001'
      and registration_revision = 3
  ),
  '{"routes":[{"kind":"ownership"}]}'::jsonb,
  'withdrawal preserves scoped immutable history'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.read_available_permission(
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001',
      '43400000-0000-4000-8000-000000000001'
    )
  ),
  0,
  'withdrawn scope is not currently available'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'reactivate', 3,
      pg_temp.scope_registration_preparation(
        (select scoped from scope_candidates), 'a'
      ),
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001',
      '93400000-0000-4000-8000-000000000001',
      '73400000-0000-4000-8000-000000000008'
    )
  $$,
  $$ values ('changed'::text, 'reactivate'::text, 4::bigint, 5::bigint) $$,
  'reactivation preserves scope and advances Access once'
);
select is(
  (
    select record_scope
    from vortex_access.read_available_permission(
      '23400000-0000-4000-8000-000000000001',
      '33400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001',
      '43400000-0000-4000-8000-000000000001'
    )
  ),
  '{"routes":[{"kind":"ownership"}]}'::jsonb,
  'reactivated availability returns the same canonical scope'
);

select throws_ok(
  $$
    insert into vortex_access.permission_catalogue_entries (
      organization_id, registration_kind, registration_owner_id,
      registration_revision, application_root_id, owner_kind, owner_id,
      permission_id, permission_key, label, description, record_type_id,
      action_kind, named_action, administrative, source_kind,
      source_definition_key, source_root_id, source_version, source_revision,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_catalogue_fingerprint,
      meaning_fingerprint, record_scope
    ) values (
      '23400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001', 4,
      '33400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001',
      '43400000-0000-4000-8000-000000000002', 'neutral.action.read',
      'Read action', 'Read a non-record action.', null, 'read', null, false,
      'application', 'neutral.scope_application',
      '33400000-0000-4000-8000-000000000001', '1.1.0', 2, '2.18.0',
      'sha256:' || pg_catalog.repeat('4', 64),
      'sha256:' || pg_catalog.repeat('5', 64),
      'sha256:' || pg_catalog.repeat('6', 64),
      'sha256:' || pg_catalog.repeat('9', 64),
      '{"routes":[{"kind":"ownership"}]}'::jsonb
    )
  $$,
  '23514',
  null,
  'storage refuses scope on a permission without a record type'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '23400000-0000-4000-8000-000000000001'
  ),
  5::bigint,
  'storage-shape refusal leaves Access unchanged'
);

-- Store-level shape enforcement (#387): every structural rule
-- `permissionRecordScopeSchema` states in Zod now has a matching
-- `vortex_access.permission_record_scope_is_valid` check on the column
-- itself (permission_catalogue_entries_record_scope_value,
-- 20260911101613_constrain_permission_record_scope_shape.sql), so illegal
-- shapes are refused at the row, independent of the registration writer.
-- The full shared corpus lives in
-- 470_permission_record_scope_parity.test.sql; this proves the same
-- refusal at the real table via a direct insert, bypassing the writer.
create function pg_temp.record_scope_insert_sql(
  p_permission_id uuid,
  p_record_scope text
)
returns text
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.format(
    $sql$insert into vortex_access.permission_catalogue_entries (
      organization_id, registration_kind, registration_owner_id,
      registration_revision, application_root_id, owner_kind, owner_id,
      permission_id, permission_key, label, description, record_type_id,
      action_kind, named_action, administrative, source_kind,
      source_definition_key, source_root_id, source_version, source_revision,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_catalogue_fingerprint,
      meaning_fingerprint, record_scope
    ) values (
      '23400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001', 4,
      '33400000-0000-4000-8000-000000000001', 'application',
      '33400000-0000-4000-8000-000000000001',
      %L, 'neutral.action.scope_check',
      'Scope check', 'Store-check probe.',
      '63400000-0000-4000-8000-000000000001', 'read', null, false,
      'application', 'neutral.scope_application',
      '33400000-0000-4000-8000-000000000001', '1.1.0', 2, '2.18.0',
      'sha256:' || pg_catalog.repeat('4', 64),
      'sha256:' || pg_catalog.repeat('5', 64),
      null,
      'sha256:' || pg_catalog.repeat('9', 64),
      %L::jsonb
    )$sql$,
    p_permission_id, p_record_scope
  )
$function$;

select throws_ok(
  pg_temp.record_scope_insert_sql(illegal.permission_id, illegal.record_scope),
  '23514',
  null,
  'store refuses ' || illegal.description
)
from (values
  (
    '43400000-0000-4000-8000-000000000010'::uuid,
    '{"routes":[{"kind":"all_records"},{"kind":"ownership"}]}',
    'an all-record route combined with another route'
  ),
  (
    '43400000-0000-4000-8000-000000000011'::uuid,
    '{"routes":[{"kind":"direct_share"},{"kind":"ownership"}]}',
    'routes out of canonical order'
  ),
  (
    '43400000-0000-4000-8000-000000000012'::uuid,
    '{"routes":[{"kind":"ownership"}],"unexpected":true}',
    'an unknown top-level key'
  ),
  (
    '43400000-0000-4000-8000-000000000013'::uuid,
    '{"routes":[{"kind":"ownership"},{"kind":"ownership"}]}',
    'duplicate routes'
  ),
  (
    '43400000-0000-4000-8000-000000000014'::uuid,
    '{"routes":[]}',
    'an empty routes array'
  ),
  (
    '43400000-0000-4000-8000-000000000015'::uuid,
    '{"routes":[{"kind":"mystery"}]}',
    'an unknown route kind'
  ),
  (
    '43400000-0000-4000-8000-000000000016'::uuid,
    '{"routes":[{"kind":"relationship","sourcePermissionId":"43400000-0000-4000-8000-000000000001"}]}',
    'a relationship route missing relationshipId'
  ),
  (
    '43400000-0000-4000-8000-000000000017'::uuid,
    '{"routes":[{"kind":"relationship","relationshipId":"43400000-0000-4000-8000-000000000001"}]}',
    'a relationship route missing sourcePermissionId'
  ),
  (
    '43400000-0000-4000-8000-000000000018'::uuid,
    '{"routes":[{"kind":"all_records"}],"savedCondition":{"conditionId":"43400000-0000-4000-8000-000000000001","publishedRevision":1,"parameterBindings":[]}}',
    'an invalid savedCondition'
  )
) as illegal(permission_id, record_scope, description)
order by illegal.permission_id;

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '23400000-0000-4000-8000-000000000001'
  ),
  5::bigint,
  'every store shape refusal above leaves Access unchanged'
);

insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_version, source_revision,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_catalogue_fingerprint,
  meaning_fingerprint, record_scope
)
select
  '23400000-0000-4000-8000-000000000001', 'application',
  '33400000-0000-4000-8000-000000000001', 4,
  '33400000-0000-4000-8000-000000000001', 'application',
  '33400000-0000-4000-8000-000000000001',
  legal.permission_id, legal.permission_key,
  'Scope check', 'Store-check probe.',
  '63400000-0000-4000-8000-000000000001', 'read', null, false,
  'application', 'neutral.scope_application',
  '33400000-0000-4000-8000-000000000001', '1.1.0', 2, '2.18.0',
  'sha256:' || pg_catalog.repeat('4', 64),
  'sha256:' || pg_catalog.repeat('5', 64),
  null,
  legal.meaning_character,
  legal.record_scope::jsonb
from (values
  (
    '43400000-0000-4000-8000-000000000020'::uuid,
    'neutral.action.scope_check_all_records',
    'sha256:' || pg_catalog.repeat('a', 64),
    '{"routes":[{"kind":"all_records"}]}'
  ),
  (
    '43400000-0000-4000-8000-000000000021'::uuid,
    'neutral.action.scope_check_ownership',
    'sha256:' || pg_catalog.repeat('b', 64),
    '{"routes":[{"kind":"ownership"}]}'
  ),
  (
    '43400000-0000-4000-8000-000000000022'::uuid,
    'neutral.action.scope_check_direct_share',
    'sha256:' || pg_catalog.repeat('c', 64),
    '{"routes":[{"kind":"direct_share"}]}'
  ),
  (
    '43400000-0000-4000-8000-000000000023'::uuid,
    'neutral.action.scope_check_relationship',
    'sha256:' || pg_catalog.repeat('d', 64),
    '{"routes":[{"kind":"relationship","relationshipId":"43400000-0000-4000-8000-000000000030","sourcePermissionId":"43400000-0000-4000-8000-000000000031"}]}'
  ),
  (
    '43400000-0000-4000-8000-000000000024'::uuid,
    'neutral.action.scope_check_saved_condition',
    'sha256:' || pg_catalog.repeat('e', 64),
    '{"routes":[{"kind":"all_records"}],"savedCondition":{"conditionId":"43400000-0000-4000-8000-000000000032","publishedRevision":1,"contractFingerprint":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","parameterBindings":[{"key":"actor","source":"current_organization_account_id"}]}}'
  )
) as legal(permission_id, permission_key, meaning_character, record_scope);

select is(
  (
    select pg_catalog.jsonb_agg(entry.record_scope order by entry.permission_id)
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = '23400000-0000-4000-8000-000000000001'
      and entry.registration_owner_id = '33400000-0000-4000-8000-000000000001'
      and entry.registration_revision = 4
      and entry.permission_id in (
        '43400000-0000-4000-8000-000000000020', '43400000-0000-4000-8000-000000000021',
        '43400000-0000-4000-8000-000000000022', '43400000-0000-4000-8000-000000000023',
        '43400000-0000-4000-8000-000000000024'
      )
  ),
  pg_catalog.jsonb_build_array(
    '{"routes":[{"kind":"all_records"}]}'::jsonb,
    '{"routes":[{"kind":"ownership"}]}'::jsonb,
    '{"routes":[{"kind":"direct_share"}]}'::jsonb,
    '{"routes":[{"kind":"relationship","relationshipId":"43400000-0000-4000-8000-000000000030","sourcePermissionId":"43400000-0000-4000-8000-000000000031"}]}'::jsonb,
    '{"routes":[{"kind":"all_records"}],"savedCondition":{"conditionId":"43400000-0000-4000-8000-000000000032","publishedRevision":1,"contractFingerprint":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","parameterBindings":[{"key":"actor","source":"current_organization_account_id"}]}}'::jsonb
  ),
  'the store accepts each legal record-scope shape -- one per route kind, plus a valid saved condition -- and preserves it exactly'
);

-- End-to-end (#387 review finding B1): the registration writer itself only
-- confirms `recordScope` is a JSON object when present
-- (apply_application_permission_registration_v1_internal); it does not
-- re-check routes/savedCondition shape, so a keyless saved-condition binding
-- (a well-formed JSON object, just not what Zod allows) reaches the same
-- INSERT the raw-insert tests above exercise directly. Before the store
-- check existed with this shape rule, the writer stored such a row. A fresh
-- application root and a single release whose compilation_output already
-- carries the keyless binding keep the writer's own stale-evidence check
-- satisfied (candidate and release agree, since both come from the same
-- permission literal), so the *store* check is what is being proven here,
-- not a side effect of some other refusal.
create function pg_temp.keyless_binding_permission()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'permissionId', '43400000-0000-4000-8000-000000000040'::uuid,
    'key', 'neutral.action.keyless_binding',
    'label', 'Keyless binding',
    'description', 'End-to-end keyless-binding probe.',
    'recordTypeId', '63400000-0000-4000-8000-000000000001'::uuid,
    'recordScope', (
      '{"routes":[{"kind":"ownership"}],"savedCondition":{"conditionId":' ||
      '"43400000-0000-4000-8000-000000000041","publishedRevision":1,' ||
      '"contractFingerprint":"sha256:' || pg_catalog.repeat('a', 64) || '",' ||
      '"parameterBindings":[{"source":"current_organization_account_id","extra":1}]}}'
    )::jsonb,
    'actionKind', 'read',
    'namedAction', null,
    'administrative', false
  ))
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '33400000-0000-4000-8000-000000000099',
  '23400000-0000-4000-8000-000000000001', 'application',
  'neutral.keyless_binding_application', pg_catalog.statement_timestamp(),
  '93400000-0000-4000-8000-000000000001'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values (
  '33400000-0000-4000-8000-000000000099', 1, '1.0.0',
  pg_catalog.jsonb_build_object(
    'source_contract_version', '1.0.0', 'kind', 'application',
    'key', 'neutral.keyless_binding_application', 'body', '{}'::jsonb
  ),
  'sha256:' || pg_catalog.repeat('c', 64), '1.0.0',
  pg_catalog.jsonb_build_object(
    'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
      'content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(pg_temp.keyless_binding_permission())
      )
    )
  ),
  pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('d', 64)),
  'sha256:' || pg_catalog.repeat('c', 64),
  'sha256:' || pg_catalog.repeat('d', 64), '2.18.0',
  'sha256:' || pg_catalog.repeat('e', 64), '[]'::jsonb, 'Keyless binding probe release',
  pg_catalog.statement_timestamp(), '93400000-0000-4000-8000-000000000001'
);

create function pg_temp.keyless_binding_release()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', 'neutral.keyless_binding_application',
    'rootId', '33400000-0000-4000-8000-000000000099'::uuid,
    'releaseRevision', 1, 'releaseVersion', '1.0.0',
    'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
  )
$function$;

select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.apply_application_permission_registration_v1_internal(''register'',null,%L::jsonb,%L,%L)',
    pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'organizationId', '23400000-0000-4000-8000-000000000001'::uuid,
      'applicationRootId', '33400000-0000-4000-8000-000000000099'::uuid,
      'applicationRelease', pg_temp.keyless_binding_release(),
      'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('f', 64),
      'applicationPermissionIds', pg_catalog.jsonb_build_array(
        '43400000-0000-4000-8000-000000000040'::uuid
      ),
      'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'applicationRootId', '33400000-0000-4000-8000-000000000099'::uuid,
        'ownerKind', 'application',
        'ownerId', '33400000-0000-4000-8000-000000000099'::uuid,
        'permission', pg_temp.keyless_binding_permission(),
        'sourceRelease', pg_temp.keyless_binding_release(),
        'meaningFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
      )),
      'candidateFingerprint', 'sha256:' || pg_catalog.repeat('0', 64)
    )::text,
    '93400000-0000-4000-8000-000000000001',
    '73400000-0000-4000-8000-000000000099'
  ),
  '23514',
  null,
  'the registration writer refuses a keyless saved-condition binding end to end, via the store check'
);

set constraints all immediate;

select * from finish();

rollback;
