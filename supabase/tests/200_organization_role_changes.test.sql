\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_function(
  'vortex_access',
  'coordinate_organization_role_change',
  array['jsonb', 'uuid', 'uuid'],
  'the owner-only organization role-change coordinator exists'
);
select ok(
  not pg_catalog.has_function_privilege(
    'public',
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  ),
  'the role-change coordinator remains owner-only'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000200', 'role_change_tenant',
  'Role change tenant', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000200', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  '21000000-0000-4000-8000-000000000200',
  '11000000-0000-4000-8000-000000000200', 'role_change_org',
  'Role change organisation', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000200', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '41000000-0000-4000-8000-000000000200', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000209', 1
);

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '42000000-0000-4000-8000-000000000200',
  '21000000-0000-4000-8000-000000000200',
  '41000000-0000-4000-8000-000000000200', 'Role change account', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000210', 1
);

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000200',
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000200'
);

create function pg_temp.role_change_permission(
  p_permission_id uuid,
  p_action_kind text default null
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', p_permission_id,
    'key', case p_permission_id
      when '41000000-0000-4000-8000-000000000200'::uuid
        then 'example.records.read'
      when '41000000-0000-4000-8000-000000000201'::uuid
        then 'example.records.update'
      else 'example.records.transfer'
    end,
    'label', case p_permission_id
      when '41000000-0000-4000-8000-000000000200'::uuid then 'View records'
      when '41000000-0000-4000-8000-000000000201'::uuid then 'Update records'
      else 'Transfer records'
    end,
    'description', case p_permission_id
      when '41000000-0000-4000-8000-000000000200'::uuid
        then 'View records in the role-change fixture.'
      when '41000000-0000-4000-8000-000000000201'::uuid
        then 'Update records in the role-change fixture.'
      else 'Transfer records in the role-change fixture.'
    end,
    'actionKind', case p_permission_id
      when '41000000-0000-4000-8000-000000000200'::uuid
        then coalesce(p_action_kind, 'read')
      when '41000000-0000-4000-8000-000000000201'::uuid then 'update'
      else coalesce(p_action_kind, 'update')
    end,
    'administrative', false
  )
$function$;

create function pg_temp.role_change_candidate(
  p_release_revision bigint,
  p_release_version text,
  p_content_character text,
  p_resolution_character text,
  p_catalogue_character text,
  p_candidate_character text,
  p_first_meaning_character text default 'd',
  p_include_third_permission boolean default false,
  p_third_action_kind text default 'update',
  p_first_action_kind text default 'read'
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with release_value as (
    select pg_catalog.jsonb_build_object(
      'kind', 'application',
      'definitionKey', 'example.role_change',
      'rootId', '31000000-0000-4000-8000-000000000200'::uuid,
      'releaseRevision', p_release_revision,
      'releaseVersion', p_release_version,
      'validationContractVersion', '2.18.0',
      'contentFingerprint', 'sha256:' || pg_catalog.repeat(p_content_character, 64),
      'resolutionFingerprint', 'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
    ) as value
  ), permission_values as (
    select pg_catalog.jsonb_build_array(
      pg_temp.role_change_permission(
        '41000000-0000-4000-8000-000000000200', p_first_action_kind
      ),
      pg_temp.role_change_permission('41000000-0000-4000-8000-000000000201')
    ) || case when p_include_third_permission then pg_catalog.jsonb_build_array(
      pg_temp.role_change_permission(
        '41000000-0000-4000-8000-000000000202', p_third_action_kind
      )
    ) else '[]'::jsonb end as value
  ), entry_values as (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'applicationRootId', '31000000-0000-4000-8000-000000000200'::uuid,
      'ownerKind', 'application',
      'ownerId', '31000000-0000-4000-8000-000000000200'::uuid,
      'permission', permission.value,
      'sourceRelease', release_value.value,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat(
        case permission.value ->> 'permissionId'
          when '41000000-0000-4000-8000-000000000200'
            then p_first_meaning_character
          when '41000000-0000-4000-8000-000000000201' then 'e'
          else case when p_third_action_kind = 'export' then '0' else 'f' end
        end,
        64
      )
    ) order by permission.value ->> 'key') as value
    from release_value, permission_values,
      pg_catalog.jsonb_array_elements(permission_values.value) as permission(value)
  )
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'applicationRootId', '31000000-0000-4000-8000-000000000200'::uuid,
    'applicationRelease', release_value.value,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(p_catalogue_character, 64),
    'applicationPermissionIds', (
      select pg_catalog.jsonb_agg(
        item.value #> '{permission,permissionId}' order by item.ordinality
      )
      from pg_catalog.jsonb_array_elements(entry_values.value)
        with ordinality as item(value, ordinality)
    ),
    'entries', entry_values.value,
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat(p_candidate_character, 64)
  )
  from release_value, entry_values
$function$;

