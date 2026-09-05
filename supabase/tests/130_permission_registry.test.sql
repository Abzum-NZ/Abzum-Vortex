\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_table(
  'vortex_access', 'permission_registrations',
  'Access stores one current permission-registration pointer per owner and organisation'
);
select has_table(
  'vortex_access', 'permission_registration_revisions',
  'Access preserves immutable permission-registration history'
);
select has_table(
  'vortex_access', 'permission_catalogue_entries',
  'Access preserves owner-qualified permission evidence for every registration revision'
);
select has_pk(
  'vortex_access', 'permission_registrations',
  'current registrations have one organisation/kind/owner identity'
);
select has_pk(
  'vortex_access', 'permission_registration_revisions',
  'registration history is revision-qualified'
);
select has_pk(
  'vortex_access', 'permission_catalogue_entries',
  'permission evidence is owner and permission qualified'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_class
    where oid in (
      'vortex_access.permission_registrations'::regclass,
      'vortex_access.permission_registration_revisions'::regclass,
      'vortex_access.permission_catalogue_entries'::regclass
    )
      and relrowsecurity
      and relforcerowsecurity
  ),
  3,
  'all permission-registry relations enable and force row security'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'vortex_access'
      and tablename in (
        'permission_registrations',
        'permission_registration_revisions',
        'permission_catalogue_entries'
      )
  ),
  0,
  'no direct row policy exposes private permission-registry storage'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_runtime', 'vortex_access.permission_registrations', 'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.permission_catalogue_entries', 'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.initialize_platform_permission_catalogue(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'browser, runtime, request and service roles cannot reach registry storage or owner handoffs'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.accept_organization_invitation(text,uuid,text,text,uuid)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_access.validated_human_request_context()', 'EXECUTE'
  ),
  'registry least privilege does not revoke earlier narrow Access grants'
);
select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc
    where oid in (
      'vortex_access.initialize_platform_permission_catalogue(uuid,uuid,uuid)'::regprocedure,
      'vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)'::regprocedure,
      'vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid)'::regprocedure,
      'vortex_access.read_available_permission(uuid,uuid,text,uuid,uuid)'::regprocedure,
      'vortex_access.read_application_permission_snapshot(uuid,uuid)'::regprocedure
    )
      and prosecdef
      and proconfig @> array['search_path=""']
  ),
  5,
  'every private registry operation is security definer with an empty search path'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000130', 'registry_tenant',
  'Registry tenant', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000130', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '21000000-0000-4000-8000-000000000130',
    '11000000-0000-4000-8000-000000000130', null, 'registry_org_one',
    'Registry organisation one', 'active', pg_catalog.statement_timestamp(),
    '91000000-0000-4000-8000-000000000130', pg_catalog.statement_timestamp(), 1
  ),
  (
    '21000000-0000-4000-8000-000000000131',
    '11000000-0000-4000-8000-000000000130', null, 'registry_org_two',
    'Registry organisation two', 'active', pg_catalog.statement_timestamp(),
    '91000000-0000-4000-8000-000000000130', pg_catalog.statement_timestamp(), 1
  ),
  (
    '21000000-0000-4000-8000-000000000132',
    '11000000-0000-4000-8000-000000000130', null, 'registry_org_exhausted',
    'Registry exhausted organisation', 'active', pg_catalog.statement_timestamp(),
    '91000000-0000-4000-8000-000000000130', pg_catalog.statement_timestamp(), 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000130',
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000130'
);
select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000131',
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000131'
);
insert into vortex_access.organization_access_versions (
  organization_id, current_version, changed_at, changed_by,
  change_correlation_id, change_reason
) values (
  '21000000-0000-4000-8000-000000000132', 9007199254740991,
  pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000132', 'organization_initialized'
);

create function pg_temp.registry_permission(
  p_permission_id uuid,
  p_key text,
  p_label text,
  p_description text,
  p_action_kind text,
  p_administrative boolean
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
    'description', p_description,
    'actionKind', p_action_kind,
    'administrative', p_administrative
  )
$function$;

