\ir helpers/private-schema-assertions.psql

select no_plan();

begin;

set local search_path = pg_catalog, extensions, public;

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_table(
  'vortex_access', 'organization_roles',
  'Access has one private current pointer per organisation-owned role'
);
select has_table(
  'vortex_access', 'organization_role_activation_policy_revisions',
  'Access preserves immutable role-scoped activation policy revisions'
);
select has_table(
  'vortex_access', 'organization_role_revisions',
  'Access preserves immutable role revisions'
);
select has_table(
  'vortex_access', 'organization_role_permission_entries',
  'Access preserves immutable exact permissions per role revision'
);
select has_table(
  'vortex_access', 'permission_continuities',
  'Access retains exact permission continuity and tombstones'
);
select has_table(
  'vortex_access', 'application_role_template_continuities',
  'Access retains exact application-template continuity and tombstones'
);

select has_pk(
  'vortex_access', 'organization_roles',
  'role current pointers are organisation qualified'
);
select has_pk(
  'vortex_access', 'organization_role_activation_policy_revisions',
  'activation policy revisions are organisation and role qualified'
);
select has_pk(
  'vortex_access', 'organization_role_revisions',
  'role history is organisation, role and revision qualified'
);
select has_pk(
  'vortex_access', 'organization_role_permission_entries',
  'accepted entries preserve deterministic ordinal identity'
);
select has_pk(
  'vortex_access', 'permission_continuities',
  'permission continuity is exact-scope qualified'
);
select has_pk(
  'vortex_access', 'application_role_template_continuities',
  'template continuity is application and source-role qualified'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_class
    where oid in (
      'vortex_access.organization_roles'::regclass,
      'vortex_access.organization_role_activation_policy_revisions'::regclass,
      'vortex_access.organization_role_revisions'::regclass,
      'vortex_access.organization_role_permission_entries'::regclass,
      'vortex_access.permission_continuities'::regclass,
      'vortex_access.application_role_template_continuities'::regclass
    )
      and relrowsecurity
      and relforcerowsecurity
  ),
  6,
  'all role-catalogue relations enable and force row security'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'vortex_access'
      and tablename in (
        'organization_roles',
        'organization_role_activation_policy_revisions',
        'organization_role_revisions',
        'organization_role_permission_entries',
        'permission_continuities',
        'application_role_template_continuities'
      )
  ),
  0,
  'no direct row policy exposes inert role-catalogue storage'
);

select ok(
  not pg_catalog.has_table_privilege(
    'anon', 'vortex_access.organization_roles', 'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'vortex_access.organization_role_activation_policy_revisions',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'vortex_access.organization_role_revisions',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'vortex_access.organization_role_permission_entries',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'vortex_runtime', 'vortex_access.permission_continuities',
    'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.application_role_template_continuities',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'browser, service, runtime and request roles hold no role-storage privilege'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values
        ('anon'::text),
        ('authenticated'::text),
        ('service_role'::text),
        ('vortex_runtime'::text),
        ('vortex_request'::text)
    ) as denied(role_name)
    cross join (
      values
        ('vortex_access.organization_roles'::regclass),
        ('vortex_access.organization_role_activation_policy_revisions'::regclass),
        ('vortex_access.organization_role_revisions'::regclass),
        ('vortex_access.organization_role_permission_entries'::regclass),
        ('vortex_access.permission_continuities'::regclass),
        ('vortex_access.application_role_template_continuities'::regclass)
    ) as relation(relation_id)
    where pg_catalog.has_table_privilege(
      denied.role_name::name, relation.relation_id::oid, 'SELECT,INSERT,UPDATE,DELETE'
    )
  ),
  0,
  'every non-owner role is denied every inert role-catalogue table'
);

select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_access.protect_organization_role_identity()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.validate_organization_role_revision_evidence()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_access.protect_permission_continuity()', 'EXECUTE'
  ),
  'defensive storage triggers are not callable by shipping roles'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from (
      values
        ('anon'::text),
        ('authenticated'::text),
        ('service_role'::text),
        ('vortex_runtime'::text),
        ('vortex_request'::text)
    ) as denied(role_name)
    cross join (
      values
        ('vortex_access.protect_organization_role_identity()'::regprocedure),
        ('vortex_access.refuse_organization_role_history_mutation()'::regprocedure),
        ('vortex_access.validate_organization_role_revision_evidence()'::regprocedure),
        ('vortex_access.protect_permission_continuity()'::regprocedure),
        ('vortex_access.validate_permission_continuity_evidence()'::regprocedure),
        ('vortex_access.protect_application_role_template_continuity()'::regprocedure),
        ('vortex_access.validate_application_role_template_continuity_evidence()'::regprocedure)
    ) as operation(operation_id)
    where pg_catalog.has_function_privilege(
      denied.role_name::name, operation.operation_id::oid, 'EXECUTE'
    )
  ),
  0,
  'every defensive role-storage trigger is owner-only'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_roles
  ),
  0,
  'the storage migration creates no implicit role'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_activation_policy_revisions
  ),
  0,
  'the storage migration creates no activation policy authority'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11000000-0000-4000-8000-000000000140', 'role_storage_tenant',
  'Role storage tenant', 'active', pg_catalog.statement_timestamp(),
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '21000000-0000-4000-8000-000000000140',
    '11000000-0000-4000-8000-000000000140', null, 'role_storage_one',
    'Role storage organisation one', 'active', pg_catalog.statement_timestamp(),
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(), 1
  ),
  (
    '21000000-0000-4000-8000-000000000141',
    '11000000-0000-4000-8000-000000000140', null, 'role_storage_two',
    'Role storage organisation two', 'active', pg_catalog.statement_timestamp(),
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(), 1
  );

