\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_structural_reduction_context(
  p_identity_id uuid,
  p_organization_account_id uuid,
  p_correlation_id uuid
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
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24100000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '84100000-0000-4000-8000-000000000001',
    'tenantId', '14100000-0000-4000-8000-000000000001',
    'organizationId', '24100000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '64100000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', p_correlation_id
  ));
end
$function$;

create function pg_temp.current_platform_permissions(
  p_organization_id uuid,
  p_permission_ids uuid[]
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_agg(candidate.permission order by
    candidate.application_root_id nulls first,
    candidate.owner_kind collate "C", candidate.owner_id,
    candidate.permission_id)
  from (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id,
      pg_catalog.jsonb_build_object(
        'kind', 'exact', 'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id, 'permissionId', entry.permission_id,
        'acceptedRegistrationRevision', entry.registration_revision,
        'catalogueFingerprint', registration.permission_catalogue_fingerprint,
        'continuityRevision', continuity.continuity_revision,
        'meaningFingerprint', entry.meaning_fingerprint
      ) as permission
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registration_revisions as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
      and registration.state = 'active'
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = entry.organization_id
      and continuity.application_root_id is not distinct from entry.application_root_id
      and continuity.owner_kind = entry.owner_kind
      and continuity.owner_id = entry.owner_id
      and continuity.permission_id = entry.permission_id
      and continuity.state = 'available'
    where entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.permission_id = any(p_permission_ids)
  ) as candidate;
$function$;

select has_function(
  'vortex_access', 'retire_organization_group_for_administration',
  array['uuid', 'bigint', 'uuid'],
  'Access exposes exact protected Group retirement'
);
select has_function(
  'vortex_access', 'remove_organization_group_membership_for_administration',
  array['uuid', 'bigint', 'uuid'],
  'Access exposes exact protected Group membership removal'
);
select has_function(
  'vortex_access', 'revise_organization_role_metadata_for_administration',
  array['uuid', 'bigint', 'text', 'text', 'jsonb', 'uuid'],
  'Access exposes exact protected role metadata revision'
);
select has_function(
  'vortex_access', 'prepare_organization_role_metadata_change_for_administration',
  array['uuid', 'bigint'],
  'Access exposes one authority-checked private role metadata preparation'
);
select has_function(
  'vortex_access', 'retire_organization_role_for_administration',
  array['uuid', 'bigint', 'jsonb', 'uuid'],
  'Access exposes exact protected role retirement'
);

select is(
  (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', procedure_row.proname,
      'owner', owner_role.rolname,
      'securityDefiner', procedure_row.prosecdef,
      'volatility', procedure_row.provolatile,
      'configuration', procedure_row.proconfig
    ) order by procedure_row.proname)
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role
      on owner_role.oid = procedure_row.proowner
    where procedure_row.oid in (
      'vortex_access.prepare_organization_role_metadata_change_for_administration(uuid,bigint)'::regprocedure,
      'vortex_access.retire_organization_group_for_administration(uuid,bigint,uuid)'::regprocedure,
      'vortex_access.remove_organization_group_membership_for_administration(uuid,bigint,uuid)'::regprocedure,
      'vortex_access.revise_organization_role_metadata_for_administration(uuid,bigint,text,text,jsonb,uuid)'::regprocedure,
      'vortex_access.retire_organization_role_for_administration(uuid,bigint,jsonb,uuid)'::regprocedure
    )
  ),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'name', 'prepare_organization_role_metadata_change_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'remove_organization_group_membership_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'retire_organization_group_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'retire_organization_role_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'revise_organization_role_metadata_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    )
  ),
  'all structural reductions are owner-held volatile compositions with empty paths'
);

