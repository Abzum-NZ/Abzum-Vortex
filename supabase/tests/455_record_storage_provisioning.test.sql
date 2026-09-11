\ir helpers/definition-release-writer.psql

begin;
select plan(43);

set local search_path = pg_catalog, extensions, public;

create function pg_temp.storage_field(
  p_field_id uuid,
  p_type text,
  p_required boolean default false,
  p_unique boolean default false,
  p_filterable boolean default false,
  p_sortable boolean default false
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field_id,
    'type', p_type,
    'required', p_required,
    'unique', p_unique,
    'filterable', p_filterable,
    'sortable', p_sortable,
    'settings', '{}'::jsonb
  )
$function$;

-- Canonical content of the storage-test Module releases. The writer builds
-- the rest of each compilation output from the release it appends.
create function pg_temp.module_content(p_revision bigint)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordTypeId', '54550000-0000-4000-8000-000000000001',
        'storageContractId', '64550000-0000-4000-8000-000000000001',
        'storageScope', 'organization_shared',
        'ownershipMode', 'group',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.storage_field(
            '74550000-0000-4000-8000-000000000001', 'text', true, true, true, true
          )
        ) || case when p_revision >= 2 then pg_catalog.jsonb_build_array(
          pg_temp.storage_field(
            '74550000-0000-4000-8000-000000000003', 'whole_number', false,
            false, true, true
          )
        ) else '[]'::jsonb end || case when p_revision >= 3 then pg_catalog.jsonb_build_array(
          pg_temp.storage_field(
            '74550000-0000-4000-8000-000000000004', 'long_text', false
          )
        ) else '[]'::jsonb end,
        'relationships', '[]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'recordTypeId', '54550000-0000-4000-8000-000000000002',
        'storageContractId', '64550000-0000-4000-8000-000000000002',
        'storageScope', 'application_contained',
        'ownershipMode', 'group',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.storage_field(
            '74550000-0000-4000-8000-000000000002', 'link', false
          )
        ),
        'relationships', case when p_revision < 3 then pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', '84550000-0000-4000-8000-000000000001',
            'fromFieldId', '74550000-0000-4000-8000-000000000002',
            'toRecordType', pg_catalog.jsonb_build_object(
              'recordTypeId', '54550000-0000-4000-8000-000000000001'
            ),
            'cardinality', 'many_to_one',
            'onParentDelete', 'refuse'
          )
        ) else '[]'::jsonb end
      )
    )
  )
$function$;

create function pg_temp.newer_first_module_content(p_revision bigint)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordTypeId', '54550000-0000-4000-8000-000000000003',
        'storageContractId', '64550000-0000-4000-8000-000000000003',
        'storageScope', 'organization_shared',
        'ownershipMode', 'group',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.storage_field(
            '74550000-0000-4000-8000-000000000005', 'text', true
          )
        ) || case when p_revision >= 2 then pg_catalog.jsonb_build_array(
          pg_temp.storage_field(
            '74550000-0000-4000-8000-000000000006', 'whole_number', false
          )
        ) else '[]'::jsonb end,
        'relationships', '[]'::jsonb
      )
    )
  )
$function$;

create function pg_temp.single_record_type(
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_field_id uuid
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id,
    'storageContractId', p_storage_contract_id,
    'storageScope', 'organization_shared',
    'ownershipMode', 'group',
    'fields', pg_catalog.jsonb_build_array(
      pg_temp.storage_field(p_field_id, 'text', true)
    ),
    'relationships', '[]'::jsonb
  )
$function$;

create function pg_temp.storage_rule_graph(p_record_type_id uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'ruleId', 'b4550000-0000-4000-8000-000000000001',
    'key', 'storage_test_rule',
    'subjectRecordTypeId', p_record_type_id,
    'profile', 'before_save',
    'graphVersion', '1.0.0',
    'priority', 0,
    'inputs', '[]'::jsonb,
    'variables', '[]'::jsonb,
    'nodes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'nodeId', 'b4550000-0000-4000-8000-000000000002',
        'nodeVersion', '1.0.0',
        'type', 'start',
        'operations', pg_catalog.jsonb_build_array('create', 'update')
      ),
      pg_catalog.jsonb_build_object(
        'nodeId', 'b4550000-0000-4000-8000-000000000003',
        'nodeVersion', '1.0.0',
        'type', 'finish'
      )
    ),
    'edges', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'fromNodeId', 'b4550000-0000-4000-8000-000000000002',
      'port', 'next',
      'toNodeId', 'b4550000-0000-4000-8000-000000000003'
    ))
  )
$function$;

create function pg_temp.versioned_module_output(
  p_root_id uuid,
  p_validation_contract_version text,
  p_record_type jsonb,
  p_rules jsonb default null
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'kind', 'module',
    'validationContractVersion', p_validation_contract_version,
    'canonical', pg_catalog.jsonb_build_object(
      'envelope', pg_catalog.jsonb_build_object('rootId', p_root_id),
      'content', pg_catalog.jsonb_build_object(
        'recordTypes', pg_catalog.jsonb_build_array(p_record_type)
      ) || case
        when p_rules is null then '{}'::jsonb
        else pg_catalog.jsonb_build_object('rules', p_rules)
      end
    )
  )
$function$;

create function pg_temp.refused_module_output()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_temp.versioned_module_output(
    '44550000-0000-4000-8000-000000000005', '3.0.0',
    pg_temp.single_record_type(
      '54550000-0000-4000-8000-000000000006',
      '64550000-0000-4000-8000-000000000006',
      '74550000-0000-4000-8000-000000000009'
    ),
    pg_catalog.jsonb_build_array(
      pg_temp.storage_rule_graph('54550000-0000-4000-8000-000000000006')
    )
  )
