begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11210000-0000-4000-8000-000000000001', 'role_rejection_tenant',
  'Role rejection tenant', 'active', pg_catalog.statement_timestamp(),
  '91210000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values
  (
    '21210000-0000-4000-8000-000000000001',
    '11210000-0000-4000-8000-000000000001', 'role_rejection_one',
    'Role rejection organisation one', 'active', pg_catalog.statement_timestamp(),
    '91210000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '21210000-0000-4000-8000-000000000002',
    '11210000-0000-4000-8000-000000000001', 'role_rejection_two',
    'Role rejection organisation two', 'active', pg_catalog.statement_timestamp(),
    '91210000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '41210000-0000-4000-8000-000000000001', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000001', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '42210000-0000-4000-8000-000000000001',
    '21210000-0000-4000-8000-000000000001',
    '41210000-0000-4000-8000-000000000001', 'Role rejection account one',
    'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '91210000-0000-4000-8000-000000000001',
    '71210000-0000-4000-8000-000000000002', 1
  ),
  (
    '42210000-0000-4000-8000-000000000002',
    '21210000-0000-4000-8000-000000000002',
    '41210000-0000-4000-8000-000000000001', 'Role rejection account two',
    'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '91210000-0000-4000-8000-000000000001',
    '71210000-0000-4000-8000-000000000003', 1
  );

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values (
  '21210000-0000-4000-8000-000000000001',
  '32210000-0000-4000-8000-000000000001', 'review_group',
  'Review group', 'active', 1,
  '91210000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  '91210000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  '71210000-0000-4000-8000-000000000004'
);

select * from vortex_access.initialize_organization_access_version(
  '21210000-0000-4000-8000-000000000001',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000005'
);
select * from vortex_access.initialize_organization_access_version(
  '21210000-0000-4000-8000-000000000002',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21210000-0000-4000-8000-000000000001',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000007'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21210000-0000-4000-8000-000000000002',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000008'
);

-- C3b consumes B2 continuity evidence. Platform catalogue initialization is
-- deliberately separate, so the fixture establishes each fresh current set.
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
  'available', 1, entry.meaning_fingerprint, entry.registration_revision,
  pg_catalog.statement_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id in (
    '21210000-0000-4000-8000-000000000001',
    '21210000-0000-4000-8000-000000000002'
  )
  and entry.registration_kind = 'platform';

create function pg_temp.fixture_permissions(p_application_root_id uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case p_application_root_id
    when '31210000-0000-4000-8000-000000000001'::uuid then
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'permissionId', '41210000-0000-4000-8000-000000000101'::uuid,
          'key', 'example.records.read', 'label', 'View records',
          'description', 'View records in the rejection fixture.',
          'actionKind', 'read', 'administrative', false
        ),
        pg_catalog.jsonb_build_object(
          'permissionId', '41210000-0000-4000-8000-000000000102'::uuid,
          'key', 'example.records.update', 'label', 'Update records',
          'description', 'Update records in the rejection fixture.',
          'actionKind', 'update', 'administrative', false
        )
      )
    else pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'permissionId', '41210000-0000-4000-8000-000000000201'::uuid,
        'key', 'example.notes.read', 'label', 'View notes',
        'description', 'View notes in the foreign rejection fixture.',
        'actionKind', 'read', 'administrative', false
      )
    )
  end
$function$;

create function pg_temp.fixture_candidate(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  with fixture as (
    select
      case p_application_root_id
        when '31210000-0000-4000-8000-000000000001'::uuid
          then 'example.role_rejection_one'
        else 'example.role_rejection_two'
      end as definition_key,
      case p_application_root_id
        when '31210000-0000-4000-8000-000000000001'::uuid then 'a'
        else '6'
      end as content_character,
      case p_application_root_id
        when '31210000-0000-4000-8000-000000000001'::uuid then 'b'
        else '7'
      end as resolution_character,
      case p_application_root_id
        when '31210000-0000-4000-8000-000000000001'::uuid then 'c'
        else '8'
      end as catalogue_character,
      case p_application_root_id
        when '31210000-0000-4000-8000-000000000001'::uuid then 'd'
        else '9'
      end as candidate_character
  ), release_value as (
    select pg_catalog.jsonb_build_object(
      'kind', 'application', 'definitionKey', fixture.definition_key,
      'rootId', p_application_root_id, 'releaseRevision', 1,
      'releaseVersion', '1.0.0', 'validationContractVersion', '2.18.0',
      'contentFingerprint', 'sha256:' || pg_catalog.repeat(fixture.content_character, 64),
      'resolutionFingerprint',
        'sha256:' || pg_catalog.repeat(fixture.resolution_character, 64)
    ) as value
    from fixture
  ), entries as (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id,
      'ownerKind', 'application', 'ownerId', p_application_root_id,
      'permission', permission.value, 'sourceRelease', release_value.value,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat(
        case permission.ordinality when 1 then 'e' else 'f' end, 64
      )
    ) order by permission.value ->> 'key') as value
    from release_value,
      pg_catalog.jsonb_array_elements(pg_temp.fixture_permissions(p_application_root_id))
        with ordinality as permission(value, ordinality)
  )
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationRelease', release_value.value,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(fixture.catalogue_character, 64),
    'applicationPermissionIds', (
      select pg_catalog.jsonb_agg(
        permission.value -> 'permissionId'
        order by (permission.value ->> 'permissionId')::uuid
      )
      from pg_catalog.jsonb_array_elements(
        pg_temp.fixture_permissions(p_application_root_id)
      ) as permission(value)
    ),
    'entries', entries.value,
    'candidateFingerprint',
      'sha256:' || pg_catalog.repeat(fixture.candidate_character, 64)
  )
  from fixture, release_value, entries