create function pg_temp.role_template(
  p_candidate jsonb,
  p_template_character text,
  p_wildcard boolean default false
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'template', pg_catalog.jsonb_build_object(
      'roleId', '52000000-0000-4000-8000-000000000200'::uuid,
      'key', 'records_reader',
      'name', 'Records reader',
      'homePageId', '61000000-0000-4000-8000-000000000200'::uuid,
      'permissionKeys', (
        select pg_catalog.jsonb_agg(
          item.value #>> '{permission,key}' order by item.value #>> '{permission,key}'
        )
        from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(value)
      ),
      'permissionSelection', case when p_wildcard then
        pg_catalog.jsonb_build_object(
          'kind', 'application_wildcard',
          'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('a', 64)
        )
      else pg_catalog.jsonb_build_object('kind', 'exact') end
    ),
    'sourceTemplateFingerprint',
      'sha256:' || pg_catalog.repeat(p_template_character, 64),
    'sourcePermissions', p_candidate -> 'entries',
    'livePermissions', case when p_wildcard then (
      select coalesce(pg_catalog.jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(p_candidate -> 'entries')
        with ordinality as item(value, ordinality)
      where item.value #>> '{permission,actionKind}' <> 'export'
    ) else p_candidate -> 'entries' end
  )
$function$;

create function pg_temp.registration_preparation(
  p_candidate jsonb,
  p_template_character text,
  p_wildcard boolean default false
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
    'templates', pg_catalog.jsonb_build_array(
      pg_temp.role_template(p_candidate, p_template_character, p_wildcard)
    ),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('0', 64)
  )
$function$;

create function pg_temp.current_role_templates(
  p_candidate jsonb,
  p_registration_revision bigint,
  p_template_character text,
  p_wildcard boolean default false
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
    'templates', pg_catalog.jsonb_build_array(
      pg_temp.role_template(p_candidate, p_template_character, p_wildcard)
    ),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('1', 64)
  )
$function$;

create function pg_temp.role_permissions(
  p_candidate jsonb,
  p_registration_revision bigint,
  p_continuity_revision bigint,
  p_permission_id uuid default null,
  p_first_continuity_revision bigint default null,
  p_excluded_action_kind text default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', item.value -> 'applicationRootId',
      'ownerKind', item.value -> 'ownerKind',
      'ownerId', item.value -> 'ownerId',
      'permissionId', item.value #> '{permission,permissionId}',
      'acceptedRegistrationRevision', p_registration_revision,
      'catalogueFingerprint', p_candidate -> 'applicationCatalogueFingerprint',
      'continuityRevision', case
        when item.value #>> '{permission,permissionId}' =
            '41000000-0000-4000-8000-000000000200'
          then coalesce(p_first_continuity_revision, p_continuity_revision)
        else p_continuity_revision
      end,
      'meaningFingerprint', item.value -> 'meaningFingerprint'
    ) order by
      (item.value ->> 'applicationRootId')::uuid,
      (item.value ->> 'ownerKind') collate "C",
      (item.value ->> 'ownerId')::uuid,
      (item.value #>> '{permission,permissionId}')::uuid
  )
  from pg_catalog.jsonb_array_elements(p_candidate -> 'entries') as item(value)
  where (
    p_permission_id is null
    or (item.value #>> '{permission,permissionId}')::uuid = p_permission_id
  ) and (
    p_excluded_action_kind is null
    or item.value #>> '{permission,actionKind}' <> p_excluded_action_kind
  )
$function$;

create function pg_temp.role_change_evidence(
  p_candidate jsonb,
  p_accepted_grant_character text default null,
  p_manifest jsonb default null,
  p_new_policy_character text default null
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'candidate', p_candidate,
    'newActivationPolicyFingerprint', case when p_new_policy_character is null
      then null else 'sha256:' || pg_catalog.repeat(p_new_policy_character, 64) end,
    'acceptedGrantFingerprint', case when p_accepted_grant_character is null
      then null else 'sha256:' || pg_catalog.repeat(p_accepted_grant_character, 64) end,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'affectedAssignmentManifest', p_manifest
  ))
$function$;

create function pg_temp.assignment_manifest(p_role_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', p_role_id,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'assignments', coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'roleAssignmentId', assignment.role_assignment_id,
        'expectedRevision', assignment.revision,
        'assignee', pg_catalog.jsonb_build_object(
          'kind', 'organization_account',
          'organizationAccountId', assignment.organization_account_id
        )
      ) order by assignment.role_assignment_id
    ), '[]'::jsonb),
    'manifestFingerprint', 'sha256:' || pg_catalog.repeat('3', 64)
  )
  from vortex_access.organization_role_assignments as assignment
  where assignment.organization_id = '21000000-0000-4000-8000-000000000200'
    and assignment.role_id = p_role_id
    and assignment.state = 'live'
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '31000000-0000-4000-8000-000000000200',
  '21000000-0000-4000-8000-000000000200', 'application',
  'example.role_change', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000200'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '31000000-0000-4000-8000-000000000200', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.role_change","body":{}}',
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application',
      'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.role_change_permission('41000000-0000-4000-8000-000000000200'),
            pg_temp.role_change_permission('41000000-0000-4000-8000-000000000201')
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)),
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('2', 64), '[]', 'Initial role-change release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000200'
  ),
  (
    '31000000-0000-4000-8000-000000000200', 2, '1.1.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.role_change","body":{}}',
    'sha256:' || pg_catalog.repeat('3', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application',
      'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.role_change_permission('41000000-0000-4000-8000-000000000200'),
            pg_temp.role_change_permission('41000000-0000-4000-8000-000000000201')
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('4', 64)),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), '2.18.0',
    'sha256:' || pg_catalog.repeat('5', 64), '[]', 'Updated role-change release',
    pg_catalog.statement_timestamp(), '91000000-0000-4000-8000-000000000200'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
)
select
  '31000000-0000-4000-8000-000000000200', release.revision, release.version,
  '{"source_contract_version":"1.0.0","kind":"application","key":"example.role_change","body":{}}',
  'sha256:' || pg_catalog.repeat(release.content_character, 64), '1.0.0',
  pg_catalog.jsonb_build_object(
    'kind', 'application',
    'canonical', pg_catalog.jsonb_build_object(
      'content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(
          pg_temp.role_change_permission(
            '41000000-0000-4000-8000-000000000200', release.first_action_kind
          ),
          pg_temp.role_change_permission(
            '41000000-0000-4000-8000-000000000202', release.third_action_kind
          ),
          pg_temp.role_change_permission('41000000-0000-4000-8000-000000000201')
        )
      )
    )
  ),
  pg_catalog.jsonb_build_object(
    'fingerprint', 'sha256:' || pg_catalog.repeat(release.resolution_character, 64)
  ),
  'sha256:' || pg_catalog.repeat(release.content_character, 64),
  'sha256:' || pg_catalog.repeat(release.resolution_character, 64),
  '2.18.0', 'sha256:' || pg_catalog.repeat(release.comparison_character, 64),
  '[]', release.note, pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000200'
from (values
  (3::bigint, '1.2.0'::text, '6'::text, '7'::text, '8'::text,
    'update'::text, 'read'::text,
    'Added role permission'),
  (4::bigint, '1.3.0'::text, '7'::text, '8'::text, '9'::text,
    'export'::text, 'read'::text,
    'Wildcard role excludes export authority'),
  (5::bigint, '1.4.0'::text, '8'::text, '9'::text, 'a'::text,
    'export'::text, 'update'::text,
    'Changed read permission meaning'),
  (6::bigint, '1.5.0'::text, '9'::text, 'a'::text, 'b'::text,
    'export'::text, 'read'::text,
    'Restored read permission meaning')
) as release(
  revision, version, content_character, resolution_character,
  comparison_character, third_action_kind, first_action_kind, note
);