select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000140',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000140'
);
select * from vortex_access.initialize_organization_access_version(
  '21000000-0000-4000-8000-000000000141',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000141'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21000000-0000-4000-8000-000000000140',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000142'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '21000000-0000-4000-8000-000000000141',
  '91000000-0000-4000-8000-000000000140',
  '71000000-0000-4000-8000-000000000143'
);

create function pg_temp.add_application_registration_revision(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_revision bigint,
  p_state text,
  p_meaning_fingerprint text default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision, state,
    operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, p_revision, p_state,
    case when p_state = 'withdrawn' then 'withdraw'
      when p_revision = 1 then 'register' else 'update' end,
    'example.role_storage', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('c', 64),
    'sha256:' || pg_catalog.repeat('d', 64),
    pg_catalog.statement_timestamp(),
    '91000000-0000-4000-8000-000000000140',
    ('71000000-0000-4000-8000-' || pg_catalog.lpad((150 + p_revision)::text, 12, '0'))::uuid
  );

  if p_meaning_fingerprint is not null then
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
      p_revision, p_application_root_id, 'application', p_application_root_id,
      '41000000-0000-4000-8000-000000000140', 'example.records.read',
      'Read records', 'Read application records.', null, 'read', null, false,
      'application', 'example.role_storage', p_application_root_id, '1.0.0', 1,
      '1.0.0', 'sha256:' || pg_catalog.repeat('a', 64),
      'sha256:' || pg_catalog.repeat('b', 64), null, p_meaning_fingerprint
    );
  end if;
end;
$$;

select pg_temp.add_application_registration_revision(
  '21000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140', 1, 'active',
  'sha256:' || pg_catalog.repeat('e', 64)
);
select pg_temp.add_application_registration_revision(
  '21000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140', 2, 'active', null
);
select pg_temp.add_application_registration_revision(
  '21000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140', 3, 'active',
  'sha256:' || pg_catalog.repeat('e', 64)
);
select pg_temp.add_application_registration_revision(
  '21000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140', 4, 'active',
  'sha256:' || pg_catalog.repeat('e', 64)
);
select pg_temp.add_application_registration_revision(
  '21000000-0000-4000-8000-000000000141',
  '31000000-0000-4000-8000-000000000140', 1, 'active',
  'sha256:' || pg_catalog.repeat('e', 64)
);
select pg_temp.add_application_registration_revision(
  '21000000-0000-4000-8000-000000000141',
  '31000000-0000-4000-8000-000000000141', 1, 'active',
  'sha256:' || pg_catalog.repeat('e', 64)
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000140', 'application', 'records_reader',
  '31000000-0000-4000-8000-000000000140',
  '52000000-0000-4000-8000-000000000140', 1,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000140', 1, 'application',
  '31000000-0000-4000-8000-000000000140', 'active',
  'standard', 'standing', 1, 'records_reader', 'Records reader',
  'Read records in this organisation.', 'example.role_storage', 1, '1.0.0',
  '1.0.0', 'sha256:' || pg_catalog.repeat('a', 64),
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('f', 64),
  'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('0', 64),
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000160'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000140', 1, 1, 'application',
  '31000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140', 'application',
  '31000000-0000-4000-8000-000000000140',
  '41000000-0000-4000-8000-000000000140', 'application',
  '31000000-0000-4000-8000-000000000140', 1,
  'sha256:' || pg_catalog.repeat('c', 64), 1,
  'sha256:' || pg_catalog.repeat('e', 64)
);

set constraints all immediate;
set constraints all deferred;

select is(
  (
    select lifecycle
    from vortex_access.organization_role_revisions
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000140'
      and revision = 1
  ),
  'active',
  'an application role preserves exact accepted source and permission evidence'
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
)
select
  organization_id, role_id, 2, role_kind, application_root_id,
  'acceptance_required', privilege_classification, assignment_policy,
  policy_continuity_revision, role_key, label, description, source_definition_key,
  source_release_revision, source_release_version,
  source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, source_template_fingerprint,
  source_catalogue_fingerprint, accepted_registration_revision,
  template_continuity_revision, accepted_grant_fingerprint,
  '91000000-0000-4000-8000-000000000140'::uuid,
  pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000168'::uuid
from vortex_access.organization_role_revisions
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000140'
  and revision = 1;

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select
  organization_id, role_id, 2, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
from vortex_access.organization_role_permission_entries
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000140'
  and role_revision = 1;

update vortex_access.organization_roles
set live_revision = 2
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000140';

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select revision.lifecycle, pg_catalog.count(permission.permission_id)::bigint
    from vortex_access.organization_role_revisions as revision
    left join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    where revision.organization_id = '21000000-0000-4000-8000-000000000140'
      and revision.role_id = '51000000-0000-4000-8000-000000000140'
      and revision.revision = 2
    group by revision.lifecycle
  $$,
  $$ values ('acceptance_required'::text, 1::bigint) $$,
  'acceptance-required roles retain their continuously accepted permission intersection'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000149', 'custom', 'platform_reader', 1,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle, role_key, label, description,
  privilege_classification, assignment_policy, policy_continuity_revision,
  changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000149', 1, 'custom', 'active',
  'platform_reader', 'Platform reader', 'Read organisation access metadata.',
  'privileged', 'standing', 1,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000169'
);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select
  '21000000-0000-4000-8000-000000000140'::uuid,
  '51000000-0000-4000-8000-000000000149'::uuid, 1, 1, 'custom', null,
  entry.owner_kind, entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '21000000-0000-4000-8000-000000000140'
  and entry.registration_kind = 'platform'
  and entry.permission_id = '687d5649-62ee-43dd-b684-b8af3a5394c1';