$function$;

create function pg_temp.initialize_storage_context(
  p_organization_id uuid default '24550000-0000-4000-8000-000000000001',
  p_organization_account_id uuid default '54550000-0000-4000-8000-000000000010',
  p_identity_id uuid default '44550000-0000-4000-8000-000000000010',
  p_application_root_id uuid default null,
  p_access_version bigint default null
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  selected_access_version bigint;
  request_context jsonb;
begin
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  selected_access_version := p_access_version;
  if selected_access_version is null then
    select version.current_version into strict selected_access_version
    from vortex_access.organization_access_versions as version
    where version.organization_id = p_organization_id;
  end if;
  request_context := pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '94550000-0000-4000-8000-000000000001',
    'tenantId', '14550000-0000-4000-8000-000000000001',
    'organizationId', p_organization_id,
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '64550000-0000-4000-8000-000000000010',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', selected_access_version,
    'correlationId', 'a4550000-0000-4000-8000-000000000001',
    'accessTokenIssuedAt', operation_at,
    'primaryAuthenticatedAt', operation_at
  );
  if p_application_root_id is not null then
    request_context := request_context || pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id
    );
  end if;
  perform vortex_context.initialize(request_context);
end
$function$;

grant usage on schema extensions to vortex_request;

select has_function(
  'vortex_module', 'provision_module_installation_storage',
  array['uuid', 'bigint', 'uuid', 'bigint', 'bigint'],
  'Module exposes one fixed exact-release storage coordinator'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_module_owner',
    'vortex_record.provision_exact_module_storage(uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'public', 'vortex_record.provision_exact_module_storage(uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_record.provision_exact_module_storage(uuid,bigint)', 'EXECUTE'
  ),
  'only Module owns invocation of the private Record generator'
);
select ok(
  (
    select pg_catalog.pg_get_userbyid(procedure.proowner) = 'vortex_record_owner'
      and procedure.prosecdef
      and procedure.provolatile = 'v'
      and procedure.proconfig = array['search_path=""']
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'vortex_record.provision_exact_module_storage(uuid,bigint)'::regprocedure
  ),
  'the Record generator keeps its owner, definer rights and empty search path'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_module.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'vortex_module.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'vortex_module.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE'
  ),
  'only the restricted request boundary can call the Module coordinator'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14550000-0000-4000-8000-000000000001', 'storage_provision_tenant',
  'Storage provision tenant', 'active', pg_catalog.statement_timestamp(),
  '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '24550000-0000-4000-8000-000000000001',
    '14550000-0000-4000-8000-000000000001', null, 'storage_provision_one',
    'Storage provision one', 'active', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  ),
  (
    '24550000-0000-4000-8000-000000000002',
    '14550000-0000-4000-8000-000000000001', null, 'storage_provision_two',
    'Storage provision two', 'active', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(), 1
  );
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '44550000-0000-4000-8000-000000000010', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001',
    'a4550000-0000-4000-8000-000000000010', 1
  ),
  (
    '44550000-0000-4000-8000-000000000011', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001',
    'a4550000-0000-4000-8000-000000000011', 1
  );
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '54550000-0000-4000-8000-000000000010',
    '24550000-0000-4000-8000-000000000001',
    '44550000-0000-4000-8000-000000000010', 'Storage steward', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '94550000-0000-4000-8000-000000000001',
    'a4550000-0000-4000-8000-000000000012', 1
  ),
  (
    '54550000-0000-4000-8000-000000000011',
    '24550000-0000-4000-8000-000000000002',
    '44550000-0000-4000-8000-000000000011', 'Other organisation member', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '94550000-0000-4000-8000-000000000001',
    'a4550000-0000-4000-8000-000000000013', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '24550000-0000-4000-8000-000000000001',
  '94550000-0000-4000-8000-000000000001',
  'a4550000-0000-4000-8000-000000000020'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '24550000-0000-4000-8000-000000000001',
  '94550000-0000-4000-8000-000000000001',
  'a4550000-0000-4000-8000-000000000021'
);
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  '24550000-0000-4000-8000-000000000001', 1, '1.0.0', '1.0.1',
  '94550000-0000-4000-8000-000000000001',
  'a4550000-0000-4000-8000-000000000022'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '24550000-0000-4000-8000-000000000001',
  '54550000-0000-4000-8000-000000000010',
  '64550000-0000-4000-8000-000000000010',
  'storage_steward', 'Storage steward', 'Permanent storage-test stewardship.',
  '74550000-0000-4000-8000-000000000010',
  '84550000-0000-4000-8000-000000000010',
  '44550000-0000-4000-8000-000000000010',
  'a4550000-0000-4000-8000-000000000023'
);
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  '24550000-0000-4000-8000-000000000001', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  '94550000-0000-4000-8000-000000000001',
  'a4550000-0000-4000-8000-000000000024'
);
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '24550000-0000-4000-8000-000000000001',
  '64550000-0000-4000-8000-000000000011', 'custom',
  'application_installer', 1, '94550000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select entry.organization_id, '64550000-0000-4000-8000-000000000011'::uuid,
  1, 1, 'custom', null, entry.application_root_id,
  entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.registration_kind, entry.registration_owner_id,
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
  and continuity.application_root_id is not distinct from entry.application_root_id
  and continuity.owner_kind = entry.owner_kind
  and continuity.owner_id = entry.owner_id
  and continuity.permission_id = entry.permission_id