select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.prepare_organization_role_metadata_change_for_administration(uuid,bigint)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.retire_organization_group_for_administration(uuid,bigint,uuid)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.remove_organization_group_membership_for_administration(uuid,bigint,uuid)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.revise_organization_role_metadata_for_administration(uuid,bigint,text,text,jsonb,uuid)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.retire_organization_role_for_administration(uuid,bigint,jsonb,uuid)',
    'EXECUTE'
  ),
  'the restricted request role can execute all four protected reductions'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.prepare_organization_role_metadata_change_for_administration(uuid,bigint)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.retire_organization_group_for_administration(uuid,bigint,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.remove_organization_group_membership_for_administration(uuid,bigint,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.revise_organization_role_metadata_for_administration(uuid,bigint,text,text,jsonb,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.retire_organization_role_for_administration(uuid,bigint,jsonb,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute protected structural reductions'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";

select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.organization_group_reduction_authority(uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.project_organization_role_change_summary(uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.coordinate_organization_group_change(text,uuid,uuid,bigint,text,text,uuid,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.coordinate_organization_role_change(jsonb,uuid,uuid)',
    'EXECUTE'
  ),
  'request callers cannot bypass the protected compositions or their private derivation'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14100000-0000-4000-8000-000000000001', 'structural_reductions',
  'Structural reductions', 'active', pg_catalog.clock_timestamp(),
  '94100000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '24100000-0000-4000-8000-000000000001',
    '14100000-0000-4000-8000-000000000001', 'structural_reductions',
    'Structural reductions', 'active', pg_catalog.clock_timestamp(),
    '94100000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  ),
  (
    '24100000-0000-4000-8000-000000000002',
    '14100000-0000-4000-8000-000000000001', 'structural_foreign',
    'Foreign structural reductions', 'active', pg_catalog.clock_timestamp(),
    '94100000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
  );

insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '44100000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '94100000-0000-4000-8000-000000000001',
    'a4100000-0000-4000-8000-000000000001', 1
  ),
  (
    '44100000-0000-4000-8000-000000000002', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '94100000-0000-4000-8000-000000000001',
    'a4100000-0000-4000-8000-000000000002', 1
  );

insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '54100000-0000-4000-8000-000000000001',
    '24100000-0000-4000-8000-000000000001',
    '44100000-0000-4000-8000-000000000001', 'Catalogue manager', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '94100000-0000-4000-8000-000000000001',
    'a4100000-0000-4000-8000-000000000003', 1
  ),
  (
    '54100000-0000-4000-8000-000000000002',
    '24100000-0000-4000-8000-000000000001',
    '44100000-0000-4000-8000-000000000002', 'Bounded manager', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '94100000-0000-4000-8000-000000000001',
    'a4100000-0000-4000-8000-000000000004', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '24100000-0000-4000-8000-000000000001',
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000005'
);
select * from vortex_access.initialize_organization_access_version(
  '24100000-0000-4000-8000-000000000002',
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '24100000-0000-4000-8000-000000000001',
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000007'
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
  pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24100000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '24100000-0000-4000-8000-000000000001',
  '54100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-000000000001',
  'structural_steward', 'Structural steward',
  'Permanent stewardship for structural-reduction proof.',
  '74100000-0000-4000-8000-000000000001',
  '84100000-0000-4000-8000-000000000001',
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000008'
);

-- A dedicated privileged management role proves that fixed management
-- permission and delegated affected scope remain separate requirements.
select * from vortex_access.coordinate_organization_role_change(
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'candidate', pg_catalog.jsonb_build_object(
      'operation', 'create_custom',
      'organizationId', '24100000-0000-4000-8000-000000000001',
      'roleId', '64100000-0000-4000-8000-000000000010',
      'key', 'bounded_manager', 'label', 'Bounded manager',
      'description', 'Management permissions with deliberately partial delegation.',
      'privilegeClassification', 'privileged',
      'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
      'permissions', pg_temp.current_platform_permissions(
        '24100000-0000-4000-8000-000000000001',
        array[
          '87c96495-c806-4692-9bc2-250ddb10613c'::uuid,
          '6185dc64-464b-4776-97dc-c64a6f299550'::uuid
        ]
      )
    ),
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('1', 64)
  ),
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000010'
);

select * from vortex_access.coordinate_organization_role_change(
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'candidate', pg_catalog.jsonb_build_object(
      'operation', 'create_custom',
      'organizationId', '24100000-0000-4000-8000-000000000001',
      'roleId', '64100000-0000-4000-8000-000000000011',
      'key', 'reviewed_role', 'label', 'Reviewed role',
      'description', 'Role whose exact accepted scope is structurally reduced.',
      'privilegeClassification', 'privileged',
      'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
      'permissions', pg_temp.current_platform_permissions(
        '24100000-0000-4000-8000-000000000001',
        array[
          '687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid,
          'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2'::uuid
        ]
      )
    ),
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
  ),
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000011'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '24100000-0000-4000-8000-000000000001',
  '74100000-0000-4000-8000-000000000010', null,
  '64100000-0000-4000-8000-000000000010', 1,
  'organization_account', '54100000-0000-4000-8000-000000000002', null,
  'standing', pg_catalog.clock_timestamp(), null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000012'
);

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation', '24100000-0000-4000-8000-000000000001',
  '84100000-0000-4000-8000-000000000010', null,
  'organization_account', '54100000-0000-4000-8000-000000000002', null,
  'bounded', pg_temp.current_platform_permissions(
    '24100000-0000-4000-8000-000000000001',
    array['687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid]
  ), 'sha256:' || pg_catalog.repeat('3', 64),
  pg_catalog.clock_timestamp(), null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000013'
);

select * from vortex_access.coordinate_organization_group_change(
  'create_group', '24100000-0000-4000-8000-000000000001',
  '64100000-0000-4000-8000-000000000020', null,
  'review_group', 'Review group',
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000014'
);
select * from vortex_access.coordinate_organization_group_change(
  'create_group', '24100000-0000-4000-8000-000000000002',
  '64100000-0000-4000-8000-000000000099', null,
  'foreign_group', 'Foreign group',
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000015'
);

select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '24100000-0000-4000-8000-000000000001',
  '74100000-0000-4000-8000-000000000020', null,
  '64100000-0000-4000-8000-000000000020',
  '54100000-0000-4000-8000-000000000002',
  pg_catalog.clock_timestamp(), null, null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000016'
);

select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '24100000-0000-4000-8000-000000000001',
  '74100000-0000-4000-8000-000000000021', null,
  '64100000-0000-4000-8000-000000000011', 1,
  'group', null, '64100000-0000-4000-8000-000000000020',
  'standing', pg_catalog.clock_timestamp(), null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000017'
);

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation', '24100000-0000-4000-8000-000000000001',
  '84100000-0000-4000-8000-000000000020', null,
  'group', null, '64100000-0000-4000-8000-000000000020',
  'bounded', pg_temp.current_platform_permissions(
    '24100000-0000-4000-8000-000000000001',
    array['02c772e5-2921-4300-ad90-4f5772a7fa46'::uuid]
  ), 'sha256:' || pg_catalog.repeat('4', 64),
  pg_catalog.clock_timestamp() + interval '1 day', null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000018'
);

