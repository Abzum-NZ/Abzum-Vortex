\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select has_column(
  'vortex_access', 'organization_role_revisions', 'authority_continuity_revision',
  'role revisions expose the exact authority continuity epoch'
);
select col_not_null(
  'vortex_access', 'organization_role_revisions', 'authority_continuity_revision',
  'authority continuity is required storage evidence'
);
select fk_ok(
  'vortex_access', 'organization_role_permission_entries',
  array['organization_id', 'role_id', 'role_revision', 'role_kind', 'role_application_scope_id'],
  'vortex_access', 'organization_role_revisions',
  array['organization_id', 'role_id', 'revision', 'role_kind', 'application_scope_id'],
  'role permission entries retain their revision foreign key'
);
select ok(
  (
    select condeferrable and condeferred
    from pg_catalog.pg_constraint
    where conname = 'organization_role_permission_entries_role_revision_fk'
      and conrelid = 'vortex_access.organization_role_permission_entries'::regclass
  ),
  'only the entry-to-final-revision foreign key permits entry-first sealing'
);
select ok(
  to_regprocedure(
    'vortex_access.apply_application_permission_registration(text,bigint,jsonb,uuid,uuid)'
  ) is null
  and to_regprocedure(
    'vortex_access.withdraw_application_permission_registration(uuid,uuid,bigint,uuid,uuid)'
  ) is null,
  'the uncoordinated raw application mutation names are no longer callable'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_access.coordinate_application_access_change(text,bigint,jsonb,uuid,uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid)',
    'EXECUTE'
  ),
  'coordinator, legacy raw helpers and all composition helpers remain owner-only'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_trigger
    where tgrelid = 'vortex_access.organization_role_permission_entries'::regclass
      and not tgisinternal
      and tgname = 'organization_role_permission_entries_refuse_sealed_append'
  ),
  1,
  'one immediate trigger locks the permanent role and refuses sealed appends'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_trigger
    where tgrelid = 'vortex_access.organization_role_revisions'::regclass
      and not tgisinternal
      and tgname = 'organization_role_revisions_lock_before_seal'
  ),
  1,
  'the final revision seal takes the same permanent-role lock as entry insertion'
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
  'per-entry aggregate role validation is removed'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000150', 'coordination_tenant',
  'Coordination tenant', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  '21000000-0000-4000-8000-000000000150',
  '11000000-0000-4000-8000-000000000150', 'coordination_org',
  'Coordination organisation', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-000000000150'
);

create function pg_temp.coordination_permission(
  p_permission_id uuid,
  p_label text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', p_permission_id,
    'key', case p_permission_id
      when '41000000-0000-4000-8000-000000000150'::uuid
        then 'example.records.read'
      when '41000000-0000-4000-8000-000000000151'::uuid
        then 'example.records.update'
      else 'example.records.manage'
    end,
    'label', p_label,
    'description', p_label || ' in the coordination fixture.',
    'actionKind', case p_permission_id
      when '41000000-0000-4000-8000-000000000150'::uuid then 'read'
      when '41000000-0000-4000-8000-000000000151'::uuid then 'update'
      else 'manage'
    end,
    'administrative', false
  )
$function$;

create function pg_temp.coordination_candidate(
  p_release_revision bigint,
  p_release_version text,
  p_content_character text,
  p_resolution_character text,
  p_catalogue_character text,
  p_candidate_character text,
  p_permissions jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  release_value jsonb;
  entries jsonb;
begin
  release_value := pg_catalog.jsonb_build_object(
    'kind', 'application',
    'definitionKey', 'example.coordination',
    'rootId', '31000000-0000-4000-8000-000000000150'::uuid,
    'releaseRevision', p_release_revision,
    'releaseVersion', p_release_version,
    'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
  );
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', '31000000-0000-4000-8000-000000000150'::uuid,
      'ownerKind', 'application',
      'ownerId', '31000000-0000-4000-8000-000000000150'::uuid,
      'permission', item.value,
      'sourceRelease', release_value,
      'meaningFingerprint', case
        when item.value ->> 'permissionId' =
          '41000000-0000-4000-8000-000000000150'
          then 'sha256:' || pg_catalog.repeat('d', 64)
        else 'sha256:' || pg_catalog.repeat('e', 64)
      end
    ) order by item.value ->> 'key'
  ) into entries
  from pg_catalog.jsonb_array_elements(p_permissions) as item(value);
  return pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '21000000-0000-4000-8000-000000000150'::uuid,
    'applicationRootId', '31000000-0000-4000-8000-000000000150'::uuid,
    'applicationRelease', release_value,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(p_catalogue_character, 64),
    'applicationPermissionIds', (
      select pg_catalog.jsonb_agg(item.value ->> 'permissionId' order by item.value ->> 'key')
      from pg_catalog.jsonb_array_elements(p_permissions) as item(value)
    ),
    'entries', entries,
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat(p_candidate_character, 64)
  );
end
$function$;

create function pg_temp.coordination_prepared(
  p_candidate jsonb,
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
        'roleId', '52000000-0000-4000-8000-000000000150'::uuid,
        'key', 'records_reader', 'name', 'Records reader',
        'homePageId', '61000000-0000-4000-8000-000000000150'::uuid,
        'permissionKeys', (
          select pg_catalog.jsonb_agg(item.value #>> '{permission,key}' order by
            item.value #>> '{permission,key}')
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

create function pg_temp.coordination_prepared_template_matrix(
  p_candidate jsonb,
  p_template_character text,
  p_include_primary boolean,
  p_include_sentinel boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with template_items as (
    select pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '52000000-0000-4000-8000-000000000150'::uuid,
        'key', 'records_reader', 'name', 'Records reader',
        'homePageId', '61000000-0000-4000-8000-000000000150'::uuid,
        'permissionKeys', pg_catalog.jsonb_build_array('example.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint',
        'sha256:' || pg_catalog.repeat(p_template_character, 64),
      'sourcePermissions', p_candidate -> 'entries',
      'livePermissions', p_candidate -> 'entries'
    ) as item
    where p_include_primary
    union all
    select pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '52000000-0000-4000-8000-000000000151'::uuid,
        'key', 'records_observer', 'name', 'Records observer',
        'homePageId', '61000000-0000-4000-8000-000000000151'::uuid,
        'permissionKeys', pg_catalog.jsonb_build_array('example.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint',
        'sha256:' || pg_catalog.repeat('4', 64),
      'sourcePermissions', p_candidate -> 'entries',
      'livePermissions', p_candidate -> 'entries'
    )
    where p_include_sentinel
  )
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
    'permissionRegistration', p_candidate,
    'templates', (
      select pg_catalog.jsonb_agg(item order by item #>> '{template,roleId}')
      from template_items
    ),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
  )
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '31000000-0000-4000-8000-000000000150',
  '21000000-0000-4000-8000-000000000150', 'application',
  'example.coordination', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000150'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '31000000-0000-4000-8000-000000000150', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.coordination","body":{}}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(
          pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records'),
          pg_temp.coordination_permission('41000000-0000-4000-8000-000000000151', 'Update records')
        )
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)),
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('2', 64), '[]', 'Initial coordination release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000150'
  ),
  (
    '31000000-0000-4000-8000-000000000150', 2, '2.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.coordination","body":{}}',
    'sha256:' || pg_catalog.repeat('3', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(
          pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
        )
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('4', 64)),
    'sha256:' || pg_catalog.repeat('c', 64),
    'sha256:' || pg_catalog.repeat('4', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('5', 64), '[]', 'Narrow coordination release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000150'
  ),
  (
    '31000000-0000-4000-8000-000000000150', 3, '2.0.1',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.coordination","body":{}}',
    'sha256:' || pg_catalog.repeat('6', 64), '1.0.0',
    pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(
          pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'Read records')
        )
      ))),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('7', 64)),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('7', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('8', 64), '[]', 'Display coordination release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000150'
  );