$function$;

create function pg_temp.fixture_templates(
  p_candidate jsonb,
  p_source_role_id uuid,
  p_template_character text,
  p_basis_kind text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', case p_basis_kind
      when 'registration_candidate' then
        pg_catalog.jsonb_build_object('kind', 'registration_candidate')
      else pg_catalog.jsonb_build_object(
        'kind', 'current_active_registration', 'registrationRevision', 1
      )
    end,
    'permissionRegistration', p_candidate,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', p_source_role_id, 'key', 'fixture_reader',
        'name', 'Fixture reader',
        'homePageId', '61210000-0000-4000-8000-000000000001'::uuid,
        'permissionKeys', (
          select pg_catalog.jsonb_agg(
            entry.value #>> '{permission,key}' order by entry.value #>> '{permission,key}'
          )
          from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as entry(value)
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

create function pg_temp.registration_preparation(
  p_candidate jsonb,
  p_source_role_id uuid,
  p_template_character text
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_temp.fixture_templates(
    p_candidate, p_source_role_id, p_template_character, 'registration_candidate'
  )
$function$;

create function pg_temp.current_templates(
  p_candidate jsonb,
  p_source_role_id uuid,
  p_template_character text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_temp.fixture_templates(
    p_candidate, p_source_role_id, p_template_character, 'current_active_registration'
  )
$function$;

create function pg_temp.role_permissions(
  p_candidate jsonb,
  p_permission_id uuid default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'kind', 'exact',
    'applicationRootId', item.value -> 'applicationRootId',
    'ownerKind', item.value -> 'ownerKind', 'ownerId', item.value -> 'ownerId',
    'permissionId', item.value #> '{permission,permissionId}',
    'acceptedRegistrationRevision', 1,
    'catalogueFingerprint', p_candidate -> 'applicationCatalogueFingerprint',
    'continuityRevision', 1,
    'meaningFingerprint', item.value -> 'meaningFingerprint'
  ) order by
    (item.value ->> 'applicationRootId')::uuid,
    (item.value ->> 'ownerKind') collate "C",
    (item.value ->> 'ownerId')::uuid,
    (item.value #>> '{permission,permissionId}')::uuid)
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(value)
  where p_permission_id is null
    or (item.value #>> '{permission,permissionId}')::uuid = p_permission_id
$function$;

create function pg_temp.platform_permission(
  p_organization_id uuid,
  p_administrative boolean
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', 'exact', 'ownerKind', entry.owner_kind,
    'ownerId', entry.owner_id, 'permissionId', entry.permission_id,
    'acceptedRegistrationRevision', entry.registration_revision,
    'catalogueFingerprint', registration.permission_catalogue_fingerprint,
    'continuityRevision', continuity.continuity_revision,
    'meaningFingerprint', entry.meaning_fingerprint
  )
  from vortex_access.permission_registrations as current_registration
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = current_registration.organization_id
    and registration.registration_kind = current_registration.registration_kind
    and registration.registration_owner_id = current_registration.registration_owner_id
    and registration.revision = current_registration.revision
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.registration_kind = entry.registration_kind
    and continuity.registration_owner_id = entry.registration_owner_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.state = 'available'
  where current_registration.organization_id = p_organization_id
    and current_registration.registration_kind = 'platform'
    and entry.administrative = p_administrative
  order by entry.permission_id
  limit 1
$function$;

create function pg_temp.role_change_evidence(
  p_candidate jsonb,
  p_manifest jsonb default null,
  p_accepted_grant_character text default null,
  p_new_policy_character text default null
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'candidate', p_candidate,
    'newActivationPolicyFingerprint', case when p_new_policy_character is null
      then null else 'sha256:' || pg_catalog.repeat(p_new_policy_character, 64) end,
    'acceptedGrantFingerprint', case when p_accepted_grant_character is null
      then null else 'sha256:' || pg_catalog.repeat(p_accepted_grant_character, 64) end,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'affectedAssignmentManifest', p_manifest
  ))
$function$;

create function pg_temp.organization_snapshot(p_organization_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'access', (
      select to_jsonb(version.*)
      from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
    ),
    'roles', coalesce((
      select pg_catalog.jsonb_agg(to_jsonb(role.*) order by role.role_id)
      from vortex_access.organization_roles as role
      where role.organization_id = p_organization_id
    ), '[]'::jsonb),
    'revisions', coalesce((
      select pg_catalog.jsonb_agg(
        to_jsonb(revision.*) order by revision.role_id, revision.revision
      )
      from vortex_access.organization_role_revisions as revision
      where revision.organization_id = p_organization_id
    ), '[]'::jsonb),
    'permissions', coalesce((
      select pg_catalog.jsonb_agg(
        to_jsonb(permission.*)
        order by permission.role_id, permission.role_revision, permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = p_organization_id
    ), '[]'::jsonb),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(
        to_jsonb(policy.*)
        order by policy.role_id, policy.activation_policy_id, policy.revision
      )
      from vortex_access.organization_role_activation_policy_revisions as policy
      where policy.organization_id = p_organization_id
    ), '[]'::jsonb)
  )
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '31210000-0000-4000-8000-000000000001',
    '21210000-0000-4000-8000-000000000001', 'application',
    'example.role_rejection_one', pg_catalog.statement_timestamp(),
    '91210000-0000-4000-8000-000000000001'
  ),
  (
    '31210000-0000-4000-8000-000000000002',
    '21210000-0000-4000-8000-000000000002', 'application',
    'example.role_rejection_two', pg_catalog.statement_timestamp(),
    '91210000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '31210000-0000-4000-8000-000000000001', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.role_rejection_one","body":{}}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_temp.fixture_permissions(
            '31210000-0000-4000-8000-000000000001'
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)),
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('2', 64), '[]', 'Role rejection release one',
    pg_catalog.statement_timestamp(), '91210000-0000-4000-8000-000000000001'
  ),
  (
    '31210000-0000-4000-8000-000000000002', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.role_rejection_two","body":{}}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_temp.fixture_permissions(
            '31210000-0000-4000-8000-000000000002'
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('7', 64)),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('7', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('3', 64), '[]', 'Role rejection release two',
    pg_catalog.statement_timestamp(), '91210000-0000-4000-8000-000000000001'
  );

create temporary table fixture_candidates as
select
  pg_temp.fixture_candidate(
    '21210000-0000-4000-8000-000000000001',
    '31210000-0000-4000-8000-000000000001'
  ) as local_candidate,
  pg_temp.fixture_candidate(
    '21210000-0000-4000-8000-000000000002',
    '31210000-0000-4000-8000-000000000002'
  ) as foreign_candidate;

select * from vortex_access.coordinate_application_access_change(
  'register', null,
  pg_temp.registration_preparation(
    (select local_candidate from fixture_candidates),
    '52210000-0000-4000-8000-000000000001', '4'
  ),
  '21210000-0000-4000-8000-000000000001',
  '31210000-0000-4000-8000-000000000001',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000009'
);
select * from vortex_access.coordinate_application_access_change(
  'register', null,
  pg_temp.registration_preparation(
    (select foreign_candidate from fixture_candidates),
    '52210000-0000-4000-8000-000000000002', '5'
  ),
  '21210000-0000-4000-8000-000000000002',
  '31210000-0000-4000-8000-000000000002',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000010'
);

create function pg_temp.custom_candidate(
  p_organization_id uuid,
  p_role_id uuid,
  p_key text,
  p_label text,
  p_classification text,
  p_permission jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operation', 'create_custom', 'organizationId', p_organization_id,
    'roleId', p_role_id, 'key', p_key, 'label', p_label,
    'description', 'A neutral role-change rejection fixture.',
    'privilegeClassification', p_classification,
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
    'permissions', pg_catalog.jsonb_build_array(p_permission)
  )
$function$;

select ok(
  pg_catalog.jsonb_array_length(pg_temp.role_permissions(
    (select local_candidate from fixture_candidates),
    '41210000-0000-4000-8000-000000000101'
  )) = 1
  and pg_temp.platform_permission(
    '21210000-0000-4000-8000-000000000001', true
  ) is not null,
  'the fixture resolves standard application and administrative platform evidence'
);

select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_temp.custom_candidate(
    '21210000-0000-4000-8000-000000000001',
    '51210000-0000-4000-8000-000000000001', 'review_role', 'Review role',
    'standard',
    pg_temp.role_permissions(
      (select local_candidate from fixture_candidates),
      '41210000-0000-4000-8000-000000000101'
    ) -> 0
  )),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000011'
);
select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_temp.custom_candidate(
    '21210000-0000-4000-8000-000000000002',
    '51210000-0000-4000-8000-000000000002', 'foreign_review_role',
    'Foreign review role', 'standard',
    pg_temp.role_permissions(
      (select foreign_candidate from fixture_candidates),
      '41210000-0000-4000-8000-000000000201'
    ) -> 0
  )),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000012'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21210000-0000-4000-8000-000000000001',
  '63210000-0000-4000-8000-000000000001', null,
  '51210000-0000-4000-8000-000000000001', 1,
  'organization_account', '42210000-0000-4000-8000-000000000001', null,
  'standing', pg_catalog.clock_timestamp() - interval '1 minute', null,
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000013'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21210000-0000-4000-8000-000000000001',
  '63210000-0000-4000-8000-000000000002', null,
  '51210000-0000-4000-8000-000000000001', 1,
  'group', null, '32210000-0000-4000-8000-000000000001',
  'standing', pg_catalog.clock_timestamp() + interval '1 hour',
  pg_catalog.clock_timestamp() + interval '2 hours',
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000014'
);
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '21210000-0000-4000-8000-000000000002',
  '63210000-0000-4000-8000-000000000003', null,
  '51210000-0000-4000-8000-000000000002', 1,
  'organization_account', '42210000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp() - interval '1 minute', null,
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000015'
);

