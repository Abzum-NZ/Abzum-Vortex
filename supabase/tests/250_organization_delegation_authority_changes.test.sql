\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

select * from pg_temp.vortex_private_schema_assertions(
  'vortex_access', 'postgres', true, true
);

select has_function(
  'vortex_access', 'coordinate_organization_delegation_authority_change',
  array[
    'text', 'uuid', 'uuid', 'bigint', 'text', 'uuid', 'uuid', 'text',
    'jsonb', 'text', 'timestamp with time zone', 'timestamp with time zone',
    'uuid', 'uuid'
  ],
  'Access exposes one private delegation change composition'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'owner', owner_role.rolname,
      'securityDefiner', routine.prosecdef,
      'volatility', routine.provolatile,
      'configuration', routine.proconfig
    )
    from pg_catalog.pg_proc as routine
    join pg_catalog.pg_roles as owner_role on owner_role.oid = routine.proowner
    where routine.oid =
      'vortex_access.coordinate_organization_delegation_authority_change(text,uuid,uuid,bigint,text,uuid,uuid,text,jsonb,text,timestamptz,timestamptz,uuid,uuid)'::regprocedure
  ),
  pg_catalog.jsonb_build_object(
    'owner', 'postgres', 'securityDefiner', false, 'volatility', 'v',
    'configuration', array['search_path=""']
  ),
  'the delegation coordinator is owner-held, volatile, invoker-security and empty-search-path'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_organization_delegation_authority_change(text,uuid,uuid,bigint,text,uuid,uuid,text,jsonb,text,timestamptz,timestamptz,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute the private delegation coordinator'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')
) as caller(role_name)
order by caller.role_name collate "C";

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001', null,
      'organization_account',
      '55000000-0000-4000-8000-000000000001', null,
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000001'
    )
  $$,
  '42501'::char(5),
  'permission denied for function coordinate_organization_delegation_authority_change',
  'an actual request-role call cannot invoke delegation changes'
);
reset role;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'unknown',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001', null,
      null, null, null, null, null, null, null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization delegation change input is invalid',
  'unknown delegation operations refuse before organization lookup'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'revoke_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001', 1,
      null, null, null, 'bounded', '[]'::jsonb,
      'sha256:' || pg_catalog.repeat('0', 64), null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000001'
    )
  $$,
  '22023'::char(5),
  'Organization delegation revocation input is invalid',
  'revocation refuses leaked replacement scope input'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '15000000-0000-4000-8000-000000000001', 'delegation_changes',
  'Delegation changes', 'active', pg_catalog.statement_timestamp(),
  '95000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '25000000-0000-4000-8000-000000000001',
    '15000000-0000-4000-8000-000000000001', 'delegation_one',
    'Delegation one', 'active', pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '25000000-0000-4000-8000-000000000002',
    '15000000-0000-4000-8000-000000000001', 'delegation_two',
    'Delegation two', 'active', pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '45000000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000002', 1
  ),
  (
    '45000000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000003', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '55000000-0000-4000-8000-000000000001',
    '25000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000001', 'Delegation holder', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000004', 1
  ),
  (
    '55000000-0000-4000-8000-000000000002',
    '25000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000002', 'Suspended holder', 'suspended',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000005', 1
  ),
  (
    '55000000-0000-4000-8000-000000000003',
    '25000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000001', 'Foreign holder', 'active',
    pg_catalog.statement_timestamp(), null, pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    'a5000000-0000-4000-8000-000000000006', 1
  );

select initialized.*
from vortex_identity.organizations as organization
cross join lateral vortex_access.initialize_organization_access_version(
  organization.organization_id,
  '95000000-0000-4000-8000-000000000001',
  pg_catalog.gen_random_uuid()
) as initialized
where organization.organization_id in (
  '25000000-0000-4000-8000-000000000001'::uuid,
  '25000000-0000-4000-8000-000000000002'::uuid
);

