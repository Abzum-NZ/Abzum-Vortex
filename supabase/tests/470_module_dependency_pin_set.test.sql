\ir helpers/definition-release-writer.psql

begin;
select plan(36);

set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_request;

-- The Module dependency pin-set rule: an Application's closure pins each Module
-- root at exactly one revision, with each edge's evidence matching its target
-- release. vortex_definition.reachable_module_dependency_edges owns the rule,
-- vortex_definition.append_release enforces it, and the two readers, the
-- storage provisioner and the permission registry read their Module set from
-- it. Every release below is published through append_release by
-- pg_temp.append_writer_release; only the legacy section adds dependency
-- edges directly, and it says why.

create function pg_temp.pin_set_context(p_application_root_id uuid default null)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  request_context jsonb;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);
  request_context := pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '94700000-0000-4000-8000-000000000001',
    'tenantId', '14700000-0000-4000-8000-000000000001',
    'organizationId', '24700000-0000-4000-8000-000000000001',
    'organizationAccountId', '54700000-0000-4000-8000-000000000010',
    'identityId', '44700000-0000-4000-8000-000000000010',
    'sessionId', '64700000-0000-4000-8000-000000000099',
    'authenticationStrength', 'single_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', (
      select version.current_version
      from vortex_access.organization_access_versions as version
      where version.organization_id = '24700000-0000-4000-8000-000000000001'
    ),
    'correlationId', 'a4700000-0000-4000-8000-000000000001',
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

create function pg_temp.pin_set_permission(p_suffix integer, p_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', ('b4700000-0000-4000-8000-' || pg_catalog.lpad(p_suffix::text, 12, '0'))::uuid,
    'key', p_key,
    'label', 'Read pin-set records',
    'description', 'Read records supplied by one pin-set fixture definition.',
    'actionKind', 'read',
    'administrative', false
  )
$function$;

-- One storage-bearing record type and one declared permission per Module, so
-- every Module in a closure can be provisioned and registered.
create function pg_temp.pin_set_module_content(p_suffix integer, p_permission_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', ('54700000-0000-4000-8000-' || pg_catalog.lpad(p_suffix::text, 12, '0'))::uuid,
      'storageContractId', ('64700000-0000-4000-8000-' || pg_catalog.lpad(p_suffix::text, 12, '0'))::uuid,
      'storageScope', 'organization_shared',
      'ownershipMode', 'group',
      'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'fieldId', ('74700000-0000-4000-8000-' || pg_catalog.lpad(p_suffix::text, 12, '0'))::uuid,
        'type', 'text',
        'required', true,
        'unique', false,
        'filterable', false,
        'sortable', false,
        'settings', '{}'::jsonb
      )),
      'relationships', '[]'::jsonb
    )),
    'permissions', pg_catalog.jsonb_build_array(pg_temp.pin_set_permission(p_suffix, p_permission_key))
  )
$function$;

create function pg_temp.pin_set_release_evidence(p_root_id uuid, p_release_revision bigint)
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
    and release.release_revision = p_release_revision
$function$;

