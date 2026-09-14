\ir helpers/definition-release-writer.psql

begin;
select plan(19);

set local search_path = pg_catalog, extensions, public;

-- #396: newly published permission field policies are checked by the database
-- at append_release. Module policies own their local record-type fields;
-- Application policies resolve only the exact Module revisions they pin.

create function pg_temp.policy_field(p_field_id uuid, p_sensitive boolean default false)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fieldId', p_field_id,
    'type', 'text',
    'required', false,
    'unique', false,
    'filterable', true,
    'sortable', true,
    'settings', '{}'::jsonb,
    'personalData', case when p_sensitive then 'sensitive' else null end
  ))
$function$;

create function pg_temp.policy_record(p_record_type_id uuid, p_fields jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id,
    'storageContractId', p_record_type_id,
    'storageScope', 'organization_shared',
    'ownershipMode', 'organization_account',
    'fields', p_fields,
    'relationships', '[]'::jsonb
  )
$function$;

create function pg_temp.policy_permission(
  p_permission_id uuid,
  p_key text,
  p_record_type_id uuid,
  p_readable jsonb,
  p_changeable jsonb default '[]'::jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', p_permission_id,
    'key', p_key,
    'label', 'Use selected fields',
    'description', 'Use only fields explicitly named by this permission.',
    'recordTypeId', p_record_type_id,
    'recordScope', pg_catalog.jsonb_build_object(
      'routes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind', 'all_records'))
    ),
    'fieldPolicy', pg_catalog.jsonb_build_object(
      'readableFieldIds', p_readable,
      'changeableFieldIds', p_changeable
    ),
    'actionKind', 'read',
    'administrative', false
  )
$function$;

create function pg_temp.policy_content(
  p_record_types jsonb,
  p_permissions jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypes', p_record_types,
    'permissions', p_permissions
  )
$function$;

create function pg_temp.policy_release_evidence(p_root_id uuid, p_revision bigint)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', root.kind,
    'definitionKey', root.key,
    'rootId', root.root_id,
    'releaseRevision', release.release_revision,
    'releaseVersion', release.release_version,
    'validationContractVersion', release.validation_contract_version,
    'contentFingerprint', release.content_fingerprint,
    'resolutionFingerprint', release.resolution_fingerprint
  )
  from vortex_definition.roots as root
  join vortex_definition.releases as release on release.root_id = root.root_id
  where root.root_id = p_root_id
    and release.release_revision = p_revision
$function$;

create function pg_temp.policy_registration_candidate()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with owners as (
    select 'application'::text as owner_kind,
      '33960000-0000-4000-8000-000000000010'::uuid as owner_id,
      1::bigint as release_revision
    union all
    select 'module', '33960000-0000-4000-8000-000000000001', 1
  ), declared as (
    select owner.owner_kind, owner.owner_id, permission.value,
      pg_temp.policy_release_evidence(owner.owner_id, owner.release_revision) as source_release
    from owners as owner
    join vortex_definition.releases as release
      on release.root_id = owner.owner_id
      and release.release_revision = owner.release_revision
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,permissions}'
    ) as permission(value)
  ), entries as (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', '33960000-0000-4000-8000-000000000010'::uuid,
        'ownerKind', declared.owner_kind,
        'ownerId', declared.owner_id,
        'permission', declared.value,
        'sourceRelease', declared.source_release,
        'meaningFingerprint', pg_temp.writer_fixture_fingerprint(
          declared.owner_id::text || ':' || (declared.value ->> 'permissionId')
        )
      ) order by declared.owner_kind collate "C", declared.owner_id::text collate "C",
        (declared.value ->> 'key') collate "C",
        (declared.value ->> 'permissionId') collate "C"
    ) as value
    from declared
  )
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '23960000-0000-4000-8000-000000000001'::uuid,
    'applicationRootId', '33960000-0000-4000-8000-000000000010'::uuid,
    'applicationRelease', pg_temp.policy_release_evidence(
      '33960000-0000-4000-8000-000000000010', 1
    ),
    'applicationCatalogueFingerprint', pg_temp.writer_fixture_fingerprint('policy:catalogue'),
    'applicationPermissionIds', pg_catalog.jsonb_build_array(
      '43960000-0000-4000-8000-000000000010'::uuid
    ),
    'entries', entries.value,
    'candidateFingerprint', pg_temp.writer_fixture_fingerprint('policy:candidate')
  )
  from entries
