\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_role_administration_context(
  p_identity_id uuid,
  p_organization_account_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  current_access_version bigint;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '23700000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83700000-0000-4000-8000-000000000001',
    'tenantId', '13700000-0000-4000-8000-000000000001',
    'organizationId', '23700000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '63700000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3700000-0000-4000-8000-000000000001'
  ));
end
$function$;

create function pg_temp.seed_template_application(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_definition_key text,
  p_current_revision bigint,
  p_current_state text,
  p_source_role_id uuid,
  p_current_label text,
  p_current_template_present boolean,
  p_include_removed_template boolean,
  p_fingerprint_character text
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  selected_revision bigint;
  selected_state text;
  selected_roles jsonb;
  selected_permissions jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
  removed_source_role_id uuid := '63700000-0000-4000-8000-000000000101';
begin
  if p_current_revision not in (1, 2)
    or p_current_state not in ('active', 'withdrawn')
    or p_current_state = 'withdrawn' and p_current_revision <> 2 then
    raise exception using errcode = '22023', message = 'Test application input is invalid';
  end if;

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    p_application_root_id, p_organization_id, 'application', p_definition_key,
    operation_at, '93700000-0000-4000-8000-000000000001'
  );

  for selected_revision in 1..p_current_revision loop
    selected_state := case when selected_revision = p_current_revision
      then p_current_state else 'active' end;
    selected_permissions := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', 'application',
        'ownerId', p_application_root_id,
        'permissionId', '53700000-0000-4000-8000-000000000100'::uuid,
        'key', 'example.records.read', 'label', 'Read records',
        'description', 'Read application records.',
        'actionKind', 'read', 'administrative', false,
        'meaningFingerprint', 'sha256:' || pg_catalog.repeat('4', 64)
      )
    );
    if selected_revision = 2 and selected_state = 'active' then
      selected_permissions := selected_permissions || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'applicationRootId', p_application_root_id,
          'ownerKind', 'application',
          'ownerId', p_application_root_id,
          'permissionId', '53700000-0000-4000-8000-000000000102'::uuid,
          'key', 'example.records.update', 'label', 'Update records',
          'description', 'Update application records.',
          'actionKind', 'update', 'administrative', false,
          'meaningFingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
        )
      );
    end if;

    selected_roles := '[]'::jsonb;
    if selected_revision < p_current_revision or p_current_template_present then
      selected_roles := selected_roles || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'roleId', p_source_role_id,
          'key', 'records_reader',
          'name', case when selected_revision = p_current_revision
            then p_current_label else 'Historical records reader' end,
          'homePageId', '73700000-0000-4000-8000-000000000100'::uuid,
          'permissionKeys', case when selected_revision = 2
            then pg_catalog.jsonb_build_array(
              'example.records.read', 'example.records.update'
            )
            else pg_catalog.jsonb_build_array('example.records.read')
          end,
          'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
        )
      );
    end if;
    if selected_revision = 1 and p_include_removed_template then
      selected_roles := selected_roles || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'roleId', removed_source_role_id,
          'key', 'removed_reader', 'name', 'Removed reader',
          'homePageId', '73700000-0000-4000-8000-000000000101'::uuid,
          'permissionKeys', pg_catalog.jsonb_build_array('example.records.read'),
          'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
        )
      );
    end if;

    insert into vortex_definition.releases (
      root_id, release_revision, release_version, authored_source,
      authored_source_fingerprint, source_contract_version, compilation_output,
      resolution_snapshot, content_fingerprint, resolution_fingerprint,
      validation_contract_version, comparison_fingerprint, impact_reasons,
      release_note, published_at, published_by
    ) values (
      p_application_root_id, selected_revision,
      case when selected_revision = 1 then '1.0.0' else '1.1.0' end,
      pg_catalog.jsonb_build_object(
        'source_contract_version', '1.0.0', 'kind', 'application',
        'key', p_definition_key, 'body', pg_catalog.jsonb_build_object()
      ),
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64), '1.0.0',
      pg_catalog.jsonb_build_object(
        'kind', 'application',
        'canonical', pg_catalog.jsonb_build_object(
          'content', pg_catalog.jsonb_build_object(
            'permissions', selected_permissions,
            'roles', selected_roles
          )
        )
      ),
      pg_catalog.jsonb_build_object(
        'fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
      ),
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('6', 64), '2.18.0',
      'sha256:' || pg_catalog.repeat('7', 64), '[]'::jsonb,
      'Role administration fixture release', operation_at,
      '93700000-0000-4000-8000-000000000001'
    );

    insert into vortex_access.permission_registration_revisions (
      organization_id, registration_kind, registration_owner_id, revision,
      state, operation, source_definition_key, source_version, source_revision,
      validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, permission_catalogue_fingerprint,
      candidate_fingerprint, changed_at, changed_by, change_correlation_id
    ) values (
      p_organization_id, 'application', p_application_root_id, selected_revision,
      selected_state,
      case when selected_revision = 1 then 'register'
        when selected_state = 'withdrawn' then 'withdraw' else 'update' end,
      p_definition_key,
      case when selected_revision = 1 then '1.0.0' else '1.1.0' end,
      selected_revision, '2.18.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('6', 64),
      'sha256:' || pg_catalog.repeat('8', 64),
      'sha256:' || pg_catalog.repeat('9', 64), operation_at,
      '93700000-0000-4000-8000-000000000001',
      'a3700000-0000-4000-8000-000000000010'
    );

    if selected_state = 'active' then
      insert into vortex_access.permission_catalogue_entries (
        organization_id, registration_kind, registration_owner_id,
        registration_revision, application_root_id, owner_kind, owner_id,
        permission_id, permission_key, label, description, record_type_id,
        action_kind, named_action, administrative, source_kind,
        source_definition_key, source_root_id, source_version, source_revision,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_catalogue_fingerprint,
        meaning_fingerprint
      ) values (
        p_organization_id, 'application', p_application_root_id,
        selected_revision, p_application_root_id, 'application',
        p_application_root_id, '53700000-0000-4000-8000-000000000100',
        'example.records.read',
        case when selected_revision = 1 then 'Historical read records'
          else 'Current read records' end,
        'Read application records.', null, 'read', null, false,
        'application', p_definition_key, p_application_root_id,
        case when selected_revision = 1 then '1.0.0' else '1.1.0' end,
        selected_revision, '2.18.0',
        'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
        'sha256:' || pg_catalog.repeat('6', 64), null,
        'sha256:' || pg_catalog.repeat('4', 64)
      );
      if selected_revision = 2 then
        insert into vortex_access.permission_catalogue_entries (
          organization_id, registration_kind, registration_owner_id,
          registration_revision, application_root_id, owner_kind, owner_id,
          permission_id, permission_key, label, description, record_type_id,
          action_kind, named_action, administrative, source_kind,
          source_definition_key, source_root_id, source_version, source_revision,
          source_validation_contract_version, source_content_fingerprint,
          source_resolution_fingerprint, source_catalogue_fingerprint,
          meaning_fingerprint
        ) values (
          p_organization_id, 'application', p_application_root_id,
          selected_revision, p_application_root_id, 'application',
          p_application_root_id, '53700000-0000-4000-8000-000000000102',
          'example.records.update', 'Update records',
          'Update application records.', null, 'update', null, false,
          'application', p_definition_key, p_application_root_id,
          '1.1.0', selected_revision, '2.18.0',
          'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
          'sha256:' || pg_catalog.repeat('6', 64), null,
          'sha256:' || pg_catalog.repeat('5', 64)
        );
      end if;
    end if;
  end loop;

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, p_current_state,
    p_current_revision, p_definition_key,
    case when p_current_revision = 1 then '1.0.0' else '1.1.0' end,
    p_current_revision, '2.18.0',
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('8', 64),
    'sha256:' || pg_catalog.repeat('9', 64), operation_at,
    '93700000-0000-4000-8000-000000000001',
    'a3700000-0000-4000-8000-000000000010'
  );

  insert into vortex_access.permission_continuities (
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    p_organization_id, p_application_root_id, 'application',
    p_application_root_id, '53700000-0000-4000-8000-000000000100',
    'application', p_application_root_id,
    case when p_current_state = 'active' then 'available' else 'unavailable' end,
    case when p_current_state = 'active' then 1 else 2 end,
    'sha256:' || pg_catalog.repeat('4', 64), p_current_revision, operation_at
  );
  if p_current_revision = 2 and p_current_state = 'active' then
    insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id, state,
      continuity_revision, meaning_fingerprint,
      last_processed_registration_revision, changed_at
    ) values (
      p_organization_id, p_application_root_id, 'application',
      p_application_root_id, '53700000-0000-4000-8000-000000000102',
      'application', p_application_root_id, 'available', 1,
      'sha256:' || pg_catalog.repeat('5', 64), p_current_revision, operation_at
    );
  end if;

  insert into vortex_access.application_role_template_continuities (
    organization_id, application_root_id, source_role_id, state,
    continuity_revision, source_template_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    p_organization_id, p_application_root_id, p_source_role_id,
    case when p_current_state = 'active' and p_current_template_present
      then 'available' else 'unavailable' end,
    case when p_current_state = 'active' and p_current_template_present
      then 1 else 2 end,
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    p_current_revision, operation_at
  );
  if p_include_removed_template then
    insert into vortex_access.application_role_template_continuities (
      organization_id, application_root_id, source_role_id, state,
      continuity_revision, source_template_fingerprint,
      last_processed_registration_revision, changed_at
    ) values (
      p_organization_id, p_application_root_id, removed_source_role_id,
      'unavailable', 2, 'sha256:' || pg_catalog.repeat('b', 64),
      p_current_revision, operation_at
    );
  end if;