create function pg_temp.registry_candidate(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_definition_key text,
  p_release_revision bigint,
  p_release_version text,
  p_content_character text,
  p_resolution_character text,
  p_permissions jsonb,
  p_include_module boolean,
  p_catalogue_character text,
  p_candidate_character text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  application_release jsonb;
  entries jsonb;
  application_permission_ids jsonb;
begin
  application_release := pg_catalog.jsonb_build_object(
    'kind', 'application',
    'definitionKey', p_definition_key,
    'rootId', p_application_root_id,
    'releaseRevision', p_release_revision,
    'releaseVersion', p_release_version,
    'validationContractVersion', '2.15.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
  );

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', 'application',
        'ownerId', p_application_root_id,
        'permission', permission_value,
        'sourceRelease', application_release,
        'meaningFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
      ) order by
        (permission_value ->> 'key') collate "C",
        (permission_value ->> 'permissionId') collate "C"
    ),
    '[]'::jsonb
  ) into entries
  from pg_catalog.jsonb_array_elements(p_permissions) as permission(permission_value);

  select coalesce(
    pg_catalog.jsonb_agg(permission_value ->> 'permissionId' order by
      (permission_value ->> 'key') collate "C",
      (permission_value ->> 'permissionId') collate "C"),
    '[]'::jsonb
  ) into application_permission_ids
  from pg_catalog.jsonb_array_elements(p_permissions) as permission(permission_value)
  where (permission_value ->> 'administrative')::boolean = false;

  if p_include_module then
    entries := entries || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', 'module',
        'ownerId', '31000000-0000-4000-8000-000000000130'::uuid,
        'permission', pg_temp.registry_permission(
          '41000000-0000-4000-8000-000000000133',
          'shared.module.read', 'View shared records',
          'View records supplied by the shared module.', 'read', false
        ),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'module',
          'definitionKey', 'example.shared_module',
          'rootId', '31000000-0000-4000-8000-000000000130'::uuid,
          'releaseRevision', 1,
          'releaseVersion', '1.0.0',
          'validationContractVersion', '2.15.0',
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
    'applicationRelease', application_release,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(p_catalogue_character, 64),
    'applicationPermissionIds', application_permission_ids,
    'entries', entries,
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat(p_candidate_character, 64)
  );
end
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '31000000-0000-4000-8000-000000000130',
    '21000000-0000-4000-8000-000000000130', 'module', 'example.shared_module',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000131',
    '21000000-0000-4000-8000-000000000130', 'application', 'example.application_one',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000132',
    '21000000-0000-4000-8000-000000000130', 'application', 'example.application_two',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000133',
    '21000000-0000-4000-8000-000000000131', 'application', 'example.application_one',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '31000000-0000-4000-8000-000000000130', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"module","key":"example.shared_module","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('0', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'module', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(pg_temp.registry_permission(
            '41000000-0000-4000-8000-000000000133',
            'shared.module.read', 'View shared records',
            'View records supplied by the shared module.', 'read', false
          ))
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64), '2.15.0',
    'sha256:' || pg_catalog.repeat('3', 64), '[]', 'Shared module release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000131', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.application_one","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('4', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000131',
              'shared.orders.read', 'View orders', 'View application orders.', 'read', false
            ),
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000132',
              'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
            )
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('6', 64), '2.15.0',
    'sha256:' || pg_catalog.repeat('7', 64), '[]', 'Application one release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000131', 2, '2.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.application_one","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('8', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000131',
              'shared.orders.read', 'Read orders', 'View application orders.', 'read', false
            ),
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000132',
              'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
            )
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('a', 64)),
    'sha256:' || pg_catalog.repeat('9', 64),
    'sha256:' || pg_catalog.repeat('a', 64), '2.15.0',
    'sha256:' || pg_catalog.repeat('b', 64), '[]', 'Application one replacement release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000132', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.application_two","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('c', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000131',
              'shared.orders.read', 'View orders', 'View application orders.', 'read', false
            ),
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000134',
              'shared.orders1.read', 'View numbered orders',
              'View numbered application orders.', 'read', false
            ),
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000135',
              'shared.orders_1.read', 'View grouped orders',
              'View grouped application orders.', 'read', false
            )
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('e', 64)),
    'sha256:' || pg_catalog.repeat('d', 64),
    'sha256:' || pg_catalog.repeat('e', 64), '2.15.0',
    'sha256:' || pg_catalog.repeat('f', 64), '[]', 'Application two release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  ),
  (
    '31000000-0000-4000-8000-000000000133', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.application_one","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('0', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.registry_permission(
              '41000000-0000-4000-8000-000000000131',
              'shared.orders.read', 'View orders', 'View application orders.', 'read', false
            )
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('1', 64)),
    'sha256:' || pg_catalog.repeat('0', 64),
    'sha256:' || pg_catalog.repeat('1', 64), '2.15.0',
    'sha256:' || pg_catalog.repeat('2', 64), '[]', 'Other organisation application release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000130'
  );

insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
) values
  (
    '31000000-0000-4000-8000-000000000131', 1, 'module', 'example.shared_module',
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    '31000000-0000-4000-8000-000000000130', 1, null
  ),
  (
    '31000000-0000-4000-8000-000000000132', 1, 'module', 'example.shared_module',
    '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    '31000000-0000-4000-8000-000000000130', 1, null
  );

update vortex_definition.roots
set current_release_revision = case
  when root_id = '31000000-0000-4000-8000-000000000131'::uuid then 2
  else 1
end
where root_id in (
  '31000000-0000-4000-8000-000000000130'::uuid,
  '31000000-0000-4000-8000-000000000131'::uuid,
  '31000000-0000-4000-8000-000000000132'::uuid,
  '31000000-0000-4000-8000-000000000133'::uuid
);

select is(
  (
    select count(*)::integer
    from vortex_access.read_available_permission(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131',
      'application',
      '31000000-0000-4000-8000-000000000131',
      '41000000-0000-4000-8000-000000000131'
    )
  ),
  0,
  'publishing an application release does not activate its permissions'
);

create temporary table platform_initialization on commit drop as
select * from vortex_access.initialize_platform_permission_catalogue(
  '21000000-0000-4000-8000-000000000130',
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000133'
);
select is(
  (select access_version from platform_initialization),
  2::bigint,
  'explicit platform registration invalidates the organisation Access version once'
);
select is(
  (
    select count(*)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_kind = 'platform'
  ),
  13,
  'the exact closed v1 platform catalogue contributes thirteen entries'
);
select is(
  (
    select count(*)::integer
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    where entry.organization_id = '21000000-0000-4000-8000-000000000130'
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'
      and entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'
      and entry.source_kind = 'platform_catalogue'
      and entry.source_version = '1.0.0'
      and entry.source_catalogue_fingerprint =
        'sha256:f618491ff7091595ba5dde875e030bfdf7c4bdfe49572a3428914e91a6fe25bd'
      and entry.administrative
      and entry.record_type_id is null
      and entry.named_action is null
      and entry.action_kind in ('read', 'manage')
      and entry.permission_key like '%.' || entry.action_kind
      and registration.state = 'active'
      and registration.source_version = '1.0.0'
  ),
  13,
  'executed platform rows retain the documented owner, version and administrative classification'
);
select is(
  (
    select permission_key
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and permission_id = '687d5649-62ee-43dd-b684-b8af3a5394c1'
  ),
  'platform.organization.permissions.read',
  'the documented permanent platform permission identity and key are preserved'
);
select is(
  (
    select access_version
    from vortex_access.initialize_platform_permission_catalogue(
      '21000000-0000-4000-8000-000000000130',
      '91000000-0000-4000-8000-000000000130',
      '71000000-0000-4000-8000-000000000134'
    )
  ),
  2::bigint,
  'exact platform initialisation replay creates no revision or Access-version change'
);