set constraints all immediate;
set constraints all deferred;

select is(
  (
    select role_kind || ':' || privilege_classification || ':' || assignment_policy
    from vortex_access.organization_role_revisions
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000149'
  ),
  'custom:privileged:standing',
  'an administrative platform permission forces explicit privileged standing policy'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000148', 'custom', 'activation_reader', 1,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148',
    '61000000-0000-4000-8000-000000000140', 1,
    'sha256:' || pg_catalog.repeat('7', 64), 3600, true, 'primary', 300, false,
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000174'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148',
    '61000000-0000-4000-8000-000000000140', 2,
    'sha256:' || pg_catalog.repeat('8', 64), 1800, true, 'multi_factor', 600, true,
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000175'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148',
    '61000000-0000-4000-8000-000000000141', 1,
    'sha256:' || pg_catalog.repeat('6', 64), 9007199254740991, false, 'none', null, false,
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000176'
  );

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  activation_policy_id, activation_policy_revision, activation_policy_fingerprint,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', 1, 'custom', 'active',
    'standard', 'standing', 1, null, null, null,
    'activation_reader', 'Activation reader', 'A standard role with explicit policy history.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000177'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', 2, 'custom', 'active',
    'standard', 'activation_required', 2,
    '61000000-0000-4000-8000-000000000140', 1,
    'sha256:' || pg_catalog.repeat('7', 64),
    'activation_reader', 'Activation reader', 'Standard roles may require activation.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000178'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', 3, 'custom', 'active',
    'privileged', 'activation_required', 2,
    '61000000-0000-4000-8000-000000000140', 1,
    'sha256:' || pg_catalog.repeat('7', 64),
    'activation_reader', 'Privileged activation reader',
    'Classification alone does not invent a new policy epoch.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000179'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', 4, 'custom', 'active',
    'privileged', 'activation_required', 3,
    '61000000-0000-4000-8000-000000000140', 2,
    'sha256:' || pg_catalog.repeat('8', 64),
    'activation_reader', 'Privileged activation reader', 'The exact policy revision changed.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000180'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', 5, 'custom', 'active',
    'privileged', 'standing', 4, null, null, null,
    'activation_reader', 'Privileged standing reader', 'Standing policy carries no policy reference.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000181'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', 6, 'custom', 'active',
    'privileged', 'activation_required', 5,
    '61000000-0000-4000-8000-000000000140', 1,
    'sha256:' || pg_catalog.repeat('7', 64),
    'activation_reader', 'Privileged activation reader',
    'Returning to old policy bytes still advances continuity.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000182'
  );

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select
  '21000000-0000-4000-8000-000000000140'::uuid,
  '51000000-0000-4000-8000-000000000148'::uuid,
  target_revision.revision, 1, 'custom', entry.application_root_id,
  entry.owner_kind, entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
from pg_catalog.generate_series(1, 6) as target_revision(revision)
cross join vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '21000000-0000-4000-8000-000000000140'
  and entry.registration_kind = 'application'
  and entry.registration_revision = 1
  and entry.permission_id = '41000000-0000-4000-8000-000000000140';

set constraints all immediate;
set constraints all deferred;

update vortex_access.organization_roles set live_revision = 2
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000148';
update vortex_access.organization_roles set live_revision = 3
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000148';
update vortex_access.organization_roles set live_revision = 4
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000148';
update vortex_access.organization_roles set live_revision = 5
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000148';
update vortex_access.organization_roles set live_revision = 6
where organization_id = '21000000-0000-4000-8000-000000000140'
  and role_id = '51000000-0000-4000-8000-000000000148';

set constraints all immediate;
set constraints all deferred;

select results_eq(
  $$
    select revision, privilege_classification, assignment_policy,
      policy_continuity_revision, activation_policy_revision
    from vortex_access.organization_role_revisions
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000148'
    order by revision
  $$,
  $$ values
    (1::bigint, 'standard'::text, 'standing'::text, 1::bigint, null::bigint),
    (2::bigint, 'standard'::text, 'activation_required'::text, 2::bigint, 1::bigint),
    (3::bigint, 'privileged'::text, 'activation_required'::text, 2::bigint, 1::bigint),
    (4::bigint, 'privileged'::text, 'activation_required'::text, 3::bigint, 2::bigint),
    (5::bigint, 'privileged'::text, 'standing'::text, 4::bigint, null::bigint),
    (6::bigint, 'privileged'::text, 'activation_required'::text, 5::bigint, 1::bigint)
  $$,
  'classification, assignment policy, exact policy evidence and ABA continuity are independent'
);

select throws_ok(
  $$
    update vortex_access.organization_role_activation_policy_revisions
    set maximum_activation_duration_seconds = 7200
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000148'
      and activation_policy_id = '61000000-0000-4000-8000-000000000140'
      and revision = 1
  $$,
  '23514'::char(5), null,
  'activation policy history cannot be rewritten'
);