where entry.organization_id = '24550000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform'
  and entry.registration_revision = 3
  and entry.permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba';
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '24550000-0000-4000-8000-000000000001',
  '64550000-0000-4000-8000-000000000011', 1, 'custom', 'active',
  'privileged', 'standing', 1, 1, 'application_installer',
  'Application installer', 'Explicit current lifecycle authority for storage testing.',
  '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4550000-0000-4000-8000-000000000025'
);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24550000-0000-4000-8000-000000000001',
  '74550000-0000-4000-8000-000000000011',
  '64550000-0000-4000-8000-000000000011', 'organization_account',
  '54550000-0000-4000-8000-000000000010', null, 'standing', 1,
  pg_catalog.statement_timestamp() - interval '1 minute', null, 'live',
  '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4550000-0000-4000-8000-000000000026',
  '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4550000-0000-4000-8000-000000000026'
);

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '24550000-0000-4000-8000-000000000001',
    '64550000-0000-4000-8000-000000000020', 'storage_group_one',
    'Storage group one', 'active', 1,
    '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    'a4550000-0000-4000-8000-000000000030'
  ),
  (
    '24550000-0000-4000-8000-000000000002',
    '64550000-0000-4000-8000-000000000021', 'storage_group_two',
    'Storage group two', 'active', 1,
    '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
    'a4550000-0000-4000-8000-000000000031'
  );

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '34550000-0000-4000-8000-000000000001',
    '24550000-0000-4000-8000-000000000001', 'application',
    'vortex.storage_test.application', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '34550000-0000-4000-8000-000000000002',
    '24550000-0000-4000-8000-000000000001', 'application',
    'vortex.storage_test.other_application', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '34550000-0000-4000-8000-000000000003',
    '24550000-0000-4000-8000-000000000002', 'application',
    'vortex.storage_test.wrong_organization_application',
    pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '34550000-0000-4000-8000-000000000004',
    '24550000-0000-4000-8000-000000000001', 'application',
    'vortex.storage_test.newer_first_application',
    pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '44550000-0000-4000-8000-000000000001',
    '24550000-0000-4000-8000-000000000001', 'module',
    'vortex.storage_test.module', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '44550000-0000-4000-8000-000000000002',
    '24550000-0000-4000-8000-000000000001', 'module',
    'vortex.storage_test.newer_first_module', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '44550000-0000-4000-8000-000000000006',
    '24550000-0000-4000-8000-000000000002', 'module',
    'vortex.storage_test.wrong_organization_module', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  );

-- Every release in this section is published through the writer,
-- vortex_definition.append_release, so each dependency edge carries the
-- exact evidence of the Module release it pins and stays within its
-- Application's organisation. The installing organisation owns both Modules
-- it installs. The wrong-organisation Application depends on a Module of its
-- own organisation, so the one reason it cannot be installed here is that it
-- belongs to another organisation.
select pg_temp.append_writer_release(
  '44550000-0000-4000-8000-000000000001', '2.0.0', '[]', pg_temp.module_content(1), '2.0.0'
);
select pg_temp.append_writer_release(
  '44550000-0000-4000-8000-000000000001', '2.1.0', '[]', pg_temp.module_content(2), '2.0.0'
);
select pg_temp.append_writer_release(
  '44550000-0000-4000-8000-000000000001', '2.2.0', '[]', pg_temp.module_content(3), '2.0.0'
);
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000001', '1.0.0',
  '[["44550000-0000-4000-8000-000000000001", 1]]'
);
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000001', '1.1.0',
  '[["44550000-0000-4000-8000-000000000001", 2]]'
);
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000001', '1.2.0',
  '[["44550000-0000-4000-8000-000000000001", 3]]'
);
select pg_temp.append_writer_release(
  '44550000-0000-4000-8000-000000000002', '2.0.0', '[]',
  pg_temp.newer_first_module_content(1), '2.0.0'
);
select pg_temp.append_writer_release(
  '44550000-0000-4000-8000-000000000002', '2.1.0', '[]',
  pg_temp.newer_first_module_content(2), '2.0.0'
);
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000004', '1.0.0',
  '[["44550000-0000-4000-8000-000000000002", 1]]'
);
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000004', '1.1.0',
  '[["44550000-0000-4000-8000-000000000002", 2]]'
);
select pg_temp.append_writer_release(
  '44550000-0000-4000-8000-000000000006', '2.0.0', '[]',
  pg_catalog.jsonb_build_object('recordTypes', pg_catalog.jsonb_build_array(
    pg_temp.single_record_type(
      '54550000-0000-4000-8000-000000000007',
      '64550000-0000-4000-8000-000000000007',
      '74550000-0000-4000-8000-000000000012'
    )
  )),
  '2.0.0'
);
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000003', '1.0.0',
  '[["44550000-0000-4000-8000-000000000006", 1]]'
);

select pg_temp.initialize_storage_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34550000-0000-4000-8000-000000000003', 1,
    '44550000-0000-4000-8000-000000000006', 1, null
  )$$::text,
  'P0002'::char(5), 'Module installation evidence is unavailable'::text,
  'an Application release owned by another organisation is unavailable'::text
);
reset role;

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table first_provision on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000001', 1,
  '44550000-0000-4000-8000-000000000001', 1, null
);
reset role;

select is((select state from first_provision), 'provisioned',
  'the exact Application V1 to Module V2 binding remains inactive after provisioning');
select is((select changed from first_provision), true,
  'first provisioning reports its real storage change');
select is(
  (
    select pg_catalog.concat_ws(':', state, binding_revision,
      application_release_revision, module_release_revision)
    from vortex_module.installation_bindings
    where organization_id = '24550000-0000-4000-8000-000000000001'
      and application_root_id = '34550000-0000-4000-8000-000000000001'
      and module_root_id = '44550000-0000-4000-8000-000000000001'
  ),
  'provisioned:1:1:1',
  'the stored binding is provisioned rather than active and records exact releases');