create temporary table role_change_candidates as
select
  pg_temp.role_change_candidate(1, '1.0.0', 'a', 'b', 'c', '1') as initial_candidate,
  pg_temp.role_change_candidate(2, '1.1.0', '3', '4', '5', '6') as update_candidate,
  pg_temp.role_change_candidate(
    3, '1.2.0', '6', '7', '8', '9', 'd', true, 'update'
  ) as added_permission_candidate,
  pg_temp.role_change_candidate(
    4, '1.3.0', '7', '8', '9', 'a', 'd', true, 'export'
  ) as wildcard_candidate,
  pg_temp.role_change_candidate(
    5, '1.4.0', '8', '9', 'a', 'b', 'b', true, 'export', 'update'
  ) as meaning_b_candidate,
  pg_temp.role_change_candidate(
    6, '1.5.0', '9', 'a', 'b', 'c', 'd', true, 'export', 'read'
  ) as meaning_a_candidate;

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'register', null,
      pg_temp.registration_preparation(
        (select initial_candidate from role_change_candidates), 'e'
      ),
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000201'
    )
  $$,
  $$ values ('changed'::text, 'register'::text, 1::bigint, 2::bigint) $$,
  'the real registration coordinator establishes the application source fixture'
);

create temporary table custom_create_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'create_custom',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
    'key', 'custom_reader',
    'label', 'Custom reader',
    'description', 'A custom role created through the protected composition.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
    'permissions', pg_temp.role_permissions(
      (select initial_candidate from role_change_candidates), 1, 1
    )
  )),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000202'
);

select is(
  (select role #>> '{liveRevision}' from custom_create_result),
  '1',
  'create_custom seals revision one'
);
select is(
  (select role #>> '{label}' from custom_create_result),
  'Custom reader',
  'create_custom returns the stored role'
);
select is(
  (select access_version from custom_create_result),
  3::bigint,
  'create_custom increments Access exactly once'
);

create temporary table custom_metadata_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'revise_metadata_policy',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
    'expectedRoleRevision', 1,
    'key', 'custom_reader',
    'label', 'Custom records reader',
    'description', 'Metadata changed without refreshing accepted authority.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
  )),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000203'
);

select is(
  (select role #>> '{liveRevision}' from custom_metadata_result),
  '2',
  'metadata revision advances the role revision'
);
select is(
  (select role #>> '{label}' from custom_metadata_result),
  'Custom records reader',
  'metadata revision returns the new configuration'
);
select is(
  (select role #>> '{permissions,0,acceptedRegistrationRevision}'
   from custom_metadata_result),
  '1',
  'metadata revision preserves the sealed permission provenance'
);
select is(
  (select access_version from custom_metadata_result),
  4::bigint,
  'metadata revision increments Access exactly once'
);

create temporary table application_create_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'accept_new_application_role',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
      'key', 'records_reader',
      'label', 'Records reader',
      'description', 'Accepted application reader role.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'new',
          'policy', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000201'::uuid,
            'revision', 1,
            'maximumActivationDurationSeconds', 1800,
            'reasonRequired', false,
            'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
            'independentApprovalRequired', false
          )
        )
      ),
      'preparedTemplates', pg_temp.current_role_templates(
        (select initial_candidate from role_change_candidates), 1, 'e'
      ),
      'sourceRoleId', '52000000-0000-4000-8000-000000000200'::uuid,
      'templateContinuityRevision', 1,
      'permissions', pg_temp.role_permissions(
        (select initial_candidate from role_change_candidates), 1, 1
      )
    ),
    '7',
    null,
    '6'
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000204'
);

select results_eq(
  $$
    select role #>> '{kind}', role #>> '{lifecycle}',
      (role #>> '{source,acceptedRegistrationRevision}')::bigint,
      access_version
    from application_create_result
  $$,
  $$ values ('application'::text, 'active'::text, 1::bigint, 5::bigint) $$,
  'initial application acceptance stores the exact current source'
);

create temporary table template_copy_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'create_custom_from_template',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', '51000000-0000-4000-8000-000000000202'::uuid,
    'key', 'copied_reader',
    'label', 'Copied reader',
    'description', 'A custom role copied from one exact current template permission.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
    'preparedTemplates', pg_temp.current_role_templates(
      (select initial_candidate from role_change_candidates), 1, 'e'
    ),
    'sourceRoleId', '52000000-0000-4000-8000-000000000200'::uuid,
    'templateContinuityRevision', 1,
    'permissions', pg_temp.role_permissions(
      (select initial_candidate from role_change_candidates), 1, 1,
      '41000000-0000-4000-8000-000000000200'
    )
  )),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000211'
);

select results_eq(
  $$
    select role #>> '{kind}',
      pg_catalog.jsonb_array_length(role -> 'permissions'),
      role #>> '{derivedFromTemplate,sourceRoleId}',
      access_version
    from template_copy_result
  $$,
  $$ values (
    'custom'::text,
    1,
    '52000000-0000-4000-8000-000000000200'::text,
    6::bigint
  ) $$,
  'custom template copy accepts a nonempty exact subset and records provenance'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 1,
      pg_temp.registration_preparation(
        (select update_candidate from role_change_candidates), 'f'
      ),
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000205'
    )
  $$,
  $$ values ('changed'::text, 'update'::text, 2::bigint, 7::bigint) $$,
  'the real update coordinator advances the application source once'
);

select is(
  (
    select revision.lifecycle
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = '21000000-0000-4000-8000-000000000200'
      and role.role_id = '51000000-0000-4000-8000-000000000201'
  ),
  'active',
  'registration provenance refresh does not itself remove retained authority'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_catalog.jsonb_build_object(
          'operation', 'revise_custom_permissions',
          'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
          'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
          'expectedRoleRevision', 2,
          'key', 'custom_reader',
          'label', 'Custom records reader',
          'description', 'Metadata changed without refreshing accepted authority.',
          'privilegeClassification', 'standard',
          'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
          'permissions', pg_temp.role_permissions(
            (select update_candidate from role_change_candidates), 2, 1,
            '41000000-0000-4000-8000-000000000200'
          )
        ),
        null,
        pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200')
      ),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000224'
    )
  $$,
  '22023'::char(5),
  null,
  'pure custom narrowing refuses an extraneous assignment manifest'
);

create temporary table custom_narrow_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'revise_custom_permissions',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
    'expectedRoleRevision', 2,
    'key', 'custom_reader',
    'label', 'Custom records reader',
    'description', 'Metadata changed without refreshing accepted authority.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
    'permissions', pg_temp.role_permissions(
      (select update_candidate from role_change_candidates), 2, 1,
      '41000000-0000-4000-8000-000000000200'
    )
  )),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000212'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      pg_catalog.jsonb_array_length(role -> 'permissions'),
      (role #>> '{authorityContinuityRevision}')::bigint,
      access_version
    from custom_narrow_result
  $$,
  $$ values (3::bigint, 1, 1::bigint, 8::bigint) $$,
  'custom narrowing needs no manifest and preserves the authority period'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_custom_permissions',
        'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
        'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
        'expectedRoleRevision', 3,
        'key', 'custom_reader',
        'label', 'Custom records reader',
        'description', 'Metadata changed without refreshing accepted authority.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
        'permissions', pg_temp.role_permissions(
          (select update_candidate from role_change_candidates), 2, 1
        )
      )),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000225'
    )
  $$,
  '22023'::char(5),
  null,
  'custom broadening refuses an absent complete assignment manifest'
);

