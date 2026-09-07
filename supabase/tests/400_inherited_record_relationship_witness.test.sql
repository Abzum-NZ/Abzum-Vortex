begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select has_function(
  'vortex_access', 'record_relationship_witness_matches',
  array[
    'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid',
    'jsonb', 'jsonb', 'uuid', 'uuid'
  ],
  'Access owns one private factual relationship-witness matcher'
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
      'vortex_access.record_relationship_witness_matches(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'i',
    'configuration', array['search_path=""']
  ),
  'the factual matcher is owner-held, immutable, invoker-rights and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.record_relationship_witness_matches(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private relationship matcher'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

create function pg_temp.record_identity(
  p_record_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_storage_scope text default 'application_contained',
  p_organization_id uuid default '24000000-0000-4000-8000-000000000001',
  p_application_root_id uuid default '34000000-0000-4000-8000-000000000001'
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'storageScope', p_storage_scope,
    'organizationId', p_organization_id,
    'moduleRootId', p_module_root_id,
    'recordTypeId', p_record_type_id,
    'storageContractId', p_storage_contract_id,
    'recordId', p_record_id,
    'applicationRootId', case
      when p_storage_scope = 'application_contained' then p_application_root_id
      else null
    end
  ))
$function$;

create function pg_temp.relationship_match(
  p_declared_relationship_id uuid default 'c4000000-0000-4000-8000-000000000001',
  p_declared_from_module_root_id uuid default '44000000-0000-4000-8000-000000000001',
  p_declared_from_record_type_id uuid default '54000000-0000-4000-8000-000000000001',
  p_declared_to_module_root_id uuid default '44000000-0000-4000-8000-000000000002',
  p_declared_to_record_type_id uuid default '54000000-0000-4000-8000-000000000002',
  p_edge_relationship_id uuid default 'c4000000-0000-4000-8000-000000000001',
  p_edge_from_record_id uuid default 'd4000000-0000-4000-8000-000000000001',
  p_edge_to_record_id uuid default 'd4000000-0000-4000-8000-000000000002',
  p_from_record_scope jsonb default pg_temp.record_identity(
    'd4000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001'
  ),
  p_to_record_scope jsonb default pg_temp.record_identity(
    'd4000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000002',
    '54000000-0000-4000-8000-000000000002',
    '64000000-0000-4000-8000-000000000002'
  ),
  p_current_organization_id uuid default '24000000-0000-4000-8000-000000000001',
  p_current_application_root_id uuid default '34000000-0000-4000-8000-000000000001'
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select vortex_access.record_relationship_witness_matches(
    p_declared_relationship_id, p_declared_from_module_root_id,
    p_declared_from_record_type_id, p_declared_to_module_root_id,
    p_declared_to_record_type_id, p_edge_relationship_id,
    p_edge_from_record_id, p_edge_to_record_id, p_from_record_scope,
    p_to_record_scope, p_current_organization_id,
    p_current_application_root_id
  )
$function$;

select is(
  pg_temp.relationship_match(), true,
  'an exact application-contained relationship witness matches'
);
select is(
  pg_temp.relationship_match(
    p_from_record_scope => pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000001',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001', 'organization_shared'
    ),
    p_to_record_scope => pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000002',
      '44000000-0000-4000-8000-000000000002',
      '54000000-0000-4000-8000-000000000002',
      '64000000-0000-4000-8000-000000000002', 'organization_shared'
    )
  ),
  true,
  'organization-shared endpoints match within the trusted consuming context'
);
select is(
  pg_temp.relationship_match(
    p_edge_relationship_id => 'c4000000-0000-4000-8000-000000000099'
  ),
  false,
  'another relationship identity is a valid nonmatch'
);
select is(
  pg_temp.relationship_match(
    p_edge_from_record_id => 'd4000000-0000-4000-8000-000000000002',
    p_edge_to_record_id => 'd4000000-0000-4000-8000-000000000001'
  ),
  false,
  'a reversed edge is a valid nonmatch'
);
select is(
  pg_temp.relationship_match(
    p_declared_from_module_root_id => '44000000-0000-4000-8000-000000000099'
  ),
  false,
  'another declared source module identity cannot match'
);
select is(
  pg_temp.relationship_match(
    p_current_organization_id => '24000000-0000-4000-8000-000000000002'
  ),
  false,
  'a foreign current organization cannot match the endpoints'
);
select is(
  pg_temp.relationship_match(
    p_current_application_root_id => '34000000-0000-4000-8000-000000000002'
  ),
  false,
  'another application cannot match application-contained endpoints'
);
select throws_ok(
  $$select pg_temp.relationship_match(
    p_from_record_scope => pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000001',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ) || '{"unexpected":true}'::jsonb
  )$$,
  '22023', 'Relationship source record identity is invalid',
  'an open source RecordScope shape refuses'
);
select throws_ok(
  $$select pg_temp.relationship_match(
    p_to_record_scope => pg_catalog.jsonb_build_object(
      'storageScope', 'application_contained',
      'organizationId', 42,
      'moduleRootId', '44000000-0000-4000-8000-000000000002',
      'recordTypeId', '54000000-0000-4000-8000-000000000002',
      'storageContractId', '64000000-0000-4000-8000-000000000002',
      'recordId', 'd4000000-0000-4000-8000-000000000002',
      'applicationRootId', '34000000-0000-4000-8000-000000000001'
    )
  )$$,
  '22023', 'Relationship target record identity is invalid',
  'a non-string target RecordScope identity refuses'
);
select throws_ok(
  $$select pg_temp.relationship_match(
    p_declared_relationship_id => '00000000-0000-0000-0000-000000000000'
  )$$,
  '22023', 'Record relationship witness context is invalid',
  'a nil declared relationship identity refuses'
);