set constraints all immediate;
set constraints all deferred;

create function pg_temp.assignment_entry(
  p_organization_id uuid,
  p_role_assignment_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'expectedRevision', assignment.revision,
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id
      )
      else pg_catalog.jsonb_build_object('kind', 'group', 'groupId', assignment.group_id)
    end
  )
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = p_organization_id
    and assignment.role_assignment_id = p_role_assignment_id
$function$;

create function pg_temp.assignment_manifest(
  p_role_id uuid,
  p_assignments jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
    'roleId', p_role_id,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'assignments', p_assignments,
    'manifestFingerprint', 'sha256:' || pg_catalog.repeat('3', 64)
  )
$function$;

create temporary table manifest_rejection_context as
select
  pg_catalog.jsonb_build_object(
    'operation', 'revise_metadata_policy',
    'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
    'roleId', '51210000-0000-4000-8000-000000000001'::uuid,
    'expectedRoleRevision', 1,
    'key', 'review_role', 'label', 'Review role',
    'description', 'A neutral role-change rejection fixture.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object(
      'kind', 'activation_required',
      'activationPolicy', pg_catalog.jsonb_build_object(
        'selection', 'new',
        'policy', pg_catalog.jsonb_build_object(
          'activationPolicyId', '53210000-0000-4000-8000-000000000001'::uuid,
          'revision', 1, 'maximumActivationDurationSeconds', 3600,
          'reasonRequired', false,
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'independentApprovalRequired', false
        )
      )
    )
  ) as candidate,
  pg_catalog.jsonb_build_array(
    pg_temp.assignment_entry(
      '21210000-0000-4000-8000-000000000001',
      '63210000-0000-4000-8000-000000000001'
    ),
    pg_temp.assignment_entry(
      '21210000-0000-4000-8000-000000000001',
      '63210000-0000-4000-8000-000000000002'
    )
  ) as canonical_assignments;

