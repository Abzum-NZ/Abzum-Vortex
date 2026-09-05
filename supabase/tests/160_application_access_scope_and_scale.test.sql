\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11600000-0000-4000-8000-000000000160', 'scope_scale_tenant',
  'Application access scope and scale tenant', 'active',
  pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values
  (
    '21600000-0000-4000-8000-000000000160',
    '11600000-0000-4000-8000-000000000160', 'scope_scale_one',
    'Application access scope and scale one', 'active',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21600000-0000-4000-8000-000000000161',
    '11600000-0000-4000-8000-000000000160', 'scope_scale_two',
    'Application access scope and scale two', 'active',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160',
    pg_catalog.statement_timestamp(), 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21600000-0000-4000-8000-000000000160',
  '91600000-0000-4000-8000-000000000160',
  '71600000-0000-4000-8000-000000000160'
);
select * from vortex_access.initialize_organization_access_version(
  '21600000-0000-4000-8000-000000000161',
  '91600000-0000-4000-8000-000000000160',
  '71600000-0000-4000-8000-000000000161'
);

create function pg_temp.scope_scale_permission(
  p_permission_id uuid,
  p_key text,
  p_label text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', p_permission_id,
    'key', p_key,
    'label', p_label,
    'description', p_label || ' in the scope and scale fixture.',
    'actionKind', 'read',
    'administrative', false
  )
$function$;

create function pg_temp.scope_scale_candidate(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_definition_key text,
  p_release_revision bigint,
  p_release_version text,
  p_content_character text,
  p_resolution_character text,
  p_catalogue_character text,
  p_candidate_character text,
  p_permissions jsonb,
  p_include_shared_module boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  release_value jsonb;
  entries jsonb;
  application_permission_ids jsonb;
begin
  release_value := pg_catalog.jsonb_build_object(
    'kind', 'application',
    'definitionKey', p_definition_key,
    'rootId', p_application_root_id,
    'releaseRevision', p_release_revision,
    'releaseVersion', p_release_version,
    'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', 'application',
        'ownerId', p_application_root_id,
        'permission', permission.value,
        'sourceRelease', release_value,
        'meaningFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
      ) order by
        (permission.value ->> 'key') collate "C",
        (permission.value ->> 'permissionId') collate "C"
    ),
    '[]'::jsonb
  ) into entries
  from pg_catalog.jsonb_array_elements(p_permissions) as permission(value);

  select coalesce(
    pg_catalog.jsonb_agg(permission.value ->> 'permissionId' order by
      (permission.value ->> 'key') collate "C",
      (permission.value ->> 'permissionId') collate "C"),
    '[]'::jsonb
  ) into application_permission_ids
  from pg_catalog.jsonb_array_elements(p_permissions) as permission(value);

  if p_include_shared_module then
    entries := entries || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', 'module',
        'ownerId', '31600000-0000-4000-8000-000000000160'::uuid,
        'permission', pg_temp.scope_scale_permission(
          '41600000-0000-4000-8000-000000000160',
          'shared.scope.read', 'View shared scope records'
        ),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'module',
          'definitionKey', 'example.scope_module',
          'rootId', '31600000-0000-4000-8000-000000000160'::uuid,
          'releaseRevision', 1,
          'releaseVersion', '1.0.0',
          'validationContractVersion', '2.18.0',
          'contentFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
          'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
        ),
        'meaningFingerprint', 'sha256:' || pg_catalog.repeat('e', 64)
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationRelease', release_value,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(p_catalogue_character, 64),
    'applicationPermissionIds', application_permission_ids,
    'entries', entries,
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat(p_candidate_character, 64)
  );
end
$function$;