-- The remaining fixture proves a real restricted-role seam. As in the prior
-- ownership checkpoint, permission 101 is the existing operation gate while
-- the test-owned record and relationship declarations stand in for #35/#45.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14000000-0000-4000-8000-000000000001', 'inherited_ownership',
  'Inherited ownership', 'active', pg_catalog.clock_timestamp(),
  '94000000-0000-4000-8000-000000000001',
  pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '24000000-0000-4000-8000-000000000001',
    '14000000-0000-4000-8000-000000000001', 'inherited_ownership',
    'Inherited ownership', 'active', pg_catalog.clock_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 1
  ),
  (
    '24000000-0000-4000-8000-000000000002',
    '14000000-0000-4000-8000-000000000001', 'foreign_inheritance',
    'Foreign inheritance', 'active', pg_catalog.clock_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '44000000-0000-4000-8000-000000000101', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000001', 1
  ),
  (
    '44000000-0000-4000-8000-000000000102', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '74000000-0000-4000-8000-000000000001',
    '24000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000101', 'Inherited reader', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000003', 1
  ),
  (
    '74000000-0000-4000-8000-000000000002',
    '24000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000102', 'Other owner', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '94000000-0000-4000-8000-000000000001',
    'a4000000-0000-4000-8000-000000000004', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '24000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000005'
);

create temporary table inherited_times (
  key text primary key,
  value timestamptz not null
) on commit drop;
insert into inherited_times values
  ('now', pg_catalog.clock_timestamp()),
  ('membership_expiry', pg_catalog.clock_timestamp() + interval '20 minutes');

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
)
select '24000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001', 'inherited_group',
  'Inherited Group', 'active', 1,
  '94000000-0000-4000-8000-000000000001', value,
  '94000000-0000-4000-8000-000000000001', value,
  'a4000000-0000-4000-8000-000000000011'
from inherited_times where key = 'now';