set constraints all immediate;
set constraints all deferred;

alter table vortex_access.organization_role_revisions
  disable trigger organization_role_revisions_immutable;
alter table vortex_access.organization_role_revisions
  disable trigger organization_role_revisions_evidence;
update vortex_access.organization_role_revisions
set authority_continuity_revision = 9007199254740991
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200'
  and revision = 3;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_catalog.jsonb_build_object(
          'operation', 'revise_custom_permissions',
          'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
          'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
          'expectedRoleRevision', 3,
          'key', 'custom_reader',
          'label', 'Custom records reader',
          'description', 'Metadata changed without refreshing accepted authority.',
          'privilegeClassification', 'standard',
          'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
          'permissions', pg_temp.role_permissions(
            (select update_candidate from role_change_candidates), 2, 1
          )
        ),
        null,
        pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200')
      ),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000226'
    )
  $$,
  '22003'::char(5),
  null,
  'authority continuity exhaustion rolls back custom broadening'
);

update vortex_access.organization_role_revisions
set authority_continuity_revision = 1
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200'
  and revision = 3;
set constraints all immediate;
set constraints all deferred;
alter table vortex_access.organization_role_revisions
  enable trigger organization_role_revisions_evidence;
alter table vortex_access.organization_role_revisions
  enable trigger organization_role_revisions_immutable;

create temporary table custom_broaden_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_custom_permissions',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
      'expectedRoleRevision', 3,
      'key', 'custom_reader',
      'label', 'Custom records reader',
      'description', 'Metadata changed without refreshing accepted authority.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
      'permissions', pg_temp.role_permissions(
        (select update_candidate from role_change_candidates), 2, 1
      )
    ),
    null,
    pg_catalog.jsonb_build_object(
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
      'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
      'assignments', '[]'::jsonb,
      'manifestFingerprint', 'sha256:' || pg_catalog.repeat('3', 64)
    )
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000213'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      pg_catalog.jsonb_array_length(role -> 'permissions'),
      (role #>> '{authorityContinuityRevision}')::bigint,
      access_version
    from custom_broaden_result
  $$,
  $$ values (4::bigint, 2, 2::bigint, 9::bigint) $$,
  'custom broadening requires an explicit complete empty assignment manifest'
);

create temporary table application_accept_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'accept_application_role_revision',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
      'expectedRoleRevision', 1,
      'key', 'records_reader',
      'label', 'Records reader',
      'description', 'Accepted application reader role.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'existing',
          'reference', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000201'::uuid,
            'revision', 1,
            'fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
          )
        )
      ),
      'preparedTemplates', pg_temp.current_role_templates(
        (select update_candidate from role_change_candidates), 2, 'f'
      ),
      'sourceRoleId', '52000000-0000-4000-8000-000000000200'::uuid,
      'templateContinuityRevision', 1,
      'permissions', pg_temp.role_permissions(
        (select update_candidate from role_change_candidates), 2, 1
      )
    ),
    '8'
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000206'
);

select results_eq(
  $$
    select role #>> '{lifecycle}',
      (role #>> '{liveRevision}')::bigint,
      (role #>> '{source,acceptedRegistrationRevision}')::bigint,
      (role #>> '{authorityContinuityRevision}')::bigint,
      access_version
    from application_accept_result
  $$,
  $$ values ('active'::text, 2::bigint, 2::bigint, 1::bigint, 10::bigint) $$,
  'existing application acceptance refreshes source provenance without broadening authority'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 2,
      pg_temp.registration_preparation(
        (select added_permission_candidate from role_change_candidates), '1'
      ),
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000232'
    )
  $$,
  $$ values ('changed'::text, 'update'::text, 3::bigint, 11::bigint) $$,
  'an added live permission moves the application role to acceptance required'
);

select results_eq(
  $$
    select revision.lifecycle, role.live_revision,
      pg_catalog.count(permission.permission_id)::bigint,
      revision.accepted_registration_revision,
      revision.authority_continuity_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    left join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    where role.organization_id = '21000000-0000-4000-8000-000000000200'
      and role.role_id = '51000000-0000-4000-8000-000000000201'
    group by revision.lifecycle, role.live_revision,
      revision.accepted_registration_revision,
      revision.authority_continuity_revision
  $$,
  $$ values ('acceptance_required'::text, 3::bigint, 2::bigint, 2::bigint, 1::bigint) $$,
  'the pending application role retains its nonempty accepted authority and source grant'
);

create temporary table application_pending_metadata_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'revise_metadata_policy',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
    'expectedRoleRevision', 3,
    'key', 'records_reader',
    'label', 'Records reader pending acceptance',
    'description', 'Metadata changed without accepting added application authority.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object(
      'kind', 'activation_required',
      'activationPolicy', pg_catalog.jsonb_build_object(
        'selection', 'existing',
        'reference', pg_catalog.jsonb_build_object(
          'activationPolicyId', '53000000-0000-4000-8000-000000000201'::uuid,
          'revision', 1,
          'fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
        )
      )
    )
  )),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000233'
);

select ok(
  (
    select
      pg_catalog.to_jsonb(current_value.*) - array[
        'revision', 'role_key', 'label', 'description',
        'changed_by', 'changed_at', 'change_correlation_id'
      ]::text[] =
      pg_catalog.to_jsonb(previous_value.*) - array[
        'revision', 'role_key', 'label', 'description',
        'changed_by', 'changed_at', 'change_correlation_id'
      ]::text[]
      and (
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(permission.*) - 'role_revision'
          order by permission.entry_ordinal
        )
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = current_value.organization_id
          and permission.role_id = current_value.role_id
          and permission.role_revision = current_value.revision
      ) = (
        select pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(permission.*) - 'role_revision'
          order by permission.entry_ordinal
        )
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = previous_value.organization_id
          and permission.role_id = previous_value.role_id
          and permission.role_revision = previous_value.revision
      )
    from vortex_access.organization_role_revisions as previous_value
    join vortex_access.organization_role_revisions as current_value
      on current_value.organization_id = previous_value.organization_id
      and current_value.role_id = previous_value.role_id
      and current_value.revision = previous_value.revision + 1
    where previous_value.organization_id = '21000000-0000-4000-8000-000000000200'
      and previous_value.role_id = '51000000-0000-4000-8000-000000000201'
      and previous_value.revision = 3
  )
  and (
    select role #>> '{createdByActorId}' =
        (select role #>> '{createdByActorId}' from application_create_result)
      and role #>> '{createdAt}' =
        (select role #>> '{createdAt}' from application_create_result)
      and access_version = 12
    from application_pending_metadata_result
  ),
  'pending metadata preserves lifecycle, policy, full accepted source, permissions and original grant'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
        'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
        'expectedRoleRevision', 3,
        'key', 'records_reader',
        'label', 'Stale pending metadata',
        'description', 'A stale metadata request must not partially write.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', '53000000-0000-4000-8000-000000000201'::uuid,
              'revision', 1,
              'fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
            )
          )
        )
      )),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000234'
    )
  $$,
  '40001'::char(5),
  null,
  'pending metadata refuses a stale expected role revision'
);