-- A registration candidate carrying the Application's own permissions and the
-- declared permissions of exactly the Module releases named in p_modules.
create function pg_temp.pin_set_registration_candidate(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_modules jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  entries jsonb;
  application_permission_ids jsonb;
begin
  with owners as (
    select 'application'::text as owner_kind, p_application_root_id as owner_id,
      p_application_release_revision as release_revision
    union all
    select 'module', (module.pair ->> 0)::uuid, (module.pair ->> 1)::bigint
    from pg_catalog.jsonb_array_elements(p_modules) as module(pair)
  ), declared as (
    select owners.owner_kind, owners.owner_id, permission.value as permission_value,
      pg_temp.pin_set_release_evidence(owners.owner_id, owners.release_revision) as source_release
    from owners
    join vortex_definition.releases as release
      on release.root_id = owners.owner_id
      and release.release_revision = owners.release_revision
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,permissions}'
    ) as permission(value)
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', declared.owner_kind,
        'ownerId', declared.owner_id,
        'permission', declared.permission_value,
        'sourceRelease', declared.source_release,
        'meaningFingerprint', pg_temp.writer_fixture_fingerprint(
          declared.owner_id::text || ':' || (declared.permission_value ->> 'permissionId')
        )
      ) order by declared.owner_kind collate "C", declared.owner_id::text collate "C",
        (declared.permission_value ->> 'key') collate "C",
        (declared.permission_value ->> 'permissionId') collate "C"
    ),
    '[]'::jsonb
  ) into entries
  from declared;

  select coalesce(
    pg_catalog.jsonb_agg(entry.value #>> '{permission,permissionId}' order by
      (entry.value #>> '{permission,key}') collate "C",
      (entry.value #>> '{permission,permissionId}') collate "C"),
    '[]'::jsonb
  ) into application_permission_ids
  from pg_catalog.jsonb_array_elements(entries) as entry(value)
  where entry.value ->> 'ownerKind' = 'application'
    and not (entry.value #>> '{permission,administrative}')::boolean;

  return pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '24700000-0000-4000-8000-000000000001'::uuid,
    'applicationRootId', p_application_root_id,
    'applicationRelease', pg_temp.pin_set_release_evidence(
      p_application_root_id, p_application_release_revision
    ),
    'applicationCatalogueFingerprint', pg_temp.writer_fixture_fingerprint(
      p_application_root_id::text || ':catalogue'
    ),
    'applicationPermissionIds', application_permission_ids,
    'entries', entries,
    'candidateFingerprint', pg_temp.writer_fixture_fingerprint(p_modules::text)
  );
end
$function$;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14700000-0000-4000-8000-000000000001', 'pin_set_tenant', 'Pin set tenant',
  'active', pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values
  (
    '24700000-0000-4000-8000-000000000001', '14700000-0000-4000-8000-000000000001',
    null, 'pin_set_organisation', 'Pin set organisation', 'active',
    pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '24700000-0000-4000-8000-000000000002', '14700000-0000-4000-8000-000000000001',
    null, 'pin_set_other_organisation', 'Pin set other organisation', 'active',
    pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '44700000-0000-4000-8000-000000000010', 'active',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  '94700000-0000-4000-8000-000000000001',
  'a4700000-0000-4000-8000-000000000010', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '54700000-0000-4000-8000-000000000010',
  '24700000-0000-4000-8000-000000000001',
  '44700000-0000-4000-8000-000000000010', 'Pin set installer', 'active',
  pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001',
  'a4700000-0000-4000-8000-000000000012', 1
);

-- Installation authority, established exactly as the storage provisioning
-- suite establishes it.
select * from vortex_access.initialize_organization_access_version(
  '24700000-0000-4000-8000-000000000001',
  '94700000-0000-4000-8000-000000000001',
  'a4700000-0000-4000-8000-000000000020'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '24700000-0000-4000-8000-000000000001',
  '94700000-0000-4000-8000-000000000001',
  'a4700000-0000-4000-8000-000000000021'
);
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  '24700000-0000-4000-8000-000000000001', 1, '1.0.0', '1.0.1',
  '94700000-0000-4000-8000-000000000001',
  'a4700000-0000-4000-8000-000000000022'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '24700000-0000-4000-8000-000000000001',
  '54700000-0000-4000-8000-000000000010',
  '64700000-0000-4000-8000-000000000010',
  'pin_set_steward', 'Pin set steward', 'Permanent pin-set test stewardship.',
  '74700000-0000-4000-8000-000000000010',
  '84700000-0000-4000-8000-000000000010',
  '44700000-0000-4000-8000-000000000010',
  'a4700000-0000-4000-8000-000000000023'
);
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  '24700000-0000-4000-8000-000000000001', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  '94700000-0000-4000-8000-000000000001',
  'a4700000-0000-4000-8000-000000000024'
);
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '24700000-0000-4000-8000-000000000001',
  '64700000-0000-4000-8000-000000000011', 'custom',
  'application_installer', 1, '94700000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp()
);
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select entry.organization_id, '64700000-0000-4000-8000-000000000011'::uuid,
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
where entry.organization_id = '24700000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform'
  and entry.registration_revision = 3
  and entry.permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba';
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values (
  '24700000-0000-4000-8000-000000000001',
  '64700000-0000-4000-8000-000000000011', 1, 'custom', 'active',
  'privileged', 'standing', 1, 1, 'application_installer',
  'Application installer', 'Explicit current lifecycle authority for pin-set testing.',
  '94700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4700000-0000-4000-8000-000000000025'
);
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, group_id, assignment_kind, revision,
  starts_at, expires_at, state, granted_by, granted_at,
  grant_correlation_id, changed_by, changed_at, change_correlation_id
) values (
  '24700000-0000-4000-8000-000000000001',
  '74700000-0000-4000-8000-000000000011',
  '64700000-0000-4000-8000-000000000011', 'organization_account',
  '54700000-0000-4000-8000-000000000010', null, 'standing', 1,
  pg_catalog.statement_timestamp() - interval '1 minute', null, 'live',
  '94700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4700000-0000-4000-8000-000000000026',
  '94700000-0000-4000-8000-000000000001', pg_catalog.statement_timestamp(),
  'a4700000-0000-4000-8000-000000000026'
);