select throws_ok(
  $$
    delete from vortex_access.organization_role_activation_policy_revisions
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000148'
      and activation_policy_id = '61000000-0000-4000-8000-000000000140'
      and revision = 2
  $$,
  '23514'::char(5), null,
  'activation policy history cannot be erased'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000142', 1,
      'sha256:' || pg_catalog.repeat('1', 64), 0, false, 'none', null, false,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000183'
    )
  $$,
  '23514'::char(5), null,
  'activation duration must be positive'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000143', 1,
      'sha256:' || pg_catalog.repeat('2', 64), 9007199254740992, false,
      'none', null, false,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000184'
    )
  $$,
  '23514'::char(5), null,
  'activation duration must remain JavaScript-safe'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000144', 1,
      'sha256:' || pg_catalog.repeat('3', 64), 3600, false, 'none', 300, false,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000185'
    )
  $$,
  '23514'::char(5), null,
  'no recent-authentication requirement forbids an age'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000145', 1,
      'sha256:' || pg_catalog.repeat('4', 64), 3600, false, 'primary', null, false,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000186'
    )
  $$,
  '23514'::char(5), null,
  'required recent authentication requires a maximum age'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000146', 1,
      'sha256:' || pg_catalog.repeat('5', 64), 3600, false,
      'multi_factor', 9007199254740992, false,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000187'
    )
  $$,
  '23514'::char(5), null,
  'authentication maximum age must remain JavaScript-safe'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000148', 1,
      'sha256:' || pg_catalog.repeat('5', 64), 3600, false,
      'recent_multi_factor', 300, false,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000196'
    )
  $$,
  '23514'::char(5), null,
  'activation policy authentication requirements reject unknown and legacy labels'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_activation_policy_revisions (
      organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
      maximum_activation_duration_seconds, reason_required,
      authentication_requirement, authentication_maximum_age_seconds,
      independent_approval_required, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148',
      '61000000-0000-4000-8000-000000000147', 1,
      'sha256:' || pg_catalog.repeat('6', 64), 3600, false, 'none', null, false,
      '91000000-0000-4000-8000-000000000140', 'infinity'::timestamptz,
      '71000000-0000-4000-8000-000000000188'
    )
  $$,
  '23514'::char(5), null,
  'activation policy evidence time must be finite'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, lifecycle,
      privilege_classification, assignment_policy, policy_continuity_revision,
      activation_policy_id, activation_policy_revision, activation_policy_fingerprint,
      role_key, label, description, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148', 7, 'custom', 'active',
      'privileged', 'standing', 6,
      '61000000-0000-4000-8000-000000000140', 1,
      'sha256:' || pg_catalog.repeat('7', 64),
      'activation_reader', 'Invalid standing reader', 'Standing must not pin policy evidence.',
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000189'
    )
  $$,
  '23514'::char(5), null,
  'standing assignment policy forbids an activation policy reference'
);

select throws_ok(
  $$
    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, lifecycle,
      privilege_classification, assignment_policy, policy_continuity_revision,
      activation_policy_id, activation_policy_revision, activation_policy_fingerprint,
      role_key, label, description, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000148', 7, 'custom', 'active',
      'privileged', 'activation_required', 6,
      '61000000-0000-4000-8000-000000000140', null, null,
      'activation_reader', 'Incomplete activation reader',
      'Activation-required policy evidence must be complete.',
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000190'
    )
  $$,
  '23514'::char(5), null,
  'activation-required assignment policy rejects partial policy evidence'
);