$function$;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13960000-0000-4000-8000-000000000001', 'policy_tenant',
  'Policy tenant', 'active', pg_catalog.statement_timestamp(),
  '93960000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '23960000-0000-4000-8000-000000000001',
  '13960000-0000-4000-8000-000000000001', null, 'policy_org',
  'Policy organisation', 'active', pg_catalog.statement_timestamp(),
  '93960000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '23960000-0000-4000-8000-000000000001',
  '93960000-0000-4000-8000-000000000001',
  '73960000-0000-4000-8000-000000000001'
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
)
select fixture.root_id, '23960000-0000-4000-8000-000000000001', fixture.kind,
  fixture.key, pg_catalog.statement_timestamp(),
  '93960000-0000-4000-8000-000000000001'
from (values
  ('33960000-0000-4000-8000-000000000001'::uuid, 'module', 'sample.policy.module_a'),
  ('33960000-0000-4000-8000-000000000002'::uuid, 'module', 'sample.policy.module_b'),
  ('33960000-0000-4000-8000-000000000003'::uuid, 'module', 'sample.policy.empty'),
  ('33960000-0000-4000-8000-000000000004'::uuid, 'module', 'sample.policy.foreign'),
  ('33960000-0000-4000-8000-000000000005'::uuid, 'module', 'sample.policy.missing'),
  ('33960000-0000-4000-8000-000000000006'::uuid, 'module', 'sample.policy.wrong_type'),
  ('33960000-0000-4000-8000-000000000007'::uuid, 'module', 'sample.policy.malformed'),
  ('33960000-0000-4000-8000-000000000008'::uuid, 'module', 'sample.policy.nonrecord'),
  ('33960000-0000-4000-8000-000000000009'::uuid, 'module', 'sample.policy.historical'),
  ('33960000-0000-4000-8000-000000000010'::uuid, 'application', 'sample.policy.application'),
  ('33960000-0000-4000-8000-000000000011'::uuid, 'application', 'sample.policy.unpinned'),
  ('33960000-0000-4000-8000-000000000012'::uuid, 'application', 'sample.policy.newer_revision')
) as fixture(root_id, kind, key);

-- Module A revision 1 owns two record types. Its first record has an ordinary
-- field and a sensitive field; the sensitive field is not implied by its flag.
select is(
  pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000001', '1.0.0', '[]',
    pg_temp.policy_content(
      pg_catalog.jsonb_build_array(
        pg_temp.policy_record(
          '53960000-0000-4000-8000-000000000001',
          pg_catalog.jsonb_build_array(
            pg_temp.policy_field('63960000-0000-4000-8000-000000000011'),
            pg_temp.policy_field('63960000-0000-4000-8000-000000000012', true)
          )
        ),
        pg_temp.policy_record(
          '53960000-0000-4000-8000-000000000002',
          pg_catalog.jsonb_build_array(
            pg_temp.policy_field('63960000-0000-4000-8000-000000000021')
          )
        )
      ),
      pg_catalog.jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000001', 'sample.policy.module_a.read',
        '53960000-0000-4000-8000-000000000001',
        '["63960000-0000-4000-8000-000000000011"]'
      ))
    ), '2.18.0'
  ),
  1::bigint,
  'a valid Module field policy appends through the supported writer'
);

select is(
  pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000002', '1.0.0', '[]',
    pg_temp.policy_content(
      pg_catalog.jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000003',
        pg_catalog.jsonb_build_array(
          pg_temp.policy_field('63960000-0000-4000-8000-000000000031')
        )
      )),
      pg_catalog.jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000002', 'sample.policy.module_b.read',
        '53960000-0000-4000-8000-000000000003',
        '["63960000-0000-4000-8000-000000000031"]'
      ))
    ), '2.18.0'
  ),
  1::bigint,
  'a second valid Module release provides an unpinned-field control'
);