-- Roots, all in the first organisation except F. Modules: S shared_module, P
-- dependent_module, C cycle_module, D cycle_bridge_module, U1
-- later_dependency_module, U3 later_application_module, X unrelated_module.
-- Applications: Z application, Y transitive_application, L
-- legacy_application, E legacy_evidence_application, W consistent_application,
-- V cross_organisation_application, R legacy_reference_application and Q
-- legacy_kind_application. F other_organisation_module belongs to the second
-- organisation.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
)
select fixture.root_id, '24700000-0000-4000-8000-000000000001', fixture.kind,
  fixture.key, pg_catalog.statement_timestamp(), '94700000-0000-4000-8000-000000000001'
from (values
  ('44700000-0000-4000-8000-000000000001'::uuid, 'module', 'vortex.pin_set.shared_module'),
  ('44700000-0000-4000-8000-000000000002'::uuid, 'module', 'vortex.pin_set.dependent_module'),
  ('44700000-0000-4000-8000-000000000003'::uuid, 'module', 'vortex.pin_set.cycle_module'),
  ('44700000-0000-4000-8000-000000000004'::uuid, 'module', 'vortex.pin_set.cycle_bridge_module'),
  ('44700000-0000-4000-8000-000000000005'::uuid, 'module', 'vortex.pin_set.later_dependency_module'),
  ('44700000-0000-4000-8000-000000000006'::uuid, 'module', 'vortex.pin_set.later_application_module'),
  ('44700000-0000-4000-8000-000000000007'::uuid, 'module', 'vortex.pin_set.unrelated_module'),
  ('34700000-0000-4000-8000-000000000001'::uuid, 'application', 'vortex.pin_set.application'),
  ('34700000-0000-4000-8000-000000000002'::uuid, 'application', 'vortex.pin_set.transitive_application'),
  ('34700000-0000-4000-8000-000000000003'::uuid, 'application', 'vortex.pin_set.legacy_application'),
  ('34700000-0000-4000-8000-000000000004'::uuid, 'application', 'vortex.pin_set.legacy_evidence_application'),
  ('34700000-0000-4000-8000-000000000005'::uuid, 'application', 'vortex.pin_set.consistent_application'),
  ('34700000-0000-4000-8000-000000000006'::uuid, 'application', 'vortex.pin_set.cross_organisation_application'),
  ('34700000-0000-4000-8000-000000000007'::uuid, 'application', 'vortex.pin_set.legacy_reference_application'),
  ('34700000-0000-4000-8000-000000000008'::uuid, 'application', 'vortex.pin_set.legacy_kind_application')
) as fixture(root_id, kind, key);
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '44700000-0000-4000-8000-000000000008', '24700000-0000-4000-8000-000000000002', 'module',
  'vortex.pin_set.other_organisation_module', pg_catalog.statement_timestamp(),
  '94700000-0000-4000-8000-000000000001'
);

-- C@2 depends on D@1, which depends on C@1: a root-level cycle.
select pg_temp.append_writer_release('44700000-0000-4000-8000-000000000003', '1.0.0');
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000004', '1.0.0',
  '[["44700000-0000-4000-8000-000000000003", 1]]'
);
select throws_ok(
  $$select pg_temp.append_writer_release(
    '44700000-0000-4000-8000-000000000003', '2.0.0',
    '[["44700000-0000-4000-8000-000000000004", 1]]'
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the writer refuses a Module release whose closure reaches another release of its own root'::text
);

-- S@1, then P published against S@1, then S@2.
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000001', '1.0.0', '[]',
  pg_temp.pin_set_module_content(1, 'pinset.shared.read'), '2.0.0'
);
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000002', '1.0.0',
  '[["44700000-0000-4000-8000-000000000001", 1]]',
  pg_temp.pin_set_module_content(2, 'pinset.dependent.read'), '2.0.0'
);
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000001', '1.1.0', '[]',
  pg_temp.pin_set_module_content(1, 'pinset.shared.read'), '2.0.0'
);