select is(
  (
    select pg_catalog.jsonb_agg(physical_table_token order by storage_contract_id)
    from vortex_record.storage_catalogue
  ),
  '["rt_64550000000040008000000000000001", "rt_64550000000040008000000000000002"]'::jsonb,
  'full storage UUIDs deterministically allocate the two physical tables');
select is(
  (
    select pg_catalog.jsonb_agg(physical_column_token order by field_id)
    from vortex_record.field_storage_mappings
  ),
  '["f_74550000000040008000000000000001", "f_74550000000040008000000000000002"]'::jsonb,
  'full field UUIDs deterministically allocate the initial physical columns');
select ok(
  (
    select pg_catalog.bool_and(owner_name = 'vortex_record_owner'
      and relrowsecurity and relforcerowsecurity and policy_count = 4)
    from (
      select pg_catalog.pg_get_userbyid(class.relowner) as owner_name,
        class.relrowsecurity, class.relforcerowsecurity,
        (
          select pg_catalog.count(*)
          from pg_catalog.pg_policy as policy
          where policy.polrelid = class.oid
        ) as policy_count
      from pg_catalog.pg_class as class
      where class.oid in (
        'record_data.rt_64550000000040008000000000000001'::regclass,
        'record_data.rt_64550000000040008000000000000002'::regclass
      )
    ) as generated
  ),
  'generated tables are Record-owned with forced RLS and four operation policies');
select is(
  (
    select pg_catalog.concat_ws(':', source_storage_contract_id, source_field_id,
      target_record_type_ids[1], cardinality, on_parent_delete)
    from vortex_record.relationship_storage_mappings
    where relationship_id = '84550000-0000-4000-8000-000000000001'
  ),
  '64550000-0000-4000-8000-000000000002:74550000-0000-4000-8000-000000000002:54550000-0000-4000-8000-000000000001:many_to_one:refuse',
  'the declared relationship maps its exact source field and target record type');

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table exact_retry on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000001', 1,
  '44550000-0000-4000-8000-000000000001', 1, null
);
reset role;
select is((select pg_catalog.concat_ws(':', changed, binding_revision) from exact_retry),
  'f:1'::text, 'the original null-expected command reuses its exact provision');
select pg_temp.initialize_storage_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34550000-0000-4000-8000-000000000001', 2,
    '44550000-0000-4000-8000-000000000001', 2, null
  )$$::text,
  '40001'::char(5), 'Module installation binding changed'::text,
  'a null-expected replay cannot retarget an existing binding'::text
);
reset role;
select pg_temp.initialize_storage_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34550000-0000-4000-8000-000000000001', 1,
    '44550000-0000-4000-8000-000000000001', 1, 2
  )$$::text,
  '40001'::char(5), 'Module installation binding changed'::text,
  'a mismatched expected binding revision is refused'::text);
reset role;

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table compatible_upgrade on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000001', 2,
  '44550000-0000-4000-8000-000000000001', 2, 1
);
reset role;
select is((select pg_catalog.concat_ws(':', changed, binding_revision) from compatible_upgrade),
  't:2'::text, 'a compatible nullable-field release advances the existing binding once');
select is((select pg_catalog.count(*) from vortex_record.storage_catalogue), 2::bigint,
  'a compatible release reuses both storage contracts rather than allocating copies');
select is(
  (
    select pg_catalog.concat_ws(':', physical_column_token, database_value_type,
      introduced_at_release_revision, state)
    from vortex_record.field_storage_mappings
    where field_id = '74550000-0000-4000-8000-000000000003'
  ),
  'f_74550000000040008000000000000003:integer:2:active',
  'the compatible release records the exact nullable field allocation');
select ok(
  (
    select not attribute.attnotnull
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid =
      'record_data.rt_64550000000040008000000000000001'::regclass
      and attribute.attname = 'f_74550000000040008000000000000003'
      and attribute.attnum > 0 and not attribute.attisdropped
  ),
  'the compatible field addition is physically nullable');

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table upgraded_retry on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000001', 2,
  '44550000-0000-4000-8000-000000000001', 2, 2
);
reset role;
select is((select pg_catalog.concat_ws(':', changed, binding_revision) from upgraded_retry),
  'f:2'::text, 'an exact upgraded retry is a no-change reuse');
select pg_temp.initialize_storage_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34550000-0000-4000-8000-000000000001', 3,
    '44550000-0000-4000-8000-000000000001', 3, 2
  )$$::text,
  '55000'::char(5), 'Compatible storage upgrades cannot remove relationships'::text,
  'a release that removes a stored relationship is refused'::text);
reset role;
select ok(
  not exists (
    select 1 from vortex_record.field_storage_mappings
    where field_id = '74550000-0000-4000-8000-000000000004'
  )
  and not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'record_data.rt_64550000000040008000000000000001'::regclass
      and attname = 'f_74550000000040008000000000000004'
      and attnum > 0 and not attisdropped
  )
  and not exists (
    select 1 from vortex_record.release_provisions
    where module_root_id = '44550000-0000-4000-8000-000000000001'
      and release_revision = 3
  )
  and (
    select binding_revision = 2 and module_release_revision = 2
    from vortex_module.installation_bindings
    where organization_id = '24550000-0000-4000-8000-000000000001'
      and application_root_id = '34550000-0000-4000-8000-000000000001'
      and module_root_id = '44550000-0000-4000-8000-000000000001'
  ),
  'the refused removal rolls back its preceding column, mapping, receipt and binding work');

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table newer_first_provision on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000004', 2,
  '44550000-0000-4000-8000-000000000002', 2, null
);
reset role;
select is(
  (
    select pg_catalog.concat_ws(':', changed, binding_revision)
    from newer_first_provision
  ),
  't:1'::text,
  'a newer compatible release may allocate its storage lineage first'
);