create function pg_temp.add_activation_reader_candidate(
  p_revision bigint,
  p_policy_continuity_revision bigint,
  p_activation_policy_id uuid,
  p_activation_policy_revision bigint,
  p_activation_policy_fingerprint text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy, policy_continuity_revision,
    activation_policy_id, activation_policy_revision, activation_policy_fingerprint,
    role_key, label, description, changed_by, changed_at, change_correlation_id
  ) values (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000148', p_revision, 'custom', 'active',
    'privileged', 'activation_required', p_policy_continuity_revision,
    p_activation_policy_id, p_activation_policy_revision, p_activation_policy_fingerprint,
    'activation_reader', 'Activation reader', 'Candidate policy continuity revision.',
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000191'
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select
    organization_id, role_id, p_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  from vortex_access.organization_role_permission_entries
  where organization_id = '21000000-0000-4000-8000-000000000140'
    and role_id = '51000000-0000-4000-8000-000000000148'
    and role_revision = 6;
end;
$$;

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        7, 6, '61000000-0000-4000-8000-000000000140', 1,
        'sha256:' || pg_catalog.repeat('7', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'unchanged exact activation policy cannot invent a new continuity epoch'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        7, 5, '61000000-0000-4000-8000-000000000140', 2,
        'sha256:' || pg_catalog.repeat('8', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'changed exact activation policy cannot reuse an old continuity epoch'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        8, 6, '61000000-0000-4000-8000-000000000140', 2,
        'sha256:' || pg_catalog.repeat('8', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'a later role revision cannot skip its immediate predecessor'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        7, 6, '61000000-0000-4000-8000-000000000140', 1,
        'sha256:' || pg_catalog.repeat('0', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23503'::char(5), null,
  'an activation-required role pins the exact policy fingerprint'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        7, 6, '61000000-0000-4000-8000-000000000140', 99,
        'sha256:' || pg_catalog.repeat('7', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23503'::char(5), null,
  'an activation-required role pins the exact policy revision'
);
set constraints all deferred;

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000140',
  '51000000-0000-4000-8000-000000000149',
  '61000000-0000-4000-8000-000000000149', 1,
  'sha256:' || pg_catalog.repeat('1', 64), 3600, false, 'none', null, false,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000194'
);

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        7, 6, '61000000-0000-4000-8000-000000000149', 1,
        'sha256:' || pg_catalog.repeat('1', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23503'::char(5), null,
  'an activation-required role cannot borrow policy evidence from another role'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
        organization_id, role_id, role_kind, role_key, live_revision,
        created_by, created_at
      ) values (
        '21000000-0000-4000-8000-000000000140',
        '51000000-0000-4000-8000-000000000146', 'custom', 'invalid_initial_epoch', 1,
        '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
      );
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, lifecycle,
        privilege_classification, assignment_policy, policy_continuity_revision,
        role_key, label, description, changed_by, changed_at, change_correlation_id
      ) values (
        '21000000-0000-4000-8000-000000000140',
        '51000000-0000-4000-8000-000000000146', 1, 'custom', 'active',
        'standard', 'standing', 2, 'invalid_initial_epoch', 'Invalid initial epoch',
        'Initial role and policy continuity revisions must both start at one.',
        '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000192'
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'an initial role revision must start at policy continuity revision one'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
        organization_id, role_id, role_kind, role_key, live_revision,
        created_by, created_at
      ) values (
        '21000000-0000-4000-8000-000000000140',
        '51000000-0000-4000-8000-000000000146', 'custom', 'standard_admin', 1,
        '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
      );
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, lifecycle,
        privilege_classification, assignment_policy, policy_continuity_revision,
        role_key, label, description, changed_by, changed_at, change_correlation_id
      ) values (
        '21000000-0000-4000-8000-000000000140',
        '51000000-0000-4000-8000-000000000146', 1, 'custom', 'active',
        'standard', 'standing', 1, 'standard_admin', 'Standard administrator',
        'Administrative accepted permissions cannot remain standard.',
        '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000193'
      );
      insert into vortex_access.organization_role_permission_entries (
        organization_id, role_id, role_revision, entry_ordinal, role_kind,
        application_root_id, owner_kind, owner_id, permission_id, registration_kind,
        registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
        continuity_revision, meaning_fingerprint
      )
      select
        entry.organization_id,
        '51000000-0000-4000-8000-000000000146'::uuid, 1, 1, 'custom', null,
        entry.owner_kind, entry.owner_id, entry.permission_id, entry.registration_kind,
        entry.registration_owner_id, entry.registration_revision,
        registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
      from vortex_access.permission_catalogue_entries as entry
      join vortex_access.permission_registration_revisions as registration
        on registration.organization_id = entry.organization_id
        and registration.registration_kind = entry.registration_kind
        and registration.registration_owner_id = entry.registration_owner_id
        and registration.revision = entry.registration_revision
      where entry.organization_id = '21000000-0000-4000-8000-000000000140'
        and entry.registration_kind = 'platform'
        and entry.administrative
      order by entry.permission_id
      limit 1;
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'canonical administrative permission evidence imposes the privileged classification floor'
);
set constraints all deferred;

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000141', 'application', 'empty_unavailable',
    '31000000-0000-4000-8000-000000000140',
    '52000000-0000-4000-8000-000000000141', 1,
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000142', 'application', 'empty_retired',
    '31000000-0000-4000-8000-000000000140',
    '52000000-0000-4000-8000-000000000142', 1,
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
  );

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
) values
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000141', 1, 'application',
    '31000000-0000-4000-8000-000000000140', 'unavailable',
    'standard', 'standing', 1, 'empty_unavailable',
    'Unavailable wildcard', 'No live permissions survived the projection.',
    'example.role_storage', 1, '1.0.0', '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('2', 64),
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000161'
  ),
  (
    '21000000-0000-4000-8000-000000000140',
    '51000000-0000-4000-8000-000000000142', 1, 'application',
    '31000000-0000-4000-8000-000000000140', 'retired',
    'standard', 'standing', 1, 'empty_retired',
    'Retired application role', 'Retired without effective permissions.',
    'example.role_storage', 1, '1.0.0', '1.0.0',
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
    'sha256:' || pg_catalog.repeat('4', 64),
    '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
    '71000000-0000-4000-8000-000000000162'
  );

set constraints all immediate;
set constraints all deferred;

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_role_permission_entries
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id in (
        '51000000-0000-4000-8000-000000000141'::uuid,
        '51000000-0000-4000-8000-000000000142'::uuid
      )
  ),
  0,
  'unavailable and retired application roles may retain an empty effective snapshot'
);

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, application_root_id,
  source_role_id, live_revision, created_by, created_at
) values (
  '21000000-0000-4000-8000-000000000141',
  '51000000-0000-4000-8000-000000000140', 'application', 'records_reader',
  '31000000-0000-4000-8000-000000000140',
  '52000000-0000-4000-8000-000000000140', 1,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  role_key, label, description, source_definition_key, source_release_revision,
  source_release_version, source_validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint,
  source_template_fingerprint, source_catalogue_fingerprint,
  accepted_registration_revision, template_continuity_revision,
  accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000141',
  '51000000-0000-4000-8000-000000000140', 1, 'application',
  '31000000-0000-4000-8000-000000000140', 'unavailable',
  'standard', 'standing', 1, 'records_reader', 'Records reader',
  'Same local key in another organisation.', 'example.role_storage', 1, '1.0.0',
  '1.0.0', 'sha256:' || pg_catalog.repeat('a', 64),
  'sha256:' || pg_catalog.repeat('b', 64),
  'sha256:' || pg_catalog.repeat('f', 64),
  'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
  'sha256:' || pg_catalog.repeat('0', 64),
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000170'
);