-- Z declares P, which pins S@1, and S@2 directly: S would be pinned twice.
select throws_ok(
  $$select pg_temp.append_writer_release(
    '34700000-0000-4000-8000-000000000001', '1.0.0',
    '[["44700000-0000-4000-8000-000000000002", 1], ["44700000-0000-4000-8000-000000000001", 2]]',
    '{"permissions": []}'
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the writer refuses an Application whose closure pins one Module at two revisions'::text
);
select ok(
  not exists (
    select 1 from vortex_definition.releases
    where root_id = '34700000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1 from vortex_definition.release_dependencies
    where root_id = '34700000-0000-4000-8000-000000000001'
  )
  and (
    select current_release_revision from vortex_definition.roots
    where root_id = '34700000-0000-4000-8000-000000000001'
  ) is null,
  'the refused append stores no release or dependency row and leaves the current pointer unset'
);

-- F@1 is published through the writer in the second organisation. V declares
-- it with F@1's exact evidence, so the only reason to refuse V is that F
-- belongs to another organisation: Module dependencies stay within the
-- Application's organisation until shared Modules are delivered.
select pg_temp.append_writer_release('44700000-0000-4000-8000-000000000008', '1.0.0');
select throws_ok(
  $$select pg_temp.append_writer_release(
    '34700000-0000-4000-8000-000000000006', '1.0.0',
    '[["44700000-0000-4000-8000-000000000008", 1]]', '{"permissions": []}'
  )$$::text,
  '23514'::char(5),
  'Module dependency does not identify an exact same-organization module release'::text,
  'the writer refuses a Module dependency owned by another organisation'::text
);

-- W declares P and S at the revision P pins: S is reached by two edges with
-- one revision and one evidence, which the rule permits.
select lives_ok(
  $$select pg_temp.append_writer_release(
    '34700000-0000-4000-8000-000000000005', '1.0.0',
    '[["44700000-0000-4000-8000-000000000002", 1], ["44700000-0000-4000-8000-000000000001", 1]]',
    '{"permissions": []}'
  )$$::text,
  'an Application publishes when it pins the shared Module at the revision its dependency pins'::text
);
select results_eq(
  $$select target_root_id, target_release_revision
    from vortex_definition.reachable_module_dependency_edges(
      '34700000-0000-4000-8000-000000000005', 1
    )
    order by target_root_id$$::text,
  $$values
    ('44700000-0000-4000-8000-000000000001'::uuid, 1::bigint),
    ('44700000-0000-4000-8000-000000000002'::uuid, 1::bigint)$$::text,
  'the pin set holds one row per Module root although two edges reach the shared Module'::text
);

-- Other releases of the Application and of an intermediate Module reach
-- Modules that Y@1 does not pin: U1 only through P@2, U3 only through Y@2.
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000005', '1.0.0', '[]',
  pg_temp.pin_set_module_content(5, 'pinset.later_dependency.read'), '2.0.0'
);
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000002', '1.1.0',
  '[["44700000-0000-4000-8000-000000000001", 1], ["44700000-0000-4000-8000-000000000005", 1]]',
  pg_temp.pin_set_module_content(2, 'pinset.dependent.read'), '2.0.0'
);
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000006', '1.0.0', '[]',
  pg_temp.pin_set_module_content(6, 'pinset.later_application.read'), '2.0.0'
);
select pg_temp.append_writer_release(
  '44700000-0000-4000-8000-000000000007', '1.0.0', '[]',
  pg_temp.pin_set_module_content(7, 'pinset.unrelated.read'), '2.0.0'
);
select pg_temp.append_writer_release(
  '34700000-0000-4000-8000-000000000002', '1.0.0',
  '[["44700000-0000-4000-8000-000000000002", 1]]',
  pg_catalog.jsonb_build_object('permissions', pg_catalog.jsonb_build_array(
    pg_temp.pin_set_permission(8, 'pinset.transitive_application.read')
  ))
);
select pg_temp.append_writer_release(
  '34700000-0000-4000-8000-000000000002', '1.1.0',
  '[["44700000-0000-4000-8000-000000000002", 1], ["44700000-0000-4000-8000-000000000006", 1]]',
  pg_catalog.jsonb_build_object('permissions', pg_catalog.jsonb_build_array(
    pg_temp.pin_set_permission(8, 'pinset.transitive_application.read')
  ))
);
select results_eq(
  $$select target_root_id, target_release_revision
    from vortex_definition.reachable_module_dependency_edges(
      '34700000-0000-4000-8000-000000000002', 1
    )
    order by target_root_id$$::text,
  $$values
    ('44700000-0000-4000-8000-000000000001'::uuid, 1::bigint),
    ('44700000-0000-4000-8000-000000000002'::uuid, 1::bigint)$$::text,
  'the pin set follows only the exact Application release and the Module releases it pins'::text
);