set local role vortex_module_owner;
create temporary table older_storage_reuse on commit drop as
select * from vortex_record.provision_exact_module_storage(
  '44550000-0000-4000-8000-000000000002', 1
);
reset role;
select is(
  (select changed from older_storage_reuse), false,
  'the older compatible release reuses the evolved storage without physical change'
);

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table older_pinned_binding on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000004', 1,
  '44550000-0000-4000-8000-000000000002', 1, 1
);
reset role;
select is(
  (
    select pg_catalog.concat_ws(':', changed, binding_revision,
      application_release_revision, module_release_revision)
    from older_pinned_binding
  ),
  't:2:1:1'::text,
  'an older pinned compatible release can become the exact inactive binding'
);
select ok(
  (
    select catalogue.first_compatible_release_revision = 1
      and catalogue.last_compatible_release_revision = 2
      and catalogue.record_type_definition =
        pg_temp.newer_first_module_content(2) #> '{recordTypes,0}'
      and mapping.state = 'active'
      and mapping.introduced_at_release_revision = 2
      and pg_catalog.to_regclass(
        'record_data.rt_64550000000040008000000000000003'
      ) is not null
      and (
        select pg_catalog.count(*) = 2
        from vortex_record.release_provisions as provision
        where provision.module_root_id =
          '44550000-0000-4000-8000-000000000002'
      )
    from vortex_record.storage_catalogue as catalogue
    join vortex_record.field_storage_mappings as mapping
      on mapping.storage_contract_id = catalogue.storage_contract_id
      and mapping.field_id = '74550000-0000-4000-8000-000000000006'
    where catalogue.storage_contract_id =
      '64550000-0000-4000-8000-000000000003'
  ),
  'older reuse expands the compatible lower bound without downgrading newer storage'
);

select pg_temp.initialize_storage_context(
  p_application_root_id => '34550000-0000-4000-8000-000000000001'
);
set local role vortex_record_adapter;
insert into record_data.rt_64550000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision, owner_group_id,
  lifecycle_state, concurrency_number, created_at, created_by, updated_at,
  updated_by, f_74550000000040008000000000000001
) values (
  '24550000-0000-4000-8000-000000000001',
  '44550000-0000-4000-8000-000000000001',
  '54550000-0000-4000-8000-000000000001',
  '64550000-0000-4000-8000-000000000001',
  'e4550000-0000-4000-8000-000000000010', null, 2,
  '64550000-0000-4000-8000-000000000020', 'active', 1,
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000010',
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000010',
  'First organisation'
);
insert into record_data.rt_64550000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision, owner_group_id,
  lifecycle_state, concurrency_number, created_at, created_by, updated_at, updated_by
) values (
  '24550000-0000-4000-8000-000000000001',
  '44550000-0000-4000-8000-000000000001',
  '54550000-0000-4000-8000-000000000002',
  '64550000-0000-4000-8000-000000000002',
  'e4550000-0000-4000-8000-000000000011',
  '34550000-0000-4000-8000-000000000001', 2,
  '64550000-0000-4000-8000-000000000020', 'active', 1,
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000010',
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000010'
);
reset role;

select pg_temp.initialize_storage_context(
  p_application_root_id => '34550000-0000-4000-8000-000000000002'
);
set local role vortex_record_adapter;
insert into record_data.rt_64550000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision, owner_group_id,
  lifecycle_state, concurrency_number, created_at, created_by, updated_at, updated_by
) values (
  '24550000-0000-4000-8000-000000000001',
  '44550000-0000-4000-8000-000000000001',
  '54550000-0000-4000-8000-000000000002',
  '64550000-0000-4000-8000-000000000002',
  'e4550000-0000-4000-8000-000000000012',
  '34550000-0000-4000-8000-000000000002', 2,
  '64550000-0000-4000-8000-000000000020', 'active', 1,
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000010',
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000010'
);
reset role;

select pg_temp.initialize_storage_context(
  '24550000-0000-4000-8000-000000000002',
  '54550000-0000-4000-8000-000000000011',
  '44550000-0000-4000-8000-000000000011', null, 1
);
set local role vortex_record_adapter;
insert into record_data.rt_64550000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision, owner_group_id,
  lifecycle_state, concurrency_number, created_at, created_by, updated_at,
  updated_by, f_74550000000040008000000000000001
) values (
  '24550000-0000-4000-8000-000000000002',
  '44550000-0000-4000-8000-000000000001',
  '54550000-0000-4000-8000-000000000001',
  '64550000-0000-4000-8000-000000000001',
  'e4550000-0000-4000-8000-000000000013', null, 2,
  '64550000-0000-4000-8000-000000000021', 'active', 1,
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000011',
  pg_catalog.statement_timestamp(), '54550000-0000-4000-8000-000000000011',
  'Second organisation'
);
create temporary table organization_two_visible on commit drop as
select pg_catalog.string_agg(record_id::text, ',' order by record_id) as record_ids
from record_data.rt_64550000000040008000000000000001;
reset role;
select is(
  (select record_ids from organization_two_visible),
  'e4550000-0000-4000-8000-000000000013',
  'organisation-shared storage exposes only the second organisation row');