select * from vortex_access.initialize_platform_permission_catalogue(
  '25000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000007'
);

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
where entry.organization_id = '25000000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '37000000-0000-4000-8000-000000000001',
  '25000000-0000-4000-8000-000000000001', 'application',
  'proof.delegation_application', pg_catalog.statement_timestamp(),
  '95000000-0000-4000-8000-000000000001'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values (
  '37000000-0000-4000-8000-000000000001', 1, '1.0.0',
  pg_catalog.jsonb_build_object(
    'source_contract_version', '1.0.0', 'kind', 'application',
    'key', 'proof.delegation_application', 'body', '{}'::jsonb
  ),
  'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
  pg_catalog.jsonb_build_object(
    'kind', 'application', 'canonical',
    pg_catalog.jsonb_build_object(
      'content', pg_catalog.jsonb_build_object(
        'permissions', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'permissionId', '38000000-0000-4000-8000-000000000001',
            'key', 'proof.records.read', 'label', 'View records',
            'description', 'View proof records.', 'actionKind', 'read',
            'administrative', false
          )
        )
      )
    )
  ),
  pg_catalog.jsonb_build_object(
    'fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
  ),
  'sha256:' || pg_catalog.repeat('3', 64),
  'sha256:' || pg_catalog.repeat('2', 64), '2.18.0',
  'sha256:' || pg_catalog.repeat('4', 64), '[]'::jsonb,
  'Initial release', pg_catalog.statement_timestamp(),
  '95000000-0000-4000-8000-000000000001'
);

update vortex_definition.roots
set current_release_revision = 1
where root_id = '37000000-0000-4000-8000-000000000001';

create temporary table prepared_delegation_application on commit drop as
with source_release as (
  select pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', 'proof.delegation_application',
    'rootId', '37000000-0000-4000-8000-000000000001',
    'releaseRevision', 1, 'releaseVersion', '1.0.0',
    'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
  ) as value
), permission_value as (
  select pg_catalog.jsonb_build_object(
    'permissionId', '38000000-0000-4000-8000-000000000001',
    'key', 'proof.records.read', 'label', 'View records',
    'description', 'View proof records.', 'actionKind', 'read',
    'administrative', false
  ) as value
), candidate as (
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '25000000-0000-4000-8000-000000000001',
    'applicationRootId', '37000000-0000-4000-8000-000000000001',
    'applicationRelease', source_release.value,
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat('5', 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array(
      '38000000-0000-4000-8000-000000000001'
    ),
    'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'applicationRootId', '37000000-0000-4000-8000-000000000001',
      'ownerKind', 'application',
      'ownerId', '37000000-0000-4000-8000-000000000001',
      'permission', permission_value.value,
      'sourceRelease', source_release.value,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
  ) as value
  from source_release cross join permission_value
)
select pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object(
    'kind', 'registration_candidate'
  ),
  'permissionRegistration', candidate.value,
  'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'template', pg_catalog.jsonb_build_object(
      'roleId', '39000000-0000-4000-8000-000000000001',
      'key', 'records_reader', 'name', 'Records reader',
      'homePageId', '39000000-0000-4000-8000-000000000001',
      'permissionKeys', pg_catalog.jsonb_build_array('proof.records.read'),
      'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
    ),
    'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
    'sourcePermissions', candidate.value -> 'entries',
    'livePermissions', candidate.value -> 'entries'
  )),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
) as prepared
from candidate;

select *
from vortex_access.coordinate_application_access_change(
  'register', null, (select prepared from prepared_delegation_application),
  '25000000-0000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000031'
);

insert into vortex_access.organization_groups (
  organization_id, group_id, group_key, label, state, revision,
  created_by, created_at, changed_by, changed_at, change_correlation_id
) values
  (
    '25000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000001', 'delegation_group',
    'Delegation Group', 'active', 1,
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    'a5000000-0000-4000-8000-000000000008'
  ),
  (
    '25000000-0000-4000-8000-000000000001',
    '35000000-0000-4000-8000-000000000002', 'retired_delegation_group',
    'Retired delegation Group', 'active', 1,
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    'a5000000-0000-4000-8000-000000000009'
  ),
  (
    '25000000-0000-4000-8000-000000000002',
    '35000000-0000-4000-8000-000000000003', 'foreign_delegation_group',
    'Foreign delegation Group', 'active', 1,
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    '95000000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(),
    'a5000000-0000-4000-8000-000000000010'
  );

update vortex_access.organization_groups
set state = 'retired', revision = 2,
  changed_by = '95000000-0000-4000-8000-000000000001',
  changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = 'a5000000-0000-4000-8000-000000000030'
where organization_id = '25000000-0000-4000-8000-000000000001'
  and group_id = '35000000-0000-4000-8000-000000000002';