create temporary table manifest_rejection_snapshot as
select pg_temp.organization_snapshot(
  '21210000-0000-4000-8000-000000000001'
) as value;

create temporary table invalid_manifests as
with context as (
  select * from manifest_rejection_context
), variants as (
  select 'a manifest missing one current assignment is refused' as description,
    pg_catalog.jsonb_build_array(context.canonical_assignments -> 0) as assignments
  from context
  union all
  select 'a manifest containing one assignment twice is refused',
    pg_catalog.jsonb_build_array(
      context.canonical_assignments -> 0,
      context.canonical_assignments -> 0,
      context.canonical_assignments -> 1
    )
  from context
  union all
  select 'a manifest containing an extra unknown assignment is refused',
    context.canonical_assignments || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'roleAssignmentId', '63210000-0000-4000-8000-000000000004'::uuid,
          'expectedRevision', 1,
          'assignee', pg_catalog.jsonb_build_object(
            'kind', 'organization_account',
            'organizationAccountId', '42210000-0000-4000-8000-000000000001'::uuid
          )
        )
      ) as assignments
  from context
  union all
  select 'a manifest containing another organization assignment is refused',
    context.canonical_assignments || pg_catalog.jsonb_build_array(
        pg_temp.assignment_entry(
          '21210000-0000-4000-8000-000000000002',
          '63210000-0000-4000-8000-000000000003'
        )
      ) as assignments
  from context
  union all
  select 'a manifest containing a stale assignment revision is refused',
    pg_catalog.jsonb_set(
      context.canonical_assignments, '{0,expectedRevision}', '2'::jsonb
    ) as assignments
  from context
)
select description,
  pg_temp.role_change_evidence(
    context.candidate,
    pg_temp.assignment_manifest(
      '51210000-0000-4000-8000-000000000001', variants.assignments
    ),
    null,
    '6'
  ) as evidence