-- Legacy data. A release stored before the writer gate existed may hold a
-- closure the writer now refuses, so a direct insert is the only way to build
-- one; this section is the one place this file writes release_dependencies
-- directly. L@1 is published through the writer against P@1, then gains the
-- S@2 edge the pre-gate writer would also have stored: S is pinned at 1
-- through P and at 2 directly. E@1 gains an edge to P@1 carrying P@2's
-- evidence fingerprint, a shape no writer revision stores (the target foreign
-- key already pins version and content fingerprint); it exercises the
-- evidence rule the resolver took over from the readers. R@1 and Q@1 gain
-- the two edges below, which no writer revision stores either, because every
-- writer revision checks the target root's key and kind; they exercise the
-- root-key and Module-kind rules the resolver also took over.
select pg_temp.append_writer_release(
  '34700000-0000-4000-8000-000000000003', '1.0.0',
  '[["44700000-0000-4000-8000-000000000002", 1]]', '{"permissions": []}'
);
select pg_temp.append_writer_release(
  '34700000-0000-4000-8000-000000000004', '1.0.0', '[]', '{"permissions": []}'
);
select pg_temp.append_writer_release(
  '34700000-0000-4000-8000-000000000007', '1.0.0', '[]', '{"permissions": []}'
);
select pg_temp.append_writer_release(
  '34700000-0000-4000-8000-000000000008', '1.0.0', '[]', '{"permissions": []}'
);
insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
)
select legacy.root_id, 1, 'module', target_root.key, target.release_version,
  target.content_fingerprint, legacy.evidence_fingerprint,
  target.root_id, target.release_revision, null
from (values
  (
    '34700000-0000-4000-8000-000000000003'::uuid,
    '44700000-0000-4000-8000-000000000001'::uuid, 2::bigint,
    (select resolution_fingerprint from vortex_definition.releases
      where root_id = '44700000-0000-4000-8000-000000000001' and release_revision = 2)
  ),
  (
    '34700000-0000-4000-8000-000000000004'::uuid,
    '44700000-0000-4000-8000-000000000002'::uuid, 1::bigint,
    (select resolution_fingerprint from vortex_definition.releases
      where root_id = '44700000-0000-4000-8000-000000000002' and release_revision = 2)
  )
) as legacy(root_id, target_root_id, target_release_revision, evidence_fingerprint)
join vortex_definition.releases as target
  on target.root_id = legacy.target_root_id
  and target.release_revision = legacy.target_release_revision
join vortex_definition.roots as target_root on target_root.root_id = target.root_id;
-- R@1's edge to X@1 names S's key, and Q@1's Module edge targets the
-- Application release W@1 under W's own key. Each carries its target's exact
-- version and fingerprints, so only the root-key or the Module-kind rule can
-- refuse it.
insert into vortex_definition.release_dependencies (
  root_id, release_revision, dependency_kind, dependency_reference,
  dependency_version, dependency_content_fingerprint, evidence_fingerprint,
  target_root_id, target_release_revision, catalogue_item_id
)
select legacy.root_id, 1, 'module', legacy.dependency_reference, target.release_version,
  target.content_fingerprint, target.resolution_fingerprint,
  target.root_id, target.release_revision, null
from (values
  (
    '34700000-0000-4000-8000-000000000007'::uuid,
    '44700000-0000-4000-8000-000000000007'::uuid, 'vortex.pin_set.shared_module'
  ),
  (
    '34700000-0000-4000-8000-000000000008'::uuid,
    '34700000-0000-4000-8000-000000000005'::uuid, 'vortex.pin_set.consistent_application'
  )
) as legacy(root_id, target_root_id, dependency_reference)
join vortex_definition.releases as target
  on target.root_id = legacy.target_root_id
  and target.release_revision = 1;

-- Both legacy Applications hold an active binding for P@1, so the
-- active-installation reader reaches its dependency checks.
set local role vortex_module_owner;
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
)
select '24700000-0000-4000-8000-000000000001', legacy.application_root_id,
  release.root_id, 1, 1, release.release_revision, 'active',
  release.content_fingerprint, release.resolution_fingerprint, '1.0.0',
  array['64700000-0000-4000-8000-000000000002'::uuid]
from (values
  ('34700000-0000-4000-8000-000000000003'::uuid),
  ('34700000-0000-4000-8000-000000000004'::uuid)
) as legacy(application_root_id)
join vortex_definition.releases as release
  on release.root_id = '44700000-0000-4000-8000-000000000002'
  and release.release_revision = 1;
reset role;