create function pg_temp.current_platform_permissions(
  p_organization_id uuid,
  p_count integer
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(candidate.permission order by candidate.ordinality)
  from (
    select pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'ownerKind', entry.owner_kind,
      'ownerId', entry.owner_id,
      'permissionId', entry.permission_id,
      'acceptedRegistrationRevision', entry.registration_revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', entry.meaning_fingerprint
    ) as permission,
    pg_catalog.row_number() over (
      order by entry.application_root_id asc nulls last,
        entry.owner_kind collate "C", entry.owner_id, entry.permission_id
    ) as ordinality
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = entry.organization_id
      and continuity.application_root_id is not distinct from
        entry.application_root_id
      and continuity.owner_kind = entry.owner_kind
      and continuity.owner_id = entry.owner_id
      and continuity.permission_id = entry.permission_id
      and continuity.state = 'available'
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
    order by entry.application_root_id asc nulls last,
      entry.owner_kind collate "C", entry.owner_id, entry.permission_id
    limit p_count
  ) as candidate;
$function$;

create function pg_temp.current_application_permissions(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'kind', 'exact',
      'applicationRootId', entry.application_root_id,
      'ownerKind', entry.owner_kind,
      'ownerId', entry.owner_id,
      'permissionId', entry.permission_id,
      'acceptedRegistrationRevision', entry.registration_revision,
      'catalogueFingerprint', registration.permission_catalogue_fingerprint,
      'continuityRevision', continuity.continuity_revision,
      'meaningFingerprint', entry.meaning_fingerprint
    )
    order by entry.application_root_id, entry.owner_kind collate "C",
      entry.owner_id, entry.permission_id
  )
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registrations as current_registration
    on current_registration.organization_id = entry.organization_id
    and current_registration.registration_kind = entry.registration_kind
    and current_registration.registration_owner_id = entry.registration_owner_id
    and current_registration.revision = entry.registration_revision
    and current_registration.state = 'active'
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
    and registration.state = 'active'
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id = entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
    and continuity.state = 'available'
  where entry.organization_id = p_organization_id
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = p_application_root_id;
$function$;

select is(
  pg_catalog.jsonb_array_length(pg_temp.current_platform_permissions(
    '25000000-0000-4000-8000-000000000001', 2
  )),
  2,
  'the bounded delegation fixture uses two exact current canonical tuples'
);

create temporary table delegation_application_scope on commit drop as
select pg_temp.current_application_permissions(
  '25000000-0000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000001'
) as permissions;

select is(
  pg_catalog.jsonb_array_length(
    (select permissions from delegation_application_scope)
  ),
  1,
  'the stale-scope fixture begins with one exact current application tuple'
);

create temporary table delegation_results (
  outcome text,
  operation text,
  delegation jsonb,
  access_version bigint,
  correlation_id uuid
) on commit drop;

create temporary table initial_delegation_access_version on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id = '25000000-0000-4000-8000-000000000001';

insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000001', null,
  'organization_account',
  '55000000-0000-4000-8000-000000000001', null,
  'organization_catalogue', null, null,
  pg_catalog.statement_timestamp() + interval '1 hour', null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000011'
);

select is(
  (
    select operation || ':' || (delegation ->> 'revision') || ':' ||
      (delegation #>> '{holder,kind}') || ':' ||
      (delegation #>> '{scope,kind}') || ':' ||
      ((delegation ? 'expiresAt') is false)::text
    from delegation_results
  ),
  'grant_delegation:1:organization_account:organization_catalogue:true',
  'grant returns the complete scheduled permanent account delegation'
);

select is(
  (
    select access_version
    from delegation_results
  ),
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '25000000-0000-4000-8000-000000000001'
  ),
  'grant returns the exact committed Access version'
);

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000002', null,
  'group', null, '35000000-0000-4000-8000-000000000001',
  'bounded', (select permissions from delegation_application_scope),
  'sha256:' || pg_catalog.repeat('b', 64),
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp() + interval '1 hour',
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000012'
);