insert into vortex_access.organization_group_memberships (
  organization_id, membership_id, group_id, organization_account_id,
  revision, starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
)
select '24000000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001', 1,
  started.value - interval '1 minute', expires.value, 'live',
  '94000000-0000-4000-8000-000000000001', started.value,
  'a4000000-0000-4000-8000-000000000012',
  '94000000-0000-4000-8000-000000000001', started.value,
  'a4000000-0000-4000-8000-000000000012'
from inherited_times as started
cross join inherited_times as expires
where started.key = 'now' and expires.key = 'membership_expiry';

insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001', 'application',
  '34000000-0000-4000-8000-000000000001', 1, 'active', 'register',
  'example.inherited_ownership', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
  '94000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000021'
);

insert into vortex_access.permission_registrations (
  organization_id, registration_kind, registration_owner_id, state,
  revision, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001', 'application',
  '34000000-0000-4000-8000-000000000001', 'active', 1,
  'example.inherited_ownership', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
  '94000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000021'
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
) values (
  '24000000-0000-4000-8000-000000000001', 'application',
  '34000000-0000-4000-8000-000000000001', 1,
  '34000000-0000-4000-8000-000000000001', 'application',
  '34000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000101',
  'example.inherited_ownership.read', 'Read inherited records',
  'Authorizes the protected neutral inherited-read seam.',
  null, 'read', null, false, 'application', 'example.inherited_ownership',
  '34000000-0000-4000-8000-000000000001', '1.0.0', 1, '1.0.0',
  'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64), null,
  'sha256:' || pg_catalog.repeat('5', 64), null
);

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id, state,
  continuity_revision, meaning_fingerprint,
  last_processed_registration_revision, changed_at
) select entry.organization_id, entry.application_root_id, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, 'available', 1, entry.meaning_fingerprint,
  1, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24000000-0000-4000-8000-000000000001'
  and entry.permission_id = '64000000-0000-4000-8000-000000000101';

insert into vortex_access.application_role_template_continuities (
  organization_id, application_root_id, source_role_id, state,
  continuity_revision, source_template_fingerprint,
  last_processed_registration_revision, changed_at
) values (
  '24000000-0000-4000-8000-000000000001',
  '34000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000102', 'available', 1,
  'sha256:' || pg_catalog.repeat('6', 64), 1,
  pg_catalog.clock_timestamp()
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000103', 'application',
  'inherited_reader', '34000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000102', 1,
  '94000000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp()
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
) values (
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000103', 1, 1, 'application',
  '34000000-0000-4000-8000-000000000001',
  '34000000-0000-4000-8000-000000000001', 'application',
  '34000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000101', 'application',
  '34000000-0000-4000-8000-000000000001', 1,
  'sha256:' || pg_catalog.repeat('3', 64), 1,
  'sha256:' || pg_catalog.repeat('5', 64)
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
  '24000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000103', 1, 'application',
  '34000000-0000-4000-8000-000000000001', 'active', 'standard',
  'standing', 1, 1, 'inherited_reader', 'Inherited reader',
  'Neutral inherited-read role.', 'example.inherited_ownership', 1, '1.0.0',
  '1.0.0', 'sha256:' || pg_catalog.repeat('1', 64),
  'sha256:' || pg_catalog.repeat('2', 64),
  'sha256:' || pg_catalog.repeat('6', 64),
  'sha256:' || pg_catalog.repeat('3', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('7', 64),
  '94000000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4000000-0000-4000-8000-000000000022'
);

insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000103',
  '64000000-0000-4000-8000-000000000103', 'organization_account',
  '74000000-0000-4000-8000-000000000001', null, 'standing', 1,
  pg_catalog.clock_timestamp() - interval '1 minute',
  pg_catalog.clock_timestamp() + interval '30 minutes', 'live',
  '94000000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4000000-0000-4000-8000-000000000023',
  '94000000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(),
  'a4000000-0000-4000-8000-000000000023'
);