end
$function$;

select has_function(
  'vortex_access', 'list_organization_roles_for_administration',
  array['uuid', 'integer'],
  'Access exposes one bounded protected local-role list'
);
select has_function(
  'vortex_access', 'read_organization_role_for_administration',
  array['uuid'],
  'Access exposes one exact protected local-role detail'
);
select has_function(
  'vortex_access', 'list_application_role_templates_for_administration',
  array['uuid', 'uuid', 'integer'],
  'Access exposes a separately keyed registered-template list'
);
select has_function(
  'vortex_access', 'read_application_role_template_for_administration',
  array['uuid', 'uuid'],
  'Access exposes one exact registered-template detail'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_roles_for_administration(uuid,integer)', 'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_role_for_administration(uuid)', 'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_application_role_templates_for_administration(uuid,uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_application_role_template_for_administration(uuid,uuid)', 'EXECUTE'
  ),
  'request role can execute the four safe role catalogue reads'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_roles_for_administration(uuid,integer)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.read_organization_role_for_administration(uuid)', 'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_application_role_templates_for_administration(uuid,uuid,integer)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.read_application_role_template_for_administration(uuid,uuid)', 'EXECUTE'
  ),
  caller.role_name || ' cannot execute protected role catalogue reads'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.organization_roles_administration_scope()', 'EXECUTE'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.organization_roles', 'SELECT'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_definition.releases', 'SELECT'
  ),
  'request role cannot bypass the fixed decision or safe projections'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13700000-0000-4000-8000-000000000001', 'role_administration',
  'Role administration', 'active', pg_catalog.statement_timestamp(),
  '93700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23700000-0000-4000-8000-000000000001',
    '13700000-0000-4000-8000-000000000001', 'role_administration',
    'Role administration', 'active', pg_catalog.statement_timestamp(),
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '23700000-0000-4000-8000-000000000002',
    '13700000-0000-4000-8000-000000000001', 'foreign_roles',
    'Foreign roles', 'active', pg_catalog.statement_timestamp(),
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43700000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '93700000-0000-4000-8000-000000000001',
    'a3700000-0000-4000-8000-000000000002', 1
  ),
  (
    '43700000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '93700000-0000-4000-8000-000000000001',
    'a3700000-0000-4000-8000-000000000003', 1
  );
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '53700000-0000-4000-8000-000000000010',
    '23700000-0000-4000-8000-000000000001',
    '43700000-0000-4000-8000-000000000001', 'Role steward', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '93700000-0000-4000-8000-000000000001',
    'a3700000-0000-4000-8000-000000000004', 1
  ),
  (
    '53700000-0000-4000-8000-000000000020',
    '23700000-0000-4000-8000-000000000001',
    '43700000-0000-4000-8000-000000000002', 'No role authority', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '93700000-0000-4000-8000-000000000001',
    'a3700000-0000-4000-8000-000000000005', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '23700000-0000-4000-8000-000000000001',
  '93700000-0000-4000-8000-000000000001',
  'a3700000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_organization_access_version(
  '23700000-0000-4000-8000-000000000002',
  '93700000-0000-4000-8000-000000000001',
  'a3700000-0000-4000-8000-000000000007'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '23700000-0000-4000-8000-000000000001',
  '93700000-0000-4000-8000-000000000001',
  'a3700000-0000-4000-8000-000000000008'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '23700000-0000-4000-8000-000000000002',
  '93700000-0000-4000-8000-000000000001',
  'a3700000-0000-4000-8000-000000000009'
);
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id, state,
  continuity_revision, meaning_fingerprint,
  last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id,
  entry.permission_id, 'platform', entry.registration_owner_id,
  'available', 1, entry.meaning_fingerprint, entry.registration_revision,
  pg_catalog.statement_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id in (
    '23700000-0000-4000-8000-000000000001',
    '23700000-0000-4000-8000-000000000002'
  )
  and entry.registration_kind = 'platform';

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '23700000-0000-4000-8000-000000000001',
  '53700000-0000-4000-8000-000000000010',
  '63700000-0000-4000-8000-000000000001',
  'role_administration_steward', 'Role administration steward',
  'Minimum authority for the protected role catalogue fixture.',
  '73700000-0000-4000-8000-000000000001',
  '83700000-0000-4000-8000-000000000001',
  '93700000-0000-4000-8000-000000000001',
  'a3700000-0000-4000-8000-000000000011'
);