create function pg_temp.add_coordination_release(
  p_revision bigint,
  p_version text,
  p_content_character text,
  p_resolution_character text,
  p_permissions jsonb
)
returns void
language sql
set search_path = ''
as $function$
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  ) values (
    '31000000-0000-4000-8000-000000000150', p_revision, p_version,
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.coordination","body":{}}',
    'sha256:' || pg_catalog.repeat(p_content_character, 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical',
      pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object('permissions', p_permissions)
      )
    ),
    pg_catalog.jsonb_build_object(
      'fingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
    ),
    'sha256:' || pg_catalog.repeat(p_content_character, 64),
    'sha256:' || pg_catalog.repeat(p_resolution_character, 64), '2.18.0',
    'sha256:' || pg_catalog.repeat(p_content_character, 64), '[]',
    'Coordination matrix release ' || p_revision,
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000150'
  )
$function$;

select pg_temp.add_coordination_release(
  4, '3.0.0', '9', '0',
  pg_catalog.jsonb_build_array(
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records'),
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000151', 'Update records'),
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000152', 'Manage records')
  )
);
select pg_temp.add_coordination_release(
  5, '4.0.0', '1', '2',
  pg_catalog.jsonb_build_array(
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
  )
);
select pg_temp.add_coordination_release(
  6, '5.0.0', '5', '6',
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_set(
      pg_temp.coordination_permission(
        '41000000-0000-4000-8000-000000000150', 'Update records'
      ),
      '{actionKind}', '"update"'::jsonb
    )
  )
);
select pg_temp.add_coordination_release(
  7, '6.0.0', '9', 'a',
  pg_catalog.jsonb_build_array(
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
  )
);
select pg_temp.add_coordination_release(
  8, '7.0.0', 'd', 'e',
  pg_catalog.jsonb_build_array(
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
  )
);
select pg_temp.add_coordination_release(
  9, '8.0.0', '1', '3',
  pg_catalog.jsonb_build_array(
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
  )
);
select pg_temp.add_coordination_release(
  10, '9.0.0', '5', '7',
  pg_catalog.jsonb_build_array(
    pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
  )
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '31000000-0000-4000-8000-000000000151',
  '21000000-0000-4000-8000-000000000150', 'application',
  'example.legacy_coordination', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000150'
);
insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
)
select '31000000-0000-4000-8000-000000000151'::uuid,
  release_revision, release_version,
  pg_catalog.jsonb_set(authored_source, '{key}', '"example.legacy_coordination"'::jsonb),
  authored_source_fingerprint,
  source_contract_version, compilation_output, resolution_snapshot,
  content_fingerprint, resolution_fingerprint, validation_contract_version,
  comparison_fingerprint, impact_reasons, release_note,
  pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000150'::uuid
from vortex_definition.releases
where root_id = '31000000-0000-4000-8000-000000000150'
  and release_revision in (1, 2);

create temporary table coordination_candidates as
select
  pg_temp.coordination_candidate(
    1, '1.0.0', 'a', 'b', 'c', '1',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records'),
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000151', 'Update records')
    )
  ) as initial_candidate,
  pg_temp.coordination_candidate(
    2, '2.0.0', 'c', '4', '5', '2',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
    )
  ) as narrow_candidate,
  pg_temp.coordination_candidate(
    3, '2.0.1', '6', '7', '8', '3',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'Read records')
    )
  ) as display_candidate,
  pg_temp.coordination_candidate(
    4, '3.0.0', '9', '0', 'a', 'b',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records'),
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000151', 'Update records'),
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000152', 'Manage records')
    )
  ) as addition_candidate,
  pg_temp.coordination_candidate(
    5, '4.0.0', '1', '2', '3', '4',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
    )
  ) as pending_removal_candidate,
  pg_catalog.jsonb_set(
    pg_temp.coordination_candidate(
      6, '5.0.0', '5', '6', '7', '8',
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_set(
          pg_temp.coordination_permission(
            '41000000-0000-4000-8000-000000000150', 'Update records'
          ),
          '{actionKind}', '"update"'::jsonb
        )
      )
    ),
    '{entries,0,meaningFingerprint}',
    pg_catalog.to_jsonb('sha256:' || pg_catalog.repeat('e', 64))
  ) as meaning_b_candidate,
  pg_temp.coordination_candidate(
    7, '6.0.0', '9', 'a', 'b', 'c',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
    )
  ) as meaning_a_return_candidate,
  pg_temp.coordination_candidate(
    8, '7.0.0', 'd', 'e', 'f', '0',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
    )
  ) as template_add_candidate,
  pg_temp.coordination_candidate(
    9, '8.0.0', '1', '3', '5', '7',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
    )
  ) as template_remove_candidate,
  pg_temp.coordination_candidate(
    10, '9.0.0', '5', '7', '9', 'b',
    pg_catalog.jsonb_build_array(
      pg_temp.coordination_permission('41000000-0000-4000-8000-000000000150', 'View records')
    )
  ) as template_readd_candidate;

create temporary table legacy_coordination_candidates as
select
  pg_catalog.replace(
    pg_catalog.replace(initial_candidate::text,
      '31000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151'),
    'example.coordination', 'example.legacy_coordination'
  )::jsonb as initial_candidate,
  pg_catalog.replace(
    pg_catalog.replace(narrow_candidate::text,
      '31000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151'),
    'example.coordination', 'example.legacy_coordination'
  )::jsonb as narrow_candidate