select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000200'
  ),
  12::bigint,
  'the stale pending metadata request leaves Access unchanged'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 3,
      pg_temp.registration_preparation(
        (select wildcard_candidate from role_change_candidates), '2', true
      ),
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000235'
    )
  $$,
  $$ values ('changed'::text, 'update'::text, 4::bigint, 13::bigint) $$,
  'removing the unaccepted addition leaves the role pending with retained authority'
);

create temporary table application_wildcard_accept_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'accept_application_role_revision',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
      'expectedRoleRevision', 4,
      'key', 'records_reader',
      'label', 'Records reader pending acceptance',
      'description', 'Metadata changed without accepting added application authority.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'existing',
          'reference', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000201'::uuid,
            'revision', 1,
            'fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
          )
        )
      ),
      'preparedTemplates', pg_temp.current_role_templates(
        (select wildcard_candidate from role_change_candidates), 4, '2', true
      ),
      'sourceRoleId', '52000000-0000-4000-8000-000000000200'::uuid,
      'templateContinuityRevision', 1,
      'permissions', pg_temp.role_permissions(
        (select wildcard_candidate from role_change_candidates), 4, 1,
        null, null, 'export'
      )
    ),
    '9'
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000236'
);

select results_eq(
  $$
    select role #>> '{lifecycle}',
      (role #>> '{liveRevision}')::bigint,
      (role #>> '{source,acceptedRegistrationRevision}')::bigint,
      (role #>> '{authorityContinuityRevision}')::bigint,
      pg_catalog.jsonb_array_length(role -> 'permissions'),
      role #>> '{permissions,0,permissionId}' =
        '41000000-0000-4000-8000-000000000202'
        or role #>> '{permissions,1,permissionId}' =
          '41000000-0000-4000-8000-000000000202',
      access_version
    from application_wildcard_accept_result
  $$,
  $$ values (
    'active'::text, 5::bigint, 4::bigint, 1::bigint, 2, false, 14::bigint
  ) $$,
  'explicit pending acceptance needs no manifest when wildcard live authority is unchanged'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 4,
      pg_temp.registration_preparation(
        (select meaning_b_candidate from role_change_candidates), '3', true
      ),
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000238'
    )
  $$,
  $$ values ('changed'::text, 'update'::text, 5::bigint, 15::bigint) $$,
  'the real coordinator changes the read permission from meaning A to B'
);

create temporary table custom_meaning_b_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_custom_permissions',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000202'::uuid,
      'expectedRoleRevision', 1,
      'key', 'copied_reader',
      'label', 'Copied reader',
      'description', 'A custom role copied from one exact current template permission.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
      'permissions', pg_temp.role_permissions(
        (select meaning_b_candidate from role_change_candidates), 5, 1,
        '41000000-0000-4000-8000-000000000200', 2
      )
    ),
    null,
    pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000202')
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000239'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      (role #>> '{authorityContinuityRevision}')::bigint,
      (role #>> '{permissions,0,acceptedRegistrationRevision}')::bigint,
      (role #>> '{permissions,0,continuityRevision}')::bigint,
      role #>> '{permissions,0,meaningFingerprint}',
      (role #>> '{derivedFromTemplate,sourceRelease,releaseRevision}')::bigint,
      access_version
    from custom_meaning_b_result
  $$,
  $$ values (
    2::bigint, 2::bigint, 5::bigint, 2::bigint,
    ('sha256:' || pg_catalog.repeat('b', 64))::text, 1::bigint, 16::bigint
  ) $$,
  'explicit custom refresh binds meaning B and advances authority without rewriting provenance'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'update', 5,
      pg_temp.registration_preparation(
        (select meaning_a_candidate from role_change_candidates), '4', true
      ),
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000240'
    )
  $$,
  $$ values ('changed'::text, 'update'::text, 6::bigint, 17::bigint) $$,
  'the real coordinator restores the read permission from meaning B to A'
);

create temporary table custom_meaning_a_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_custom_permissions',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000202'::uuid,
      'expectedRoleRevision', 2,
      'key', 'copied_reader',
      'label', 'Copied reader',
      'description', 'A custom role copied from one exact current template permission.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
      'permissions', pg_temp.role_permissions(
        (select meaning_a_candidate from role_change_candidates), 6, 1,
        '41000000-0000-4000-8000-000000000200', 3
      )
    ),
    null,
    pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000202')
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000241'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      (role #>> '{authorityContinuityRevision}')::bigint,
      (role #>> '{permissions,0,acceptedRegistrationRevision}')::bigint,
      (role #>> '{permissions,0,continuityRevision}')::bigint,
      role #>> '{permissions,0,meaningFingerprint}',
      (role #>> '{derivedFromTemplate,sourceRelease,releaseRevision}')::bigint,
      access_version,
      (
        select pg_catalog.count(*)::bigint
        from vortex_access.organization_role_permission_entries as historical
        where historical.organization_id =
            '21000000-0000-4000-8000-000000000200'
          and historical.role_id = '51000000-0000-4000-8000-000000000202'
          and historical.role_revision = 1
          and historical.continuity_revision = 1
          and historical.meaning_fingerprint =
            'sha256:' || pg_catalog.repeat('d', 64)
      )
    from custom_meaning_a_result
  $$,
  $$ values (
    3::bigint, 3::bigint, 6::bigint, 3::bigint,
    ('sha256:' || pg_catalog.repeat('d', 64))::text, 1::bigint, 18::bigint,
    1::bigint
  ) $$,
  'restored meaning A requires new continuity and authority instead of reviving old evidence'
);

select results_eq(
  $$
    select outcome, operation, registration_revision, access_version
    from vortex_access.coordinate_application_access_change(
      'withdraw', 6, null,
      '21000000-0000-4000-8000-000000000200',
      '31000000-0000-4000-8000-000000000200',
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000207'
    )
  $$,
  $$ values ('changed'::text, 'withdraw'::text, 7::bigint, 19::bigint) $$,
  'source withdrawal transitions the accepted application role through the real coordinator'
);

select is(
  (
    select revision.lifecycle
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = '21000000-0000-4000-8000-000000000200'
      and role.role_id = '51000000-0000-4000-8000-000000000201'
  ),
  'unavailable',
  'the source withdrawal makes the application role unavailable'
);

create temporary table application_unavailable_policy_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_metadata_policy',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
      'expectedRoleRevision', 7,
      'key', 'records_reader',
      'label', 'Records reader pending acceptance',
      'description', 'Unavailable source with independently revised policy details.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'new',
          'policy', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000201'::uuid,
            'revision', 2,
            'maximumActivationDurationSeconds', 900,
            'reasonRequired', true,
            'recentAuthentication', pg_catalog.jsonb_build_object(
              'kind', 'primary', 'maximumAgeSeconds', 300
            ),
            'independentApprovalRequired', false
          )
        )
      )
    ),
    null,
    null,
    'a'
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000237'
);