select pg_temp.seed_template_application(
  '23700000-0000-4000-8000-000000000001',
  '33700000-0000-4000-8000-000000000001',
  'example.role_administration_one', 2, 'active',
  '63700000-0000-4000-8000-000000000100',
  'Current records reader', true, true, '1'
);
select pg_temp.seed_template_application(
  '23700000-0000-4000-8000-000000000001',
  '33700000-0000-4000-8000-000000000002',
  'example.role_administration_two', 1, 'active',
  '63700000-0000-4000-8000-000000000100',
  'Second application reader', true, false, '2'
);
select pg_temp.seed_template_application(
  '23700000-0000-4000-8000-000000000001',
  '33700000-0000-4000-8000-000000000003',
  'example.role_administration_withdrawn', 2, 'withdrawn',
  '63700000-0000-4000-8000-000000000103',
  'Withdrawn reader', false, false, '3'
);
select pg_temp.seed_template_application(
  '23700000-0000-4000-8000-000000000002',
  '33700000-0000-4000-8000-000000000004',
  'example.role_administration_foreign', 1, 'active',
  '63700000-0000-4000-8000-000000000104',
  'Foreign reader', true, false, '4'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000110', 'application',
    'pending_reader', '33700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000100', 2,
    '93700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000111', 'application',
    'unavailable_reader', '33700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000101', 2,
    '93700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000112', 'custom',
    'retired_reviewer', null, null, 2,
    '93700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  ),
  (
    '23700000-0000-4000-8000-000000000002',
    '63700000-0000-4000-8000-000000000120', 'custom',
    'foreign_reviewer', null, null, 1,
    '93700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp()
  );

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision,
  policy_fingerprint, maximum_activation_duration_seconds,
  reason_required, authentication_requirement,
  authentication_maximum_age_seconds, independent_approval_required,
  changed_by, changed_at, change_correlation_id
) values (
  '23700000-0000-4000-8000-000000000001',
  '63700000-0000-4000-8000-000000000110',
  '64700000-0000-4000-8000-000000000110', 1,
  'sha256:' || pg_catalog.repeat('c', 64), 3600, true,
  'multi_factor', 900, true,
  '93700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000012'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select fixture.organization_id, fixture.role_id, fixture.role_revision, 1,
  fixture.role_kind, fixture.role_application_root_id,
  fixture.application_root_id, fixture.owner_kind, fixture.owner_id,
  fixture.permission_id, fixture.registration_kind,
  fixture.registration_owner_id, fixture.accepted_registration_revision,
  registration.permission_catalogue_fingerprint,
  fixture.continuity_revision, catalogue.meaning_fingerprint
from (values
  (
    '23700000-0000-4000-8000-000000000001'::uuid,
    '63700000-0000-4000-8000-000000000110'::uuid, 1::bigint,
    'application'::text, '33700000-0000-4000-8000-000000000001'::uuid,
    '33700000-0000-4000-8000-000000000001'::uuid, 'application'::text,
    '33700000-0000-4000-8000-000000000001'::uuid,
    '53700000-0000-4000-8000-000000000100'::uuid, 'application'::text,
    '33700000-0000-4000-8000-000000000001'::uuid, 1::bigint, 1::bigint
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000110', 2,
    'application', '33700000-0000-4000-8000-000000000001',
    '33700000-0000-4000-8000-000000000001', 'application',
    '33700000-0000-4000-8000-000000000001',
    '53700000-0000-4000-8000-000000000100', 'application',
    '33700000-0000-4000-8000-000000000001', 1, 1
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000111', 1,
    'application', '33700000-0000-4000-8000-000000000001',
    '33700000-0000-4000-8000-000000000001', 'application',
    '33700000-0000-4000-8000-000000000001',
    '53700000-0000-4000-8000-000000000100', 'application',
    '33700000-0000-4000-8000-000000000001', 1, 1
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000112', 1,
    'custom', null, null, 'platform',
    'cabe121e-0baf-4084-9471-cce915d460a8',
    'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2', 'platform',
    'cabe121e-0baf-4084-9471-cce915d460a8', 1, 1
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000112', 2,
    'custom', null, null, 'platform',
    'cabe121e-0baf-4084-9471-cce915d460a8',
    'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2', 'platform',
    'cabe121e-0baf-4084-9471-cce915d460a8', 1, 1
  ),
  (
    '23700000-0000-4000-8000-000000000002',
    '63700000-0000-4000-8000-000000000120', 1,
    'custom', null, null, 'platform',
    'cabe121e-0baf-4084-9471-cce915d460a8',
    'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2', 'platform',
    'cabe121e-0baf-4084-9471-cce915d460a8', 1, 1
  )
) as fixture(
  organization_id, role_id, role_revision, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, continuity_revision
)
join vortex_access.permission_catalogue_entries as catalogue
  on catalogue.organization_id = fixture.organization_id
  and catalogue.registration_kind = fixture.registration_kind
  and catalogue.registration_owner_id = fixture.registration_owner_id
  and catalogue.registration_revision = fixture.accepted_registration_revision
  and catalogue.owner_kind = fixture.owner_kind
  and catalogue.owner_id = fixture.owner_id
  and catalogue.permission_id = fixture.permission_id
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = fixture.organization_id
  and registration.registration_kind = fixture.registration_kind
  and registration.registration_owner_id = fixture.registration_owner_id
  and registration.revision = fixture.accepted_registration_revision;

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
) values
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000110', 1, 'application',
    '33700000-0000-4000-8000-000000000001', 'active', 'privileged',
    'activation_required', 1, 1,
    '64700000-0000-4000-8000-000000000110', 1,
    'sha256:' || pg_catalog.repeat('c', 64),
    'pending_reader', 'Historical pending reader', 'Historical accepted role.',
    'example.role_administration_one', 1, '1.0.0', '2.18.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('d', 64),
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000013'
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000110', 2, 'application',
    '33700000-0000-4000-8000-000000000001', 'acceptance_required', 'privileged',
    'activation_required', 1, 1,
    '64700000-0000-4000-8000-000000000110', 1,
    'sha256:' || pg_catalog.repeat('c', 64),
    'pending_reader', 'Pending records reader', 'Retains one accepted permission.',
    'example.role_administration_one', 1, '1.0.0', '2.18.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('d', 64),
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000014'
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000111', 1, 'application',
    '33700000-0000-4000-8000-000000000001', 'active', 'standard',
    'standing', 1, 1, null, null, null,
    'unavailable_reader', 'Removed reader', 'Previously accepted role.',
    'example.role_administration_one', 1, '1.0.0', '2.18.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('e', 64),
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000015'
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000111', 2, 'application',
    '33700000-0000-4000-8000-000000000001', 'unavailable', 'standard',
    'standing', 1, 1, null, null, null,
    'unavailable_reader', 'Unavailable reader', 'The source template was removed.',
    'example.role_administration_one', 1, '1.0.0', '2.18.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('6', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('8', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('e', 64),
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000016'
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000112', 1, 'custom', null,
    'active', 'privileged', 'standing', 1, 1, null, null, null,
    'retired_reviewer', 'Reviewer', 'Review selected records.',
    null, null, null, null, null, null, null, null, null, null, null,
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000017'
  ),
  (
    '23700000-0000-4000-8000-000000000001',
    '63700000-0000-4000-8000-000000000112', 2, 'custom', null,
    'retired', 'privileged', 'standing', 1, 1, null, null, null,
    'retired_reviewer', 'Retired reviewer', 'Retains accepted configuration only.',
    null, null, null, null, null, null, null, null, null, null, null,
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000018'
  ),
  (
    '23700000-0000-4000-8000-000000000002',
    '63700000-0000-4000-8000-000000000120', 1, 'custom', null,
    'active', 'privileged', 'standing', 1, 1, null, null, null,
    'foreign_reviewer', 'Foreign reviewer', 'Foreign accepted role.',
    null, null, null, null, null, null, null, null, null, null, null,
    '93700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 'a3700000-0000-4000-8000-000000000019'
  );

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_request;
select pg_temp.install_role_administration_context(
  '43700000-0000-4000-8000-000000000001',
  '53700000-0000-4000-8000-000000000010'
);
set local role vortex_request;