select throws_ok(
  $$select * from vortex_definition.reachable_module_dependency_edges(
    '34700000-0000-4000-8000-000000000003', 1
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the resolver refuses a stored closure that pins one Module at two revisions'::text
);
select throws_ok(
  $$select * from vortex_definition.reachable_module_dependency_edges(
    '34700000-0000-4000-8000-000000000004', 1
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the resolver refuses a stored edge whose evidence disagrees with its target release'::text
);
select throws_ok(
  $$select * from vortex_definition.reachable_module_dependency_edges(
    '34700000-0000-4000-8000-000000000007', 1
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the resolver refuses a stored edge whose reference is not its target root key'::text
);
select throws_ok(
  $$select * from vortex_definition.reachable_module_dependency_edges(
    '34700000-0000-4000-8000-000000000008', 1
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the resolver refuses a stored Module edge whose target is an Application release'::text
);

select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000003');
set local role vortex_request;
select throws_ok(
  $$select vortex_definition.read_application_bound_release_set(1)$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the bound reader refuses legacy data that pins one Module at two revisions'::text
);
reset role;
select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000004');
set local role vortex_request;
select throws_ok(
  $$select vortex_definition.read_application_bound_release_set(1)$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the bound reader refuses legacy edge evidence that disagrees with its target release'::text
);
reset role;

select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000003', 1,
    '44700000-0000-4000-8000-000000000001', 1, null
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the provisioner refuses the shared Module at the revision the legacy Application does not pin'::text
);
reset role;
select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000003', 1,
    '44700000-0000-4000-8000-000000000001', 2, null
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the provisioner refuses the shared Module at the revision the legacy Application pins directly'::text
);
reset role;
select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000004', 1,
    '44700000-0000-4000-8000-000000000002', 1, null
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the provisioner refuses a Module whose legacy edge evidence disagrees with its release'::text
);
reset role;
select ok(
  (
    select pg_catalog.count(*) = 2
      and pg_catalog.bool_and(
        module_root_id = '44700000-0000-4000-8000-000000000002'
        and state = 'active'
        and binding_revision = 1
      )
    from vortex_module.installation_bindings
    where application_root_id in (
      '34700000-0000-4000-8000-000000000003', '34700000-0000-4000-8000-000000000004'
    )
  )
  and not exists (
    select 1 from vortex_record.release_provisions
    where module_root_id in (
      '44700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000002'
    )
  )
  and pg_catalog.to_regclass('record_data.rt_64700000000040008000000000000001') is null,
  'the refused legacy provisioning creates no storage, provision receipt or binding change'
);

select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000003');
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the active-installation reader refuses legacy data that pins one Module at two revisions'::text
);
reset role;
select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000004');
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the active-installation reader refuses legacy edge evidence that disagrees with its target release'::text
);
reset role;

select throws_ok(
  $$select * from vortex_access.apply_application_permission_registration_v1_internal(
    'register', null,
    pg_temp.pin_set_registration_candidate(
      '34700000-0000-4000-8000-000000000003', 1, '[]'
    ),
    '94700000-0000-4000-8000-000000000001',
    'a4700000-0000-4000-8000-000000000030'
  )$$::text,
  '23514'::char(5), 'Exact bound Module dependency evidence is inconsistent'::text,
  'the permission registry refuses legacy data that pins one Module at two revisions'::text
);

-- The storage provisioner accepts exactly the pins of Y@1.
select pg_temp.pin_set_context();
set local role vortex_request;
select lives_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000002', 1,
    '44700000-0000-4000-8000-000000000001', 1, null
  )$$::text,
  'a shared Module reached only through another Module is accepted for provisioning'::text
);
reset role;
select ok(
  not exists (
    select 1 from vortex_definition.release_dependencies
    where root_id = '34700000-0000-4000-8000-000000000002'
      and release_revision = 1
      and target_root_id = '44700000-0000-4000-8000-000000000001'
  )
  and pg_catalog.to_regclass('record_data.rt_64700000000040008000000000000001') is not null
  and exists (
    select 1 from vortex_module.installation_bindings
    where organization_id = '24700000-0000-4000-8000-000000000001'
      and application_root_id = '34700000-0000-4000-8000-000000000002'
      and module_root_id = '44700000-0000-4000-8000-000000000001'
      and module_release_revision = 1
      and state = 'provisioned'
  ),
  'the shared Module has real storage and an inactive binding with no direct declaration'
);
select pg_temp.pin_set_context();
set local role vortex_request;
select lives_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000002', 1,
    '44700000-0000-4000-8000-000000000002', 1, null
  )$$::text,
  'the directly declared Module is accepted for provisioning'::text
);
reset role;
create temporary table transitive_application_provisioned on commit drop as
select module_root_id, module_release_revision
from vortex_module.installation_bindings
where organization_id = '24700000-0000-4000-8000-000000000001'
  and application_root_id = '34700000-0000-4000-8000-000000000002';