set constraints all immediate;
set constraints all deferred;

select is(
  (
    select pg_catalog.count(distinct organization_id)::integer
    from vortex_access.organization_roles
    where role_id = '51000000-0000-4000-8000-000000000140'
      and role_key = 'records_reader'
  ),
  2,
  'matching role identity, key and template source remain organisation qualified'
);

insert into vortex_access.organization_role_activation_policy_revisions (
  organization_id, role_id, activation_policy_id, revision, policy_fingerprint,
  maximum_activation_duration_seconds, reason_required,
  authentication_requirement, authentication_maximum_age_seconds,
  independent_approval_required, changed_by, changed_at, change_correlation_id
) values (
  '21000000-0000-4000-8000-000000000141',
  '51000000-0000-4000-8000-000000000140',
  '61000000-0000-4000-8000-000000000150', 1,
  'sha256:' || pg_catalog.repeat('2', 64), 3600, false, 'none', null, false,
  '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
  '71000000-0000-4000-8000-000000000195'
);

select throws_ok(
  $test$
    do $body$
    begin
      perform pg_temp.add_activation_reader_candidate(
        7, 6, '61000000-0000-4000-8000-000000000150', 1,
        'sha256:' || pg_catalog.repeat('2', 64)
      );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23503'::char(5), null,
  'an activation-required role cannot borrow policy evidence from another organisation'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, live_revision, created_by, created_at
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000143', 'application', 'empty_active',
      '31000000-0000-4000-8000-000000000140',
      '52000000-0000-4000-8000-000000000143', 1,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
    );
      insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
      privilege_classification, assignment_policy, policy_continuity_revision,
      role_key, label, description, source_definition_key, source_release_revision,
      source_release_version, source_validation_contract_version,
      source_content_fingerprint, source_resolution_fingerprint,
      source_template_fingerprint, source_catalogue_fingerprint,
      accepted_registration_revision, template_continuity_revision,
      accepted_grant_fingerprint, changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000143', 1, 'application',
      '31000000-0000-4000-8000-000000000140', 'active',
      'standard', 'standing', 1, 'empty_active', 'Empty active',
      'An invalid active role without permissions.', 'example.role_storage', 1,
      '1.0.0', '1.0.0', 'sha256:' || pg_catalog.repeat('a', 64),
      'sha256:' || pg_catalog.repeat('b', 64),
      'sha256:' || pg_catalog.repeat('5', 64),
      'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
      'sha256:' || pg_catalog.repeat('6', 64),
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000163'
    );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'an active application role cannot commit an empty accepted snapshot'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, live_revision, created_by, created_at
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000144', 'application', 'foreign_source',
      '31000000-0000-4000-8000-000000000141',
      '52000000-0000-4000-8000-000000000144', 1,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
    );
      insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, role_key, label, description, source_definition_key,
      source_release_revision, source_release_version,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_template_fingerprint,
      source_catalogue_fingerprint, accepted_registration_revision,
      template_continuity_revision, accepted_grant_fingerprint,
      changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000144', 1, 'application',
      '31000000-0000-4000-8000-000000000141', 'unavailable',
      'standard', 'standing', 1, 'foreign_source',
      'Foreign source', 'Must not borrow another organisation registration.',
      'example.role_storage', 1, '1.0.0', '1.0.0',
      'sha256:' || pg_catalog.repeat('a', 64),
      'sha256:' || pg_catalog.repeat('b', 64),
      'sha256:' || pg_catalog.repeat('f', 64),
      'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
      'sha256:' || pg_catalog.repeat('0', 64),
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000171'
    );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23503'::char(5), null,
  'an application role cannot borrow another organisation registration'
);
set constraints all deferred;

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_roles (
      organization_id, role_id, role_kind, role_key, application_root_id,
      source_role_id, live_revision, created_by, created_at
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000145', 'application', 'changed_source',
      '31000000-0000-4000-8000-000000000140',
      '52000000-0000-4000-8000-000000000145', 1,
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp()
    );
      insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, role_key, label, description, source_definition_key,
      source_release_revision, source_release_version,
      source_validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, source_template_fingerprint,
      source_catalogue_fingerprint, accepted_registration_revision,
      template_continuity_revision, accepted_grant_fingerprint,
      changed_by, changed_at, change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000145', 1, 'application',
      '31000000-0000-4000-8000-000000000140', 'unavailable',
      'standard', 'standing', 1, 'changed_source',
      'Changed source', 'Must preserve exact registration source evidence.',
      'example.role_storage', 1, '1.0.0', '1.0.0',
      'sha256:' || pg_catalog.repeat('9', 64),
      'sha256:' || pg_catalog.repeat('b', 64),
      'sha256:' || pg_catalog.repeat('f', 64),
      'sha256:' || pg_catalog.repeat('c', 64), 1, 1,
      'sha256:' || pg_catalog.repeat('0', 64),
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000172'
    );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'application role source evidence must match its accepted registration revision'
);
set constraints all deferred;