select pg_temp.initialize_storage_context(
  p_application_root_id => '34550000-0000-4000-8000-000000000001'
);
set local role vortex_record_adapter;
create temporary table organization_one_visible on commit drop as
select pg_catalog.string_agg(record_id::text, ',' order by record_id) as record_ids
from record_data.rt_64550000000040008000000000000001;
create temporary table application_one_visible on commit drop as
select pg_catalog.string_agg(record_id::text, ',' order by record_id) as record_ids
from record_data.rt_64550000000040008000000000000002;
reset role;
select is(
  (select record_ids from organization_one_visible),
  'e4550000-0000-4000-8000-000000000010',
  'organisation-shared storage exposes only the selected organisation row');
select is(
  (select record_ids from application_one_visible),
  'e4550000-0000-4000-8000-000000000011',
  'application-contained storage exposes only the selected application row');

select pg_temp.initialize_storage_context(
  p_application_root_id => '34550000-0000-4000-8000-000000000002'
);
set local role vortex_record_adapter;
create temporary table application_two_visible on commit drop as
select pg_catalog.string_agg(record_id::text, ',' order by record_id) as record_ids
from record_data.rt_64550000000040008000000000000002;
reset role;
select is(
  (select record_ids from application_two_visible),
  'e4550000-0000-4000-8000-000000000012',
  'application-contained storage separates another application in the same organisation');

select pg_temp.initialize_storage_context(
  p_application_root_id => '34550000-0000-4000-8000-000000000001'
);
set local role vortex_request;
select throws_ok(
  $$select * from record_data.rt_64550000000040008000000000000001$$::text,
  '42501'::char(5), null,
  'the request role cannot bypass Record through the generated table'::text);
reset role;

-- The native Module V3 root belongs to the installing organisation because
-- the Application below is published against it through the writer, which
-- accepts dependencies only within the Application's organisation.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (
    '44550000-0000-4000-8000-000000000003',
    '24550000-0000-4000-8000-000000000001', 'module',
    'vortex.storage_test.native_v3_module', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '44550000-0000-4000-8000-000000000004',
    '24550000-0000-4000-8000-000000000002', 'module',
    'vortex.storage_test.rule_upgrade_module', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  ),
  (
    '44550000-0000-4000-8000-000000000005',
    '24550000-0000-4000-8000-000000000002', 'module',
    'vortex.storage_test.refused_module', pg_catalog.statement_timestamp(),
    '94550000-0000-4000-8000-000000000001'
  );

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values (
  '44550000-0000-4000-8000-000000000003', 1, '1.0.0',
  pg_catalog.jsonb_build_object(
    'source_contract_version', '3.0.0', 'kind', 'module',
    'key', 'vortex.storage_test.native_v3_module'
  ),
  'sha256:' || pg_catalog.repeat('a', 64), '3.0.0',
  pg_temp.versioned_module_output(
    '44550000-0000-4000-8000-000000000003', '3.0.0',
    pg_temp.single_record_type(
      '54550000-0000-4000-8000-000000000004',
      '64550000-0000-4000-8000-000000000004',
      '74550000-0000-4000-8000-000000000007'
    ),
    pg_catalog.jsonb_build_array(
      pg_temp.storage_rule_graph('54550000-0000-4000-8000-000000000004')
    )
  ),
  pg_catalog.jsonb_build_object(
    'fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)
  ),
  'sha256:' || pg_catalog.repeat('c', 64),
  'sha256:' || pg_catalog.repeat('b', 64), '3.0.0',
  'sha256:' || pg_catalog.repeat('d', 64), '[]'::jsonb,
  'Native Module V3 storage release.', pg_catalog.statement_timestamp(),
  '94550000-0000-4000-8000-000000000001'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
)
select '44550000-0000-4000-8000-000000000004'::uuid, release.revision,
  release.release_version,
  pg_catalog.jsonb_build_object(
    'source_contract_version', release.contract_version, 'kind', 'module',
    'key', 'vortex.storage_test.rule_upgrade_module'
  ),
  'sha256:' || pg_catalog.repeat('e', 64), release.contract_version,
  pg_temp.versioned_module_output(
    '44550000-0000-4000-8000-000000000004', release.contract_version,
    pg_temp.single_record_type(
      '54550000-0000-4000-8000-000000000005',
      '64550000-0000-4000-8000-000000000005',
      '74550000-0000-4000-8000-000000000008'
    ),
    case when release.contract_version = '3.0.0' then pg_catalog.jsonb_build_array(
      pg_temp.storage_rule_graph('54550000-0000-4000-8000-000000000005')
    ) end
  ),
  pg_catalog.jsonb_build_object(
    'fingerprint', 'sha256:' || pg_catalog.repeat(release.revision::text, 64)
  ),
  'sha256:' || pg_catalog.repeat(release.content_digit, 64),
  'sha256:' || pg_catalog.repeat(release.revision::text, 64),
  release.contract_version, 'sha256:' || pg_catalog.repeat('e', 64), '[]'::jsonb,
  release.release_note, pg_catalog.statement_timestamp(),
  '94550000-0000-4000-8000-000000000001'::uuid
from (
  values
    (
      1::bigint, '2.0.0', '1.0.0', '7',
      'Rule-upgrade Module V2 storage release.'
    ),
    (
      2::bigint, '3.0.0', '1.1.0', '8',
      'Rule-only Module V3 storage release.'
    )
) as release(revision, contract_version, release_version, content_digit, release_note);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
)
select '44550000-0000-4000-8000-000000000005'::uuid, gate.revision,
  gate.revision::text || '.0.0',
  pg_catalog.jsonb_build_object(
    'source_contract_version', gate.source_contract_version, 'kind', 'module',
    'key', 'vortex.storage_test.refused_module'
  ),
  'sha256:' || pg_catalog.repeat('5', 64), gate.source_contract_version,
  gate.compilation_output,
  pg_catalog.jsonb_build_object(
    'fingerprint', 'sha256:' || pg_catalog.repeat(gate.revision::text, 64)
  ),
  'sha256:' || pg_catalog.repeat(gate.revision::text, 64),
  'sha256:' || pg_catalog.repeat(gate.revision::text, 64),
  gate.validation_contract_version, 'sha256:' || pg_catalog.repeat('5', 64),
  '[]'::jsonb, gate.release_note, pg_catalog.statement_timestamp(),
  '94550000-0000-4000-8000-000000000001'::uuid