from coordination_candidates;

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.coordination_prepared((select initial_candidate from coordination_candidates), 'e'),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000151'
    )
  $$,
  $$ values ('changed'::text, 'register'::text, 1::bigint, 2::bigint) $$,
  'register atomically establishes catalogue and both continuity sets with one Access increment'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000150', 'application', 'records_reader',
  '31000000-0000-4000-8000-000000000150',
  '52000000-0000-4000-8000-000000000150', 1,
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select entry.organization_id,
  '51000000-0000-4000-8000-000000000150'::uuid, 1,
  pg_catalog.row_number() over (order by entry.permission_id), 'application',
  entry.application_root_id, entry.application_root_id, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '21000000-0000-4000-8000-000000000150'
  and entry.registration_owner_id = '31000000-0000-4000-8000-000000000150'
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
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000150', 1, 'application',
  '31000000-0000-4000-8000-000000000150', 'active', 'standard', 'standing',
  1, 1, 'records_reader', 'Records reader', 'Locally accepted reader.',
  'example.coordination', 1, '1.0.0', '2.18.0',
  'sha256:' || pg_catalog.repeat('a', 64),
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('e', 64),
  'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('9', 64),
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000152'
);
set constraints all immediate;
set constraints all deferred;

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000153', 'custom',
  'target_custom_reader', 1,
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select entry.organization_id,
  '51000000-0000-4000-8000-000000000153'::uuid, 1, 1, 'custom',
  entry.application_root_id, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  entry.registration_revision, registration.permission_catalogue_fingerprint,
  1, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '21000000-0000-4000-8000-000000000150'
  and entry.registration_owner_id = '31000000-0000-4000-8000-000000000150'
  and entry.registration_revision = 1
  and entry.permission_id = '41000000-0000-4000-8000-000000000150';
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000153', 1, 'custom', 'active',
  'standard', 'standing', 1, 1, 'target_custom_reader',
  'Target custom reader', 'Must not be rewritten by application coordination.',
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000183'
);
set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.coordination_prepared((select narrow_candidate from coordination_candidates), 'f'),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000153'
    )
  $$,
  $$ values ('changed'::text, 2::bigint, 3::bigint) $$,
  'a pure reduction changes the registration once'
);
select results_eq(
  $$
    select revision, lifecycle, authority_continuity_revision,
      accepted_registration_revision,
      (select pg_catalog.count(*) from vortex_access.organization_role_permission_entries p
       where p.organization_id = r.organization_id and p.role_id = r.role_id
         and p.role_revision = r.revision)::bigint
    from vortex_access.organization_role_revisions r
    where organization_id = '21000000-0000-4000-8000-000000000150'
      and role_id = '51000000-0000-4000-8000-000000000150'
      and revision = 2
  $$,
  $$ values (2::bigint, 'active'::text, 1::bigint, 1::bigint, 1::bigint) $$,
  'automatic reduction stays active and preserves accepted provenance and authority epoch'
);
select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 2,
      pg_temp.coordination_prepared((select narrow_candidate from coordination_candidates), 'f'),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000154'
    )
  $$,
  $$ values ('unchanged'::text, 2::bigint, 3::bigint) $$,
  'complete current parity returns an explicit unchanged result without incrementing Access'
);

select * from vortex_access.coordinate_application_access_change(
  'update', 2,
  pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-000000000155'
);
select results_eq(
  $$
    select live_revision, authority_continuity_revision,
      (select continuity_revision
       from vortex_access.application_role_template_continuities
       where organization_id = role.organization_id
         and application_root_id = role.application_root_id
         and source_role_id = role.source_role_id)
    from vortex_access.organization_roles role
    join vortex_access.organization_role_revisions revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id and revision.revision = role.live_revision
    where role.organization_id = '21000000-0000-4000-8000-000000000150'
      and role.role_id = '51000000-0000-4000-8000-000000000150'
  $$,
  $$ values (2::bigint, 1::bigint, 1::bigint) $$,
  'display-only source evolution preserves role and template authority continuity'
);

select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 3,
      pg_temp.coordination_prepared(
        (select addition_candidate from coordination_candidates), '9'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000175'
    )
  $$,
  $$ values ('changed'::text, 4::bigint, 5::bigint) $$,
  'a supplied permission addition is recorded as one coordinated change'
);
select results_eq(
  $$
    select revision, lifecycle, authority_continuity_revision,
      (select pg_catalog.count(*)
       from vortex_access.organization_role_permission_entries as permission
       where permission.organization_id = revision.organization_id
         and permission.role_id = revision.role_id
         and permission.role_revision = revision.revision),
      (select pg_catalog.count(*)
       from vortex_access.organization_role_permission_entries as permission
       where permission.organization_id = revision.organization_id
         and permission.role_id = revision.role_id
         and permission.role_revision = revision.revision
          and permission.permission_id in (
            '41000000-0000-4000-8000-000000000151',
            '41000000-0000-4000-8000-000000000152'
          ))
    from vortex_access.organization_role_revisions as revision
    where revision.organization_id = '21000000-0000-4000-8000-000000000150'
      and revision.role_id = '51000000-0000-4000-8000-000000000150'
      and revision.revision = 3
  $$,
  $$ values (3::bigint, 'acceptance_required'::text, 1::bigint, 1::bigint, 0::bigint) $$,
  'pending restored and new additions retain only the continuously accepted intersection'
);
select results_eq(
  $$
    select permission_id, state, continuity_revision,
      last_processed_registration_revision
    from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000150'
      and application_root_id = '31000000-0000-4000-8000-000000000150'
      and permission_id in (
        '41000000-0000-4000-8000-000000000151',
        '41000000-0000-4000-8000-000000000152'
      )
    order by permission_id
  $$,
  $$ values
    ('41000000-0000-4000-8000-000000000151'::uuid,
      'available'::text, 3::bigint, 4::bigint),
    ('41000000-0000-4000-8000-000000000152'::uuid,
      'available'::text, 1::bigint, 4::bigint)
  $$,
  'restored and genuinely new permissions have distinct continuity while review remains pending'
);

select * from vortex_access.coordinate_application_access_change(
  'update', 4,
  pg_temp.coordination_prepared(
    (select pending_removal_candidate from coordination_candidates), '5'
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-000000000182'
);
select results_eq(
  $$
    select role.live_revision, revision.lifecycle,
      revision.authority_continuity_revision,
      (select pg_catalog.count(*)
       from vortex_access.organization_role_permission_entries as permission
       where permission.organization_id = role.organization_id
         and permission.role_id = role.role_id
         and permission.role_revision = role.live_revision)
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = '21000000-0000-4000-8000-000000000150'
      and role.role_id = '51000000-0000-4000-8000-000000000150'
  $$,
  $$ values (3::bigint, 'acceptance_required'::text, 1::bigint, 1::bigint) $$,
  'removing every pending addition later does not silently return the role to active'
);

select * from vortex_access.coordinate_application_access_change(
  'withdraw', 5, null,
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-000000000156'
);
set constraints all immediate;
set constraints all deferred;
select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.application_role_template_continuities disable trigger application_role_template_continuities_protect_change';
      execute 'alter table vortex_access.application_role_template_continuities disable trigger application_role_template_continuities_evidence';
      update vortex_access.application_role_template_continuities
      set state = 'available'
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and application_root_id = '31000000-0000-4000-8000-000000000150';
      execute 'alter table vortex_access.application_role_template_continuities enable trigger application_role_template_continuities_protect_change';
      execute 'alter table vortex_access.application_role_template_continuities enable trigger application_role_template_continuities_evidence';
      perform * from vortex_access.coordinate_application_access_change(
        'reactivate', 6,
        pg_temp.coordination_prepared(
          (select pending_removal_candidate from coordination_candidates), '5'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000150',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000169'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'reactivation refuses a withdrawn state that falsely retains available template continuity'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '21000000-0000-4000-8000-000000000150'),
  7::bigint,
  'refused reactivation rolls back corruption and increments nothing'
);
select * from vortex_access.coordinate_application_access_change(
  'reactivate', 6,
  pg_temp.coordination_prepared(
    (select pending_removal_candidate from coordination_candidates), '5'
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-000000000157'
);
set constraints all immediate;
set constraints all deferred;
select results_eq(
  $$
    select revision, lifecycle, authority_continuity_revision,
      (select pg_catalog.count(*) from vortex_access.organization_role_permission_entries p
       where p.organization_id = r.organization_id and p.role_id = r.role_id
         and p.role_revision = r.revision)::bigint
    from vortex_access.organization_role_revisions r
    where organization_id = '21000000-0000-4000-8000-000000000150'
      and role_id = '51000000-0000-4000-8000-000000000150'
      and revision = 5
  $$,
  $$ values (5::bigint, 'acceptance_required'::text, 2::bigint, 0::bigint) $$,
  'withdrawal removes live entries and reactivation requires acceptance in a new authority period'
);
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'withdraw', 4, null,
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000158'
    )
  $$,
  '40001'::char(5), null,
  'a stale withdrawal repeat is refused rather than treated as a receipt replay'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '21000000-0000-4000-8000-000000000150'),
  8::bigint,
  'register, reduction, display, pending addition/removal, withdrawal and reactivation increment Access once each'
);

alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '21000000-0000-4000-8000-000000000150';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;
select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 7,
      pg_temp.coordination_prepared(
        (select pending_removal_candidate from coordination_candidates), '5'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-00000000018c'
    )
  $$,
  $$ values ('unchanged'::text, 7::bigint, 9007199254740991::bigint) $$,
  'a complete exact update is unchanged at the maximum Access version'
);
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'withdraw', 7, null,
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-00000000018d'
    )
  $$,
  '22003'::char(5), null,
  'withdrawal reports Access-version exhaustion without making a change'
);
alter table vortex_access.organization_access_versions
  disable trigger organization_access_versions_protect_update;
update vortex_access.organization_access_versions
set current_version = 8
where organization_id = '21000000-0000-4000-8000-000000000150';
alter table vortex_access.organization_access_versions
  enable trigger organization_access_versions_protect_update;

select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.organization_access_versions disable trigger organization_access_versions_protect_update';
      update vortex_access.organization_access_versions
      set current_version = 9007199254740991
      where organization_id = '21000000-0000-4000-8000-000000000150';
      execute 'alter table vortex_access.organization_access_versions enable trigger organization_access_versions_protect_update';
      perform * from vortex_access.coordinate_application_access_change(
        'update', 7,
        pg_temp.coordination_prepared(
          (select meaning_b_candidate from coordination_candidates), '1'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000150',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000176'
      );
    end
    $body$
  $test$,
  '22003'::char(5), null,
  'Access-version exhaustion rolls back the complete coordinated update'
);
select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.permission_continuities disable trigger permission_continuities_protect_change';
      execute 'alter table vortex_access.permission_continuities disable trigger permission_continuities_evidence';
      update vortex_access.permission_continuities
      set continuity_revision = 9007199254740991
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and application_root_id = '31000000-0000-4000-8000-000000000150'
        and permission_id = '41000000-0000-4000-8000-000000000150';
      execute 'alter table vortex_access.permission_continuities enable trigger permission_continuities_evidence';
      execute 'alter table vortex_access.permission_continuities enable trigger permission_continuities_protect_change';
      perform * from vortex_access.coordinate_application_access_change(
        'update', 7,
        pg_temp.coordination_prepared(
          (select meaning_b_candidate from coordination_candidates), '1'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000150',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000177'
      );
    end
    $body$
  $test$,
  '22003'::char(5), null,
  'permission-continuity exhaustion rolls back registration, Access and role changes'
);
select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.application_role_template_continuities disable trigger application_role_template_continuities_protect_change';
      execute 'alter table vortex_access.application_role_template_continuities disable trigger application_role_template_continuities_evidence';
      update vortex_access.application_role_template_continuities
      set continuity_revision = 9007199254740991
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and application_root_id = '31000000-0000-4000-8000-000000000150'
        and source_role_id = '52000000-0000-4000-8000-000000000150';
      execute 'alter table vortex_access.application_role_template_continuities enable trigger application_role_template_continuities_evidence';
      execute 'alter table vortex_access.application_role_template_continuities enable trigger application_role_template_continuities_protect_change';
      perform * from vortex_access.coordinate_application_access_change(
        'withdraw', 7, null,
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000150',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-00000000017f'
      );
    end
    $body$
  $test$,
  '22003'::char(5), null,
  'template-continuity exhaustion rolls back withdrawal, permission and Access changes'
);
select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.organization_role_revisions disable trigger organization_role_revisions_evidence';
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, application_root_id,
        lifecycle, privilege_classification, assignment_policy,
        policy_continuity_revision, authority_continuity_revision,
        activation_policy_id, activation_policy_revision,
        activation_policy_fingerprint, role_key, label, description,
        source_definition_key, source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        changed_by, changed_at, change_correlation_id
      )
      select organization_id, role_id, 6, role_kind, application_root_id,
        'unavailable', privilege_classification, assignment_policy,
        policy_continuity_revision, 9007199254740991,
        activation_policy_id, activation_policy_revision,
        activation_policy_fingerprint, role_key, label, description,
        source_definition_key, source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        changed_by, pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000180'
      from vortex_access.organization_role_revisions
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and role_id = '51000000-0000-4000-8000-000000000150'
        and revision = 4;
      set constraints all immediate;
      set constraints all deferred;
      execute 'alter table vortex_access.organization_role_revisions enable trigger organization_role_revisions_evidence';
      execute 'alter table vortex_access.organization_roles disable trigger organization_roles_protect_change';
      update vortex_access.organization_roles
      set live_revision = 6
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and role_id = '51000000-0000-4000-8000-000000000150';
      set constraints vortex_access.organization_roles_current_revision_fk immediate;
      execute 'alter table vortex_access.organization_roles enable trigger organization_roles_protect_change';
      set constraints vortex_access.organization_roles_current_revision_fk deferred;
      perform * from vortex_access.coordinate_application_access_change(
        'update', 7,
        pg_temp.coordination_prepared(
          (select meaning_b_candidate from coordination_candidates), '1'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000150',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000181'
      );
    end
    $body$
  $test$,
  '22003'::char(5), null,
  'role-authority continuity exhaustion rolls back restoration and the complete update'
);
select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.organization_role_revisions disable trigger organization_role_revisions_evidence';
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, application_root_id,
        lifecycle, privilege_classification, assignment_policy,
        policy_continuity_revision, authority_continuity_revision,
        activation_policy_id, activation_policy_revision,
        activation_policy_fingerprint, role_key, label, description,
        source_definition_key, source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        changed_by, changed_at, change_correlation_id
      )
      select organization_id, role_id, 9007199254740991, role_kind,
        application_root_id, lifecycle, privilege_classification,
        assignment_policy, policy_continuity_revision,
        authority_continuity_revision, activation_policy_id,
        activation_policy_revision, activation_policy_fingerprint, role_key,
        label, description, source_definition_key, source_release_revision,
        source_release_version, source_validation_contract_version,
        source_content_fingerprint, source_resolution_fingerprint,
        source_template_fingerprint, source_catalogue_fingerprint,
        accepted_registration_revision, template_continuity_revision,
        accepted_grant_fingerprint, changed_by, pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000178'
      from vortex_access.organization_role_revisions
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and role_id = '51000000-0000-4000-8000-000000000150'
        and revision = 5;
      set constraints all immediate;
      set constraints all deferred;
      execute 'alter table vortex_access.organization_role_revisions enable trigger organization_role_revisions_evidence';
      execute 'alter table vortex_access.organization_roles disable trigger organization_roles_protect_change';
      update vortex_access.organization_roles
      set live_revision = 9007199254740991
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and role_id = '51000000-0000-4000-8000-000000000150';
      set constraints vortex_access.organization_roles_current_revision_fk immediate;
      execute 'alter table vortex_access.organization_roles enable trigger organization_roles_protect_change';
      set constraints vortex_access.organization_roles_current_revision_fk deferred;
      perform * from vortex_access.coordinate_application_access_change(
        'withdraw', 7, null,
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000150',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000179'
      );
    end
    $body$
  $test$,
  '22003'::char(5), null,
  'role-revision exhaustion rolls back withdrawal, continuity and Access changes'
);
select results_eq(
  $$
    select version.current_version, registration.revision,
      permission.continuity_revision, template.state,
      template.continuity_revision,
      template.last_processed_registration_revision,
      role.live_revision, live_revision.authority_continuity_revision,
      (select pg_catalog.count(*)
       from vortex_access.organization_role_revisions as revision
       where revision.organization_id = role.organization_id
         and revision.role_id = role.role_id
         and revision.revision = 9007199254740991)
    from vortex_access.organization_access_versions as version
    join vortex_access.permission_registrations as registration
      on registration.organization_id = version.organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = '31000000-0000-4000-8000-000000000150'
    join vortex_access.permission_continuities as permission
      on permission.organization_id = version.organization_id
      and permission.application_root_id = '31000000-0000-4000-8000-000000000150'
      and permission.permission_id = '41000000-0000-4000-8000-000000000150'
    join vortex_access.organization_roles as role
      on role.organization_id = version.organization_id
      and role.role_id = '51000000-0000-4000-8000-000000000150'
    join vortex_access.application_role_template_continuities as template
      on template.organization_id = version.organization_id
      and template.application_root_id = '31000000-0000-4000-8000-000000000150'
      and template.source_role_id = role.source_role_id
    join vortex_access.organization_role_revisions as live_revision
      on live_revision.organization_id = role.organization_id
      and live_revision.role_id = role.role_id
      and live_revision.revision = role.live_revision
    where version.organization_id = '21000000-0000-4000-8000-000000000150'
  $$,
  $$ values (8::bigint, 7::bigint, 3::bigint, 'available'::text,
      3::bigint, 7::bigint, 5::bigint, 2::bigint, 0::bigint) $$,
  'every exhaustion refusal leaves the complete pre-change state intact'
);