select ok(
  (
    select
      pg_catalog.to_jsonb(current_value.*) - array[
        'revision', 'description', 'assignment_policy',
        'policy_continuity_revision', 'activation_policy_id',
        'activation_policy_revision', 'activation_policy_fingerprint',
        'changed_by', 'changed_at', 'change_correlation_id'
      ]::text[] =
      pg_catalog.to_jsonb(previous_value.*) - array[
        'revision', 'description', 'assignment_policy',
        'policy_continuity_revision', 'activation_policy_id',
        'activation_policy_revision', 'activation_policy_fingerprint',
        'changed_by', 'changed_at', 'change_correlation_id'
      ]::text[]
    from vortex_access.organization_role_revisions as previous_value
    join vortex_access.organization_role_revisions as current_value
      on current_value.organization_id = previous_value.organization_id
      and current_value.role_id = previous_value.role_id
      and current_value.revision = previous_value.revision + 1
    where previous_value.organization_id = '21000000-0000-4000-8000-000000000200'
      and previous_value.role_id = '51000000-0000-4000-8000-000000000201'
      and previous_value.revision = 7
  )
  and (
    select role #>> '{lifecycle}' = 'unavailable'
      and (role #>> '{liveRevision}')::bigint = 8
      and (role #>> '{source,acceptedRegistrationRevision}')::bigint = 4
      and (role #>> '{policyContinuityRevision}')::bigint = 2
      and (role #>> '{authorityContinuityRevision}')::bigint = 1
      and pg_catalog.jsonb_array_length(role -> 'permissions') = 0
      and role #>> '{createdByActorId}' =
        (select role #>> '{createdByActorId}' from application_create_result)
      and role #>> '{createdAt}' =
        (select role #>> '{createdAt}' from application_create_result)
      and created_activation_policy #>> '{fingerprint}' =
        'sha256:' || pg_catalog.repeat('a', 64)
      and access_version = 20
    from application_unavailable_policy_result
  ),
  'unavailable same-mode policy change preserves lifecycle, authority, source and original grant'
);

create temporary table application_retire_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation', 'retire_role',
    'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
    'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
    'expectedRoleRevision', 8
  )),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000208'
);

select results_eq(
  $$
    select role #>> '{lifecycle}',
      (role #>> '{liveRevision}')::bigint,
      (role #>> '{source,acceptedRegistrationRevision}')::bigint,
      access_version
    from application_retire_result
  $$,
  $$ values ('retired'::text, 9::bigint, 4::bigint, 21::bigint) $$,
  'retirement succeeds after source withdrawal and preserves accepted source provenance'
);

create temporary table standing_assignment_result as
select *
from vortex_access.coordinate_organization_role_assignment_change(
  'grant',
  '21000000-0000-4000-8000-000000000200',
  '63000000-0000-4000-8000-000000000200',
  null,
  '51000000-0000-4000-8000-000000000200',
  4,
  'organization_account',
  '42000000-0000-4000-8000-000000000200',
  null,
  'standing',
  pg_catalog.clock_timestamp(),
  null,
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000214'
);

select is(
  (select access_version from standing_assignment_result),
  22::bigint,
  'a real role-assignment grant establishes manifest evidence'
);

set constraints all immediate;
set constraints all deferred;

alter table vortex_access.organization_role_assignments
  disable trigger organization_role_assignments_validate_insert;
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, assignment_kind, revision, starts_at, expires_at,
  state, granted_by, granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
) values
  (
    '21000000-0000-4000-8000-000000000200',
    '63000000-0000-4000-8000-000000000201',
    '51000000-0000-4000-8000-000000000200', 'organization_account',
    '42000000-0000-4000-8000-000000000200', 'standing', 1,
    pg_catalog.statement_timestamp() + interval '1 hour',
    pg_catalog.statement_timestamp() + interval '2 hours', 'live',
    '91000000-0000-4000-8000-000000000200', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000215',
    '91000000-0000-4000-8000-000000000200', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000215'
  ),
  (
    '21000000-0000-4000-8000-000000000200',
    '63000000-0000-4000-8000-000000000202',
    '51000000-0000-4000-8000-000000000200', 'organization_account',
    '42000000-0000-4000-8000-000000000200', 'standing', 1,
    pg_catalog.statement_timestamp() - interval '2 hours',
    pg_catalog.statement_timestamp() - interval '1 hour', 'live',
    '91000000-0000-4000-8000-000000000200',
    pg_catalog.statement_timestamp() - interval '2 hours',
    '71000000-0000-4000-8000-000000000216',
    '91000000-0000-4000-8000-000000000200',
    pg_catalog.statement_timestamp() - interval '2 hours',
    '71000000-0000-4000-8000-000000000216'
  );
set constraints all immediate;
set constraints all deferred;
alter table vortex_access.organization_role_assignments
  enable trigger organization_role_assignments_validate_insert;

select is(
  pg_catalog.jsonb_array_length(
    pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200') ->
      'assignments'
  ),
  3,
  'the complete manifest includes active, scheduled and naturally expired live facts'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_catalog.jsonb_build_object(
          'operation', 'revise_metadata_policy',
          'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
          'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
          'expectedRoleRevision', 4,
          'key', 'custom_reader',
          'label', 'Custom records reader',
          'description', 'Metadata changed without refreshing accepted authority.',
          'privilegeClassification', 'standard',
          'assignmentPolicy', pg_catalog.jsonb_build_object(
            'kind', 'activation_required',
            'activationPolicy', pg_catalog.jsonb_build_object(
              'selection', 'new',
              'policy', pg_catalog.jsonb_build_object(
                'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
                'revision', 1,
                'maximumActivationDurationSeconds', 3600,
                'reasonRequired', true,
                'recentAuthentication', pg_catalog.jsonb_build_object(
                  'kind', 'primary', 'maximumAgeSeconds', 300
                ),
                'independentApprovalRequired', true
              )
            )
          )
        ),
        null,
        null,
        '4'
      ),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000217'
    )
  $$,
  '22023'::char(5),
  null,
  'policy mode change refuses an absent complete assignment manifest'
);

create temporary table activation_policy_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_metadata_policy',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
      'expectedRoleRevision', 4,
      'key', 'custom_reader',
      'label', 'Custom records reader',
      'description', 'Metadata changed without refreshing accepted authority.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'new',
          'policy', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
            'revision', 1,
            'maximumActivationDurationSeconds', 3600,
            'reasonRequired', true,
            'recentAuthentication', pg_catalog.jsonb_build_object(
              'kind', 'primary', 'maximumAgeSeconds', 300
            ),
            'independentApprovalRequired', true
          )
        )
      )
    ),
    null,
    pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200'),
    '4'
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000218'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      (role #>> '{policyContinuityRevision}')::bigint,
      (role #>> '{authorityContinuityRevision}')::bigint,
      role #>> '{assignmentPolicy,kind}',
      created_activation_policy #>> '{activationPolicyId}',
      (created_activation_policy #>> '{revision}')::bigint,
      created_activation_policy #>> '{changedByActorId}',
      created_activation_policy #>> '{changeCorrelationId}',
      (created_activation_policy ->> 'changedAt') = (role ->> 'changedAt'),
      access_version
    from activation_policy_result
  $$,
  $$ values (
    5::bigint, 2::bigint, 2::bigint, 'activation_required'::text,
    '53000000-0000-4000-8000-000000000200'::text, 1::bigint,
    '91000000-0000-4000-8000-000000000200'::text,
    '71000000-0000-4000-8000-000000000218'::text,
    true, 23::bigint
  ) $$,
  'new policy mode change binds the complete manifest, policy, role and Access result'
);

create temporary table standing_policy_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_metadata_policy',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
      'expectedRoleRevision', 5,
      'key', 'custom_reader',
      'label', 'Custom records reader',
      'description', 'Metadata changed without refreshing accepted authority.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
    ),
    null,
    pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200')
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000219'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      (role #>> '{policyContinuityRevision}')::bigint,
      role #>> '{assignmentPolicy,kind}', access_version
    from standing_policy_result
  $$,
  $$ values (6::bigint, 3::bigint, 'standing'::text, 24::bigint) $$,
  'standing policy restoration advances policy continuity without a policy reference'
);