create function pg_temp.scope_scale_prepared(
  p_candidate jsonb,
  p_source_role_id uuid,
  p_role_key text,
  p_template_character text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
    'permissionRegistration', p_candidate,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', p_source_role_id,
        'key', p_role_key,
        'name', 'Scope and scale reader',
        'homePageId', '61600000-0000-4000-8000-000000000160'::uuid,
        'permissionKeys', (
          select coalesce(
            pg_catalog.jsonb_agg(item.value #>> '{permission,key}' order by
              (item.value #>> '{permission,key}') collate "C"),
            '[]'::jsonb
          )
          from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(value)
        ),
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

create function pg_temp.scale_permissions(p_odd_only boolean)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(
    pg_temp.scope_scale_permission(
      ('41600000-0000-4000-8001-' || pg_catalog.lpad(series.n::text, 12, '0'))::uuid,
      'scale.record_' || pg_catalog.lpad(series.n::text, 3, '0') || '.read',
      'View scale record ' || series.n::text
    ) order by series.n
  )
  from pg_catalog.generate_series(1, 257) as series(n)
  where not p_odd_only or series.n % 2 = 1
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '31600000-0000-4000-8000-000000000160',
    '21600000-0000-4000-8000-000000000160', 'module',
    'example.scope_module', pg_catalog.statement_timestamp(),
    '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000161',
    '21600000-0000-4000-8000-000000000160', 'application',
    'example.scope_a', pg_catalog.statement_timestamp(),
    '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000162',
    '21600000-0000-4000-8000-000000000160', 'application',
    'example.scope_b', pg_catalog.statement_timestamp(),
    '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000163',
    '21600000-0000-4000-8000-000000000161', 'application',
    'example.scope_foreign', pg_catalog.statement_timestamp(),
    '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000164',
    '21600000-0000-4000-8000-000000000160', 'application',
    'example.scale', pg_catalog.statement_timestamp(),
    '91600000-0000-4000-8000-000000000160'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '31600000-0000-4000-8000-000000000160', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"module","key":"example.scope_module","body":{}}',
    'sha256:' || pg_catalog.repeat('0', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'module', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
          '41600000-0000-4000-8000-000000000160',
          'shared.scope.read', 'View shared scope records'
        ))
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('3', 64), '[]', 'Shared scope module',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000161', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.scope_a","body":{}}',
    'sha256:' || pg_catalog.repeat('4', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
          '41600000-0000-4000-8000-000000000161',
          'scope.a.read', 'View scope A records'
        ))
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('7', 64), '[]', 'Scope A initial release',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000161', 2, '2.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.scope_a","body":{}}',
    'sha256:' || pg_catalog.repeat('8', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
          '41600000-0000-4000-8000-000000000161',
          'scope.a.read', 'View scope A records'
        ))
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('a', 64)),
    'sha256:' || pg_catalog.repeat('9', 64),
    'sha256:' || pg_catalog.repeat('a', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('b', 64), '[]', 'Scope A drops module',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000162', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.scope_b","body":{}}',
    'sha256:' || pg_catalog.repeat('c', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
          '41600000-0000-4000-8000-000000000162',
          'scope.b.read', 'View scope B records'
        ))
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('e', 64)),
    'sha256:' || pg_catalog.repeat('d', 64),
    'sha256:' || pg_catalog.repeat('e', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('f', 64), '[]', 'Scope B initial release',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000163', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.scope_foreign","body":{}}',
    'sha256:' || pg_catalog.repeat('0', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
          '41600000-0000-4000-8000-000000000163',
          'scope.foreign.read', 'View foreign records'
        ))
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('3', 64), '[]', 'Foreign scope release',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000164', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.scale","body":{}}',
    'sha256:' || pg_catalog.repeat('4', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_temp.scale_permissions(false)
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('7', 64), '[]', 'Scale full release',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  ),
  (
    '31600000-0000-4000-8000-000000000164', 2, '2.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.scale","body":{}}',
    'sha256:' || pg_catalog.repeat('8', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_temp.scale_permissions(true)
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('a', 64)),
    'sha256:' || pg_catalog.repeat('9', 64),
    'sha256:' || pg_catalog.repeat('a', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('b', 64), '[]', 'Scale narrowed release',
    pg_catalog.statement_timestamp(), '91600000-0000-4000-8000-000000000160'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values
  (
    '31600000-0000-4000-8000-000000000161', 1, 'module',
    'example.scope_module', '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    '31600000-0000-4000-8000-000000000160', 1, null
  ),
  (
    '31600000-0000-4000-8000-000000000162', 1, 'module',
    'example.scope_module', '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    '31600000-0000-4000-8000-000000000160', 1, null
  );

update vortex_definition.roots
set current_release_revision = case
  when root_id in (
    '31600000-0000-4000-8000-000000000161'::uuid,
    '31600000-0000-4000-8000-000000000164'::uuid
  ) then 2 else 1 end
where root_id in (
  '31600000-0000-4000-8000-000000000160'::uuid,
  '31600000-0000-4000-8000-000000000161'::uuid,
  '31600000-0000-4000-8000-000000000162'::uuid,
  '31600000-0000-4000-8000-000000000163'::uuid,
  '31600000-0000-4000-8000-000000000164'::uuid
);

create temporary table scope_scale_candidates as
select
  pg_temp.scope_scale_candidate(
    '21600000-0000-4000-8000-000000000160',
    '31600000-0000-4000-8000-000000000161', 'example.scope_a',
    1, '1.0.0', '5', '6', '7', '1',
    pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
      '41600000-0000-4000-8000-000000000161',
      'scope.a.read', 'View scope A records'
    )), true
  ) as scope_a_initial,
  pg_temp.scope_scale_candidate(
    '21600000-0000-4000-8000-000000000160',
    '31600000-0000-4000-8000-000000000161', 'example.scope_a',
    2, '2.0.0', '9', 'a', 'b', '2',
    pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
      '41600000-0000-4000-8000-000000000161',
      'scope.a.read', 'View scope A records'
    )), false
  ) as scope_a_without_module,
  pg_temp.scope_scale_candidate(
    '21600000-0000-4000-8000-000000000160',
    '31600000-0000-4000-8000-000000000162', 'example.scope_b',
    1, '1.0.0', 'd', 'e', 'f', '3',
    pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
      '41600000-0000-4000-8000-000000000162',
      'scope.b.read', 'View scope B records'
    )), true
  ) as scope_b_initial,
  pg_temp.scope_scale_candidate(
    '21600000-0000-4000-8000-000000000161',
    '31600000-0000-4000-8000-000000000163', 'example.scope_foreign',
    1, '1.0.0', '1', '2', '3', '4',
    pg_catalog.jsonb_build_array(pg_temp.scope_scale_permission(
      '41600000-0000-4000-8000-000000000163',
      'scope.foreign.read', 'View foreign records'
    )), false
  ) as foreign_initial,
  pg_temp.scope_scale_candidate(
    '21600000-0000-4000-8000-000000000160',
    '31600000-0000-4000-8000-000000000164', 'example.scale',
    1, '1.0.0', '5', '6', '7', '5', pg_temp.scale_permissions(false), false
  ) as scale_full,
  pg_temp.scope_scale_candidate(
    '21600000-0000-4000-8000-000000000160',
    '31600000-0000-4000-8000-000000000164', 'example.scale',
    2, '2.0.0', '9', 'a', 'b', '6', pg_temp.scale_permissions(true), false
  ) as scale_narrow;

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.scope_scale_prepared(
        (select scope_a_initial from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000161', 'scope_a_reader', '1'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000161',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000162'
    )
  $$,
  $$ values ('changed'::text, 1::bigint, 2::bigint) $$,
  'scope A registration changes its organization Access version once'
);
select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.scope_scale_prepared(
        (select scope_b_initial from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000162', 'scope_b_reader', '2'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000162',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000163'
    )
  $$,
  $$ values ('changed'::text, 1::bigint, 3::bigint) $$,
  'scope B independently registers the same bound-module permission'
);