select * from vortex_access.coordinate_application_access_change(
  'update', 7,
  pg_temp.coordination_prepared(
    (select meaning_b_candidate from coordination_candidates), '1'
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-00000000017a'
);
select * from vortex_access.coordinate_application_access_change(
  'update', 8,
  pg_temp.coordination_prepared(
    (select meaning_a_return_candidate from coordination_candidates), '2'
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-00000000017b'
);
select results_eq(
  $$
    select continuity_revision, meaning_fingerprint,
      (select pg_catalog.count(*)
       from vortex_access.organization_role_permission_entries as permission
       where permission.organization_id = continuity.organization_id
         and permission.role_id = '51000000-0000-4000-8000-000000000150'
         and permission.continuity_revision = continuity.continuity_revision
         and permission.meaning_fingerprint = continuity.meaning_fingerprint)
    from vortex_access.permission_continuities as continuity
    where continuity.organization_id = '21000000-0000-4000-8000-000000000150'
      and continuity.application_root_id = '31000000-0000-4000-8000-000000000150'
      and continuity.permission_id = '41000000-0000-4000-8000-000000000150'
  $$,
  $$ values (5::bigint, 'sha256:' || pg_catalog.repeat('d', 64), 0::bigint) $$,
  'meaning A to B to A receives fresh continuity and cannot match old accepted authority'
);

select * from vortex_access.coordinate_application_access_change(
  'update', 9,
  pg_temp.coordination_prepared_template_matrix(
    (select template_add_candidate from coordination_candidates), '6', true, true
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-00000000017c'
);
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000154', 'application', 'records_observer',
  '31000000-0000-4000-8000-000000000150',
  '52000000-0000-4000-8000-000000000151', 1,
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp()
);
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
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000154', 1, 'application',
  '31000000-0000-4000-8000-000000000150', 'retired', 'standard', 'standing',
  1, 1, 'records_observer', 'Records observer',
  'A retired supplied role remains terminal.', 'example.coordination', 8, '7.0.0',
  '2.18.0', 'sha256:' || pg_catalog.repeat('d', 64),
  'sha256:' || pg_catalog.repeat('e', 64),
  'sha256:' || pg_catalog.repeat('4', 64),
  'sha256:' || pg_catalog.repeat('f', 64), 10, 1,
  'sha256:' || pg_catalog.repeat('4', 64),
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000184'
);
set constraints all immediate;
set constraints all deferred;
select * from vortex_access.coordinate_application_access_change(
  'update', 10,
  pg_temp.coordination_prepared_template_matrix(
    (select template_remove_candidate from coordination_candidates), '7', false, true
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-00000000017d'
);
select * from vortex_access.coordinate_application_access_change(
  'update', 11,
  pg_temp.coordination_prepared_template_matrix(
    (select template_readd_candidate from coordination_candidates), '8', true, true
  ),
  '21000000-0000-4000-8000-000000000150',
  '31000000-0000-4000-8000-000000000150',
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-00000000017e'
);
select results_eq(
  $$
    select role.live_revision, revision.lifecycle,
      revision.authority_continuity_revision,
      template.state, template.continuity_revision,
      (select pg_catalog.count(*)
       from vortex_access.organization_role_permission_entries as permission
       where permission.organization_id = role.organization_id
         and permission.role_id = role.role_id
         and permission.role_revision = role.live_revision)
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.application_role_template_continuities as template
      on template.organization_id = role.organization_id
      and template.application_root_id = role.application_root_id
      and template.source_role_id = role.source_role_id
    where role.organization_id = '21000000-0000-4000-8000-000000000150'
      and role.role_id = '51000000-0000-4000-8000-000000000150'
  $$,
  $$ values (7::bigint, 'acceptance_required'::text, 3::bigint,
      'available'::text, 5::bigint, 0::bigint) $$,
  'template removal and readdition cannot reactivate the old supplied role authority'
);
select results_eq(
  $$
    select role.role_id, role.live_revision, revision.lifecycle,
      (select pg_catalog.count(*)
       from vortex_access.organization_role_revisions as history
       where history.organization_id = role.organization_id
         and history.role_id = role.role_id)
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = '21000000-0000-4000-8000-000000000150'
      and role.role_id in (
        '51000000-0000-4000-8000-000000000153',
        '51000000-0000-4000-8000-000000000154'
      )
    order by role.role_id
  $$,
  $$ values
    ('51000000-0000-4000-8000-000000000153'::uuid,
      1::bigint, 'active'::text, 1::bigint),
    ('51000000-0000-4000-8000-000000000154'::uuid,
      1::bigint, 'retired'::text, 1::bigint)
  $$,
  'application coordination preserves target custom roles and retired supplied roles'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '21000000-0000-4000-8000-000000000150'),
  13::bigint,
  'meaning and template transitions each increment Access exactly once'
);

select * from vortex_access.apply_application_permission_registration_v1_internal(
  'register', null,
  (select initial_candidate from legacy_coordination_candidates),
  '91000000-0000-4000-8000-000000000150',
  '71000000-0000-4000-8000-000000000161'
);
select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.permission_continuities (
        organization_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id, state,
        continuity_revision, meaning_fingerprint,
        last_processed_registration_revision, changed_at
      )
      select organization_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id, 'available',
        1, meaning_fingerprint, 1, pg_catalog.statement_timestamp()
      from vortex_access.permission_catalogue_entries
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and registration_owner_id = '31000000-0000-4000-8000-000000000151'
        and registration_revision = 1
        and permission_id = '41000000-0000-4000-8000-000000000150';
      perform * from vortex_access.coordinate_application_access_change(
        'update', 1,
        pg_temp.coordination_prepared(
          (select initial_candidate from legacy_coordination_candidates), 'e'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000151',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000185'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'first observation refuses a partial permission-only continuity baseline'
);
select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
        organization_id, role_id, role_kind, role_key, live_revision,
        created_by, created_at
      ) values (
        '21000000-0000-4000-8000-000000000150',
        '51000000-0000-4000-8000-000000000155', 'custom',
        'untracked_custom_reader', 1,
        '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp()
      );
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        application_root_id, owner_kind, owner_id, permission_id,
        registration_kind, registration_owner_id,
        accepted_registration_revision, catalogue_fingerprint,
        continuity_revision, meaning_fingerprint
      )
      select entry.organization_id,
        '51000000-0000-4000-8000-000000000155'::uuid, 1, 1, 'custom',
        entry.application_root_id, entry.owner_kind, entry.owner_id,
        entry.permission_id, entry.registration_kind, entry.registration_owner_id,
        entry.registration_revision, registration.permission_catalogue_fingerprint,
        1, entry.meaning_fingerprint
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registration_revisions as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
      where entry.organization_id = '21000000-0000-4000-8000-000000000150'
        and entry.registration_owner_id = '31000000-0000-4000-8000-000000000151'
        and entry.registration_revision = 1
        and entry.permission_id = '41000000-0000-4000-8000-000000000150';
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, lifecycle,
        privilege_classification, assignment_policy, policy_continuity_revision,
        authority_continuity_revision, role_key, label, description,
        changed_by, changed_at, change_correlation_id
      ) values (
        '21000000-0000-4000-8000-000000000150',
        '51000000-0000-4000-8000-000000000155', 1, 'custom', 'active',
        'standard', 'standing', 1, 1, 'untracked_custom_reader',
        'Untracked custom reader', 'Historical accepted authority blocks adoption.',
        '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000186'
      );
      perform * from vortex_access.coordinate_application_access_change(
        'update', 1,
        pg_temp.coordination_prepared(
          (select initial_candidate from legacy_coordination_candidates), 'e'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000151',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000187'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'first observation refuses historical custom-role accepted authority'
);
select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
        organization_id, role_id, role_kind, role_key, application_root_id,
        source_role_id, live_revision, created_by, created_at
      ) values (
        '21000000-0000-4000-8000-000000000150',
        '51000000-0000-4000-8000-000000000156', 'application',
        'untracked_supplied_reader',
        '31000000-0000-4000-8000-000000000151',
        '52000000-0000-4000-8000-000000000156', 2,
        '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp()
      );
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        role_application_root_id, application_root_id, owner_kind, owner_id,
        permission_id, registration_kind, registration_owner_id,
        accepted_registration_revision, catalogue_fingerprint,
        continuity_revision, meaning_fingerprint
      )
      select entry.organization_id,
        '51000000-0000-4000-8000-000000000156'::uuid, 1, 1, 'application',
        entry.application_root_id, entry.application_root_id, entry.owner_kind,
        entry.owner_id, entry.permission_id, entry.registration_kind,
        entry.registration_owner_id, entry.registration_revision,
        registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registration_revisions as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
      where entry.organization_id = '21000000-0000-4000-8000-000000000150'
        and entry.registration_owner_id = '31000000-0000-4000-8000-000000000151'
        and entry.registration_revision = 1
        and entry.permission_id = '41000000-0000-4000-8000-000000000150';
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, application_root_id,
        lifecycle, privilege_classification, assignment_policy,
        policy_continuity_revision, authority_continuity_revision,
        role_key, label, description, source_definition_key,
        source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        changed_by, changed_at, change_correlation_id
      ) values
        (
          '21000000-0000-4000-8000-000000000150',
          '51000000-0000-4000-8000-000000000156', 1, 'application',
          '31000000-0000-4000-8000-000000000151', 'active',
          'standard', 'standing', 1, 1, 'untracked_supplied_reader',
          'Untracked supplied reader', 'Historical accepted supplied authority.',
          'example.legacy_coordination', 1, '1.0.0', '2.18.0',
          'sha256:' || pg_catalog.repeat('a', 64),
          'sha256:' || pg_catalog.repeat('b', 64),
          'sha256:' || pg_catalog.repeat('e', 64),
          'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
          'sha256:' || pg_catalog.repeat('e', 64),
          '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
          '71000000-0000-4000-8000-000000000188'
        ),
        (
          '21000000-0000-4000-8000-000000000150',
          '51000000-0000-4000-8000-000000000156', 2, 'application',
          '31000000-0000-4000-8000-000000000151', 'retired',
          'standard', 'standing', 1, 1, 'untracked_supplied_reader',
          'Untracked supplied reader', 'Retired current state preserves history.',
          'example.legacy_coordination', 1, '1.0.0', '2.18.0',
          'sha256:' || pg_catalog.repeat('a', 64),
          'sha256:' || pg_catalog.repeat('b', 64),
          'sha256:' || pg_catalog.repeat('e', 64),
          'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
          'sha256:' || pg_catalog.repeat('e', 64),
          '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
          '71000000-0000-4000-8000-000000000189'
        );
      perform * from vortex_access.coordinate_application_access_change(
        'update', 1,
        pg_temp.coordination_prepared(
          (select initial_candidate from legacy_coordination_candidates), 'e'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000151',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-00000000018a'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'first observation refuses current and historical supplied-role authority'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '21000000-0000-4000-8000-000000000150'),
  14::bigint,
  'refused first-observation attempts leave Access unchanged'
);
select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.coordination_prepared(
        (select initial_candidate from legacy_coordination_candidates), 'e'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000162'
    )
  $$,
  $$ values ('changed'::text, 2::bigint, 15::bigint) $$,
  'safe first observation adopts an exact raw current candidate as a real tracked revision'
);
select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 2,
      pg_temp.coordination_prepared(
        (select initial_candidate from legacy_coordination_candidates), 'e'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000173'
    )
  $$,
  $$ values ('unchanged'::text, 2::bigint, 15::bigint) $$,
  'the next exact fully coordinated observation is unchanged'
);
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.coordination_prepared(
        (select initial_candidate from legacy_coordination_candidates), 'e'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000174'
    )
  $$,
  '40001'::char(5), null,
  'the old raw revision cannot replay after first-observation adoption'
);
select results_eq(
  $$
    select outcome, registration_revision
    from vortex_access.coordinate_application_access_change(
      'update', 2,
      pg_temp.coordination_prepared(
        (select narrow_candidate from legacy_coordination_candidates), 'f'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000163'
    )
  $$,
  $$ values ('changed'::text, 3::bigint) $$,
  'a later narrow legacy transition remains a normal coordinated change'
);
select results_eq(
  $$
    select continuity_revision, last_processed_registration_revision
    from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000150'
      and application_root_id = '31000000-0000-4000-8000-000000000151'
      and permission_id = '41000000-0000-4000-8000-000000000150'
  $$,
  $$ values (1::bigint, 3::bigint) $$,
  'first observation separates initial continuity one from the observed current registration revision'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000151', 'custom',
  'legacy_custom_reader', 1,
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select entry.organization_id,
  '51000000-0000-4000-8000-000000000151'::uuid, 1, 1, 'custom',
  entry.application_root_id, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  entry.registration_revision, registration.permission_catalogue_fingerprint,
  1, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '21000000-0000-4000-8000-000000000150'
  and entry.registration_owner_id = '31000000-0000-4000-8000-000000000151'
  and entry.registration_revision = 3;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000150',
  '51000000-0000-4000-8000-000000000151', 1, 'custom', 'active',
  'standard', 'standing', 1, 1, 'legacy_custom_reader',
  'Legacy custom reader', 'Retains accepted legacy application authority.',
  '91000000-0000-4000-8000-000000000150', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000170'
);
set constraints all immediate;
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.permission_continuities disable trigger permission_continuities_protect_change';
      delete from vortex_access.permission_continuities
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and application_root_id = '31000000-0000-4000-8000-000000000151';
      execute 'alter table vortex_access.permission_continuities enable trigger permission_continuities_protect_change';
      perform * from vortex_access.coordinate_application_access_change(
        'update', 3,
        pg_temp.coordination_prepared(
          (select narrow_candidate from legacy_coordination_candidates), 'f'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000151',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000171'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'exact no-op refuses historical custom authority lacking its continuity tombstone'
);
select throws_ok(
  $test$
    do $body$
    begin
      execute 'alter table vortex_access.permission_continuities disable trigger permission_continuities_protect_change';
      delete from vortex_access.permission_continuities
      where organization_id = '21000000-0000-4000-8000-000000000150'
        and application_root_id = '31000000-0000-4000-8000-000000000151';
      execute 'alter table vortex_access.permission_continuities enable trigger permission_continuities_protect_change';
      perform * from vortex_access.coordinate_application_access_change(
        'update', 3,
        pg_temp.coordination_prepared(
          (select initial_candidate from legacy_coordination_candidates), 'e'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000151',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-00000000018b'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'a changed candidate also refuses historical custom authority lacking its tombstone'
);
select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
        organization_id, role_id, role_kind, role_key, application_root_id,
        source_role_id, live_revision, created_by, created_at
      ) values (
        '21000000-0000-4000-8000-000000000150',
        '51000000-0000-4000-8000-000000000152', 'application',
        'legacy_missing_template',
        '31000000-0000-4000-8000-000000000151',
        '52000000-0000-4000-8000-000000000152', 1,
        '91000000-0000-4000-8000-000000000150',
        pg_catalog.statement_timestamp()
      );
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, application_root_id,
        lifecycle, privilege_classification, assignment_policy,
        policy_continuity_revision, authority_continuity_revision,
        role_key, label, description, source_definition_key,
        source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        changed_by, changed_at, change_correlation_id
      ) values (
        '21000000-0000-4000-8000-000000000150',
        '51000000-0000-4000-8000-000000000152', 1, 'application',
        '31000000-0000-4000-8000-000000000151', 'unavailable',
        'standard', 'standing', 1, 1, 'legacy_missing_template',
        'Legacy missing template', 'Historical source requires a tombstone.',
        'example.legacy_coordination', 2, '2.0.0', '2.18.0',
        'sha256:' || pg_catalog.repeat('c', 64),
        'sha256:' || pg_catalog.repeat('4', 64),
        'sha256:' || pg_catalog.repeat('a', 64),
        'sha256:' || pg_catalog.repeat('5', 64), 3, 1,
        'sha256:' || pg_catalog.repeat('b', 64),
        '91000000-0000-4000-8000-000000000150',
        pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000172'
      );
      perform * from vortex_access.coordinate_application_access_change(
        'update', 3,
        pg_temp.coordination_prepared(
          (select narrow_candidate from legacy_coordination_candidates), 'f'
        ),
        '21000000-0000-4000-8000-000000000150',
        '31000000-0000-4000-8000-000000000151',
        '91000000-0000-4000-8000-000000000150',
        '71000000-0000-4000-8000-000000000172'
      );
    end
    $body$
  $test$,
  '55000'::char(5), null,
  'exact no-op refuses an existing supplied-template source without continuity evidence'
);
select is(
  (select current_version from vortex_access.organization_access_versions
   where organization_id = '21000000-0000-4000-8000-000000000150'),
  16::bigint,
  'partial-state refusals roll back and increment nothing'
);

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision, state,
  operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
)
select organization_id, registration_kind, registration_owner_id,
  9007199254740991, state, 'update', source_definition_key, source_version,
  source_revision, validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, pg_catalog.statement_timestamp(), changed_by,
  '71000000-0000-4000-8000-000000000164'::uuid