create temporary table application_one_registration on commit drop as
select * from vortex_access.apply_application_permission_registration_v1_internal(
  'register', null,
  pg_temp.registry_candidate(
    '21000000-0000-4000-8000-000000000130',
    '31000000-0000-4000-8000-000000000131', 'example.application_one',
    1, '1.0.0', '5', '6',
    pg_catalog.jsonb_build_array(
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000131',
        'shared.orders.read', 'View orders', 'View application orders.', 'read', false
      ),
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000132',
        'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
      )
    ),
    true, '6', '7'
  ),
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000135'
);
select is(
  (select registration_revision from application_one_registration),
  1::bigint,
  'first application activation creates registration revision one'
);
select is(
  (select access_version from application_one_registration),
  3::bigint,
  'application activation and Access invalidation commit together'
);
select is(
  (
    select permission_ids
    from vortex_access.read_application_permission_snapshot(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131'
    )
  ),
  array['41000000-0000-4000-8000-000000000131'::uuid],
  'application wildcard input excludes administrative and module permissions'
);
select is(
  (
    select application_root_id
    from vortex_access.read_available_permission(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131',
      'module',
      '31000000-0000-4000-8000-000000000130',
      '41000000-0000-4000-8000-000000000133'
    )
  ),
  '31000000-0000-4000-8000-000000000131'::uuid,
  'bound-module availability preserves its supplying application context'
);
select is(
  (
    select count(*)::integer
    from vortex_access.read_available_permission(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000132',
      'module',
      '31000000-0000-4000-8000-000000000130',
      '41000000-0000-4000-8000-000000000133'
    )
  ),
  0,
  'one application registration cannot manufacture another application context'
);

select * from vortex_access.apply_application_permission_registration_v1_internal(
  'register', null,
  pg_temp.registry_candidate(
    '21000000-0000-4000-8000-000000000130',
    '31000000-0000-4000-8000-000000000132', 'example.application_two',
    1, '1.0.0', 'd', 'e',
    pg_catalog.jsonb_build_array(
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000131',
        'shared.orders.read', 'View orders', 'View application orders.', 'read', false
      ),
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000134',
        'shared.orders1.read', 'View numbered orders',
        'View numbered application orders.', 'read', false
      ),
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000135',
        'shared.orders_1.read', 'View grouped orders',
        'View grouped application orders.', 'read', false
      )
    ),
    true, 'e', 'f'
  ),
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000136'
);
select is(
  (
    select count(*)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_kind = 'application'
      and permission_id = '41000000-0000-4000-8000-000000000131'
      and permission_key = 'shared.orders.read'
      and registration_revision = 1
  ),
  2,
  'the same permission identity and key remain distinct under two application owners'
);
select is(
  (
    select permission_ids
    from vortex_access.read_application_permission_snapshot(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000132'
    )
  ),
  array[
    '41000000-0000-4000-8000-000000000131'::uuid,
    '41000000-0000-4000-8000-000000000134'::uuid,
    '41000000-0000-4000-8000-000000000135'::uuid
  ],
  'punctuation-valid keys use the same locale-independent byte order as TypeScript'
);

select * from vortex_access.apply_application_permission_registration_v1_internal(
  'register', null,
  pg_temp.registry_candidate(
    '21000000-0000-4000-8000-000000000131',
    '31000000-0000-4000-8000-000000000133', 'example.application_one',
    1, '1.0.0', '0', '1',
    pg_catalog.jsonb_build_array(pg_temp.registry_permission(
      '41000000-0000-4000-8000-000000000131',
      'shared.orders.read', 'View orders', 'View application orders.', 'read', false
    )),
    false, '2', '3'
  ),
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000144'
);
select is(
  (
    select count(distinct organization_id)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id in (
      '21000000-0000-4000-8000-000000000130'::uuid,
      '21000000-0000-4000-8000-000000000131'::uuid
    )
      and registration_owner_id in (
        '31000000-0000-4000-8000-000000000131'::uuid,
        '31000000-0000-4000-8000-000000000133'::uuid
      )
      and registration_revision = 1
      and permission_id = '41000000-0000-4000-8000-000000000131'
      and permission_key = 'shared.orders.read'
      and label = 'View orders'
  ),
  2,
  'identical permission identities, keys and labels remain organisation and owner qualified'
);

select * from vortex_access.withdraw_application_permission_registration_v1_internal(
  '21000000-0000-4000-8000-000000000130',
  '31000000-0000-4000-8000-000000000131', 1,
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000137'
);
select is(
  (
    select count(*)::integer
    from vortex_access.read_available_permission(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131',
      'module', '31000000-0000-4000-8000-000000000130',
      '41000000-0000-4000-8000-000000000133'
    )
  ),
  0,
  'withdrawing one application removes only that supplying application context'
);
select is(
  (
    select count(*)::integer
    from vortex_access.read_application_permission_snapshot(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131'
    )
  ),
  0,
  'withdrawal removes the active release reference consumed by later role-template resolution'
);
select is(
  (
    select count(*)::integer
    from vortex_access.read_available_permission(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000132',
      'module', '31000000-0000-4000-8000-000000000130',
      '41000000-0000-4000-8000-000000000133'
    )
  ),
  1,
  'another active compatible supplier remains available in its exact context'
);