select throws_ok(
  $$
    insert into vortex_access.organization_role_revisions (
      organization_id, role_id, revision, role_kind, application_root_id,
      lifecycle, privilege_classification, assignment_policy,
      policy_continuity_revision, role_key, label, description, changed_by, changed_at,
      change_correlation_id
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000140', 2, 'custom', null,
      'acceptance_required', 'standard', 'standing', 1, 'wrong_kind', 'Wrong kind',
      'Custom roles do not use this state.',
      '91000000-0000-4000-8000-000000000140', pg_catalog.statement_timestamp(),
      '71000000-0000-4000-8000-000000000164'
    )
  $$,
  '23514'::char(5), null,
  'a custom role cannot enter an application-only lifecycle'
);

select throws_ok(
  $$
    update vortex_access.organization_role_revisions
    set label = 'Rewritten history'
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000140'
      and revision = 1
  $$,
  '23514'::char(5), null,
  'role revisions cannot be rewritten'
);

select throws_ok(
  $$
    delete from vortex_access.organization_role_permission_entries
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000140'
      and role_revision = 1
  $$,
  '23514'::char(5), null,
  'accepted role permission evidence cannot be erased'
);

select throws_ok(
  $$
    update vortex_access.organization_roles
    set source_role_id = '52000000-0000-4000-8000-000000000199',
      live_revision = 3
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and role_id = '51000000-0000-4000-8000-000000000140'
  $$,
  '23514'::char(5), null,
  'a current revision change cannot rewrite permanent template identity'
);

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.organization_role_revisions (
        organization_id, role_id, revision, role_kind, application_root_id,
        lifecycle, privilege_classification, assignment_policy,
        policy_continuity_revision, role_key, label, description, source_definition_key,
        source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        changed_by, changed_at, change_correlation_id
      )
      select
        organization_id, role_id, 3, role_kind, application_root_id,
        'unavailable', privilege_classification, assignment_policy,
        policy_continuity_revision, role_key, label, description, source_definition_key,
        source_release_revision, source_release_version,
        source_validation_contract_version, source_content_fingerprint,
        source_resolution_fingerprint, source_template_fingerprint,
        source_catalogue_fingerprint, accepted_registration_revision,
        template_continuity_revision, accepted_grant_fingerprint,
        '91000000-0000-4000-8000-000000000140'::uuid,
        pg_catalog.statement_timestamp(),
        '71000000-0000-4000-8000-000000000173'::uuid
      from vortex_access.organization_role_revisions
      where organization_id = '21000000-0000-4000-8000-000000000140'
        and role_id = '51000000-0000-4000-8000-000000000140'
        and revision = 2;

      insert into vortex_access.organization_role_permission_entries (
      organization_id, role_id, role_revision, entry_ordinal, role_kind,
      role_application_root_id, application_root_id, owner_kind, owner_id,
      permission_id, registration_kind, registration_owner_id,
      accepted_registration_revision, catalogue_fingerprint,
      continuity_revision, meaning_fingerprint
    ) values (
      '21000000-0000-4000-8000-000000000140',
      '51000000-0000-4000-8000-000000000140', 3, 1, 'application',
      '31000000-0000-4000-8000-000000000140',
      '31000000-0000-4000-8000-000000000140', 'application',
      '31000000-0000-4000-8000-000000000140',
      '41000000-0000-4000-8000-000000000140', 'application',
      '31000000-0000-4000-8000-000000000140', 1,
      'sha256:' || pg_catalog.repeat('9', 64), 1,
      'sha256:' || pg_catalog.repeat('e', 64)
    );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'accepted role entries cannot substitute a false catalogue fingerprint'
);
set constraints all deferred;

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values (
  '21000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140', 'application',
  '31000000-0000-4000-8000-000000000140',
  '41000000-0000-4000-8000-000000000140', 'application',
  '31000000-0000-4000-8000-000000000140', 'available', 1,
  'sha256:' || pg_catalog.repeat('e', 64), 1, pg_catalog.statement_timestamp()
);

update vortex_access.permission_continuities
set last_processed_registration_revision = 2,
  state = 'unavailable', continuity_revision = 2,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000140'
  and application_root_id = '31000000-0000-4000-8000-000000000140'
  and owner_kind = 'application'
  and owner_id = '31000000-0000-4000-8000-000000000140'
  and permission_id = '41000000-0000-4000-8000-000000000140';

update vortex_access.permission_continuities
set last_processed_registration_revision = 3,
  state = 'available', continuity_revision = 3,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000140'
  and application_root_id = '31000000-0000-4000-8000-000000000140'
  and owner_kind = 'application'
  and owner_id = '31000000-0000-4000-8000-000000000140'
  and permission_id = '41000000-0000-4000-8000-000000000140';

select is(
  (
    select continuity_revision
    from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and application_root_id = '31000000-0000-4000-8000-000000000140'
      and owner_kind = 'application'
      and owner_id = '31000000-0000-4000-8000-000000000140'
      and permission_id = '41000000-0000-4000-8000-000000000140'
  ),
  3::bigint,
  'removal and readdition cannot return to the old continuity revision'
);

select throws_ok(
  $$
    update vortex_access.permission_continuities
    set continuity_revision = 3,
      meaning_fingerprint = 'sha256:' || pg_catalog.repeat('8', 64),
      last_processed_registration_revision = 4
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and application_root_id = '31000000-0000-4000-8000-000000000140'
      and owner_kind = 'application'
      and owner_id = '31000000-0000-4000-8000-000000000140'
      and permission_id = '41000000-0000-4000-8000-000000000140'
  $$,
  '23514'::char(5), null,
  'changed meaning cannot reuse an accepted continuity revision'
);