create table vortex_access.test_inherited_storage_bindings (
  organization_id uuid not null,
  application_root_id uuid not null,
  module_root_id uuid not null,
  record_type_id uuid not null,
  storage_contract_id uuid not null,
  storage_scope text not null,
  primary key (organization_id, application_root_id, module_root_id, record_type_id)
);
revoke all on table vortex_access.test_inherited_storage_bindings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

insert into vortex_access.test_inherited_storage_bindings values
  ('24000000-0000-4000-8000-000000000001',
   '34000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000001',
   '54000000-0000-4000-8000-000000000001',
   '64000000-0000-4000-8000-000000000001', 'application_contained'),
  ('24000000-0000-4000-8000-000000000001',
   '34000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000002',
   '54000000-0000-4000-8000-000000000002',
   '64000000-0000-4000-8000-000000000002', 'application_contained'),
  ('24000000-0000-4000-8000-000000000001',
   '34000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000003',
   '54000000-0000-4000-8000-000000000003',
   '64000000-0000-4000-8000-000000000003', 'application_contained'),
  ('24000000-0000-4000-8000-000000000001',
   '34000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000004',
   '54000000-0000-4000-8000-000000000004',
   '64000000-0000-4000-8000-000000000004', 'organization_shared');

create table vortex_access.test_inherited_records (
  record_id uuid primary key,
  record_scope jsonb not null,
  ownership_mode text not null,
  ownership_relationship_id uuid,
  owner_organization_account_id uuid,
  owner_group_id uuid,
  lifecycle_state text not null,
  is_root boolean not null
);
revoke all on table vortex_access.test_inherited_records
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

insert into vortex_access.test_inherited_records values
  (
    'd4000000-0000-4000-8000-000000000101',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000101',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000001', null, null,
    'active', true
  ),
  (
    'd4000000-0000-4000-8000-000000000102',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000102',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000001', null, null,
    'active', true
  ),
  (
    'd4000000-0000-4000-8000-000000000103',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000103',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000001', null, null,
    'active', true
  ),
  (
    'd4000000-0000-4000-8000-000000000104',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000104',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000001', null, null,
    'active', true
  ),
  (
    'd4000000-0000-4000-8000-000000000105',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000105',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000001', null, null,
    'active', true
  ),
  (
    'd4000000-0000-4000-8000-000000000106',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000106',
      '44000000-0000-4000-8000-000000000001',
      '54000000-0000-4000-8000-000000000001',
      '64000000-0000-4000-8000-000000000001'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000001', null, null,
    'active', true
  ),
  (
    'd4000000-0000-4000-8000-000000000201',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000201',
      '44000000-0000-4000-8000-000000000002',
      '54000000-0000-4000-8000-000000000002',
      '64000000-0000-4000-8000-000000000002'
    ),
    'inherited', 'c4000000-0000-4000-8000-000000000002', null, null,
    'active', false
  ),
  (
    'd4000000-0000-4000-8000-000000000301',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000301',
      '44000000-0000-4000-8000-000000000003',
      '54000000-0000-4000-8000-000000000003',
      '64000000-0000-4000-8000-000000000003'
    ),
    'organization_account', null,
    '74000000-0000-4000-8000-000000000001', null, 'active', false
  ),
  (
    'd4000000-0000-4000-8000-000000000302',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000302',
      '44000000-0000-4000-8000-000000000004',
      '54000000-0000-4000-8000-000000000004',
      '64000000-0000-4000-8000-000000000004', 'organization_shared'
    ),
    'team', null, null, '84000000-0000-4000-8000-000000000001',
    'active', false
  ),
  (
    'd4000000-0000-4000-8000-000000000303',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000303',
      '44000000-0000-4000-8000-000000000003',
      '54000000-0000-4000-8000-000000000003',
      '64000000-0000-4000-8000-000000000003'
    ),
    'organization_account', null,
    '74000000-0000-4000-8000-000000000002', null, 'active', false
  ),
  (
    'd4000000-0000-4000-8000-000000000304',
    pg_temp.record_identity(
      'd4000000-0000-4000-8000-000000000304',
      '44000000-0000-4000-8000-000000000005',
      '54000000-0000-4000-8000-000000000005',
      '64000000-0000-4000-8000-000000000005'
    ),
    'organization_account', null,
    '74000000-0000-4000-8000-000000000001', null, 'active', false
  );