create temporary table application_one_reactivation on commit drop as
select * from vortex_access.apply_application_permission_registration_v1_internal(
  'reactivate', 2,
  pg_temp.registry_candidate(
    '21000000-0000-4000-8000-000000000130',
    '31000000-0000-4000-8000-000000000131', 'example.application_one',
    1, '1.0.0', '5', '6',
    pg_catalog.jsonb_build_array(
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000131',
        'shared.orders.read', 'View orders', 'View application orders.', 'read', false
      ),
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000132',
        'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
      )
    ),
    true, '6', '7'
  ),
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000138'
);
select is(
  (select registration_revision from application_one_reactivation),
  3::bigint,
  'explicit revision-checked reactivation appends new evidence'
);
select results_eq(
  $$
    select registration_revision, release_revision, definition_key, release_version
    from vortex_access.read_application_permission_snapshot(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131'
    )
  $$,
  $$ values (3::bigint, 1::bigint, 'example.application_one'::text, '1.0.0'::text) $$,
  'reactivation exposes the exact immutable application release by reference without a template copy'
);
select is(
  (
    select operation
    from vortex_access.permission_registration_revisions
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_owner_id = '31000000-0000-4000-8000-000000000131'
      and revision = 3
  ),
  'reactivate',
  'reactivation remains distinguishable from retry and initial registration'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.apply_application_permission_registration_v1_internal(%L, %s, %L::jsonb, %L, %L)',
    'update', 2,
    pg_temp.registry_candidate(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131', 'example.application_one',
      1, '1.0.0', '5', '6',
      pg_catalog.jsonb_build_array(
        pg_temp.registry_permission(
          '41000000-0000-4000-8000-000000000131',
          'shared.orders.read', 'View orders', 'View application orders.', 'read', false
        ),
        pg_temp.registry_permission(
          '41000000-0000-4000-8000-000000000132',
          'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
        )
      ),
      true, '6', '7'
    ),
    '91000000-0000-4000-8000-000000000130',
    '71000000-0000-4000-8000-000000000139'
  ),
  '40001'::char(5), null,
  'a stale registration revision is refused'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000130'
  ),
  6::bigint,
  'stale mutation refusal leaves the Access version unchanged'
);

create temporary table application_one_update on commit drop as
select * from vortex_access.apply_application_permission_registration_v1_internal(
  'update', 3,
  pg_temp.registry_candidate(
    '21000000-0000-4000-8000-000000000130',
    '31000000-0000-4000-8000-000000000131', 'example.application_one',
    2, '2.0.0', '9', 'a',
    pg_catalog.jsonb_build_array(
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000131',
        'shared.orders.read', 'Read orders', 'View application orders.', 'read', false
      ),
      pg_temp.registry_permission(
        '41000000-0000-4000-8000-000000000132',
        'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
      )
    ),
    false, 'a', 'b'
  ),
  '91000000-0000-4000-8000-000000000130',
  '71000000-0000-4000-8000-000000000140'
);
select is(
  (select registration_revision from application_one_update),
  4::bigint,
  'an explicit release update appends one registration revision'
);
select is(
  (
    select count(*)::integer
    from vortex_access.read_available_permission(
      '21000000-0000-4000-8000-000000000130',
      '31000000-0000-4000-8000-000000000131',
      'module', '31000000-0000-4000-8000-000000000130',
      '41000000-0000-4000-8000-000000000133'
    )
  ),
  0,
  'a module permission removed by the activated release is unavailable in that application'
);
select is(
  (
    select count(distinct permission_id)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_owner_id = '31000000-0000-4000-8000-000000000131'
      and owner_kind = 'application'
      and permission_key = 'shared.orders.read'
  ),
  1,
  'label changes preserve the permanent permission identity across release evidence'
);
select is(
  (
    select count(distinct meaning_fingerprint)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_owner_id = '31000000-0000-4000-8000-000000000131'
      and owner_kind = 'application'
      and permission_key = 'shared.orders.read'
  ),
  1,
  'label-only changes preserve authority-bearing meaning while release evidence changes'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.apply_application_permission_registration_v1_internal(%L, null, %L::jsonb, %L, %L)',
    'register',
    pg_catalog.jsonb_set(
      pg_temp.registry_candidate(
        '21000000-0000-4000-8000-000000000131',
        '31000000-0000-4000-8000-000000000132', 'example.application_two',
        1, '1.0.0', 'd', 'e',
        pg_catalog.jsonb_build_array(pg_temp.registry_permission(
          '41000000-0000-4000-8000-000000000131',
          'shared.orders.read', 'View orders', 'View application orders.', 'read', false
        )),
        true, 'e', 'f'
      ),
      '{applicationRootId}',
      pg_catalog.to_jsonb('31000000-0000-4000-8000-000000000132'::text)
    ),
    '91000000-0000-4000-8000-000000000130',
    '71000000-0000-4000-8000-000000000141'
  ),
  '40001'::char(5), null,
  'cross-organisation release evidence is refused'
);