from context, variants;

select throws_ok(
  pg_catalog.format(
    $test$
      select * from vortex_access.coordinate_organization_role_change(
        %L::jsonb,
        '91210000-0000-4000-8000-000000000001',
        '71210000-0000-4000-8000-000000000020'
      )
    $test$,
    invalid.evidence::text
  ),
  '40001'::char(5),
  null,
  invalid.description
)
from invalid_manifests as invalid
order by invalid.description collate "C";

select is(
  pg_temp.organization_snapshot('21210000-0000-4000-8000-000000000001'),
  (select value from manifest_rejection_snapshot),
  'every malformed current-assignment review leaves roles, policies and Access unchanged'
);

create function pg_temp.template_candidate(
  p_operation text,
  p_role_id uuid,
  p_expected_revision bigint,
  p_key text,
  p_label text,
  p_prepared_templates jsonb,
  p_source_role_id uuid,
  p_template_continuity_revision bigint,
  p_permissions jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'operation', p_operation,
    'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
    'roleId', p_role_id, 'expectedRoleRevision', p_expected_revision,
    'key', p_key, 'label', p_label,
    'description', 'A neutral current-template rejection fixture.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
    'preparedTemplates', p_prepared_templates,
    'sourceRoleId', p_source_role_id,
    'templateContinuityRevision', p_template_continuity_revision,
    'permissions', p_permissions
  ))
$function$;

create temporary table source_rejection_snapshot as
select pg_temp.organization_snapshot(
  '21210000-0000-4000-8000-000000000001'
) as value;

create temporary table source_rejection_cases as
with candidates as (
  select local_candidate, foreign_candidate
  from fixture_candidates
), current_values as (
  select
    pg_temp.current_templates(
      candidates.local_candidate,
      '52210000-0000-4000-8000-000000000001', '4'
    ) as local_templates,
    pg_temp.current_templates(
      candidates.foreign_candidate,
      '52210000-0000-4000-8000-000000000002', '5'
    ) as foreign_templates,
    pg_temp.role_permissions(candidates.local_candidate) as local_permissions,
    pg_temp.role_permissions(candidates.foreign_candidate) as foreign_permissions,
    pg_temp.platform_permission(
      '21210000-0000-4000-8000-000000000001', true
    ) as administrative_permission
  from candidates
), cases(description, candidate) as (
  select 'current template evidence from another organization is refused',
    pg_temp.template_candidate(
      'create_custom_from_template',
      '51210000-0000-4000-8000-000000000010', null,
      'foreign_template_copy', 'Foreign template copy',
      current_values.foreign_templates,
      '52210000-0000-4000-8000-000000000002', 1,
      current_values.foreign_permissions
    )
  from current_values
  union all
  select 'a wrong current template continuity revision is refused',
    pg_temp.template_candidate(
      'create_custom_from_template',
      '51210000-0000-4000-8000-000000000011', null,
      'wrong_template_continuity', 'Wrong template continuity',
      current_values.local_templates,
      '52210000-0000-4000-8000-000000000001', 2,
      pg_catalog.jsonb_build_array(current_values.local_permissions -> 0)
    )
  from current_values
  union all
  select 'a wrong current permission continuity revision is refused',
    pg_temp.template_candidate(
      'create_custom_from_template',
      '51210000-0000-4000-8000-000000000012', null,
      'wrong_permission_continuity', 'Wrong permission continuity',
      current_values.local_templates,
      '52210000-0000-4000-8000-000000000001', 1,
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_build_array(current_values.local_permissions -> 0),
        '{0,continuityRevision}', '2'::jsonb
      )
    )
  from current_values
  union all
  select 'a wrong current permission meaning fingerprint is refused',
    pg_temp.template_candidate(
      'create_custom_from_template',
      '51210000-0000-4000-8000-000000000013', null,
      'wrong_permission_meaning', 'Wrong permission meaning',
      current_values.local_templates,
      '52210000-0000-4000-8000-000000000001', 1,
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_build_array(current_values.local_permissions -> 0),
        '{0,meaningFingerprint}',
        pg_catalog.to_jsonb('sha256:' || pg_catalog.repeat('9', 64))
      )
    )
  from current_values
  union all
  select 'a custom template copy containing an unrelated permission is refused',
    pg_temp.template_candidate(
      'create_custom_from_template',
      '51210000-0000-4000-8000-000000000014', null,
      'template_copy_extra', 'Template copy with extra permission',
      current_values.local_templates,
      '52210000-0000-4000-8000-000000000001', 1,
      pg_catalog.jsonb_build_array(
        current_values.local_permissions -> 0,
        current_values.administrative_permission
      )
    )
  from current_values
)
select description, pg_temp.role_change_evidence(candidate) as evidence
from cases;