select results_eq(
  $$
    select roles #>> '{0,roleId}', roles #>> '{1,roleId}',
      next_after_role_id, access_version
    from vortex_access.list_organization_roles_for_administration(null, 2)
  $$,
  $$values (
    '63700000-0000-4000-8000-000000000001'::text,
    '63700000-0000-4000-8000-000000000110'::text,
    '63700000-0000-4000-8000-000000000110'::uuid, 3::bigint
  )$$,
  'local roles use stable identity ordering and a complete bounded cursor'
);
select results_eq(
  $$
    select roles #>> '{0,lifecycle}', roles #>> '{1,lifecycle}',
      next_after_role_id
    from vortex_access.list_organization_roles_for_administration(
      '63700000-0000-4000-8000-000000000110', 2
    )
  $$,
  $$values ('unavailable'::text, 'retired'::text, null::uuid)$$,
  'current unavailable and retired roles remain visible without history rows'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.list_organization_roles_for_administration(null, 100) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.roles) as item
    where item ->> 'label' = 'Historical pending reader'
  ),
  0::bigint,
  'the role page uses only each permanent identity current revision pointer'
);
select is(
  (
    select outcome || '|' || (role_summary ->> 'lifecycle') || '|' ||
      (role_summary ->> 'acceptedPermissionCount') || '|' ||
      (role_summary #>> '{assignmentPolicy,kind}') || '|' ||
      (role_summary #>> '{assignmentPolicy,maximumActivationDurationSeconds}') || '|' ||
      (role_summary #>> '{assignmentPolicy,recentAuthentication,kind}') || '|' ||
      (role_summary #>> '{source,applicationRootId}')
    from vortex_access.read_organization_role_for_administration(
      '63700000-0000-4000-8000-000000000110'
    )
  ),
  'available|acceptance_required|1|activation_required|3600|multi_factor|33700000-0000-4000-8000-000000000001',
  'pending application role returns retained accepted configuration and safe policy settings'
);
select is(
  (
    select (role_summary #>> '{acceptedPermissions,0,label}') || '|' ||
      (role_summary #>> '{acceptedPermissions,0,key}') || '|' ||
      pg_catalog.jsonb_array_length(role_summary -> 'acceptedPermissions')::text
    from vortex_access.read_organization_role_for_administration(
      '63700000-0000-4000-8000-000000000110'
    )
  ),
  'Historical read records|example.records.read|1',
  'accepted permissions are the stored accepted snapshot, not pending additions'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_organization_role_for_administration(
      '63700000-0000-4000-8000-000000000110'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.role_summary) as key
  ),
  '{acceptedPermissionCount,acceptedPermissions,assignmentPolicy,description,key,label,lifecycle,liveRevision,privilegeClassification,roleId,roleKind,source}',
  'role detail omits effective access, assignments, fingerprints, continuity and audit'
);
select is(
  (
    select (role_summary ->> 'lifecycle') || '|' ||
      (role_summary ->> 'acceptedPermissionCount') || '|' ||
      (role_summary ? 'effective')::text
    from vortex_access.read_organization_role_for_administration(
      '63700000-0000-4000-8000-000000000112'
    )
  ),
  'retired|1|false',
  'retired role preserves accepted configuration without claiming current use'
);
select results_eq(
  $$
    select outcome, role_summary, access_version
    from vortex_access.read_organization_role_for_administration(
      '63700000-0000-4000-8000-000000000120'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb, 3::bigint)$$,
  'a foreign local role is unavailable without leaking its existence'
);

select results_eq(
  $$
    select templates #>> '{0,reference,applicationRootId}',
      templates #>> '{0,reference,sourceRoleId}',
      next_after_application_root_id, next_after_source_role_id
    from vortex_access.list_application_role_templates_for_administration(
      null, null, 1
    )
  $$,
  $$values (
    '33700000-0000-4000-8000-000000000001'::text,
    '63700000-0000-4000-8000-000000000100'::text,
    '33700000-0000-4000-8000-000000000001'::uuid,
    '63700000-0000-4000-8000-000000000100'::uuid
  )$$,
  'registered templates use the complete application and source-role cursor'
);
select results_eq(
  $$
    select templates #>> '{0,reference,applicationRootId}',
      templates #>> '{0,reference,sourceRoleId}',
      next_after_application_root_id
    from vortex_access.list_application_role_templates_for_administration(
      '33700000-0000-4000-8000-000000000001',
      '63700000-0000-4000-8000-000000000100', 1
    )
  $$,
  $$values (
    '33700000-0000-4000-8000-000000000002'::text,
    '63700000-0000-4000-8000-000000000100'::text,
    null::uuid
  )$$,
  'the same source role in a second application remains a distinct template'
);
select is(
  (
    select outcome || '|' || (template_summary ->> 'label') || '|' ||
      (template_summary ->> 'permissionSelectionKind') || '|' ||
      pg_catalog.jsonb_array_length(template_summary -> 'publishedPermissionKeys')::text
    from vortex_access.read_application_role_template_for_administration(
      '33700000-0000-4000-8000-000000000001',
      '63700000-0000-4000-8000-000000000100'
    )
  ),
  'available|Current records reader|exact|2',
  'template detail uses the exact release selected by the active current registration'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_application_role_template_for_administration(
      '33700000-0000-4000-8000-000000000001',
      '63700000-0000-4000-8000-000000000100'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.template_summary) as key
  ),
  '{key,label,permissionSelectionKind,publishedPermissionKeys,reference}',
  'template detail omits home page, fingerprints, provenance and inferred local-role links'
);
select results_eq(
  $$
    select outcome, template_summary
    from vortex_access.read_application_role_template_for_administration(
      '33700000-0000-4000-8000-000000000001',
      '63700000-0000-4000-8000-000000000101'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb)$$,
  'a template removed from the registered current release is unavailable'
);
select results_eq(
  $$
    select outcome, template_summary
    from vortex_access.read_application_role_template_for_administration(
      '33700000-0000-4000-8000-000000000003',
      '63700000-0000-4000-8000-000000000103'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb)$$,
  'a withdrawn application registration exposes no role template'
);
select results_eq(
  $$
    select outcome, template_summary
    from vortex_access.read_application_role_template_for_administration(
      '33700000-0000-4000-8000-000000000004',
      '63700000-0000-4000-8000-000000000104'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb)$$,
  'a foreign registered template is unavailable without leaking its existence'
);
select throws_ok(
  $$select * from vortex_access.list_organization_roles_for_administration(
    '00000000-0000-0000-0000-000000000000', 10
  )$$,
  '22023', 'Organization role page input is invalid',
  'nil local-role cursor refuses before storage reads'
);
select throws_ok(
  $$select * from vortex_access.list_application_role_templates_for_administration(
    '33700000-0000-4000-8000-000000000001', null, 10
  )$$,
  '22023', 'Application role template page input is invalid',
  'partial template cursor refuses before storage reads'
);
select throws_ok(
  $$select * from vortex_access.read_application_role_template_for_administration(
    null, '63700000-0000-4000-8000-000000000100'
  )$$,
  '22023', 'Application role template detail input is invalid',
  'incomplete template detail reference refuses closed'
);

reset role;
select pg_temp.install_role_administration_context(
  '43700000-0000-4000-8000-000000000002',
  '53700000-0000-4000-8000-000000000020'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_roles_for_administration(null, 10)$$,
  '42501', 'Organization role catalogue is unavailable',
  'an account without roles-read cannot list local roles'
);
select throws_ok(
  $$select * from vortex_access.list_application_role_templates_for_administration(
    null, null, 10
  )$$,
  '42501', 'Organization role catalogue is unavailable',
  'an account without roles-read cannot list application templates'
);

reset role;
set constraints all immediate;
select * from finish();
rollback;