select is(
  (
    select (delegation #>> '{holder,kind}') || ':' ||
      (delegation #>> '{scope,kind}') || ':' ||
      pg_catalog.jsonb_array_length(delegation #> '{scope,permissions}') || ':' ||
      (delegation ?& array[
        'delegationAuthorityId', 'organizationId', 'holder', 'scope',
        'revision', 'startsAt', 'expiresAt', 'state', 'grantedByActorId',
        'grantedAt', 'grantCorrelationId', 'changedByActorId', 'changedAt',
        'changeCorrelationId'
      ])::text
    from delegation_results
  ),
  'group:bounded:1:true',
  'grant returns a complete finite Group delegation with its exact bounded set'
);

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000005', null,
  'organization_account',
  '55000000-0000-4000-8000-000000000001', null,
  'bounded', pg_temp.current_platform_permissions(
    '25000000-0000-4000-8000-000000000001', 2
  ), 'sha256:' || pg_catalog.repeat('d', 64),
  pg_catalog.statement_timestamp(), null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000026'
);

select is(
  pg_catalog.jsonb_array_length(
    (select delegation #> '{scope,permissions}' from delegation_results)
  ),
  2,
  'a second independent bounded delegation retains its own exact scope'
);

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000006', null,
  'organization_account',
  '55000000-0000-4000-8000-000000000001', null,
  'bounded', (select permissions from delegation_application_scope),
  'sha256:' || pg_catalog.repeat('f', 64),
  pg_catalog.statement_timestamp(), null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000032'
);

select is(
  (select delegation #>> '{scope,permissions,0,applicationRootId}'
   from delegation_results),
  '37000000-0000-4000-8000-000000000001',
  'an independent account delegation captures the application scope for stale revocation proof'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000003', null,
      'organization_account',
      '55000000-0000-4000-8000-000000000003', null,
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000013'
    )
  $$,
  '40001'::char(5),
  'Organization delegation holder is stale or unavailable',
  'grant refuses an account from another organization'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000003', null,
      'organization_account',
      '55000000-0000-4000-8000-000000000002', null,
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000014'
    )
  $$,
  '40001'::char(5),
  'Organization delegation holder is stale or unavailable',
  'grant refuses an inactive account holder'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000003', null,
      'group', null, '35000000-0000-4000-8000-000000000002',
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000015'
    )
  $$,
  '40001'::char(5),
  'Organization delegation holder is stale or unavailable',
  'grant refuses a retired Group holder'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000003', null,
      'group', null, '35000000-0000-4000-8000-000000000003',
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000035'
    )
  $$,
  '40001'::char(5),
  'Organization delegation holder is stale or unavailable',
  'grant refuses a Group from another organization'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000003', null,
      'organization_account',
      '55000000-0000-4000-8000-000000000001', null,
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp() - interval '2 hours',
      pg_catalog.statement_timestamp() - interval '1 hour',
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000016'
    )
  $$,
  '40001'::char(5),
  'Organization delegation window is no longer current',
  'grant refuses an already-expired window after locking sources'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001', null,
      'organization_account',
      '55000000-0000-4000-8000-000000000001', null,
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000017'
    )
  $$,
  '40001'::char(5),
  'Organization delegation grant is stale or unavailable',
  'a permanent delegation identity cannot be granted twice'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'replace_delegation_scope',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000002', 1,
      null, null, null, 'bounded',
      (select permissions from delegation_application_scope),
      'sha256:' || pg_catalog.repeat('a', 64), null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000018'
    )
  $$,
  '40001'::char(5),
  'Organization delegation scope is unchanged',
  'replacement refuses an identical normalized scope despite different fingerprint evidence'
);

create temporary table delegation_two_provenance on commit drop as
select holder_kind, organization_account_id, group_id, starts_at, expires_at,
  granted_by, granted_at, grant_correlation_id
from vortex_access.organization_delegation_authorities
where organization_id = '25000000-0000-4000-8000-000000000001'
  and delegation_authority_id = '65000000-0000-4000-8000-000000000002';

select lives_ok(
  $$
    select * from vortex_access.coordinate_application_access_change(
      'withdraw', 1, null,
      '25000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000001',
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000033'
    )
  $$,
  'the real application writer makes the accepted delegation scope stale'
);

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'replace_delegation_scope',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000002', 1,
  null, null, null, 'organization_catalogue', null, null, null, null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000019'
);