set constraints all immediate;
set constraints all deferred;
grant usage on schema extensions to vortex_request;

create temporary table structural_reduction_versions (
  step text primary key,
  access_version bigint not null
);
grant select on structural_reduction_versions to vortex_request;
insert into structural_reduction_versions (step, access_version)
select 'group_retirement', version.current_version
from vortex_access.organization_access_versions as version
where version.organization_id = '24100000-0000-4000-8000-000000000001';

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000002',
  '54100000-0000-4000-8000-000000000002',
  'a4100000-0000-4000-8000-000000000020'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.retire_organization_group_for_administration(
    '64100000-0000-4000-8000-000000000020', 1,
    'b4100000-0000-4000-8000-000000000020')$$,
  '42501'::char(5), 'Organization Group retirement is unavailable',
  'fixed Group management without the complete retained authority cannot retire a Group'
);
reset role;

select * from vortex_access.coordinate_organization_delegation_authority_change(
  'replace_delegation_scope',
  '24100000-0000-4000-8000-000000000001',
  '84100000-0000-4000-8000-000000000010', 1,
  null, null, null, 'bounded', pg_temp.current_platform_permissions(
    '24100000-0000-4000-8000-000000000001',
    array[
      '02c772e5-2921-4300-ad90-4f5772a7fa46'::uuid,
      '687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid,
      'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2'::uuid
    ]
  ), 'sha256:' || pg_catalog.repeat('5', 64), null, null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000030'
);

update structural_reduction_versions as checkpoint
set access_version = version.current_version
from vortex_access.organization_access_versions as version
where checkpoint.step = 'group_retirement'
  and version.organization_id = '24100000-0000-4000-8000-000000000001';