select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000002', 1,
    '44700000-0000-4000-8000-000000000001', 2, null
  )$$::text,
  '23514'::char(5), 'Exact application Module binding is unavailable'::text,
  'a pinned Module root at a revision the Application does not pin is refused'::text
);
reset role;
select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000002', 1,
    '44700000-0000-4000-8000-000000000007', 1, null
  )$$::text,
  '23514'::char(5), 'Exact application Module binding is unavailable'::text,
  'a Module unrelated to the Application is refused'::text
);
reset role;
select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000002', 1,
    '44700000-0000-4000-8000-000000000005', 1, null
  )$$::text,
  '23514'::char(5), 'Exact application Module binding is unavailable'::text,
  'a Module reached only through a later release of an intermediate Module is refused'::text
);
reset role;
select pg_temp.pin_set_context();
set local role vortex_request;
select throws_ok(
  $$select * from vortex_module.provision_module_installation_storage(
    '34700000-0000-4000-8000-000000000002', 1,
    '44700000-0000-4000-8000-000000000006', 1, null
  )$$::text,
  '23514'::char(5), 'Exact application Module binding is unavailable'::text,
  'a Module reached only through a later release of the Application is refused'::text
);
reset role;

-- Both readers return the same pins.
select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000002');
set local role vortex_request;
create temporary table transitive_application_bound on commit drop as
select (module.value ->> 'rootId')::uuid as module_root_id,
  (module.value ->> 'releaseRevision')::bigint as module_release_revision
from pg_catalog.jsonb_array_elements(
  vortex_definition.read_application_bound_release_set(1) -> 'modules'
) as module(value);
reset role;
select results_eq(
  $$select module_root_id, module_release_revision
    from transitive_application_bound order by module_root_id$$::text,
  $$values
    ('44700000-0000-4000-8000-000000000001'::uuid, 1::bigint),
    ('44700000-0000-4000-8000-000000000002'::uuid, 1::bigint)$$::text,
  'the bound reader returns exactly the pins of the Application release'::text
);

-- No activation operation exists yet; the provisioned bindings are made
-- active directly, as the active-installation reader suite does.
set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'active'
where organization_id = '24700000-0000-4000-8000-000000000001'
  and application_root_id = '34700000-0000-4000-8000-000000000002';
reset role;
select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000002');
set local role vortex_request;
create temporary table transitive_application_active on commit drop as
select (binding.value ->> 'moduleRootId')::uuid as module_root_id,
  (binding.value ->> 'moduleReleaseRevision')::bigint as module_release_revision
from pg_catalog.jsonb_array_elements(
  vortex_module.read_current_active_installation() -> 'moduleBindings'
) as binding(value);
reset role;
select results_eq(
  $$select module_root_id, module_release_revision
    from transitive_application_active order by module_root_id$$::text,
  $$values
    ('44700000-0000-4000-8000-000000000001'::uuid, 1::bigint),
    ('44700000-0000-4000-8000-000000000002'::uuid, 1::bigint)$$::text,
  'the active-installation reader returns exactly the pins of the Application release'::text
);

set local role vortex_module_owner;
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
)
select '24700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
  release.root_id, 1, 1, release.release_revision, 'active',
  release.content_fingerprint, release.resolution_fingerprint, '1.0.0',
  array['64700000-0000-4000-8000-000000000007'::uuid]
from vortex_definition.releases as release
where release.root_id = '44700000-0000-4000-8000-000000000007'
  and release.release_revision = 1;
reset role;
select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000002');
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'an active binding that is not a pin is refused'::text
);
reset role;
set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'detached'
where organization_id = '24700000-0000-4000-8000-000000000001'
  and application_root_id = '34700000-0000-4000-8000-000000000002'
  and module_root_id = '44700000-0000-4000-8000-000000000007';
update vortex_module.installation_bindings
set state = 'provisioned'
where organization_id = '24700000-0000-4000-8000-000000000001'
  and application_root_id = '34700000-0000-4000-8000-000000000002'
  and module_root_id = '44700000-0000-4000-8000-000000000001';