create temporary table historical_policy_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_metadata_policy',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
      'expectedRoleRevision', 6,
      'key', 'custom_reader',
      'label', 'Custom records reader',
      'description', 'Metadata changed without refreshing accepted authority.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'existing',
          'reference', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
            'revision', 1,
            'fingerprint', 'sha256:' || pg_catalog.repeat('4', 64)
          )
        )
      )
    ),
    null,
    pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200')
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000220'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      (role #>> '{policyContinuityRevision}')::bigint,
      role #>> '{assignmentPolicy,activationPolicy,fingerprint}',
      created_activation_policy is null,
      access_version
    from historical_policy_result
  $$,
  $$ values (
    7::bigint, 4::bigint, ('sha256:' || repeat('4', 64))::text,
    true, 25::bigint
  ) $$,
  'explicit historical same-role policy selection survives policy ABA and creates no policy'
);

create temporary table successor_policy_result as
select *
from vortex_access.coordinate_organization_role_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation', 'revise_metadata_policy',
      'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
      'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
      'expectedRoleRevision', 7,
      'key', 'custom_reader',
      'label', 'Custom records reader',
      'description', 'Metadata changed without refreshing accepted authority.',
      'privilegeClassification', 'standard',
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'selection', 'new',
          'policy', pg_catalog.jsonb_build_object(
            'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
            'revision', 2,
            'maximumActivationDurationSeconds', 1800,
            'reasonRequired', false,
            'recentAuthentication', pg_catalog.jsonb_build_object(
              'kind', 'multi_factor', 'maximumAgeSeconds', 120
            ),
            'independentApprovalRequired', false
          )
        )
      )
    ),
    null,
    null,
    '5'
  ),
  '91000000-0000-4000-8000-000000000200',
  '71000000-0000-4000-8000-000000000221'
);