select is(
  (
    select (authority ->> 'kind') || '|' ||
      pg_catalog.jsonb_array_length(authority -> 'permissions')::text
    from vortex_access.organization_group_reduction_authority(
      '24100000-0000-4000-8000-000000000001',
      '64100000-0000-4000-8000-000000000020'
    ) as authority
  ),
  'bounded|3',
  'retained Group assignment and delegation scope forms one deduplicated bounded union'
);

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000002',
  '54100000-0000-4000-8000-000000000002',
  'a4100000-0000-4000-8000-000000000021'
);
set local role vortex_request;
select results_eq(
  $$select group_summary ->> 'state',
      (group_summary ->> 'revision')::bigint, access_version
    from vortex_access.retire_organization_group_for_administration(
      '64100000-0000-4000-8000-000000000020', 1,
      'b4100000-0000-4000-8000-000000000021')$$,
  $$select 'retired'::text, 2::bigint, checkpoint.access_version + 1
    from structural_reduction_versions as checkpoint
    where checkpoint.step = 'group_retirement'$$,
  'complete bounded delegation retires a Group against its deduplicated retained authority'
);
reset role;

select is(
  (
    select organization_group.state || '|' || organization_group.revision::text || '|' ||
      membership.state || '|' || assignment.state || '|' || delegation.state || '|' ||
      activity.action || '|' ||
      (activity.occurred_at = organization_group.changed_at)::text
    from vortex_access.organization_groups as organization_group
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = organization_group.organization_id
      and membership.group_id = organization_group.group_id
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = organization_group.organization_id
      and assignment.group_id = organization_group.group_id
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = organization_group.organization_id
      and delegation.group_id = organization_group.group_id
    join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = organization_group.organization_id
      and activity.activity_id = 'b4100000-0000-4000-8000-000000000021'
    where organization_group.organization_id =
      '24100000-0000-4000-8000-000000000001'
      and organization_group.group_id =
        '64100000-0000-4000-8000-000000000020'
  ),
  'retired|2|live|live|live|retire_group|true',
  'Group retirement retains membership, assignment and delegation evidence and records Activity'
);

insert into structural_reduction_versions (step, access_version)
select 'membership_removal', version.current_version
from vortex_access.organization_access_versions as version
where version.organization_id = '24100000-0000-4000-8000-000000000001';

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000001',
  '54100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000022'
);
set local role vortex_request;
select results_eq(
  $$select membership_summary ->> 'state',
      membership_summary ->> 'temporalState',
      (membership_summary ->> 'revision')::bigint, access_version
    from vortex_access.remove_organization_group_membership_for_administration(
      '74100000-0000-4000-8000-000000000020', 1,
      'b4100000-0000-4000-8000-000000000022')$$,
  $$select 'revoked'::text, 'revoked'::text, 2::bigint,
      checkpoint.access_version + 1
    from structural_reduction_versions as checkpoint
    where checkpoint.step = 'membership_removal'$$,
  'membership removal remains available after Group retirement and retains safe evidence'
);
reset role;

select is(
  (
    select membership.state || '|' || membership.revision::text || '|' ||
      assignment.state || '|' || delegation.state || '|' || activity.action || '|' ||
      (activity.occurred_at = membership.changed_at)::text
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = membership.organization_id
      and assignment.group_id = membership.group_id
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = membership.organization_id
      and delegation.group_id = membership.group_id
    join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = membership.organization_id
      and activity.activity_id = 'b4100000-0000-4000-8000-000000000022'
    where membership.organization_id = '24100000-0000-4000-8000-000000000001'
      and membership.membership_id = '74100000-0000-4000-8000-000000000020'
  ),
  'revoked|2|live|live|remove_group_membership|true',
  'membership removal changes no retained Group assignment or delegation fact'
);

-- Restore the deliberately partial manager scope used by the independent role
-- metadata checks below. The complete bounded union above is already retained
-- as the successful Group-retirement evidence.
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'replace_delegation_scope',
  '24100000-0000-4000-8000-000000000001',
  '84100000-0000-4000-8000-000000000010', 2,
  null, null, null, 'bounded', pg_temp.current_platform_permissions(
    '24100000-0000-4000-8000-000000000001',
    array['687d5649-62ee-43dd-b684-b8af3a5394c1'::uuid]
  ), 'sha256:' || pg_catalog.repeat('6', 64), null, null,
  '94100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000031'
);