create table vortex_access.test_inherited_relationship_targets (
  relationship_id uuid not null,
  from_module_root_id uuid not null,
  from_record_type_id uuid not null,
  to_module_root_id uuid not null,
  to_record_type_id uuid not null,
  primary key (relationship_id, to_module_root_id, to_record_type_id)
);
revoke all on table vortex_access.test_inherited_relationship_targets
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
insert into vortex_access.test_inherited_relationship_targets values
  ('c4000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000001',
   '54000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000003',
   '54000000-0000-4000-8000-000000000003'),
  ('c4000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000001',
   '54000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000002',
   '54000000-0000-4000-8000-000000000002'),
  ('c4000000-0000-4000-8000-000000000002',
   '44000000-0000-4000-8000-000000000002',
   '54000000-0000-4000-8000-000000000002',
   '44000000-0000-4000-8000-000000000004',
   '54000000-0000-4000-8000-000000000004'),
  ('c4000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000001',
   '54000000-0000-4000-8000-000000000001',
   '44000000-0000-4000-8000-000000000005',
   '54000000-0000-4000-8000-000000000005');

create table vortex_access.test_inherited_relationship_edges (
  edge_id uuid primary key,
  relationship_id uuid not null,
  from_record_id uuid not null,
  to_record_id uuid not null
);
revoke all on table vortex_access.test_inherited_relationship_edges
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
insert into vortex_access.test_inherited_relationship_edges values
  ('e4000000-0000-4000-8000-000000000001',
   'c4000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000101',
   'd4000000-0000-4000-8000-000000000301'),
  ('e4000000-0000-4000-8000-000000000002',
   'c4000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000102',
   'd4000000-0000-4000-8000-000000000201'),
  ('e4000000-0000-4000-8000-000000000003',
   'c4000000-0000-4000-8000-000000000002',
   'd4000000-0000-4000-8000-000000000201',
   'd4000000-0000-4000-8000-000000000302'),
  ('e4000000-0000-4000-8000-000000000004',
   'c4000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000103',
   'd4000000-0000-4000-8000-000000000303'),
  ('e4000000-0000-4000-8000-000000000005',
   'c4000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000104',
   'd4000000-0000-4000-8000-000000000301'),
  ('e4000000-0000-4000-8000-000000000006',
   'c4000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000104',
   'd4000000-0000-4000-8000-000000000303'),
  ('e4000000-0000-4000-8000-000000000007',
   'c4000000-0000-4000-8000-000000000001',
   'd4000000-0000-4000-8000-000000000106',
   'd4000000-0000-4000-8000-000000000304');

-- This parent is shared directly to the reader but owned by another account.
-- Inherited ownership must ignore that independent share contribution.
insert into vortex_access.organization_direct_record_shares (
  organization_id, direct_share_id, storage_scope, application_root_id,
  module_root_id, record_type_id, storage_contract_id, record_id,
  recipient_kind, organization_account_id, group_id, readable_field_ids,
  changeable_field_ids, starts_at, expires_at, state, revision, granted_by,
  granted_at, grant_correlation_id, reason, revoked_by, revoked_at,
  revocation_correlation_id, revocation_reason, changed_at
)
select
  '24000000-0000-4000-8000-000000000001',
  'b4000000-0000-4000-8000-000000000001', 'application_contained',
  '34000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000003',
  '54000000-0000-4000-8000-000000000003',
  '64000000-0000-4000-8000-000000000003',
  'd4000000-0000-4000-8000-000000000303', 'organization_account',
  '74000000-0000-4000-8000-000000000001', null,
  array['f4000000-0000-4000-8000-000000000001'::uuid], array[]::uuid[],
  time_row.value - interval '1 minute', null, 'active', 1,
  '74000000-0000-4000-8000-000000000002', time_row.value,
  'a4000000-0000-4000-8000-000000000031', 'Independent parent share',
  null, null, null, null, time_row.value