from (
  values
    (
      1::bigint, '2.0.0', '3.0.0', pg_temp.refused_module_output(),
      'Refused source and validation contract disagreement.'
    ),
    (
      2::bigint, '3.0.0', '3.0.0',
      pg_catalog.jsonb_set(
        pg_temp.refused_module_output(), '{validationContractVersion}',
        '"2.0.0"'::jsonb
      ),
      'Refused embedded validation contract disagreement.'
    ),
    (
      3::bigint, '4.0.0', '4.0.0',
      pg_catalog.jsonb_set(
        pg_temp.refused_module_output(), '{validationContractVersion}',
        '"4.0.0"'::jsonb
      ),
      'Refused unsupported Module validation contract.'
    ),
    (
      4::bigint, '3.0.0', '3.0.0', pg_temp.refused_module_output() - 'kind',
      'Refused missing embedded definition kind.'
    ),
    (
      5::bigint, '3.0.0', '3.0.0',
      pg_catalog.jsonb_set(
        pg_temp.refused_module_output(), '{canonical,envelope}', '{}'::jsonb
      ),
      'Refused missing embedded root identity.'
    )
) as gate(revision, source_contract_version, validation_contract_version,
  compilation_output, release_note);

set local role vortex_module_owner;
create temporary table native_v3_provision on commit drop as
select * from vortex_record.provision_exact_module_storage(
  '44550000-0000-4000-8000-000000000003', 1
);
reset role;
select is(
  (
    select pg_catalog.concat_ws(':', changed, generator_contract_version,
      pg_catalog.array_to_string(storage_contract_ids, ','))
    from native_v3_provision
  ),
  't:1.0.0:64550000-0000-4000-8000-000000000004',
  'a native Module V3 release provisions its exact storage under generator contract 1.0.0');
select ok(
  (
    select catalogue.physical_table_token = 'rt_64550000000040008000000000000004'
      and catalogue.first_compatible_release_revision = 1
      and catalogue.last_compatible_release_revision = 1
      and catalogue.state = 'active'
      and catalogue.generator_contract_version = '1.0.0'
      and pg_catalog.to_regclass(
        'record_data.rt_64550000000040008000000000000004'
      ) is not null
      and exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid =
          'record_data.rt_64550000000040008000000000000004'::regclass
          and attribute.attname = 'f_74550000000040008000000000000007'
          and attribute.attnum > 0 and not attribute.attisdropped
      )
      and exists (
        select 1
        from vortex_record.release_provisions as provision
        join vortex_definition.releases as release
          on release.root_id = provision.module_root_id
          and release.release_revision = provision.release_revision
        where provision.module_root_id = '44550000-0000-4000-8000-000000000003'
          and provision.release_revision = 1
          and provision.content_fingerprint = release.content_fingerprint
          and provision.resolution_fingerprint = release.resolution_fingerprint
          and provision.generator_contract_version = '1.0.0'
          and provision.storage_contract_ids =
            array['64550000-0000-4000-8000-000000000004'::uuid]
      )
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = '64550000-0000-4000-8000-000000000004'
  ),
  'native Module V3 storage records its table, column and exact provision receipt');

-- Published through the writer, so the dependency edge carries the exact
-- evidence of the native Module V3 release it pins.
select pg_temp.append_writer_release(
  '34550000-0000-4000-8000-000000000002', '1.0.0',
  '[["44550000-0000-4000-8000-000000000003", 1]]'
);

select pg_temp.initialize_storage_context();
set local role vortex_request;
create temporary table module_v3_installation on commit drop as
select * from vortex_module.provision_module_installation_storage(
  '34550000-0000-4000-8000-000000000002', 1,
  '44550000-0000-4000-8000-000000000003', 1, null
);
reset role;
select is(
  (
    select pg_catalog.concat_ws(':', installation.state, installation.changed,
      installation.binding_revision, installation.module_release_revision,
      binding.state)
    from module_v3_installation as installation
    join vortex_module.installation_bindings as binding
      on binding.organization_id = '24550000-0000-4000-8000-000000000001'
      and binding.application_root_id = '34550000-0000-4000-8000-000000000002'
      and binding.module_root_id = '44550000-0000-4000-8000-000000000003'
  ),
  'provisioned:t:1:1:provisioned',
  'the exact Application V1 to Module V3 dependency binds through the coordinator and stays inactive');

set local role vortex_module_owner;
create temporary table rule_upgrade_base on commit drop as
select * from vortex_record.provision_exact_module_storage(
  '44550000-0000-4000-8000-000000000004', 1
);
reset role;
create temporary table rule_upgrade_before on commit drop as
select catalogue.content_fingerprint, catalogue.physical_table_token,
  pg_catalog.to_regclass(
    'record_data.rt_64550000000040008000000000000005'
  )::oid as table_oid,
  (
    select pg_catalog.count(*)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(
        'record_data.rt_64550000000040008000000000000005'
      )
      and attribute.attnum > 0 and not attribute.attisdropped
  ) as column_count
from vortex_record.storage_catalogue as catalogue
where catalogue.storage_contract_id = '64550000-0000-4000-8000-000000000005';