-- Module A revision 2 adds one field. Applications pinned to revision 1 must
-- not see it merely because a newer immutable revision exists.
select is(
  pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000001', '1.1.0', '[]',
    pg_temp.policy_content(
      pg_catalog.jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000001',
        pg_catalog.jsonb_build_array(
          pg_temp.policy_field('63960000-0000-4000-8000-000000000011'),
          pg_temp.policy_field('63960000-0000-4000-8000-000000000012', true),
          pg_temp.policy_field('63960000-0000-4000-8000-000000000013')
        )
      )),
      pg_catalog.jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000001', 'sample.policy.module_a.read',
        '53960000-0000-4000-8000-000000000001',
        '["63960000-0000-4000-8000-000000000011"]'
      ))
    ), '2.18.0'
  ),
  2::bigint,
  'a later Module revision may add a field without changing revision 1'
);

select is(
  pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000010', '1.0.0',
    '[["33960000-0000-4000-8000-000000000001",1]]',
    pg_catalog.jsonb_build_object('permissions', pg_catalog.jsonb_build_array(
      pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000010', 'sample.policy.application.read_sensitive',
        '53960000-0000-4000-8000-000000000001',
        '["63960000-0000-4000-8000-000000000012"]'
      )
    )), '2.18.0'
  ),
  1::bigint,
  'an Application policy may explicitly name a sensitive field from its exact Module pin'
);

select results_eq(
  $$
    select operation, registration_state, registration_revision, access_version
    from vortex_access.apply_application_permission_registration_v1_internal(
      'register', null, pg_temp.policy_registration_candidate(),
      '93960000-0000-4000-8000-000000000001',
      '73960000-0000-4000-8000-000000000002'
    )
  $$,
  $$ values ('register'::text, 'active'::text, 1::bigint, 2::bigint) $$,
  'the valid Application and exact pinned Module policies register together'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id = '23960000-0000-4000-8000-000000000001'
      and application_root_id = '33960000-0000-4000-8000-000000000010'
      and field_policy is not null
  ),
  2,
  'registration retains both validated Definition-owned policies'
);