from inherited_times as time_row
where time_row.key = 'now';

create function pg_temp.record_read_declaration()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'operationKey', 'record.read',
    'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
    'target', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'applicationRootId', '34000000-0000-4000-8000-000000000001'
    ),
    'requiredPermission', pg_catalog.jsonb_build_object(
      'applicationRootId', '34000000-0000-4000-8000-000000000001',
      'ownerKind', 'application',
      'ownerId', '34000000-0000-4000-8000-000000000001',
      'permissionId', '64000000-0000-4000-8000-000000000101'
    ),
    'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
    'authority', pg_catalog.jsonb_build_object('kind', 'permission')
  )
$function$;

create function vortex_access.test_inherited_record_result(p_record_id uuid)
returns table (admitted boolean, valid_until timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  current_record record;
  binding record;
  matching_parent_ids uuid[];
  current_record_id uuid := p_record_id;
begin
  select * into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_temp.record_read_declaration()
  );
  if decision.outcome <> 'eligible' then
    raise exception using errcode = '42501', message = 'Record read is unavailable';
  end if;

  for depth in 1..8 loop
    select * into strict current_record
    from vortex_access.test_inherited_records as candidate
    where candidate.record_id = current_record_id
      and candidate.lifecycle_state = 'active';

    select * into binding
    from vortex_access.test_inherited_storage_bindings as stored_binding
    where stored_binding.organization_id = decision.organization_id
      and stored_binding.application_root_id = decision.target_application_root_id
      and stored_binding.module_root_id =
        (current_record.record_scope ->> 'moduleRootId')::uuid
      and stored_binding.record_type_id =
        (current_record.record_scope ->> 'recordTypeId')::uuid;
    if not found
      or binding.storage_contract_id <>
        (current_record.record_scope ->> 'storageContractId')::uuid
      or binding.storage_scope <> (current_record.record_scope ->> 'storageScope') then
      return query select false, null::timestamptz;
      return;
    end if;

    if current_record.ownership_mode <> 'inherited' then
      return query
      select visibility.admitted, visibility.valid_until
      from vortex_access.evaluate_current_record_ownership_visibility(
        '{"routes":[{"kind":"ownership"}]}'::jsonb,
        current_record.ownership_mode,
        binding.organization_id, binding.application_root_id,
        binding.module_root_id, binding.record_type_id,
        binding.storage_contract_id, binding.storage_scope,
        current_record.record_scope,
        current_record.owner_organization_account_id,
        current_record.owner_group_id,
        decision.organization_id, decision.target_application_root_id,
        decision.organization_account_id, decision.checked_at
      ) as visibility;
      return;
    end if;

    select pg_catalog.array_agg(parent.record_id order by edge.edge_id)
      into matching_parent_ids
    from vortex_access.test_inherited_relationship_edges as edge
    join vortex_access.test_inherited_records as parent
      on parent.record_id = edge.to_record_id
      and parent.lifecycle_state = 'active'
    join vortex_access.test_inherited_relationship_targets as declaration
      on declaration.relationship_id = current_record.ownership_relationship_id
      and declaration.from_module_root_id =
        (current_record.record_scope ->> 'moduleRootId')::uuid
      and declaration.from_record_type_id =
        (current_record.record_scope ->> 'recordTypeId')::uuid
      and declaration.to_module_root_id =
        (parent.record_scope ->> 'moduleRootId')::uuid
      and declaration.to_record_type_id =
        (parent.record_scope ->> 'recordTypeId')::uuid
    where edge.from_record_id = current_record_id
      and vortex_access.record_relationship_witness_matches(
        declaration.relationship_id, declaration.from_module_root_id,
        declaration.from_record_type_id, declaration.to_module_root_id,
        declaration.to_record_type_id, edge.relationship_id,
        edge.from_record_id, edge.to_record_id, current_record.record_scope,
        parent.record_scope, decision.organization_id,
        decision.target_application_root_id
      );

    if coalesce(pg_catalog.cardinality(matching_parent_ids), 0) <> 1 then
      return query select false, null::timestamptz;
      return;
    end if;
    current_record_id := matching_parent_ids[1];
  end loop;

  return query select false, null::timestamptz;