select is(
  (
    select (delegation #>> '{scope,kind}') || ':' ||
      (delegation ->> 'revision') || ':' ||
      (delegation #>> '{holder,groupId}')
    from delegation_results
  ),
  'organization_catalogue:2:35000000-0000-4000-8000-000000000001',
  'replacement refreshes stale bounded authority by changing the complete scope'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'startsAt', delegation -> 'startsAt',
      'expiresAt', delegation -> 'expiresAt',
      'grantedByActorId', delegation -> 'grantedByActorId',
      'grantedAt', delegation -> 'grantedAt',
      'grantCorrelationId', delegation -> 'grantCorrelationId'
    )
    from delegation_results
  ),
  (
    select pg_catalog.jsonb_build_object(
      'startsAt', pg_catalog.to_jsonb(starts_at),
      'expiresAt', pg_catalog.to_jsonb(expires_at),
      'grantedByActorId', pg_catalog.to_jsonb(granted_by),
      'grantedAt', pg_catalog.to_jsonb(granted_at),
      'grantCorrelationId', pg_catalog.to_jsonb(grant_correlation_id)
    )
    from delegation_two_provenance
  ),
  'scope replacement returns the unchanged holder window and grant provenance'
);

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'replace_delegation_scope',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000005', 1,
  null, null, null, 'bounded',
  pg_temp.current_platform_permissions(
    '25000000-0000-4000-8000-000000000001', 1
  ), 'sha256:' || pg_catalog.repeat('e', 64), null, null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000027'
);

select is(
  (
    select (delegation #>> '{scope,kind}') || ':' ||
      pg_catalog.jsonb_array_length(delegation #> '{scope,permissions}') || ':' ||
      (delegation ->> 'revision')
    from delegation_results
  ),
  'bounded:1:2',
  'bounded replacement validates only its new current complete scope'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'replace_delegation_scope',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001', 1,
      null, null, null, 'bounded',
      (select permissions from delegation_application_scope),
      'sha256:' || pg_catalog.repeat('c', 64), null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000020'
    )
  $$,
  '23514'::char(5),
  'Bounded delegation permissions require exact current catalogue evidence',
  'replacement validates the proposed bounded scope against current application continuity'
);

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'revoke_delegation',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000006', 1,
  null, null, null, null, null, null, null, null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000034'
);

select is(
  (select (delegation ->> 'state') || ':' ||
    (delegation #>> '{scope,kind}') from delegation_results),
  'revoked:bounded',
  'revocation ignores stale stored application scope and preserves it as audit evidence'
);

update vortex_identity.organization_accounts
set state = 'suspended', suspended_at = pg_catalog.statement_timestamp(),
  changed_at = pg_catalog.statement_timestamp(),
  state_changed_at = pg_catalog.statement_timestamp(),
  state_changed_by = '95000000-0000-4000-8000-000000000001',
  state_change_correlation_id = 'a5000000-0000-4000-8000-000000000021',
  revision = 2
where organization_id = '25000000-0000-4000-8000-000000000001'
  and organization_account_id = '55000000-0000-4000-8000-000000000001';

truncate delegation_results;
insert into delegation_results
select *
from vortex_access.coordinate_organization_delegation_authority_change(
  'revoke_delegation',
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000001', 1,
  null, null, null, null, null, null, null, null,
  '95000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000021'
);

select is(
  (
    select operation || ':' || (delegation ->> 'state') || ':' ||
      (delegation ->> 'revision') || ':' ||
      ((delegation ->> 'revokedByActorId') =
        (delegation ->> 'changedByActorId'))::text || ':' ||
      ((delegation ->> 'revocationCorrelationId') =
        (delegation ->> 'changeCorrelationId'))::text
    from delegation_results
  ),
  'revoke_delegation:revoked:2:true:true',
  'revocation succeeds with stale scope and an inactive holder and returns coherent evidence'
);

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'revoke_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000001', 2,
      null, null, null, null, null, null, null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000022'
    )
  $$,
  '40001'::char(5),
  'Organization delegation change is stale or unavailable',
  'a revoked delegation cannot be changed or granted again under its identity'
);

set constraints all immediate;
set constraints all deferred;

savepoint delegation_revision_exhaustion;
set local session_replication_role = replica;
update vortex_access.organization_delegation_authorities
set revision = 9007199254740991
where organization_id = '25000000-0000-4000-8000-000000000001'
  and delegation_authority_id = '65000000-0000-4000-8000-000000000005';
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'replace_delegation_scope',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000005', 9007199254740991,
      null, null, null, 'organization_catalogue', null, null, null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000036'
    )
  $$,
  '22003'::char(5),
  'Organization delegation authority revision is exhausted',
  'delegation revision exhaustion refuses before changing scope or Access'
);