select is(
  pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000003', '1.0.0', '[]',
    pg_temp.policy_content(
      pg_catalog.jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000004',
        pg_catalog.jsonb_build_array(
          pg_temp.policy_field('63960000-0000-4000-8000-000000000041')
        )
      )),
      pg_catalog.jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000003', 'sample.policy.empty.read',
        '53960000-0000-4000-8000-000000000004', '[]'
      ))
    ), '2.18.0'
  ),
  1::bigint,
  'an explicit empty field policy remains valid'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000004', '1.0.0', '[]',
    pg_temp.policy_content(
      jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000005',
        jsonb_build_array(pg_temp.policy_field('63960000-0000-4000-8000-000000000051'))
      )),
      jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000004', 'sample.policy.foreign.read',
        '53960000-0000-4000-8000-000000000005',
        '["63960000-0000-4000-8000-000000000031"]'
      ))
    ), '2.18.0'
  )$$,
  '23514', 'Definition release field policy names a field outside its exact record type',
  'a Module policy refuses a field owned by another Module'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000005', '1.0.0', '[]',
    pg_temp.policy_content(
      jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000006',
        jsonb_build_array(pg_temp.policy_field('63960000-0000-4000-8000-000000000061'))
      )),
      jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000005', 'sample.policy.missing_field.read',
        '53960000-0000-4000-8000-000000000006',
        '["63960000-0000-4000-8000-000000000099"]'
      ))
    ), '2.18.0'
  )$$,
  '23514', 'Definition release field policy names a field outside its exact record type',
  'a Module policy refuses a nonexistent field'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000006', '1.0.0', '[]',
    pg_temp.policy_content(
      jsonb_build_array(
        pg_temp.policy_record(
          '53960000-0000-4000-8000-000000000007',
          jsonb_build_array(pg_temp.policy_field('63960000-0000-4000-8000-000000000071'))
        ),
        pg_temp.policy_record(
          '53960000-0000-4000-8000-000000000008',
          jsonb_build_array(pg_temp.policy_field('63960000-0000-4000-8000-000000000081'))
        )
      ),
      jsonb_build_array(pg_temp.policy_permission(
        '43960000-0000-4000-8000-000000000006', 'sample.policy.wrong_type.read',
        '53960000-0000-4000-8000-000000000007',
        '["63960000-0000-4000-8000-000000000081"]'
      ))
    ), '2.18.0'
  )$$,
  '23514', 'Definition release field policy names a field outside its exact record type',
  'a Module policy refuses a field of another record type in the same Module'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000011', '1.0.0',
    '[["33960000-0000-4000-8000-000000000001",1]]',
    jsonb_build_object('permissions', jsonb_build_array(pg_temp.policy_permission(
      '43960000-0000-4000-8000-000000000011', 'sample.policy.unpinned.read',
      '53960000-0000-4000-8000-000000000001',
      '["63960000-0000-4000-8000-000000000031"]'
    ))), '2.18.0'
  )$$,
  '23514', 'Definition release field policy names a field outside its exact record type',
  'an Application policy refuses a field from an unpinned Module'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000012', '1.0.0',
    '[["33960000-0000-4000-8000-000000000001",1]]',
    jsonb_build_object('permissions', jsonb_build_array(pg_temp.policy_permission(
      '43960000-0000-4000-8000-000000000012', 'sample.policy.newer_revision.read',
      '53960000-0000-4000-8000-000000000001',
      '["63960000-0000-4000-8000-000000000013"]'
    ))), '2.18.0'
  )$$,
  '23514', 'Definition release field policy names a field outside its exact record type',
  'an Application pinned to Module revision 1 cannot use a field added in revision 2'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000005', '1.0.0', '[]',
    pg_temp.policy_content(
      jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000006',
        jsonb_build_array(pg_temp.policy_field('63960000-0000-4000-8000-000000000061'))
      )),
      jsonb_build_array(jsonb_build_object(
        'permissionId', '43960000-0000-4000-8000-000000000005',
        'key', 'sample.policy.missing.read', 'label', 'Use selected fields',
        'description', 'Use only fields explicitly named by this permission.',
        'recordTypeId', '53960000-0000-4000-8000-000000000006',
        'recordScope', jsonb_build_object('routes', '[]'::jsonb),
        'actionKind', 'read', 'administrative', false
      ))
    ), '2.18.0'
  )$$,
  '23514', 'Definition release field policy has invalid record ownership or shape',
  'a new record permission cannot omit its field policy'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000007', '1.0.0', '[]',
    pg_temp.policy_content(
      jsonb_build_array(pg_temp.policy_record(
        '53960000-0000-4000-8000-000000000009',
        jsonb_build_array(pg_temp.policy_field('63960000-0000-4000-8000-000000000091'))
      )),
      jsonb_build_array(jsonb_set(
        pg_temp.policy_permission(
          '43960000-0000-4000-8000-000000000007', 'sample.policy.malformed.read',
          '53960000-0000-4000-8000-000000000009',
          '["63960000-0000-4000-8000-000000000091"]'
        ),
        '{fieldPolicy,changeableFieldIds}',
        '["63960000-0000-4000-8000-000000000092"]'
      ))
    ), '2.18.0'
  )$$,
  '23514', 'Definition release field policy has invalid record ownership or shape',
  'a malformed field policy is refused by the existing canonical validator'
);

select throws_ok(
  $$select pg_temp.append_writer_release(
    '33960000-0000-4000-8000-000000000008', '1.0.0', '[]',
    jsonb_build_object('permissions', jsonb_build_array(jsonb_build_object(
      'permissionId', '43960000-0000-4000-8000-000000000008',
      'key', 'sample.policy.nonrecord.read', 'label', 'Use an action',
      'description', 'Use one non-record action.',
      'fieldPolicy', jsonb_build_object('readableFieldIds', '[]'::jsonb,
        'changeableFieldIds', '[]'::jsonb),
      'actionKind', 'read', 'administrative', false
    ))), '2.18.0'
  )$$,
  '23514', 'Definition release field policy has invalid record ownership or shape',
  'a non-record permission cannot declare a field policy'
);