end
$function$;

revoke execute on function vortex_access.test_inherited_record_result(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

create function vortex_access.test_visible_inherited_records()
returns table (record_id uuid, valid_until timestamptz)
language sql
volatile
security definer
set search_path = ''
as $function$
  select candidate.record_id, result.valid_until
  from vortex_access.test_inherited_records as candidate
  cross join lateral vortex_access.test_inherited_record_result(
    candidate.record_id
  ) as result
  where candidate.is_root
    and result.admitted
  order by candidate.record_id
$function$;

revoke execute on function vortex_access.test_visible_inherited_records()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.test_visible_inherited_records()
  to vortex_request;
grant usage on schema extensions to vortex_request;

select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '84000000-0000-4000-8000-000000000101',
  'tenantId', '14000000-0000-4000-8000-000000000001',
  'organizationId', '24000000-0000-4000-8000-000000000001',
  'organizationAccountId', '74000000-0000-4000-8000-000000000001',
  'identityId', '44000000-0000-4000-8000-000000000101',
  'applicationRootId', '34000000-0000-4000-8000-000000000001',
  'sessionId', '64000000-0000-4000-8000-000000000199',
  'authenticationStrength', 'multi_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '1 hour',
  'accessVersion', (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '24000000-0000-4000-8000-000000000001'
  ),
  'correlationId', 'a4000000-0000-4000-8000-000000000099'
));

set local role vortex_request;
set local search_path = pg_catalog, extensions, public;
select results_eq(
  $$select record_id
    from vortex_access.test_visible_inherited_records()
    order by record_id$$,
  $$values
    ('d4000000-0000-4000-8000-000000000101'::uuid),
    ('d4000000-0000-4000-8000-000000000102'::uuid)$$,
  'the actual request role sees one- and two-hop inherited ownership only'
);
select is(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.test_inherited_record_result(uuid)', 'EXECUTE'
  ),
  false,
  'the request role cannot select a parent or relationship witness directly'
);
reset role;

select is(
  (
    select valid_until
    from vortex_access.test_visible_inherited_records()
    where record_id = 'd4000000-0000-4000-8000-000000000101'
  ),
  null::timestamptz,
  'direct account ownership adds no artificial inherited deadline'
);
select is(
  (
    select valid_until
    from vortex_access.test_visible_inherited_records()
    where record_id = 'd4000000-0000-4000-8000-000000000102'
  ),
  (select value from inherited_times where key = 'membership_expiry'),
  'two-hop Group ownership retains the current membership deadline'
);
select is(
  (
    select admitted
    from vortex_access.test_inherited_record_result(
      'd4000000-0000-4000-8000-000000000103'
    )
  ),
  false,
  'a direct share of the parent does not establish child ownership'
);
select is(
  (
    select admitted
    from vortex_access.test_inherited_record_result(
      'd4000000-0000-4000-8000-000000000104'
    )
  ),
  false,
  'duplicate factual edges cannot grant inherited ownership'
);
select is(
  (
    select admitted
    from vortex_access.test_inherited_record_result(
      'd4000000-0000-4000-8000-000000000105'
    )
  ),
  false,
  'a missing factual edge cannot grant inherited ownership'
);
select is(
  (
    select admitted
    from vortex_access.test_inherited_record_result(
      'd4000000-0000-4000-8000-000000000106'
    )
  ),
  false,
  'an unbound terminal parent cannot grant inherited ownership'
);

set constraints all immediate;

select * from finish();

rollback;