reset role;
select pg_temp.pin_set_context('34700000-0000-4000-8000-000000000002');
set local role vortex_request;
select throws_ok(
  $$select vortex_module.read_current_active_installation()$$::text,
  '55000'::char(5), 'Active Application Module bindings are incomplete'::text,
  'a pin without its active binding is refused'::text
);
reset role;
set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'active'
where organization_id = '24700000-0000-4000-8000-000000000001'
  and application_root_id = '34700000-0000-4000-8000-000000000002'
  and module_root_id = '44700000-0000-4000-8000-000000000001';
reset role;

-- The permission registry carries exactly the declared permissions of the pins.
select throws_ok(
  $$select * from vortex_access.apply_application_permission_registration_v1_internal(
    'register', null,
    pg_temp.pin_set_registration_candidate(
      '34700000-0000-4000-8000-000000000002', 1,
      '[["44700000-0000-4000-8000-000000000002", 1]]'
    ),
    '94700000-0000-4000-8000-000000000001',
    'a4700000-0000-4000-8000-000000000031'
  )$$::text,
  '40001'::char(5), 'Module permission declarations are stale or unavailable'::text,
  'a registration that omits the permissions of a Module reached through another Module is refused'::text
);
select lives_ok(
  $$select * from vortex_access.apply_application_permission_registration_v1_internal(
    'register', null,
    pg_temp.pin_set_registration_candidate(
      '34700000-0000-4000-8000-000000000002', 1,
      '[["44700000-0000-4000-8000-000000000001", 1], ["44700000-0000-4000-8000-000000000002", 1]]'
    ),
    '94700000-0000-4000-8000-000000000001',
    'a4700000-0000-4000-8000-000000000032'
  )$$::text,
  'a registration carrying the permissions of every pinned Module is accepted'::text
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.read_available_permission(
      '24700000-0000-4000-8000-000000000001',
      '34700000-0000-4000-8000-000000000002',
      'module',
      '44700000-0000-4000-8000-000000000001',
      'b4700000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'the permissions of a Module reached only through another Module are registered'
);

select ok(
  (
    select pg_catalog.count(*) = 5
      and pg_catalog.count(consumer.module_set) = 5
      and pg_catalog.count(distinct consumer.module_set) = 1
    from (
      select pg_catalog.array_agg(pin.module order by pin.module) as module_set
      from (
        select target_root_id::text || '@' || target_release_revision::text as module
        from vortex_definition.reachable_module_dependency_edges(
          '34700000-0000-4000-8000-000000000002', 1
        )
      ) as pin
      union all
      select pg_catalog.array_agg(bound.module order by bound.module)
      from (
        select module_root_id::text || '@' || module_release_revision::text as module
        from transitive_application_bound
      ) as bound
      union all
      select pg_catalog.array_agg(active.module order by active.module)
      from (
        select module_root_id::text || '@' || module_release_revision::text as module
        from transitive_application_active
      ) as active
      union all
      select pg_catalog.array_agg(provisioned.module order by provisioned.module)
      from (
        select module_root_id::text || '@' || module_release_revision::text as module
        from transitive_application_provisioned
      ) as provisioned
      union all
      select pg_catalog.array_agg(registered.module order by registered.module)
      from (
        select distinct entry.owner_id::text || '@' || entry.source_revision::text as module
        from vortex_access.permission_catalogue_entries as entry
        where entry.organization_id = '24700000-0000-4000-8000-000000000001'
          and entry.registration_kind = 'application'
          and entry.registration_owner_id = '34700000-0000-4000-8000-000000000002'
          and entry.registration_revision = 1
          and entry.owner_kind = 'module'
      ) as registered
    ) as consumer
  ),
  'the resolver, both readers, the provisioner and the registry agree on the Module set'
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_module_owner',
    'vortex_definition.reachable_module_dependency_edges(uuid,bigint)', 'EXECUTE'
  )
  and not exists (
    select 1
    from (values
      ('public'), ('anon'), ('authenticated'), ('service_role'),
      ('vortex_runtime'), ('vortex_request'), ('vortex_record_owner'),
      ('vortex_record_adapter')
    ) as denied(role_name)
    where pg_catalog.has_function_privilege(
      denied.role_name,
      'vortex_definition.reachable_module_dependency_edges(uuid,bigint)', 'EXECUTE'
    )
  )
  and (
    select not procedure.prosecdef
      and procedure.provolatile = 's'
      and procedure.proconfig = array['search_path=""']
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'vortex_definition.reachable_module_dependency_edges(uuid,bigint)'::regprocedure
  ),
  'the pin-set resolver stays owner-private, runs with its caller rights and has an empty search path'
);

select * from finish();
rollback;