from vortex_access.permission_registration_revisions
where organization_id = '21000000-0000-4000-8000-000000000150'
  and registration_owner_id = '31000000-0000-4000-8000-000000000151'
  and revision = 3;
insert into vortex_access.permission_catalogue_entries (
  organization_id, registration_kind, registration_owner_id,
  registration_revision, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_revision, source_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, meaning_fingerprint
)
select organization_id, registration_kind, registration_owner_id,
  9007199254740991, application_root_id, owner_kind, owner_id,
  permission_id, permission_key, label, description, record_type_id,
  action_kind, named_action, administrative, source_kind,
  source_definition_key, source_root_id, source_revision, source_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, meaning_fingerprint
from vortex_access.permission_catalogue_entries
where organization_id = '21000000-0000-4000-8000-000000000150'
  and registration_owner_id = '31000000-0000-4000-8000-000000000151'
  and registration_revision = 3;
alter table vortex_access.permission_registrations
  disable trigger permission_registrations_protect_change;
update vortex_access.permission_registrations
set revision = 9007199254740991,
  changed_at = (
    select changed_at from vortex_access.permission_registration_revisions
    where organization_id = '21000000-0000-4000-8000-000000000150'
      and registration_kind = 'application'
      and registration_owner_id = '31000000-0000-4000-8000-000000000151'
      and revision = 9007199254740991
  ),
  change_correlation_id = '71000000-0000-4000-8000-000000000164'