select results_eq(
  $$
    select (role #>> '{liveRevision}')::bigint,
      (role #>> '{policyContinuityRevision}')::bigint,
      created_activation_policy #>> '{fingerprint}',
      access_version
    from successor_policy_result
  $$,
  $$ values (
    8::bigint, 5::bigint, ('sha256:' || repeat('5', 64))::text, 26::bigint
  ) $$,
  'same-mode policy detail change creates the immediate successor without a manifest'
);

select is(
  (select role from successor_policy_result),
  (
    select pg_catalog.jsonb_build_object(
      'roleId', revision.role_id,
      'organizationId', revision.organization_id,
      'key', revision.role_key,
      'label', revision.label,
      'description', revision.description,
      'kind', revision.role_kind,
      'liveRevision', revision.revision,
      'privilegeClassification', revision.privilege_classification,
      'assignmentPolicy', pg_catalog.jsonb_build_object(
        'kind', 'activation_required',
        'activationPolicy', pg_catalog.jsonb_build_object(
          'activationPolicyId', revision.activation_policy_id,
          'revision', revision.activation_policy_revision,
          'fingerprint', revision.activation_policy_fingerprint
        )
      ),
      'policyContinuityRevision', revision.policy_continuity_revision,
      'authorityContinuityRevision', revision.authority_continuity_revision,
      'lifecycle', revision.lifecycle,
      'permissions', (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'kind', 'exact',
          'applicationRootId', permission.application_root_id,
          'ownerKind', permission.owner_kind,
          'ownerId', permission.owner_id,
          'permissionId', permission.permission_id,
          'acceptedRegistrationRevision', permission.accepted_registration_revision,
          'catalogueFingerprint', permission.catalogue_fingerprint,
          'continuityRevision', permission.continuity_revision,
          'meaningFingerprint', permission.meaning_fingerprint
        ) order by permission.entry_ordinal)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = revision.organization_id
          and permission.role_id = revision.role_id
          and permission.role_revision = revision.revision
      ),
      'createdByActorId', identity.created_by,
      'createdAt', identity.created_at,
      'changedByActorId', revision.changed_by,
      'changedAt', revision.changed_at,
      'changeCorrelationId', revision.change_correlation_id
    )
    from vortex_access.organization_roles as identity
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = identity.organization_id
      and revision.role_id = identity.role_id
      and revision.revision = identity.live_revision
    where identity.organization_id = '21000000-0000-4000-8000-000000000200'
      and identity.role_id = '51000000-0000-4000-8000-000000000200'
  ),
  'the complete returned Role JSON is assembled from the exact sealed current revision'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
        'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
        'expectedRoleRevision', 8,
        'key', 'custom_reader',
        'label', 'Custom records reader',
        'description', 'Metadata changed without refreshing accepted authority.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
              'revision', 2,
              'fingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
            )
          )
        )
      )),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000222'
    )
  $$,
  '40001'::char(5),
  null,
  'an exact same-state role request refuses without a revision or Access increment'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
        'roleId', '51000000-0000-4000-8000-000000000201'::uuid,
        'expectedRoleRevision', 9,
        'key', 'records_reader',
        'label', 'Cannot revive retired role',
        'description', 'Retired roles are terminal.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
      )),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000223'
    )
  $$,
  '40001'::char(5),
  null,
  'a retired role is terminal even for a metadata-only request'
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000200',
  '51000000-0000-4000-8000-000000000200',
  '53000000-0000-4000-8000-000000000200', 9007199254740991,
  'sha256:' || pg_catalog.repeat('9', 64), 900, false, 'none', null, false,
  '91000000-0000-4000-8000-000000000200', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000227'
);

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_catalog.jsonb_build_object(
          'operation', 'revise_metadata_policy',
          'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
          'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
          'expectedRoleRevision', 8,
          'key', 'custom_reader',
          'label', 'Policy exhaustion candidate',
          'description', 'A refused policy successor.',
          'privilegeClassification', 'standard',
          'assignmentPolicy', pg_catalog.jsonb_build_object(
            'kind', 'activation_required',
            'activationPolicy', pg_catalog.jsonb_build_object(
              'selection', 'new',
              'policy', pg_catalog.jsonb_build_object(
                'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
                'revision', 3,
                'maximumActivationDurationSeconds', 600,
                'reasonRequired', false,
                'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
                'independentApprovalRequired', false
              )
            )
          )
        ),
        null,
        null,
        '6'
      ),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000228'
    )
  $$,
  '22003'::char(5),
  null,
  'activation-policy revision exhaustion retains the distinct version error'
);

set local session_replication_role = replica;
delete from vortex_access.organization_role_activation_policy_revisions
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200'
  and activation_policy_id = '53000000-0000-4000-8000-000000000200'
  and revision = 9007199254740991;
set local session_replication_role = origin;

set local session_replication_role = replica;
update vortex_access.organization_role_revisions
set policy_continuity_revision = 9007199254740991
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200'
  and revision = 8;
set local session_replication_role = origin;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(
        pg_catalog.jsonb_build_object(
          'operation', 'revise_metadata_policy',
          'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
          'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
          'expectedRoleRevision', 8,
          'key', 'custom_reader',
          'label', 'Policy continuity exhaustion candidate',
          'description', 'A refused policy mode change.',
          'privilegeClassification', 'standard',
          'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
        ),
        null,
        pg_temp.assignment_manifest('51000000-0000-4000-8000-000000000200')
      ),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000229'
    )
  $$,
  '22003'::char(5),
  null,
  'policy-continuity exhaustion refuses the complete mode change atomically'
);

set local session_replication_role = replica;
update vortex_access.organization_role_revisions
set policy_continuity_revision = 5
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200'
  and revision = 8;
update vortex_access.organization_roles
set live_revision = 9007199254740991
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200';
set local session_replication_role = origin;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
        'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
        'expectedRoleRevision', 9007199254740991,
        'key', 'custom_reader',
        'label', 'Role revision exhaustion candidate',
        'description', 'A refused role successor.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing')
      )),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000230'
    )
  $$,
  '22003'::char(5),
  null,
  'role revision exhaustion retains the distinct version error'
);

set local session_replication_role = replica;
update vortex_access.organization_roles
set live_revision = 8
where organization_id = '21000000-0000-4000-8000-000000000200'
  and role_id = '51000000-0000-4000-8000-000000000200';
set local session_replication_role = origin;

select results_eq(
  $$
    select current_version, change_reason, change_correlation_id
    from vortex_access.organization_access_versions
    where organization_id = '21000000-0000-4000-8000-000000000200'
  $$,
  $$ values (
    26::bigint,
    'role_catalogue_changed'::text,
    '71000000-0000-4000-8000-000000000221'::uuid
  ) $$,
  'failed no-op and terminal requests leave the last successful Access evidence unchanged'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_revisions
    where organization_id = '21000000-0000-4000-8000-000000000200'
      and role_id = '51000000-0000-4000-8000-000000000201'
  ),
  9,
  'application acceptance and retirement each seal exactly one role revision'
);

set local session_replication_role = replica;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '21000000-0000-4000-8000-000000000200';
set local session_replication_role = origin;

select throws_ok(
  $$
    select * from vortex_access.coordinate_organization_role_change(
      pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '21000000-0000-4000-8000-000000000200'::uuid,
        'roleId', '51000000-0000-4000-8000-000000000200'::uuid,
        'expectedRoleRevision', 8,
        'key', 'custom_reader',
        'label', 'Access exhaustion candidate',
        'description', 'A refused atomic role change.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object(
          'kind', 'activation_required',
          'activationPolicy', pg_catalog.jsonb_build_object(
            'selection', 'existing',
            'reference', pg_catalog.jsonb_build_object(
              'activationPolicyId', '53000000-0000-4000-8000-000000000200'::uuid,
              'revision', 2,
              'fingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
            )
          )
        )
      )),
      '91000000-0000-4000-8000-000000000200',
      '71000000-0000-4000-8000-000000000231'
    )
  $$,
  '22003'::char(5),
  null,
  'Access exhaustion rolls back the sealed role successor'
);

select results_eq(
  $$
    select role.live_revision,
      (select pg_catalog.count(*)::bigint
       from vortex_access.organization_role_revisions as revision
       where revision.organization_id = role.organization_id
         and revision.role_id = role.role_id)
    from vortex_access.organization_roles as role
    where role.organization_id = '21000000-0000-4000-8000-000000000200'
      and role.role_id = '51000000-0000-4000-8000-000000000200'
  $$,
  $$ values (8::bigint, 8::bigint) $$,
  'Access exhaustion leaves no partial role revision or pointer change'
);

set constraints all immediate;

select * from finish();

rollback;