select throws_ok(
  pg_catalog.format(
    $test$
      select * from vortex_access.coordinate_organization_role_change(
        %L::jsonb,
        '91210000-0000-4000-8000-000000000001',
        '71210000-0000-4000-8000-000000000030'
      )
    $test$,
    invalid.evidence::text
  ),
  '40001'::char(5),
  null,
  invalid.description
)
from source_rejection_cases as invalid
order by invalid.description collate "C";

select is(
  pg_temp.organization_snapshot('21210000-0000-4000-8000-000000000001'),
  (select value from source_rejection_snapshot),
  'foreign, stale and broadened template evidence leaves roles, policies and Access unchanged'
);

create temporary table valid_copy_result as
select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_temp.template_candidate(
    'create_custom_from_template',
    '51210000-0000-4000-8000-000000000003', null,
    'template_copy', 'Template copy',
    pg_temp.current_templates(
      (select local_candidate from fixture_candidates),
      '52210000-0000-4000-8000-000000000001', '4'
    ),
    '52210000-0000-4000-8000-000000000001', 1,
    pg_catalog.jsonb_build_array(
      pg_temp.role_permissions(
        (select local_candidate from fixture_candidates)
      ) -> 0
    )
  )),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000031'
);

select is(
  (select role -> 'derivedFromTemplate' from valid_copy_result),
  pg_catalog.jsonb_build_object(
    'applicationRootId', '31210000-0000-4000-8000-000000000001'::uuid,
    'sourceRoleId', '52210000-0000-4000-8000-000000000001'::uuid,
    'sourceRelease', (
      select local_candidate -> 'applicationRelease' from fixture_candidates
    ),
    'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('4', 64)
  ),
  'a custom copy records the complete current immutable template provenance'
);

create function pg_temp.copy_provenance(p_role_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'identity', pg_catalog.jsonb_build_object(
      'derivedApplicationRootId', role.derived_application_root_id,
      'derivedSourceRoleId', role.derived_source_role_id,
      'derivedSourceDefinitionKey', role.derived_source_definition_key,
      'derivedSourceReleaseRevision', role.derived_source_release_revision,
      'derivedSourceReleaseVersion', role.derived_source_release_version,
      'derivedSourceValidationContractVersion',
        role.derived_source_validation_contract_version,
      'derivedSourceContentFingerprint', role.derived_source_content_fingerprint,
      'derivedSourceResolutionFingerprint', role.derived_source_resolution_fingerprint,
      'derivedSourceTemplateFingerprint', role.derived_source_template_fingerprint,
      'createdBy', role.created_by,
      'createdAt', role.created_at
    ),
    'permissions', (
      select pg_catalog.jsonb_agg(
        to_jsonb(permission.*) - 'role_revision'
        order by permission.entry_ordinal
      )
      from vortex_access.organization_role_permission_entries as permission
      where permission.organization_id = role.organization_id
        and permission.role_id = role.role_id
        and permission.role_revision = role.live_revision
    )
  )
  from vortex_access.organization_roles as role
  where role.organization_id = '21210000-0000-4000-8000-000000000001'
    and role.role_id = p_role_id
$function$;

create temporary table copy_provenance_before as
select pg_temp.copy_provenance(
  '51210000-0000-4000-8000-000000000003'
) as value,
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21210000-0000-4000-8000-000000000001'
  ) as access_version;