select is(
  (
    select pg_catalog.concat_ws('|', revision, scope_kind, scope_fingerprint)
    from vortex_access.organization_delegation_authorities
    where organization_id = '25000000-0000-4000-8000-000000000001'
      and delegation_authority_id = '65000000-0000-4000-8000-000000000005'
  ),
  '9007199254740991|bounded|sha256:' || pg_catalog.repeat('e', 64),
  'delegation revision exhaustion leaves the stored fact unchanged'
);
rollback to savepoint delegation_revision_exhaustion;

savepoint delegation_access_exhaustion;
set local session_replication_role = replica;
update vortex_access.organization_access_versions
set current_version = 9007199254740991
where organization_id = '25000000-0000-4000-8000-000000000001';
set local session_replication_role = origin;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'grant_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000007', null,
      'group', null, '35000000-0000-4000-8000-000000000001',
      'organization_catalogue', null, null,
      pg_catalog.statement_timestamp(), null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000037'
    )
  $$,
  '22003'::char(5),
  'Access version is exhausted',
  'Access exhaustion rolls back a proposed delegation grant'
);

select is(
  (
    select pg_catalog.concat_ws('|', version.current_version,
      pg_catalog.count(delegation.delegation_authority_id))
    from vortex_access.organization_access_versions as version
    left join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = version.organization_id
      and delegation.delegation_authority_id =
        '65000000-0000-4000-8000-000000000007'
    where version.organization_id = '25000000-0000-4000-8000-000000000001'
    group by version.current_version
  ),
  '9007199254740991|0',
  'Access exhaustion preserves the forced Access row and creates no delegation'
);
rollback to savepoint delegation_access_exhaustion;

-- A controlled expired fact proves that replacement refuses while reduction
-- remains possible. The trigger is restored inside this rollback-only test.
set constraints all immediate;
set constraints all deferred;
alter table vortex_access.organization_delegation_authorities
  disable trigger organization_delegation_authorities_validate_scope;
insert into vortex_access.organization_delegation_authorities (
  organization_id, delegation_authority_id, holder_kind,
  organization_account_id, group_id, scope_kind, bounded_permissions,
  scope_fingerprint, revision, starts_at, expires_at, state, granted_by,
  granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
) values (
  '25000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000004', 'group',
  null, '35000000-0000-4000-8000-000000000001',
  'organization_catalogue', null, null, 1,
  pg_catalog.statement_timestamp() - interval '2 hours',
  pg_catalog.statement_timestamp() - interval '1 hour', 'live',
  '95000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 hours',
  'a5000000-0000-4000-8000-000000000023',
  '95000000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp() - interval '2 hours',
  'a5000000-0000-4000-8000-000000000023'
);
alter table vortex_access.organization_delegation_authorities
  enable trigger organization_delegation_authorities_validate_scope;

select throws_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'replace_delegation_scope',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000004', 1,
      null, null, null, 'organization_catalogue', null, null, null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000024'
    )
  $$,
  '40001'::char(5),
  'Organization delegation window is no longer current',
  'an expired delegation cannot receive replacement scope'
);

select lives_ok(
  $$
    select *
    from vortex_access.coordinate_organization_delegation_authority_change(
      'revoke_delegation',
      '25000000-0000-4000-8000-000000000001',
      '65000000-0000-4000-8000-000000000004', 1,
      null, null, null, null, null, null, null, null,
      '95000000-0000-4000-8000-000000000001',
      'a5000000-0000-4000-8000-000000000025'
    )
  $$,
  'revocation remains possible after delegation expiry'
);

select is(
  (
    select change_reason
    from vortex_access.organization_access_versions
    where organization_id = '25000000-0000-4000-8000-000000000001'
  ),
  'delegation_changed',
  'successful delegation changes record the dedicated Access reason'
);

select is(
  (
    select version.current_version - initial.current_version
    from vortex_access.organization_access_versions as version
    cross join initial_delegation_access_version as initial
    where version.organization_id = '25000000-0000-4000-8000-000000000001'
  ),
  10::bigint,
  'delegation changes and the real withdrawal increment Access exactly once each'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.organization_delegation_authorities
    where organization_id = '25000000-0000-4000-8000-000000000001'
  ),
  5,
  'refused delegation changes create no partial facts'
);

set constraints all immediate;

select * from finish();

rollback;