where organization_id = '21000000-0000-4000-8000-000000000150'
  and registration_owner_id = '31000000-0000-4000-8000-000000000151';
set constraints all immediate;
alter table vortex_access.permission_registrations
  enable trigger permission_registrations_protect_change;
set constraints all deferred;
update vortex_access.permission_continuities
set last_processed_registration_revision = 9007199254740991,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000150'
  and application_root_id = '31000000-0000-4000-8000-000000000151';
update vortex_access.application_role_template_continuities
set last_processed_registration_revision = 9007199254740991,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000150'
  and application_root_id = '31000000-0000-4000-8000-000000000151';
set constraints all immediate;
set constraints all deferred;
select results_eq(
  $$
    select outcome, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 9007199254740991,
      pg_temp.coordination_prepared(
        (select narrow_candidate from legacy_coordination_candidates), 'f'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000165'
    )
  $$,
  $$ values ('unchanged'::text, 9007199254740991::bigint, 16::bigint) $$,
  'a complete exact update remains an honest no-op at the maximum registration revision'
);
select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'update', 9007199254740991,
      pg_temp.coordination_prepared(
        (select initial_candidate from legacy_coordination_candidates), 'e'
      ),
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000151',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000166'
    )
  $$,
  '22003'::char(5), null,
  'a genuinely changed update at the maximum registration revision reports exhaustion'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      null, null, null,
      '21000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150',
      '91000000-0000-4000-8000-000000000150',
      '71000000-0000-4000-8000-000000000159'
    )
  $$,
  '22023'::char(5), null,
  'a null operation discriminator is refused explicitly'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{templates,0,template,roleId}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-000000000160'
  ),
  '22023'::char(5), null,
  'a null source role identity is refused as malformed private input'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{candidateFingerprint}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-000000000167'
  ),
  '22023'::char(5), null,
  'a null prepared fingerprint is refused as malformed private input'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{templates,0,sourceTemplateFingerprint}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-000000000168'
  ),
  '22023'::char(5), null,
  'a null template fingerprint is refused as malformed private input'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{contractVersion}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-000000000169'
  ),
  '22023'::char(5), null,
  'a JSON-null prepared contract version is refused explicitly'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{permissionRegistration,contractVersion}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-00000000016c'
  ),
  '22023'::char(5), null,
  'a JSON-null nested registration contract version is refused explicitly'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{permissionRegistration,organizationId}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-00000000016a'
  ),
  '22023'::char(5), null,
  'a JSON-null nested organization identity is refused explicitly'
);
select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.coordinate_application_access_change(%L, %s, %L::jsonb, %L, %L, %L, %L)',
    'update', 5,
    pg_catalog.jsonb_set(
      pg_temp.coordination_prepared((select display_candidate from coordination_candidates), '7'),
      '{permissionRegistration,applicationRootId}', 'null'::jsonb
    ),
    '21000000-0000-4000-8000-000000000150',
    '31000000-0000-4000-8000-000000000150',
    '91000000-0000-4000-8000-000000000150',
    '71000000-0000-4000-8000-00000000016b'
  ),
  '22023'::char(5), null,
  'a JSON-null nested application identity is refused explicitly'
);