select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.apply_application_permission_registration_v1_internal(%L, %s, %L::jsonb, %L, %L)',
    'update', 4,
    pg_catalog.jsonb_set(
      pg_temp.registry_candidate(
        '21000000-0000-4000-8000-000000000130',
        '31000000-0000-4000-8000-000000000131', 'example.application_one',
        2, '2.0.0', '9', 'a',
        pg_catalog.jsonb_build_array(
          pg_temp.registry_permission(
            '41000000-0000-4000-8000-000000000131',
            'shared.orders.read', 'Read orders', 'View application orders.', 'read', false
          ),
          pg_temp.registry_permission(
            '41000000-0000-4000-8000-000000000132',
            'shared.orders.manage', 'Manage orders', 'Manage application orders.', 'manage', true
          )
        ),
        false, 'a', 'b'
      ),
      '{entries,0,permission,label}',
      pg_catalog.to_jsonb('Fabricated label'::text)
    ),
    '91000000-0000-4000-8000-000000000130',
    '71000000-0000-4000-8000-000000000142'
  ),
  '40001'::char(5), null,
  'a permission not matching immutable canonical release content is refused'
);
select is(
  (
    select revision
    from vortex_access.permission_registrations
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_kind = 'application'
      and registration_owner_id = '31000000-0000-4000-8000-000000000131'
  ),
  4::bigint,
  'refused canonical-content mutation leaves no partial registration revision'
);

select throws_ok(
  $$
    select * from vortex_access.initialize_platform_permission_catalogue(
      '21000000-0000-4000-8000-000000000132',
      '91000000-0000-4000-8000-000000000130',
      '71000000-0000-4000-8000-000000000143'
    )
  $$,
  '22003'::char(5), null,
  'Access-version exhaustion rolls back permission registration'
);
select is(
  (
    select
      (select count(*) from vortex_access.permission_registrations
        where organization_id = '21000000-0000-4000-8000-000000000132')
      + (select count(*) from vortex_access.permission_registration_revisions
        where organization_id = '21000000-0000-4000-8000-000000000132')
      + (select count(*) from vortex_access.permission_catalogue_entries
        where organization_id = '21000000-0000-4000-8000-000000000132')
  ),
  0::bigint,
  'failed Access invalidation rolls back current, history and provisional catalogue writes'
);

select throws_ok(
  $$
    update vortex_access.permission_registration_revisions
    set operation = 'update'
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_kind = 'application'
      and registration_owner_id = '31000000-0000-4000-8000-000000000131'
      and revision = 1
  $$,
  '23514'::char(5), null,
  'registration history cannot be rewritten'
);
select throws_ok(
  $$
    delete from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000130'
      and registration_kind = 'application'
      and registration_owner_id = '31000000-0000-4000-8000-000000000131'
      and registration_revision = 1
  $$,
  '23514'::char(5), null,
  'historical permission evidence cannot be erased'
);

select * from finish();

rollback;