select ok(
  not exists (
    select 1 from vortex_definition.releases
    where root_id in (
      '33960000-0000-4000-8000-000000000004',
      '33960000-0000-4000-8000-000000000005',
      '33960000-0000-4000-8000-000000000006',
      '33960000-0000-4000-8000-000000000007',
      '33960000-0000-4000-8000-000000000008',
      '33960000-0000-4000-8000-000000000011',
      '33960000-0000-4000-8000-000000000012'
    )
  )
  and not exists (
    select 1 from vortex_definition.release_dependencies
    where root_id in (
      '33960000-0000-4000-8000-000000000004',
      '33960000-0000-4000-8000-000000000005',
      '33960000-0000-4000-8000-000000000006',
      '33960000-0000-4000-8000-000000000007',
      '33960000-0000-4000-8000-000000000008',
      '33960000-0000-4000-8000-000000000011',
      '33960000-0000-4000-8000-000000000012'
    )
  )
  and not exists (
    select 1 from vortex_definition.roots
    where root_id in (
      '33960000-0000-4000-8000-000000000004',
      '33960000-0000-4000-8000-000000000005',
      '33960000-0000-4000-8000-000000000006',
      '33960000-0000-4000-8000-000000000007',
      '33960000-0000-4000-8000-000000000008',
      '33960000-0000-4000-8000-000000000011',
      '33960000-0000-4000-8000-000000000012'
    ) and current_release_revision is not null
  ),
  'every refused append leaves release rows, dependency rows and current pointers unchanged'
);

-- Simulate an immutable release stored before this append boundary existed.
-- Direct owner insertion is not a supported publication path; it proves that
-- the additive migration neither rewrites nor retroactively rejects history.
insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values (
  '33960000-0000-4000-8000-000000000009', 1, '1.0.0',
  pg_catalog.jsonb_build_object(
    'source_contract_version', '1.0.0',
    'kind', 'module',
    'key', 'sample.policy.historical'
  ),
  'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
  pg_catalog.jsonb_build_object(
    'kind', 'module', 'canonical', pg_catalog.jsonb_build_object(
      'envelope', pg_catalog.jsonb_build_object(
        'kind', 'module', 'key', 'sample.policy.historical',
        'rootId', '33960000-0000-4000-8000-000000000009',
        'organizationId', '23960000-0000-4000-8000-000000000001'
      ),
      'content', pg_catalog.jsonb_build_object('permissions', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'permissionId', '43960000-0000-4000-8000-000000000009',
          'key', 'sample.policy.historical.read', 'label', 'Read historical record',
          'description', 'Read one historical permission declaration.',
          'recordTypeId', '53960000-0000-4000-8000-000000000009',
          'actionKind', 'read', 'administrative', false
        )
      ))
    )
  ),
  '{"definitions":[],"fingerprint":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}',
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('2', 64), '1.0.0',
  'sha256:' || pg_catalog.repeat('4', 64), '[]'::jsonb,
  'Historical release.', pg_catalog.statement_timestamp(),
  '93960000-0000-4000-8000-000000000001'
);
update vortex_definition.roots
set current_release_revision = 1
where root_id = '33960000-0000-4000-8000-000000000009';

select ok(
  (
    select not (
      release.compilation_output #> '{canonical,content,permissions,0}'
    ) ? 'fieldPolicy'
    from vortex_definition.releases as release
    where release.root_id = '33960000-0000-4000-8000-000000000009'
      and release.release_revision = 1
  ),
  'a historical permission with omitted policy remains readable without invented policy bytes'
);

select is(
  vortex_access.permission_field_policy_is_valid(null),
  false,
  'an omitted historical policy is not converted into field authority'
);

select is(
  (
    select release.compilation_output #>> '{canonical,content,permissions,0,key}'
    from vortex_definition.releases as release
    where release.root_id = '33960000-0000-4000-8000-000000000009'
      and release.release_revision = 1
  ),
  'sample.policy.historical.read',
  'historical release content remains unchanged and addressable'
);

set constraints all immediate;
select * from finish();
rollback;