select results_eq(
  $$
    select application_root_id, state, continuity_revision,
      last_processed_registration_revision
    from vortex_access.permission_continuities
    where organization_id = '21600000-0000-4000-8000-000000000160'
      and owner_kind = 'module'
      and owner_id = '31600000-0000-4000-8000-000000000160'
      and permission_id = '41600000-0000-4000-8000-000000000160'
    order by application_root_id
  $$,
  $$ values
    ('31600000-0000-4000-8000-000000000161'::uuid, 'available'::text, 1::bigint, 1::bigint),
    ('31600000-0000-4000-8000-000000000162'::uuid, 'available'::text, 1::bigint, 1::bigint)
  $$,
  'the identical module permission has independent application continuity rows'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '21600000-0000-4000-8000-000000000160',
  '51600000-0000-4000-8000-000000000160', 'custom', 'scope_b_custom',
  null, null, 1, '91600000-0000-4000-8000-000000000160',
  pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select entry.organization_id, '51600000-0000-4000-8000-000000000160'::uuid,
  1, 1, 'custom', null, entry.application_root_id, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  entry.registration_revision, registration.permission_catalogue_fingerprint,
  continuity.continuity_revision, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
join vortex_access.permission_continuities as continuity
  on continuity.organization_id = entry.organization_id
  and continuity.application_root_id = entry.application_root_id
  and continuity.owner_kind = entry.owner_kind
  and continuity.owner_id = entry.owner_id
  and continuity.permission_id = entry.permission_id
where entry.organization_id = '21600000-0000-4000-8000-000000000160'
  and entry.application_root_id = '31600000-0000-4000-8000-000000000162'
  and entry.owner_kind = 'module'
  and entry.permission_id = '41600000-0000-4000-8000-000000000160'
  and entry.registration_revision = 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  source_definition_key, source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values (
  '21600000-0000-4000-8000-000000000160',
  '51600000-0000-4000-8000-000000000160', 1, 'custom', null, 'active',
  'standard', 'standing', 1, 1, 'scope_b_custom', 'Scope B custom reader',
  'Accepted specifically against scope B module continuity.',
  null, null, null, null, null, null, null, null, null, null, null,
  '91600000-0000-4000-8000-000000000160', pg_catalog.statement_timestamp(),
  '71600000-0000-4000-8000-000000000164'
);
set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.scope_scale_prepared(
        (select scope_a_without_module from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000161', 'scope_a_reader', '1'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000161',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000165'
    )
  $$,
  $$ values ('changed'::text, 2::bigint, 4::bigint) $$,
  'removing scope A module evidence changes Access exactly once'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.read_available_permission(
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000161', 'module',
      '31600000-0000-4000-8000-000000000160',
      '41600000-0000-4000-8000-000000000160'
    )
  ),
  0,
  'scope A can no longer read the removed module permission'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.read_available_permission(
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000162', 'module',
      '31600000-0000-4000-8000-000000000160',
      '41600000-0000-4000-8000-000000000160'
    )
  ),
  1,
  'scope B continues to read its independently supplied module permission'
);
select results_eq(
  $$
    select role.live_revision, revision.authority_continuity_revision,
      permission.accepted_registration_revision, permission.continuity_revision,
      continuity.state, continuity.last_processed_registration_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_root_id = permission.application_root_id
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
    where role.organization_id = '21600000-0000-4000-8000-000000000160'
      and role.role_id = '51600000-0000-4000-8000-000000000160'
  $$,
  $$ values (1::bigint, 1::bigint, 1::bigint, 1::bigint, 'available'::text, 1::bigint) $$,
  'scope B accepted role evidence and continuity remain exact after scope A changes'
);

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'withdraw', 2, null,
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000161',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000166'
    )
  $$,
  $$ values ('changed'::text, 3::bigint, 5::bigint) $$,
  'withdrawing scope A changes Access exactly once'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.read_available_permission(
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000162', 'module',
      '31600000-0000-4000-8000-000000000160',
      '41600000-0000-4000-8000-000000000160'
    )
  ),
  1,
  'withdrawing scope A does not remove scope B module availability'
);
select results_eq(
  $$
    select role.live_revision, permission.accepted_registration_revision,
      continuity.continuity_revision, continuity.last_processed_registration_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = role.organization_id
      and permission.role_id = role.role_id
      and permission.role_revision = role.live_revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_root_id = permission.application_root_id
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
    where role.organization_id = '21600000-0000-4000-8000-000000000160'
      and role.role_id = '51600000-0000-4000-8000-000000000160'
  $$,
  $$ values (1::bigint, 1::bigint, 1::bigint, 1::bigint) $$,
  'scope B accepted role facts remain untouched after scope A withdrawal'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.scope_scale_prepared(
        (select foreign_initial from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000163', 'scope_foreign_reader', '3'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000161',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000167'
    )
  $$,
  '22023'::char(5), null,
  'a candidate from one organization cannot be substituted into another'
);
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.scope_scale_prepared(
        (select scope_a_initial from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000161', 'scope_a_reader', '1'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000162',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000168'
    )
  $$,
  '22023'::char(5), null,
  'one application candidate cannot be substituted for another in the same organization'
);
select results_eq(
  $$
    select organization_id, current_version
    from vortex_access.organization_access_versions
    where organization_id in (
      '21600000-0000-4000-8000-000000000160',
      '21600000-0000-4000-8000-000000000161'
    )
    order by organization_id
  $$,
  $$ values
    ('21600000-0000-4000-8000-000000000160'::uuid, 5::bigint),
    ('21600000-0000-4000-8000-000000000161'::uuid, 1::bigint)
  $$,
  'scope substitution failures do not increment either organization Access version'
);

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.scope_scale_prepared(
        (select scale_full from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000164', 'scale_reader', '4'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000164',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000169'
    )
  $$,
  $$ values ('changed'::text, 1::bigint, 6::bigint) $$,
  'the coordinator accepts the generated 257-permission exact release'
);
select results_eq(
  $$
    select
      (select pg_catalog.count(*) from vortex_access.permission_catalogue_entries
       where organization_id = '21600000-0000-4000-8000-000000000160'
         and registration_kind = 'application'
         and registration_owner_id = '31600000-0000-4000-8000-000000000164'
         and registration_revision = 1)::bigint,
      (select pg_catalog.count(*) from vortex_access.permission_continuities
       where organization_id = '21600000-0000-4000-8000-000000000160'
         and application_root_id = '31600000-0000-4000-8000-000000000164'
         and state = 'available')::bigint
  $$,
  $$ values (257::bigint, 257::bigint) $$,
  'the full exact catalogue and continuity sets contain all 257 permissions'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '21600000-0000-4000-8000-000000000160',
  '51600000-0000-4000-8000-000000000164', 'application', 'scale_reader',
  '31600000-0000-4000-8000-000000000164',
  '52600000-0000-4000-8000-000000000164', 1,
  '91600000-0000-4000-8000-000000000160', pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select entry.organization_id, '51600000-0000-4000-8000-000000000164'::uuid, 1,
  pg_catalog.row_number() over (order by entry.permission_id), 'application',
  entry.application_root_id, entry.application_root_id, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, continuity.continuity_revision,
  entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
join vortex_access.permission_continuities as continuity
  on continuity.organization_id = entry.organization_id
  and continuity.application_root_id = entry.application_root_id
  and continuity.owner_kind = entry.owner_kind
  and continuity.owner_id = entry.owner_id
  and continuity.permission_id = entry.permission_id
where entry.organization_id = '21600000-0000-4000-8000-000000000160'
  and entry.registration_owner_id = '31600000-0000-4000-8000-000000000164'
  and entry.registration_revision = 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  source_definition_key, source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  changed_by, changed_at, change_correlation_id
) values (
  '21600000-0000-4000-8000-000000000160',
  '51600000-0000-4000-8000-000000000164', 1, 'application',
  '31600000-0000-4000-8000-000000000164', 'active', 'standard', 'standing',
  1, 1, 'scale_reader', 'Scale reader', 'Accepted generated exact set.',
  'example.scale', 1, '1.0.0', '2.18.0',
  'sha256:' || pg_catalog.repeat('5', 64),
  'sha256:' || pg_catalog.repeat('6', 64),
  'sha256:' || pg_catalog.repeat('4', 64),
  'sha256:' || pg_catalog.repeat('7', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('8', 64),
  '91600000-0000-4000-8000-000000000160', pg_catalog.statement_timestamp(),
  '71600000-0000-4000-8000-000000000170'
);
set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select role.live_revision,
      (select pg_catalog.count(*) from vortex_access.organization_role_permission_entries p
       where p.organization_id = role.organization_id and p.role_id = role.role_id
         and p.role_revision = role.live_revision)::bigint,
      (select pg_catalog.min(entry_ordinal) from vortex_access.organization_role_permission_entries p
       where p.organization_id = role.organization_id and p.role_id = role.role_id
         and p.role_revision = role.live_revision)::bigint,
      (select pg_catalog.max(entry_ordinal) from vortex_access.organization_role_permission_entries p
       where p.organization_id = role.organization_id and p.role_id = role.role_id
         and p.role_revision = role.live_revision)::bigint
    from vortex_access.organization_roles as role
    where role.organization_id = '21600000-0000-4000-8000-000000000160'
      and role.role_id = '51600000-0000-4000-8000-000000000164'
  $$,
  $$ values (1::bigint, 257::bigint, 1::bigint, 257::bigint) $$,
  'entry-first sealing preserves the complete ordered 257-entry role revision'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_trigger
    where tgrelid = 'vortex_access.organization_role_permission_entries'::regclass
      and not tgisinternal
      and tgname = 'organization_role_permission_entries_evidence'
  ),
  0,
  'large entry insertion does not restore per-entry aggregate validation'
);
select throws_ok(
  $$
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select organization_id, role_id, role_revision, 258, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    from vortex_access.organization_role_permission_entries
    where organization_id = '21600000-0000-4000-8000-000000000160'
      and role_id = '51600000-0000-4000-8000-000000000164'
      and role_revision = 1 and entry_ordinal = 1
  $$,
  '23514'::char(5), null,
  'the sealed large role refuses a late appended entry'
);

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.scope_scale_prepared(
        (select scale_narrow from scope_scale_candidates),
        '52600000-0000-4000-8000-000000000164', 'scale_reader', '4'
      ),
      '21600000-0000-4000-8000-000000000160',
      '31600000-0000-4000-8000-000000000164',
      '91600000-0000-4000-8000-000000000160',
      '71600000-0000-4000-8000-000000000171'
    )
  $$,
  $$ values ('changed'::text, 2::bigint, 7::bigint) $$,
  'the coordinator narrows the generated set with one Access increment'
);
set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select role.live_revision, revision.lifecycle,
      revision.authority_continuity_revision,
      revision.accepted_registration_revision,
      (select pg_catalog.count(*) from vortex_access.organization_role_permission_entries p
       where p.organization_id = role.organization_id and p.role_id = role.role_id
         and p.role_revision = revision.revision)::bigint,
      (select pg_catalog.min(entry_ordinal) from vortex_access.organization_role_permission_entries p
       where p.organization_id = role.organization_id and p.role_id = role.role_id
         and p.role_revision = revision.revision)::bigint,
      (select pg_catalog.max(entry_ordinal) from vortex_access.organization_role_permission_entries p
       where p.organization_id = role.organization_id and p.role_id = role.role_id
         and p.role_revision = revision.revision)::bigint
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id and revision.revision = role.live_revision
    where role.organization_id = '21600000-0000-4000-8000-000000000160'
      and role.role_id = '51600000-0000-4000-8000-000000000164'
  $$,
  $$ values (2::bigint, 'active'::text, 1::bigint, 1::bigint,
    129::bigint, 1::bigint, 129::bigint) $$,
  'one coordinator revision creates one narrowed role revision with an exact contiguous set'
);
select results_eq(
  $$
    select role_revision, pg_catalog.count(*)::bigint
    from vortex_access.organization_role_permission_entries
    where organization_id = '21600000-0000-4000-8000-000000000160'
      and role_id = '51600000-0000-4000-8000-000000000164'
    group by role_revision
    order by role_revision
  $$,
  $$ values (1::bigint, 257::bigint), (2::bigint, 129::bigint) $$,
  'narrowing retains immutable revision one and seals exactly one successor revision'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from (
      (
        select permission_id
        from vortex_access.organization_role_permission_entries
        where organization_id = '21600000-0000-4000-8000-000000000160'
          and role_id = '51600000-0000-4000-8000-000000000164'
          and role_revision = 2
        except
        select permission_id
        from vortex_access.permission_catalogue_entries
        where organization_id = '21600000-0000-4000-8000-000000000160'
          and registration_kind = 'application'
          and registration_owner_id = '31600000-0000-4000-8000-000000000164'
          and registration_revision = 2
      )
      union all
      (
        select permission_id
        from vortex_access.permission_catalogue_entries
        where organization_id = '21600000-0000-4000-8000-000000000160'
          and registration_kind = 'application'
          and registration_owner_id = '31600000-0000-4000-8000-000000000164'
          and registration_revision = 2
        except
        select permission_id
        from vortex_access.organization_role_permission_entries
        where organization_id = '21600000-0000-4000-8000-000000000160'
          and role_id = '51600000-0000-4000-8000-000000000164'
          and role_revision = 2
      )
    ) as difference
  ),
  0,
  'the narrowed role entries exactly equal the release-two catalogue set'
);
select results_eq(
  $$
    select state, pg_catalog.count(*)::bigint,
      pg_catalog.min(last_processed_registration_revision)::bigint,
      pg_catalog.max(last_processed_registration_revision)::bigint
    from vortex_access.permission_continuities
    where organization_id = '21600000-0000-4000-8000-000000000160'
      and application_root_id = '31600000-0000-4000-8000-000000000164'
    group by state
    order by state
  $$,
  $$ values
    ('available'::text, 129::bigint, 2::bigint, 2::bigint),
    ('unavailable'::text, 128::bigint, 2::bigint, 2::bigint)
  $$,
  'all 257 continuity rows are processed once into the exact 129/128 narrowed partition'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_revisions
    where organization_id = '21600000-0000-4000-8000-000000000160'
      and role_id = '51600000-0000-4000-8000-000000000164'
  ),
  2,
  'the large permission count does not multiply aggregate role revisions'
);

select * from finish();

rollback;