create temporary table copy_metadata_result as
select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'revise_metadata_policy',
    'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
    'roleId', '51210000-0000-4000-8000-000000000003'::uuid,
    'expectedRoleRevision', 1, 'key', 'template_copy',
    'label', 'Template copy revised',
    'description', 'A revised neutral custom template copy.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
  )),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000032'
);

select is(
  pg_temp.copy_provenance('51210000-0000-4000-8000-000000000003'),
  (select value from copy_provenance_before),
  'metadata revision preserves the complete custom-copy identity and permission provenance'
);
select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      role #>> '{derivedFromTemplate,sourceRoleId}', access_version
    from copy_metadata_result
  $$,
  $$ values (
    2::bigint,
    '52210000-0000-4000-8000-000000000001'::text,
    (select access_version + 1 from copy_provenance_before)
  ) $$,
  'metadata revision returns the preserved custom-copy source and current Access version'
);

create temporary table administrative_refusal_snapshot as
select pg_temp.organization_snapshot(
  '21210000-0000-4000-8000-000000000001'
) as value;

select throws_ok(
  $test$
    do $block$
    begin
      perform 1
      from vortex_access.coordinate_organization_role_change(
        pg_temp.role_change_evidence(pg_temp.custom_candidate(
          '21210000-0000-4000-8000-000000000001',
          '51210000-0000-4000-8000-000000000005',
          'administrative_review', 'Administrative review', 'standard',
          pg_temp.platform_permission(
            '21210000-0000-4000-8000-000000000001', true
          )
        )),
        '91210000-0000-4000-8000-000000000001',
        '71210000-0000-4000-8000-000000000040'
      );
      set constraints all immediate;
    end
    $block$
  $test$,
  '23514'::char(5),
  null,
  'an administrative permission cannot commit with standard classification'
);

select is(
  pg_temp.organization_snapshot('21210000-0000-4000-8000-000000000001'),
  (select value from administrative_refusal_snapshot),
  'the administrative classification refusal leaves no role, revision or Access change'
);

create temporary table administrative_success_before as
select current_version as access_version
from vortex_access.organization_access_versions
where organization_id = '21210000-0000-4000-8000-000000000001';

create temporary table administrative_success_result as
select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_temp.custom_candidate(
    '21210000-0000-4000-8000-000000000001',
    '51210000-0000-4000-8000-000000000005',
    'administrative_review', 'Administrative review', 'privileged',
    pg_temp.platform_permission(
      '21210000-0000-4000-8000-000000000001', true
    )
  )),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000041'
);

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select role #>> '{privilegeClassification}',
      pg_catalog.jsonb_array_length(role -> 'permissions'), access_version
    from administrative_success_result
  $$,
  $$ values (
    'privileged'::text, 1,
    (select access_version + 1 from administrative_success_before)
  ) $$,
  'privileged classification commits the administrative permission and one Access increment'
);

create temporary table application_role_result as
select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_temp.template_candidate(
      'accept_new_application_role',
      '51210000-0000-4000-8000-000000000004', null,
      'application_review', 'Application review',
      pg_temp.current_templates(
        (select local_candidate from fixture_candidates),
        '52210000-0000-4000-8000-000000000001', '4'
      ),
      '52210000-0000-4000-8000-000000000001', 1,
      pg_temp.role_permissions((select local_candidate from fixture_candidates))
    ),
    null,
    '7'
  ),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000042'
);

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select role #>> '{kind}', role #>> '{source,sourceRoleId}',
      pg_catalog.jsonb_array_length(role -> 'permissions')
    from application_role_result
  $$,
  $$ values (
    'application'::text,
    '52210000-0000-4000-8000-000000000001'::text,
    2
  ) $$,
  'the duplicate and role-kind boundary fixture has one accepted application role'
);