insert into structural_reduction_versions (step, access_version)
select 'metadata_revision', version.current_version
from vortex_access.organization_access_versions as version
where version.organization_id = '24100000-0000-4000-8000-000000000001';

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000002',
  '54100000-0000-4000-8000-000000000002',
  'a4100000-0000-4000-8000-000000000023'
);
set local role vortex_request;
select throws_ok(
  $$select *
    from vortex_access.prepare_organization_role_metadata_change_for_administration(
      '64100000-0000-4000-8000-000000000011', 1
    )$$,
  '42501'::char(5), 'Organization role metadata preparation is unavailable',
  'metadata preparation does not disclose private policy evidence without complete authority'
);
select throws_ok(
  $$select * from vortex_access.revise_organization_role_metadata_for_administration(
    '64100000-0000-4000-8000-000000000011', 1,
    'Reviewed role renamed', 'Revised metadata with unchanged authority.',
    jsonb_build_object(
      'contractVersion', '1.0.0',
      'candidate', jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '24100000-0000-4000-8000-000000000001',
        'roleId', '64100000-0000-4000-8000-000000000011',
        'expectedRoleRevision', 1,
        'key', 'reviewed_role', 'label', 'Reviewed role renamed',
        'description', 'Revised metadata with unchanged authority.',
        'privilegeClassification', 'privileged',
        'assignmentPolicy', jsonb_build_object('kind', 'standing')
      ),
      'roleCandidateFingerprint',
        'sha256:fed12065425113be3d4deb76876c7b71cdbc5150c7aa99c3bc5ecadc023ec0c8'
    ), 'b4100000-0000-4000-8000-000000000023')$$,
  '42501'::char(5), 'Organization role metadata revision is unavailable',
  'role management without complete current accepted scope cannot revise metadata'
);
reset role;

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000001',
  '54100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000024'
);
set local role vortex_request;
select results_eq(
  $$select candidate_basis ->> 'operation',
      candidate_basis ->> 'organizationId', candidate_basis ->> 'roleId',
      (candidate_basis ->> 'expectedRoleRevision')::bigint,
      candidate_basis ->> 'key',
      candidate_basis #>> '{assignmentPolicy,kind}',
      organization_id, access_version
    from vortex_access.prepare_organization_role_metadata_change_for_administration(
      '64100000-0000-4000-8000-000000000011', 1
    )$$,
  $$select 'revise_metadata_policy'::text,
      '24100000-0000-4000-8000-000000000001'::text,
      '64100000-0000-4000-8000-000000000011'::text,
      1::bigint, 'reviewed_role'::text, 'standing'::text,
      '24100000-0000-4000-8000-000000000001'::uuid,
      checkpoint.access_version
    from structural_reduction_versions as checkpoint
    where checkpoint.step = 'metadata_revision'$$,
  'authorized preparation returns the exact locked role basis without changing Access'
);
select results_eq(
  $$select role_summary ->> 'label',
      (role_summary ->> 'liveRevision')::bigint,
      (role_summary ->> 'acceptedPermissionCount')::bigint,
      access_version
    from vortex_access.revise_organization_role_metadata_for_administration(
      '64100000-0000-4000-8000-000000000011', 1,
      'Reviewed role renamed', 'Revised metadata with unchanged authority.',
      jsonb_build_object(
        'contractVersion', '1.0.0',
        'candidate', jsonb_build_object(
          'operation', 'revise_metadata_policy',
          'organizationId', '24100000-0000-4000-8000-000000000001',
          'roleId', '64100000-0000-4000-8000-000000000011',
          'expectedRoleRevision', 1,
          'key', 'reviewed_role', 'label', 'Reviewed role renamed',
          'description', 'Revised metadata with unchanged authority.',
          'privilegeClassification', 'privileged',
          'assignmentPolicy', jsonb_build_object('kind', 'standing')
        ),
        'roleCandidateFingerprint',
          'sha256:fed12065425113be3d4deb76876c7b71cdbc5150c7aa99c3bc5ecadc023ec0c8'
      ), 'b4100000-0000-4000-8000-000000000024')$$,
  $$select 'Reviewed role renamed'::text, 2::bigint, 2::bigint,
      checkpoint.access_version + 1
    from structural_reduction_versions as checkpoint
    where checkpoint.step = 'metadata_revision'$$,
  'metadata revision returns the safe current role summary with unchanged accepted count'
);
reset role;