create function pg_temp.add_authority_epoch_role_revision(
  p_revision bigint,
  p_lifecycle text,
  p_authority_continuity_revision bigint,
  p_include_permission boolean
)
returns void
language plpgsql
set search_path = ''
as $function$
begin
  if p_include_permission then
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    )
    select entry.organization_id,
      '51000000-0000-4000-8000-000000000150'::uuid, p_revision, 1,
      'application', entry.application_root_id, entry.application_root_id,
      entry.owner_kind, entry.owner_id, entry.permission_id,
      entry.registration_kind, entry.registration_owner_id,
      entry.registration_revision, registration.permission_catalogue_fingerprint,
      5, entry.meaning_fingerprint
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    where entry.organization_id = '21000000-0000-4000-8000-000000000150'
      and entry.registration_owner_id = '31000000-0000-4000-8000-000000000150'
      and entry.registration_revision = 12
      and entry.permission_id = '41000000-0000-4000-8000-000000000150';
  end if;

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id,
    lifecycle, privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    role_key, label, description, source_definition_key,
    source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    changed_by, changed_at, change_correlation_id
  ) values (
    '21000000-0000-4000-8000-000000000150',
    '51000000-0000-4000-8000-000000000150', p_revision, 'application',
    '31000000-0000-4000-8000-000000000150', p_lifecycle,
    'standard', 'standing', 1, p_authority_continuity_revision,
    'records_reader', 'Records reader', 'Locally accepted reader.',
    'example.coordination', 10, '9.0.0', '2.18.0',
    'sha256:' || pg_catalog.repeat('5', 64),
    'sha256:' || pg_catalog.repeat('7', 64),
    'sha256:' || pg_catalog.repeat('8', 64),
    'sha256:' || pg_catalog.repeat('9', 64), 12, 5,
    'sha256:' || pg_catalog.repeat('a', 64),
    '91000000-0000-4000-8000-000000000150',
    pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000168'
  );
end
$function$;

select pg_temp.add_authority_epoch_role_revision(8, 'active', 4, true);
set constraints all immediate;
set constraints all deferred;
update vortex_access.organization_roles set live_revision = 8
where organization_id = '21000000-0000-4000-8000-000000000150'
  and role_id = '51000000-0000-4000-8000-000000000150';
select pg_temp.add_authority_epoch_role_revision(
  9, 'acceptance_required', 4, true
);
set constraints all immediate;
set constraints all deferred;
update vortex_access.organization_roles set live_revision = 9
where organization_id = '21000000-0000-4000-8000-000000000150'
  and role_id = '51000000-0000-4000-8000-000000000150';
select pg_temp.add_authority_epoch_role_revision(
  10, 'acceptance_required', 4, false
);
set constraints all immediate;
set constraints all deferred;
update vortex_access.organization_roles set live_revision = 10
where organization_id = '21000000-0000-4000-8000-000000000150'
  and role_id = '51000000-0000-4000-8000-000000000150';
select pg_temp.add_authority_epoch_role_revision(
  11, 'acceptance_required', 5, true
);
set constraints all immediate;
set constraints all deferred;
update vortex_access.organization_roles set live_revision = 11
where organization_id = '21000000-0000-4000-8000-000000000150'
  and role_id = '51000000-0000-4000-8000-000000000150';

select results_eq(
  $$
    select revision, lifecycle, authority_continuity_revision
    from vortex_access.organization_role_revisions
    where organization_id = '21000000-0000-4000-8000-000000000150'
      and role_id = '51000000-0000-4000-8000-000000000150'
      and revision between 7 and 11
    order by revision
  $$,
  $$ values
    (7::bigint, 'acceptance_required'::text, 3::bigint),
    (8::bigint, 'active'::text, 4::bigint),
    (9::bigint, 'acceptance_required'::text, 4::bigint),
    (10::bigint, 'acceptance_required'::text, 4::bigint),
    (11::bigint, 'acceptance_required'::text, 5::bigint)
  $$,
  'authority epochs distinguish restoration, accepted addition, retained pending authority, narrowing and ABA re-addition'
);
select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_authority_epoch_role_revision(
        12, 'acceptance_required', 6, false
      );
      set constraints all immediate;
    end
    $body$
  $test$,
  '23514'::char(5), null,
  'an authority subset cannot invent a new epoch'
);
set constraints all deferred;
select throws_ok(
  $$
    insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    ) values (
      '21000000-0000-4000-8000-000000000150',
      '51000000-0000-4000-8000-000000000150', 4, 1, 'application',
      '31000000-0000-4000-8000-000000000150',
      '31000000-0000-4000-8000-000000000150', 'application',
      '31000000-0000-4000-8000-000000000150',
      '41000000-0000-4000-8000-000000000150', 'application',
      '31000000-0000-4000-8000-000000000150', 1,
      'sha256:' || pg_catalog.repeat('c', 64), 1,
      'sha256:' || pg_catalog.repeat('d', 64)
    )
  $$,
  '23514'::char(5), null,
  'no owner can append authority after the final role revision seals its entry set'
);

select * from finish();
rollback;