create temporary table duplicate_and_kind_snapshot as
select pg_temp.organization_snapshot(
  '21210000-0000-4000-8000-000000000001'
) as value;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_temp.custom_candidate(
        '21210000-0000-4000-8000-000000000001',
        '51210000-0000-4000-8000-000000000005',
        'different_key', 'Duplicate identity', 'standard',
        pg_temp.role_permissions(
          (select local_candidate from fixture_candidates),
          '41210000-0000-4000-8000-000000000101'
        ) -> 0
      )),
      '91210000-0000-4000-8000-000000000001',
      '71210000-0000-4000-8000-000000000043'
    )
  $$,
  '40001'::char(5),
  null,
  'a duplicate permanent role identity is refused explicitly'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_temp.custom_candidate(
        '21210000-0000-4000-8000-000000000001',
        '51210000-0000-4000-8000-000000000006',
        'administrative_review', 'Duplicate key', 'standard',
        pg_temp.role_permissions(
          (select local_candidate from fixture_candidates),
          '41210000-0000-4000-8000-000000000101'
        ) -> 0
      )),
      '91210000-0000-4000-8000-000000000001',
      '71210000-0000-4000-8000-000000000044'
    )
  $$,
  '23505'::char(5),
  null,
  'the permanent organization-local role key uniqueness refuses a duplicate key'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_temp.template_candidate(
          'accept_new_application_role',
          '51210000-0000-4000-8000-000000000007', null,
          'duplicate_application_source', 'Duplicate application source',
          pg_temp.current_templates(
            (select local_candidate from fixture_candidates),
            '52210000-0000-4000-8000-000000000001', '4'
          ),
          '52210000-0000-4000-8000-000000000001', 1,
          pg_temp.role_permissions((select local_candidate from fixture_candidates))
        ),
        null,
        '8'
      ),
      '91210000-0000-4000-8000-000000000001',
      '71210000-0000-4000-8000-000000000045'
    )
  $$,
  '23505'::char(5),
  null,
  'the permanent application source uniqueness refuses a second local role'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_custom_permissions',
        'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
        'roleId', '51210000-0000-4000-8000-000000000004'::uuid,
        'expectedRoleRevision', 1,
        'key', 'application_review', 'label', 'Application review',
        'description', 'A neutral current-template rejection fixture.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
        'permissions', pg_temp.role_permissions(
          (select local_candidate from fixture_candidates)
        )
      )),
      '91210000-0000-4000-8000-000000000001',
      '71210000-0000-4000-8000-000000000046'
    )
  $$,
  '40001'::char(5),
  null,
  'the custom-permission intent refuses an application role'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_temp.template_candidate(
          'accept_application_role_revision',
          '51210000-0000-4000-8000-000000000003', 2,
          'template_copy', 'Template copy revised',
          pg_temp.current_templates(
            (select local_candidate from fixture_candidates),
            '52210000-0000-4000-8000-000000000001', '4'
          ),
          '52210000-0000-4000-8000-000000000001', 1,
          pg_temp.role_permissions((select local_candidate from fixture_candidates))
        ),
        null,
        '9'
      ),
      '91210000-0000-4000-8000-000000000001',
      '71210000-0000-4000-8000-000000000047'
    )
  $$,
  '40001'::char(5),
  null,
  'the application-acceptance intent refuses a custom role'
);

select is(
  pg_temp.organization_snapshot('21210000-0000-4000-8000-000000000001'),
  (select value from duplicate_and_kind_snapshot),
  'duplicate identity, key, source and wrong-kind refusals are fully atomic'
);

create temporary table custom_retire_before as
select current_version as access_version
from vortex_access.organization_access_versions
where organization_id = '21210000-0000-4000-8000-000000000001';

create temporary table custom_retire_result as
select * from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'retire_role',
    'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
    'roleId', '51210000-0000-4000-8000-000000000003'::uuid,
    'expectedRoleRevision', 2
  )),
  '91210000-0000-4000-8000-000000000001',
  '71210000-0000-4000-8000-000000000048'
);

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select role #>> '{kind}', role #>> '{lifecycle}',
      (role #>> '{liveRevision}')::bigint, access_version
    from custom_retire_result
  $$,
  $$ values (
    'custom'::text, 'retired'::text, 3::bigint,
    (select access_version + 1 from custom_retire_before)
  ) $$,
  'custom retirement seals one terminal revision and one Access increment'
);

create temporary table retired_custom_snapshot as
select pg_temp.organization_snapshot(
  '21210000-0000-4000-8000-000000000001'
) as value;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '21210000-0000-4000-8000-000000000001'::uuid,
        'roleId', '51210000-0000-4000-8000-000000000003'::uuid,
        'expectedRoleRevision', 3, 'key', 'template_copy',
        'label', 'Retired template copy edit',
        'description', 'A retired custom role cannot be edited.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
      )),
      '91210000-0000-4000-8000-000000000001',
      '71210000-0000-4000-8000-000000000049'
    )
  $$,
  '40001'::char(5),
  null,
  'a retired custom role is terminal'
);

select is(
  pg_temp.organization_snapshot('21210000-0000-4000-8000-000000000001'),
  (select value from retired_custom_snapshot),
  'terminal custom-role refusal leaves history and Access unchanged'
);

set constraints all immediate;
set constraints all deferred;

select * from finish();

rollback;