select is(
  (
    select current_revision.role_key || '|' || current_revision.label || '|' ||
      current_revision.description || '|' || current_revision.lifecycle || '|' ||
      current_revision.privilege_classification || '|' ||
      current_revision.assignment_policy || '|' ||
      current_revision.policy_continuity_revision::text || '|' ||
      current_revision.authority_continuity_revision::text || '|' ||
      pg_catalog.count(permission.permission_id)::text
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as current_revision
      on current_revision.organization_id = role.organization_id
      and current_revision.role_id = role.role_id
      and current_revision.revision = role.live_revision
    left join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = current_revision.organization_id
      and permission.role_id = current_revision.role_id
      and permission.role_revision = current_revision.revision
    where role.organization_id = '24100000-0000-4000-8000-000000000001'
      and role.role_id = '64100000-0000-4000-8000-000000000011'
    group by current_revision.role_key, current_revision.label,
      current_revision.description, current_revision.lifecycle,
      current_revision.privilege_classification,
      current_revision.assignment_policy,
      current_revision.policy_continuity_revision,
      current_revision.authority_continuity_revision
  ),
  'reviewed_role|Reviewed role renamed|Revised metadata with unchanged authority.|active|privileged|standing|1|1|2',
  'metadata edit preserves key, lifecycle, classification, policy, continuity and accepted scope'
);

create temporary table structural_reduction_checkpoint (
  access_version bigint not null
);
grant select on structural_reduction_checkpoint to vortex_request;
insert into structural_reduction_checkpoint (access_version)
select version.current_version
from vortex_access.organization_access_versions as version
where version.organization_id = '24100000-0000-4000-8000-000000000001';

select vortex_activity.append_organization_activity_entry(
  '24100000-0000-4000-8000-000000000001',
  'b4100000-0000-4000-8000-000000000025',
  pg_catalog.clock_timestamp(), 'organization_account',
  '54100000-0000-4000-8000-000000000001', 'conflicting_activity',
  array['64100000-0000-4000-8000-000000000011'::uuid], array[]::uuid[],
  'web', 'a4100000-0000-4000-8000-000000000025', 'completed'
);
select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000001',
  '54100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000025'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.revise_organization_role_metadata_for_administration(
    '64100000-0000-4000-8000-000000000011', 2,
    'Rolled back label', 'This metadata must roll back with Activity failure.',
    jsonb_build_object(
      'contractVersion', '1.0.0',
      'candidate', jsonb_build_object(
        'operation', 'revise_metadata_policy',
        'organizationId', '24100000-0000-4000-8000-000000000001',
        'roleId', '64100000-0000-4000-8000-000000000011',
        'expectedRoleRevision', 2,
        'key', 'reviewed_role', 'label', 'Rolled back label',
        'description', 'This metadata must roll back with Activity failure.',
        'privilegeClassification', 'privileged',
        'assignmentPolicy', jsonb_build_object('kind', 'standing')
      ),
      'roleCandidateFingerprint',
        'sha256:3dfdee3d8118f74645a2d1c10511ce0950b90941c618bad1b02c8e1121fa69af'
    ), 'b4100000-0000-4000-8000-000000000025')$$,
  '22023'::char(5), 'Activity identity already records different evidence',
  'Activity collision rolls back role metadata and its Access increment'
);
reset role;

select is(
  (
    select role.live_revision::text || '|' || revision.label || '|' ||
      version.current_version::text
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_access_versions as version
      on version.organization_id = role.organization_id
    where role.organization_id = '24100000-0000-4000-8000-000000000001'
      and role.role_id = '64100000-0000-4000-8000-000000000011'
  ),
  (
    select '2|Reviewed role renamed|' || checkpoint.access_version::text
    from structural_reduction_checkpoint as checkpoint
  ),
  'the failed Activity composition leaves the role revision, metadata and Access exact'
);