set local role vortex_module_owner;
create temporary table rule_upgrade_provision on commit drop as
select * from vortex_record.provision_exact_module_storage(
  '44550000-0000-4000-8000-000000000004', 2
);
reset role;
select is(
  (
    select pg_catalog.concat_ws(':', base.changed, upgrade.changed,
      catalogue.first_compatible_release_revision,
      catalogue.last_compatible_release_revision)
    from rule_upgrade_base as base
    cross join rule_upgrade_provision as upgrade
    cross join vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = '64550000-0000-4000-8000-000000000005'
  ),
  't:t:1:2',
  'a rule-only Module V3 release reuses its V2 storage and advances the compatible bound');
select ok(
  (
    select catalogue.content_fingerprint = before.content_fingerprint
      and catalogue.physical_table_token = before.physical_table_token
      and before.table_oid = pg_catalog.to_regclass(
        'record_data.rt_64550000000040008000000000000005'
      )::oid
      and before.column_count = (
        select pg_catalog.count(*)
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            'record_data.rt_64550000000040008000000000000005'
          )
          and attribute.attnum > 0 and not attribute.attisdropped
      )
      and (
        select pg_catalog.count(*) = 1
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = '64550000-0000-4000-8000-000000000005'
      )
      and (
        select pg_catalog.count(*) = 2
        from vortex_record.release_provisions as provision
        where provision.module_root_id = '44550000-0000-4000-8000-000000000004'
      )
      and exists (
        select 1
        from vortex_record.release_provisions as provision
        join vortex_definition.releases as release
          on release.root_id = provision.module_root_id
          and release.release_revision = provision.release_revision
        where provision.module_root_id = '44550000-0000-4000-8000-000000000004'
          and provision.release_revision = 1
          and provision.content_fingerprint = release.content_fingerprint
          and provision.resolution_fingerprint = release.resolution_fingerprint
      )
      and exists (
        select 1 from vortex_definition.releases as release
        where release.root_id = '44550000-0000-4000-8000-000000000004'
          and release.release_revision = 1
          and release.source_contract_version = '2.0.0'
          and release.validation_contract_version = '2.0.0'
      )
      and exists (
        select 1 from vortex_definition.releases as release
        where release.root_id = '44550000-0000-4000-8000-000000000004'
          and release.release_revision = 2
          and release.source_contract_version = '3.0.0'
          and release.validation_contract_version = '3.0.0'
      )
    from vortex_record.storage_catalogue as catalogue
    cross join rule_upgrade_before as before
    where catalogue.storage_contract_id = '64550000-0000-4000-8000-000000000005'
  ),
  'the rule-only release keeps the same physical table, column and storage meaning and leaves the V2 release contracts and receipt unchanged');

set local role vortex_module_owner;
create temporary table rule_upgrade_older_retry on commit drop as
select * from vortex_record.provision_exact_module_storage(
  '44550000-0000-4000-8000-000000000004', 1
);
reset role;
select is(
  (
    select pg_catalog.concat_ws(':', retry.changed,
      catalogue.first_compatible_release_revision,
      catalogue.last_compatible_release_revision,
      catalogue.content_fingerprint = before.content_fingerprint)
    from rule_upgrade_older_retry as retry
    cross join rule_upgrade_before as before
    cross join vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = '64550000-0000-4000-8000-000000000005'
  ),
  'f:1:2:t',
  'the older compatible V2 release retried after the V3 advance changes no storage');

select throws_ok(
  $$set local role vortex_module_owner;
  select * from vortex_record.provision_exact_module_storage(
    '44550000-0000-4000-8000-000000000005', 1
  ); reset role;$$::text,
  '23514'::char(5), 'Exact Module release is incompatible'::text,
  'a source and validation contract disagreement is refused'::text);
select throws_ok(
  $$set local role vortex_module_owner;
  select * from vortex_record.provision_exact_module_storage(
    '44550000-0000-4000-8000-000000000005', 2
  ); reset role;$$::text,
  '23514'::char(5), 'Exact Module release is incompatible'::text,
  'an embedded validation contract disagreement is refused'::text);
select throws_ok(
  $$set local role vortex_module_owner;
  select * from vortex_record.provision_exact_module_storage(
    '44550000-0000-4000-8000-000000000005', 3
  ); reset role;$$::text,
  '23514'::char(5), 'Exact Module release is incompatible'::text,
  'an unsupported Module validation contract is refused'::text);
select throws_ok(
  $$set local role vortex_module_owner;
  select * from vortex_record.provision_exact_module_storage(
    '44550000-0000-4000-8000-000000000005', 4
  ); reset role;$$::text,
  '23514'::char(5), 'Exact Module release is incompatible'::text,
  'a missing embedded definition kind cannot evade the gate'::text);
select throws_ok(
  $$set local role vortex_module_owner;
  select * from vortex_record.provision_exact_module_storage(
    '44550000-0000-4000-8000-000000000005', 5
  ); reset role;$$::text,
  '23514'::char(5), 'Exact Module release is incompatible'::text,
  'a missing embedded root identity cannot evade the gate'::text);
reset role;
select ok(
  not exists (
    select 1 from vortex_record.storage_catalogue
    where storage_contract_id = '64550000-0000-4000-8000-000000000006'
  )
  and not exists (
    select 1 from vortex_record.release_provisions
    where module_root_id = '44550000-0000-4000-8000-000000000005'
  )
  and pg_catalog.to_regclass(
    'record_data.rt_64550000000040008000000000000006'
  ) is null,
  'every refused release gate leaves no storage, column or provision evidence');

select * from finish();
rollback;