select throws_ok(
  $$
    delete from vortex_access.permission_continuities
    where organization_id = '21000000-0000-4000-8000-000000000140'
  $$,
  '23514'::char(5), null,
  'permission continuity tombstones cannot be deleted'
);

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values (
  '21000000-0000-4000-8000-000000000141', null, 'platform',
  'cabe121e-0baf-4084-9471-cce915d460a8',
  '687d5649-62ee-43dd-b684-b8af3a5394c1', 'platform',
  'cabe121e-0baf-4084-9471-cce915d460a8', 'available', 1,
  (
    select meaning_fingerprint
    from vortex_access.permission_catalogue_entries
    where organization_id = '21000000-0000-4000-8000-000000000141'
      and registration_kind = 'platform'
      and permission_id = '687d5649-62ee-43dd-b684-b8af3a5394c1'
  ),
  1, pg_catalog.statement_timestamp()
);

insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
) values (
  '21000000-0000-4000-8000-000000000141',
  '31000000-0000-4000-8000-000000000140', 'application',
  '31000000-0000-4000-8000-000000000140',
  '41000000-0000-4000-8000-000000000140', 'application',
  '31000000-0000-4000-8000-000000000140', 'available', 1,
  'sha256:' || pg_catalog.repeat('e', 64), 1, pg_catalog.statement_timestamp()
);

select is(
  (
    select pg_catalog.count(distinct organization_id)::integer
    from vortex_access.permission_continuities
    where application_root_id = '31000000-0000-4000-8000-000000000140'
      and permission_id = '41000000-0000-4000-8000-000000000140'
  ),
  2,
  'permission continuity remains organisation and exact owner qualified'
);

select throws_ok(
  $test$
    do $body$
    begin
      insert into vortex_access.permission_continuities (
      organization_id, application_root_id, owner_kind, owner_id, permission_id,
      registration_kind, registration_owner_id, state, continuity_revision,
      meaning_fingerprint, last_processed_registration_revision, changed_at
    ) values (
      '21000000-0000-4000-8000-000000000141',
      '31000000-0000-4000-8000-000000000141', 'application',
      '31000000-0000-4000-8000-000000000141',
      '41000000-0000-4000-8000-000000000140', 'application',
      '31000000-0000-4000-8000-000000000141', 'available', 1,
      'sha256:' || pg_catalog.repeat('9', 64), 1,
      pg_catalog.statement_timestamp()
    );
      set constraints all immediate;
    end;
    $body$
  $test$,
  '23514'::char(5), null,
  'available permission continuity cannot substitute false meaning evidence'
);
set constraints all deferred;

insert into vortex_access.application_role_template_continuities (
  organization_id, application_root_id, source_role_id, state,
  continuity_revision, source_template_fingerprint,
  last_processed_registration_revision, changed_at
) values (
  '21000000-0000-4000-8000-000000000140',
  '31000000-0000-4000-8000-000000000140',
  '52000000-0000-4000-8000-000000000140', 'available', 1,
  'sha256:' || pg_catalog.repeat('f', 64), 1, pg_catalog.statement_timestamp()
);

update vortex_access.application_role_template_continuities
set source_template_fingerprint = 'sha256:' || pg_catalog.repeat('7', 64),
  last_processed_registration_revision = 2,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000140'
  and application_root_id = '31000000-0000-4000-8000-000000000140'
  and source_role_id = '52000000-0000-4000-8000-000000000140';

select is(
  (
    select continuity_revision
    from vortex_access.application_role_template_continuities
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and application_root_id = '31000000-0000-4000-8000-000000000140'
      and source_role_id = '52000000-0000-4000-8000-000000000140'
  ),
  1::bigint,
  'a continuously available template may update source bytes without breaking continuity'
);

update vortex_access.application_role_template_continuities
set state = 'unavailable', continuity_revision = 2,
  last_processed_registration_revision = 3,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000140'
  and application_root_id = '31000000-0000-4000-8000-000000000140'
  and source_role_id = '52000000-0000-4000-8000-000000000140';

update vortex_access.application_role_template_continuities
set state = 'available', continuity_revision = 3,
  source_template_fingerprint = 'sha256:' || pg_catalog.repeat('f', 64),
  last_processed_registration_revision = 4,
  changed_at = pg_catalog.statement_timestamp()
where organization_id = '21000000-0000-4000-8000-000000000140'
  and application_root_id = '31000000-0000-4000-8000-000000000140'
  and source_role_id = '52000000-0000-4000-8000-000000000140';

select is(
  (
    select continuity_revision
    from vortex_access.application_role_template_continuities
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and application_root_id = '31000000-0000-4000-8000-000000000140'
      and source_role_id = '52000000-0000-4000-8000-000000000140'
  ),
  3::bigint,
  'template removal and readdition cannot restore an old acceptance epoch'
);

select throws_ok(
  $$
    update vortex_access.application_role_template_continuities
    set state = 'unavailable', last_processed_registration_revision = 5
    where organization_id = '21000000-0000-4000-8000-000000000140'
      and application_root_id = '31000000-0000-4000-8000-000000000140'
      and source_role_id = '52000000-0000-4000-8000-000000000140'
  $$,
  '23514'::char(5), null,
  'template removal cannot reuse an accepted continuity revision'
);

select throws_ok(
  $$
    delete from vortex_access.application_role_template_continuities
    where organization_id = '21000000-0000-4000-8000-000000000140'
  $$,
  '23514'::char(5), null,
  'template continuity tombstones cannot be deleted'
);

select * from finish();

rollback;