insert into structural_reduction_versions (step, access_version)
select 'role_retirement', version.current_version
from vortex_access.organization_access_versions as version
where version.organization_id = '24100000-0000-4000-8000-000000000001';

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000001',
  '54100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000026'
);
set local role vortex_request;
select results_eq(
  $$select role_summary ->> 'lifecycle',
      (role_summary ->> 'liveRevision')::bigint,
      (role_summary ->> 'acceptedPermissionCount')::bigint,
      access_version
    from vortex_access.retire_organization_role_for_administration(
      '64100000-0000-4000-8000-000000000011', 2,
      jsonb_build_object(
        'contractVersion', '1.0.0',
        'candidate', jsonb_build_object(
          'operation', 'retire_role',
          'organizationId', '24100000-0000-4000-8000-000000000001',
          'roleId', '64100000-0000-4000-8000-000000000011',
          'expectedRoleRevision', 2
        ),
        'roleCandidateFingerprint',
          'sha256:6f230c8f6ca590ddeabacc50a2547dc60f8080c936744f3006f9f402b18c548f'
      ), 'b4100000-0000-4000-8000-000000000026')$$,
  $$select 'retired'::text, 3::bigint, 2::bigint,
      checkpoint.access_version + 1
    from structural_reduction_versions as checkpoint
    where checkpoint.step = 'role_retirement'$$,
  'role retirement preserves the accepted snapshot while making lifecycle terminal'
);
reset role;

select is(
  (
    select assignment.state || '|' || organization_group.state || '|' ||
      activity.action || '|' ||
      (activity.occurred_at = revision.changed_at)::text
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_activity.organization_activity_entries as activity
      on activity.organization_id = assignment.organization_id
      and activity.activity_id = 'b4100000-0000-4000-8000-000000000026'
    where assignment.organization_id = '24100000-0000-4000-8000-000000000001'
      and assignment.role_assignment_id = '74100000-0000-4000-8000-000000000021'
  ),
  'live|retired|retire_role|true',
  'role retirement retains its assignment and retired Group facts as evidence'
);

select pg_temp.install_structural_reduction_context(
  '44100000-0000-4000-8000-000000000001',
  '54100000-0000-4000-8000-000000000001',
  'a4100000-0000-4000-8000-000000000027'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.retire_organization_role_for_administration(
    '64100000-0000-4000-8000-000000000011', 2,
    jsonb_build_object(
      'contractVersion', '1.0.0',
      'candidate', jsonb_build_object(
        'operation', 'retire_role',
        'organizationId', '24100000-0000-4000-8000-000000000001',
        'roleId', '64100000-0000-4000-8000-000000000011',
        'expectedRoleRevision', 2
      ),
      'roleCandidateFingerprint',
        'sha256:6f230c8f6ca590ddeabacc50a2547dc60f8080c936744f3006f9f402b18c548f'
    ), 'b4100000-0000-4000-8000-000000000027')$$,
  '40001'::char(5), 'Organization role retirement is stale or unavailable',
  'stale or replayed role retirement refuses without another change'
);
select throws_ok(
  $$select * from vortex_access.retire_organization_role_for_administration(
    '64100000-0000-4000-8000-000000000001', 1,
    jsonb_build_object(
      'contractVersion', '1.0.0',
      'candidate', jsonb_build_object(
        'operation', 'retire_role',
        'organizationId', '24100000-0000-4000-8000-000000000001',
        'roleId', '64100000-0000-4000-8000-000000000001',
        'expectedRoleRevision', 1
      ),
      'roleCandidateFingerprint',
        'sha256:ee9b5c5f82eeac547260a579654288265393475b957013145d556996900d8c51'
    ), 'b4100000-0000-4000-8000-000000000030')$$,
  '23514'::char(5), null,
  'the protected role retirement leaf cannot remove the final permanent steward'
);
reset role;
select is(
  (
    select revision.lifecycle || '|' || role.live_revision::text
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = '24100000-0000-4000-8000-000000000001'
      and role.role_id = '64100000-0000-4000-8000-000000000001'
  ),
  'active|1',
  'refused final-steward retirement leaves the role unchanged'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.retire_organization_group_for_administration(
    '64100000-0000-4000-8000-000000000099', 1,
    'b4100000-0000-4000-8000-000000000028')$$,
  '40001'::char(5), 'Organization Group retirement is stale or unavailable',
  'foreign Group retirement is unavailable inside the selected organization'
);
select throws_ok(
  $$select * from vortex_access.remove_organization_group_membership_for_administration(
    null, 1, 'b4100000-0000-4000-8000-000000000029')$$,
  '22023'::char(5), 'Organization Group membership removal input is invalid',
  'malformed membership removal refuses before authority evaluation'
);
reset role;

select * from finish();

rollback;
