\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

create function pg_temp.install_private_authority_context(
  p_identity_id uuid, p_account_id uuid, p_correlation_id uuid
) returns void language plpgsql volatile set search_path = '' as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
  current_access_version bigint;
begin
  perform pg_catalog.set_config('vortex.request_context', '', true);
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24200000-0000-4000-8000-000000000001';
  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '84200000-0000-4000-8000-000000000001',
    'tenantId', '14200000-0000-4000-8000-000000000001',
    'organizationId', '24200000-0000-4000-8000-000000000001',
    'organizationAccountId', p_account_id,
    'identityId', p_identity_id,
    'sessionId', '64200000-0000-4000-8000-000000000001',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at, 'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version, 'correlationId', p_correlation_id
  ));
end
$function$;

create function pg_temp.current_platform_permissions(p_permission_ids uuid[])
returns jsonb language sql stable set search_path = '' as $function$
  select pg_catalog.jsonb_agg(candidate.permission order by
    candidate.owner_kind collate "C", candidate.owner_id,
    candidate.permission_id)
  from (
    select entry.owner_kind, entry.owner_id, entry.permission_id,
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
      and continuity.application_root_id is not distinct from
        entry.application_root_id
      and continuity.owner_kind = entry.owner_kind
      and continuity.owner_id = entry.owner_id
      and continuity.permission_id = entry.permission_id
      and continuity.state = 'available'
    where entry.organization_id = '24200000-0000-4000-8000-000000000001'
      and entry.registration_kind = 'platform'
      and entry.permission_id = any(p_permission_ids)
  ) as candidate;
$function$;

create function pg_temp.application_permission(p_label text)
returns jsonb language sql immutable set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId','43200000-0000-4000-8000-000000000001'::uuid,
    'key','private.records.read','label',p_label,
    'description','Read records in the private composition fixture.',
    'actionKind','read','administrative',false
  );
$function$;

create function pg_temp.application_candidate(
  p_release_revision bigint, p_release_version text,
  p_content_character text, p_resolution_character text,
  p_catalogue_character text, p_candidate_character text,
  p_label text
) returns jsonb language sql stable set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion','1.0.0',
    'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
    'applicationRootId','34200000-0000-4000-8000-000000000001'::uuid,
    'applicationRelease',pg_catalog.jsonb_build_object(
      'kind','application','definitionKey','private.authority',
      'rootId','34200000-0000-4000-8000-000000000001'::uuid,
      'releaseRevision',p_release_revision,'releaseVersion',p_release_version,
      'validationContractVersion','2.18.0',
      'contentFingerprint','sha256:' || pg_catalog.repeat(p_content_character,64),
      'resolutionFingerprint','sha256:' || pg_catalog.repeat(p_resolution_character,64)
    ),
    'applicationCatalogueFingerprint','sha256:' || pg_catalog.repeat(p_catalogue_character,64),
    'applicationPermissionIds',pg_catalog.jsonb_build_array(
      '43200000-0000-4000-8000-000000000001'::uuid),
    'entries',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'applicationRootId','34200000-0000-4000-8000-000000000001'::uuid,
      'ownerKind','application',
      'ownerId','34200000-0000-4000-8000-000000000001'::uuid,
      'permission',pg_temp.application_permission(p_label),
      'sourceRelease',pg_catalog.jsonb_build_object(
        'kind','application','definitionKey','private.authority',
        'rootId','34200000-0000-4000-8000-000000000001'::uuid,
        'releaseRevision',p_release_revision,'releaseVersion',p_release_version,
        'validationContractVersion','2.18.0',
        'contentFingerprint','sha256:' || pg_catalog.repeat(p_content_character,64),
        'resolutionFingerprint','sha256:' || pg_catalog.repeat(p_resolution_character,64)
      ),
      'meaningFingerprint','sha256:' || pg_catalog.repeat('d',64)
    )),
    'candidateFingerprint','sha256:' || pg_catalog.repeat(p_candidate_character,64)
  );
$function$;

create function pg_temp.application_template(
  p_candidate jsonb, p_template_character text
) returns jsonb language sql stable set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'template',pg_catalog.jsonb_build_object(
      'roleId','52200000-0000-4000-8000-000000000001'::uuid,
      'key','records_reader','name','Records reader',
      'homePageId','61200000-0000-4000-8000-000000000001'::uuid,
      'permissionKeys',pg_catalog.jsonb_build_array('private.records.read'),
      'permissionSelection',pg_catalog.jsonb_build_object('kind','exact')
    ),
    'sourceTemplateFingerprint','sha256:' || pg_catalog.repeat(p_template_character,64),
    'sourcePermissions',p_candidate -> 'entries',
    'livePermissions',p_candidate -> 'entries'
  );
$function$;

create function pg_temp.application_registration_preparation(
  p_candidate jsonb, p_template_character text, p_current_revision bigint default null
) returns jsonb language sql stable set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion','1.0.0',
    'preparationBasis',case when p_current_revision is null
      then pg_catalog.jsonb_build_object('kind','registration_candidate')
      else pg_catalog.jsonb_build_object(
        'kind','current_active_registration','registrationRevision',p_current_revision)
      end,
    'permissionRegistration',p_candidate,
    'templates',pg_catalog.jsonb_build_array(
      pg_temp.application_template(p_candidate,p_template_character)),
    'candidateFingerprint','sha256:' || pg_catalog.repeat(
      case when p_current_revision is null then '0' else '1' end,64)
  );
$function$;

create function pg_temp.application_role_permissions(
  p_candidate jsonb, p_registration_revision bigint,
  p_continuity_revision bigint
) returns jsonb language sql stable set search_path = '' as $function$
  select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'kind','exact',
    'applicationRootId','34200000-0000-4000-8000-000000000001'::uuid,
    'ownerKind','application',
    'ownerId','34200000-0000-4000-8000-000000000001'::uuid,
    'permissionId','43200000-0000-4000-8000-000000000001'::uuid,
    'acceptedRegistrationRevision',p_registration_revision,
    'catalogueFingerprint',p_candidate -> 'applicationCatalogueFingerprint',
    'continuityRevision',p_continuity_revision,
    'meaningFingerprint',p_candidate #> '{entries,0,meaningFingerprint}'
  ));
$function$;

create function pg_temp.role_change_evidence(
  p_candidate jsonb,
  p_manifest jsonb default null,
  p_new_policy_fingerprint text default null,
  p_accepted_grant_fingerprint text default null
) returns jsonb language sql immutable set search_path = '' as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'candidate', p_candidate,
    'newActivationPolicyFingerprint', p_new_policy_fingerprint,
    'acceptedGrantFingerprint', p_accepted_grant_fingerprint,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'affectedAssignmentManifest', p_manifest
  ));
$function$;

create function pg_temp.empty_assignment_manifest(p_role_id uuid)
returns jsonb language sql immutable set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', '24200000-0000-4000-8000-000000000001'::uuid,
    'roleId', p_role_id,
    'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'assignments', '[]'::jsonb,
    'manifestFingerprint', 'sha256:' || pg_catalog.repeat('3', 64)
  );
$function$;

select has_function(
  'vortex_access',
  'coordinate_private_organization_delegation_authority_change',
  array['text','uuid','bigint','text','uuid','uuid','jsonb',
    'timestamptz','timestamptz','text','uuid'],
  'private delegation grant/replacement composition exists'
);
select has_function(
  'vortex_access', 'coordinate_private_organization_role_authority_change',
  array['jsonb','text','uuid'],
  'private role-authority composition exists'
);
select function_owner_is(
  'vortex_access',
  'coordinate_private_organization_delegation_authority_change',
  array['text','uuid','bigint','text','uuid','uuid','jsonb',
    'timestamptz','timestamptz','text','uuid'],
  'postgres', 'private delegation composition remains owner controlled'
);
select function_owner_is(
  'vortex_access', 'coordinate_private_organization_role_authority_change',
  array['jsonb','text','uuid'], 'postgres',
  'private role composition remains owner controlled'
);
select ok(
  (
    select pg_catalog.bool_and(procedure.prosecdef)
      and pg_catalog.bool_and(
        procedure.proconfig @> array['search_path=""']::text[]
      )
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'vortex_access'
      and procedure.proname in (
        'coordinate_private_organization_delegation_authority_change',
        'coordinate_private_organization_role_authority_change'
      )
  ),
  'private authority compositions are SECURITY DEFINER with empty paths'
);

select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_private_organization_delegation_authority_change(text,uuid,bigint,text,uuid,uuid,jsonb,timestamptz,timestamptz,text,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.coordinate_private_organization_role_authority_change(jsonb,text,uuid)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.private_management_scope_from_permission_evidence(jsonb)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.private_current_role_management_scope(uuid,uuid,bigint)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot invoke private authority composition'
)
from (values ('public'), ('anon'), ('authenticated'), ('service_role'),
  ('vortex_runtime'), ('vortex_request')) as caller(role_name)
order by caller.role_name collate "C";

grant usage on schema extensions to vortex_request;
set local role vortex_request;
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'grant_delegation','76200000-0000-4000-8000-000000000099',null,
    'organization_account','54200000-0000-4000-8000-000000000099',null,
    pg_catalog.jsonb_build_object('kind','organization_catalogue'),
    pg_catalog.clock_timestamp(),null,'workflow',
    'aa200000-0000-4000-8000-000000000099')
$test$,'42501'::char(5),
  'permission denied for function coordinate_private_organization_delegation_authority_change',
  'request role is directly refused by private delegation composition');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_role_authority_change(
    '{}'::jsonb,'workflow','ab200000-0000-4000-8000-000000000099')
$test$,'42501'::char(5),
  'permission denied for function coordinate_private_organization_role_authority_change',
  'request role is directly refused by private role composition');
reset role;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14200000-0000-4000-8000-000000000001', 'private_authority',
  'Private authority', 'active', pg_catalog.clock_timestamp(),
  '94200000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values (
  '24200000-0000-4000-8000-000000000001',
  '14200000-0000-4000-8000-000000000001', 'private_authority',
  'Private authority', 'active', pg_catalog.clock_timestamp(),
  '94200000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
('44200000-0000-4000-8000-000000000001','active',pg_catalog.clock_timestamp(),
 pg_catalog.clock_timestamp(),'94200000-0000-4000-8000-000000000001',
 'a4200000-0000-4000-8000-000000000001',1),
('44200000-0000-4000-8000-000000000002','active',pg_catalog.clock_timestamp(),
 pg_catalog.clock_timestamp(),'94200000-0000-4000-8000-000000000001',
 'a4200000-0000-4000-8000-000000000002',1);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
('54200000-0000-4000-8000-000000000001','24200000-0000-4000-8000-000000000001',
 '44200000-0000-4000-8000-000000000001','Administrator','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '94200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000003',1),
('54200000-0000-4000-8000-000000000002','24200000-0000-4000-8000-000000000001',
 '44200000-0000-4000-8000-000000000002','Beneficiary','active',
 pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
 '94200000-0000-4000-8000-000000000001','a4200000-0000-4000-8000-000000000004',1);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '34200000-0000-4000-8000-000000000001',
  '24200000-0000-4000-8000-000000000001','application',
  'private.authority',pg_catalog.clock_timestamp(),
  '94200000-0000-4000-8000-000000000001'
);
insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
)
select '34200000-0000-4000-8000-000000000001'::uuid,
  fixture.release_revision,fixture.release_version,
  '{"source_contract_version":"1.0.0","kind":"application","key":"private.authority","body":{}}',
  'sha256:' || pg_catalog.repeat(fixture.authored_character,64),'1.0.0',
  pg_catalog.jsonb_build_object(
    'kind','application','canonical',pg_catalog.jsonb_build_object(
      'content',pg_catalog.jsonb_build_object(
        'permissions',pg_catalog.jsonb_build_array(
          pg_temp.application_permission(fixture.permission_label))
    ))
  ),
  pg_catalog.jsonb_build_object(
    'fingerprint','sha256:' || pg_catalog.repeat(fixture.resolution_character,64)),
  'sha256:' || pg_catalog.repeat(fixture.content_character,64),
  'sha256:' || pg_catalog.repeat(fixture.resolution_character,64),'2.18.0',
  'sha256:' || pg_catalog.repeat(fixture.comparison_character,64),
  '[]'::jsonb,fixture.release_note,pg_catalog.clock_timestamp(),
  '94200000-0000-4000-8000-000000000001'::uuid
from (values
  (1::bigint,'1.0.0'::text,'1'::text,'a'::text,'b'::text,'2'::text,
    'Records reader'::text,'Initial private application release'::text),
  (2::bigint,'1.1.0'::text,'3'::text,'c'::text,'d'::text,'4'::text,
    'Current records reader'::text,'Updated private application release'::text)
) as fixture(
  release_revision,release_version,authored_character,content_character,
  resolution_character,comparison_character,permission_label,release_note
);

create temporary table application_candidates on commit drop as
select pg_temp.application_candidate(
    1,'1.0.0','a','b','c','1','Records reader') as initial_candidate,
  pg_temp.application_candidate(
    2,'1.1.0','c','d','e','2','Current records reader') as update_candidate;

select * from vortex_access.initialize_organization_access_version(
  '24200000-0000-4000-8000-000000000001',
  '94200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000005');
select * from vortex_access.initialize_platform_permission_catalogue(
  '24200000-0000-4000-8000-000000000001',
  '94200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000006');
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, entry.application_root_id, entry.owner_kind,
  entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, 'available', 1, entry.meaning_fingerprint,
  entry.registration_revision, pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '24200000-0000-4000-8000-000000000001';

select * from vortex_access.coordinate_application_access_change(
  'register',null,
  pg_temp.application_registration_preparation(
    (select initial_candidate from application_candidates),'5'),
  '24200000-0000-4000-8000-000000000001',
  '34200000-0000-4000-8000-000000000001',
  '94200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000020');

select * from vortex_access.coordinate_organization_stewardship_adoption(
  '24200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  '74200000-0000-4000-8000-000000000001','private_authority_steward',
  'Private authority steward','Permanent steward for the private proof.',
  '75200000-0000-4000-8000-000000000001',
  '76200000-0000-4000-8000-000000000001',
  '94200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000007');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000008');
create temporary table delegation_grant_result on commit drop as
select *
from vortex_access.coordinate_private_organization_delegation_authority_change(
  'grant_delegation','76200000-0000-4000-8000-000000000002',null,
  'organization_account','54200000-0000-4000-8000-000000000002',null,
  pg_catalog.jsonb_build_object(
    'kind','bounded',
    'permissions',pg_temp.current_platform_permissions(
      array['156d01f3-8f80-45fb-8fc8-b31c47dbb1df'::uuid]),
    -- Fingerprint bytes are opaque at this owner-only SQL seam. The eventual
    -- #267 caller must supply the TS-verified prepared scope; this function
    -- deliberately does not duplicate its canonical fingerprint algorithm.
    'scopeFingerprint','sha256:' || pg_catalog.repeat('4',64)
  ),
  pg_catalog.clock_timestamp() - interval '1 minute',null,'workflow',
  'aa200000-0000-4000-8000-000000000001');
select results_eq(
  $$select outcome,operation,delegation #>> '{scope,kind}'
    from delegation_grant_result$$,
  $$values ('changed'::text,'grant_delegation'::text,'bounded'::text)$$,
  'complete current administrator grants one bounded delegation');
select results_eq(
  $$select source,outcome from vortex_activity.organization_activity_entries
    where activity_id='aa200000-0000-4000-8000-000000000001'$$,
  $$values ('workflow'::text,'completed'::text)$$,
  'delegation grant preserves its trusted source in completed Activity');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000009');
select lives_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'replace_delegation_scope','76200000-0000-4000-8000-000000000002',1,
    null,null,null,pg_catalog.jsonb_build_object('kind','organization_catalogue'),
    null,null,'interface','aa200000-0000-4000-8000-000000000002')
$test$,'complete current administrator replaces exact old scope with catalogue scope');
select results_eq(
  $$select revision,scope_kind,state
    from vortex_access.organization_delegation_authorities
    where delegation_authority_id='76200000-0000-4000-8000-000000000002'$$,
  $$values (2::bigint,'organization_catalogue'::text,'live'::text)$$,
  'replacement preserves the existing delegation revision contract');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000002',
  '54200000-0000-4000-8000-000000000002',
  'a4200000-0000-4000-8000-000000000010');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'grant_delegation','76200000-0000-4000-8000-000000000003',null,
    'organization_account','54200000-0000-4000-8000-000000000002',null,
    pg_catalog.jsonb_build_object('kind','organization_catalogue'),
    pg_catalog.clock_timestamp(),null,'workflow',
    'aa200000-0000-4000-8000-000000000003')
$test$,'42501','Private Organization delegation change is unavailable',
  'verified account without fixed permission and management scope is refused');
select is((select count(*)::bigint
  from vortex_access.organization_delegation_authorities
  where delegation_authority_id='76200000-0000-4000-8000-000000000003'),
  0::bigint,'refused delegation leaves no fact');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000011');
create temporary table role_create_result on commit drop as
select *
from vortex_access.coordinate_private_organization_role_authority_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation','create_custom',
    'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
    'roleId','74200000-0000-4000-8000-000000000002'::uuid,
    'key','private_authority_role','label','Private authority role',
    'description','Created through the private authority composition.',
    'privilegeClassification','privileged',
    'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
    'permissions',pg_temp.current_platform_permissions(
      array['87c96495-c806-4692-9bc2-250ddb10613c'::uuid])
  )),'interface','ab200000-0000-4000-8000-000000000001');
select results_eq(
  $$select operation,role #>> '{kind}',role #>> '{liveRevision}'
    from role_create_result$$,
  $$values ('create_custom'::text,'custom'::text,'1'::text)$$,
  'private role composition creates authority from verified canonical evidence');
select is((select source from vortex_activity.organization_activity_entries
  where activity_id='ab200000-0000-4000-8000-000000000001'),'interface',
  'role composition preserves its trusted non-web Activity source');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000021');
create temporary table template_copy_result on commit drop as
select *
from vortex_access.coordinate_private_organization_role_authority_change(
  pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
    'operation','create_custom_from_template',
    'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
    'roleId','74200000-0000-4000-8000-000000000003'::uuid,
    'key','copied_reader','label','Copied reader',
    'description','Custom role copied from the exact current template.',
    'privilegeClassification','standard',
    'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
    'preparedTemplates',pg_temp.application_registration_preparation(
      (select initial_candidate from application_candidates),'5',1),
    'sourceRoleId','52200000-0000-4000-8000-000000000001'::uuid,
    'templateContinuityRevision',1,
    'permissions',pg_temp.application_role_permissions(
      (select initial_candidate from application_candidates),1,1)
  )),'workflow','ab200000-0000-4000-8000-000000000008');
select results_eq(
  $$select operation,role #>> '{kind}',
      role #>> '{derivedFromTemplate,sourceRoleId}'
    from template_copy_result$$,
  $$values ('create_custom_from_template'::text,'custom'::text,
    '52200000-0000-4000-8000-000000000001'::text)$$,
  'template copy succeeds only with exact current prepared source evidence');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000022');
create temporary table application_role_result on commit drop as
select *
from vortex_access.coordinate_private_organization_role_authority_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation','accept_new_application_role',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000004'::uuid,
      'key','records_reader','label','Records reader',
      'description','Accepted application role.',
      'privilegeClassification','standard',
      'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
      'preparedTemplates',pg_temp.application_registration_preparation(
        (select initial_candidate from application_candidates),'5',1),
      'sourceRoleId','52200000-0000-4000-8000-000000000001'::uuid,
      'templateContinuityRevision',1,
      'permissions',pg_temp.application_role_permissions(
        (select initial_candidate from application_candidates),1,1)
    ),null,null,'sha256:' || pg_catalog.repeat('7',64)
  ),'workflow','ab200000-0000-4000-8000-000000000009');
select results_eq(
  $$select operation,role #>> '{kind}',
      role #>> '{source,acceptedRegistrationRevision}'
    from application_role_result$$,
  $$values ('accept_new_application_role'::text,'application'::text,'1'::text)$$,
  'new application role acceptance composes exact source and authority evidence');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000012');
create temporary table role_permissions_result on commit drop as
select *
from vortex_access.coordinate_private_organization_role_authority_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation','revise_custom_permissions',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000002'::uuid,
      'expectedRoleRevision',1,'key','private_authority_role',
      'label','Private authority role',
      'description','Authority expanded through a complete manifest.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
      'permissions',pg_temp.current_platform_permissions(array[
        '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'::uuid,
        '87c96495-c806-4692-9bc2-250ddb10613c'::uuid])
    ),
    pg_temp.empty_assignment_manifest(
      '74200000-0000-4000-8000-000000000002')
  ),'workflow','ab200000-0000-4000-8000-000000000002');
select results_eq(
  $$select role #>> '{liveRevision}',
      pg_catalog.jsonb_array_length(role -> 'permissions')
    from role_permissions_result$$,
  $$values ('2'::text,2)$$,
  'authority revision reuses the exact affected-assignment manifest');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000013');
create temporary table role_policy_result on commit drop as
select *
from vortex_access.coordinate_private_organization_role_authority_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation','revise_metadata_policy',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000002'::uuid,
      'expectedRoleRevision',2,'key','private_authority_role',
      'label','Private authority role',
      'description','Authority now requires temporary activation.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object(
        'kind','activation_required','activationPolicy',
        pg_catalog.jsonb_build_object(
          'selection','new','policy',pg_catalog.jsonb_build_object(
            'activationPolicyId','75200000-0000-4000-8000-000000000002'::uuid,
            'revision',1,'maximumActivationDurationSeconds',900,
            'reasonRequired',true,
            'recentAuthentication',pg_catalog.jsonb_build_object('kind','none'),
            'independentApprovalRequired',false
          )
        )
      )
    ),
    pg_temp.empty_assignment_manifest(
      '74200000-0000-4000-8000-000000000002'),
    'sha256:' || pg_catalog.repeat('6',64)
  ),'workflow','ab200000-0000-4000-8000-000000000003');
select results_eq(
  $$select role #>> '{liveRevision}',role #>> '{assignmentPolicy,kind}'
    from role_policy_result$$,
  $$values ('3'::text,'activation_required'::text)$$,
  'assignment-policy authority change reuses canonical policy evidence');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000014');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_role_authority_change(
    pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
      'operation','revise_metadata_policy',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000002'::uuid,
      'expectedRoleRevision',3,'key','private_authority_role',
      'label','Private authority role',
      'description','Authority now requires temporary activation.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object(
        'kind','activation_required','activationPolicy',
        pg_catalog.jsonb_build_object(
          'selection','existing','reference',pg_catalog.jsonb_build_object(
            'activationPolicyId','75200000-0000-4000-8000-000000000002'::uuid,
            'revision',1,
            'fingerprint','sha256:' || pg_catalog.repeat('6',64)
          )
        )
      )
    )),'workflow','ab200000-0000-4000-8000-000000000004')
$test$,'40001','Private Organization role-authority candidate changes no authority',
  'metadata-only revision cannot duplicate the structural metadata operation');

select * from vortex_access.coordinate_application_access_change(
  'update',1,
  pg_temp.application_registration_preparation(
    (select update_candidate from application_candidates),'8'),
  '24200000-0000-4000-8000-000000000001',
  '34200000-0000-4000-8000-000000000001',
  '94200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000023');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000024');
create temporary table application_revision_result on commit drop as
select *
from vortex_access.coordinate_private_organization_role_authority_change(
  pg_temp.role_change_evidence(
    pg_catalog.jsonb_build_object(
      'operation','accept_application_role_revision',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000004'::uuid,
      'expectedRoleRevision',1,'key','records_reader',
      'label','Current records reader',
      'description','Accepted current application role revision.',
      'privilegeClassification','standard',
      'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
      'preparedTemplates',pg_temp.application_registration_preparation(
        (select update_candidate from application_candidates),'8',2),
      'sourceRoleId','52200000-0000-4000-8000-000000000001'::uuid,
      'templateContinuityRevision',1,
      'permissions',pg_temp.application_role_permissions(
        (select update_candidate from application_candidates),2,1)
    ),null,null,'sha256:' || pg_catalog.repeat('9',64)
  ),'workflow','ab200000-0000-4000-8000-000000000007');
select results_eq(
  $$select operation,role #>> '{liveRevision}',
      role #>> '{source,acceptedRegistrationRevision}'
    from application_revision_result$$,
  $$values ('accept_application_role_revision'::text,'2'::text,'2'::text)$$,
  'application-role revision composes exact current source and scope evidence');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000025');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'replace_delegation_scope','76200000-0000-4000-8000-000000000002',1,
    null,null,null,pg_catalog.jsonb_build_object('kind','organization_catalogue'),
    null,null,'workflow','aa200000-0000-4000-8000-000000000005')
$test$,'40001','Private Organization delegation change is stale or unavailable',
  'delegation replacement refuses a stale current revision');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_role_authority_change(
    pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
      'operation','revise_custom_permissions',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000002'::uuid,
      'expectedRoleRevision',2,'key','private_authority_role',
      'label','Private authority role','description','Stale role revision.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
      'permissions',pg_temp.current_platform_permissions(
        array['87c96495-c806-4692-9bc2-250ddb10613c'::uuid])
    )),'workflow','ab200000-0000-4000-8000-000000000010')
$test$,'40001','Private Organization role-authority change is stale or unavailable',
  'role-authority change refuses a stale current revision');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_role_authority_change(
    pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
      'operation','create_custom',
      'organizationId','24200000-0000-4000-8000-000000000099'::uuid,
      'roleId','74200000-0000-4000-8000-000000000099'::uuid,
      'key','foreign_role','label','Foreign role',
      'description','Cross-organization candidate.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
      'permissions',pg_temp.current_platform_permissions(
        array['87c96495-c806-4692-9bc2-250ddb10613c'::uuid])
    )),'workflow','ab200000-0000-4000-8000-000000000011')
$test$,'42501','Private Organization role-authority change is unavailable',
  'role-authority composition refuses a foreign organization candidate');

create temporary table role_version_before on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id='24200000-0000-4000-8000-000000000001';
select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000026');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_role_authority_change(
    pg_temp.role_change_evidence(pg_catalog.jsonb_build_object(
      'operation','revise_custom_permissions',
      'organizationId','24200000-0000-4000-8000-000000000001'::uuid,
      'roleId','74200000-0000-4000-8000-000000000002'::uuid,
      'expectedRoleRevision',3,'key','private_authority_role',
      'label','Private authority role','description','Collision must roll back.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object(
        'kind','activation_required','activationPolicy',
        pg_catalog.jsonb_build_object(
          'selection','existing','reference',pg_catalog.jsonb_build_object(
            'activationPolicyId','75200000-0000-4000-8000-000000000002'::uuid,
            'revision',1,
            'fingerprint','sha256:' || pg_catalog.repeat('6',64)
          )
        )
      ),
      'permissions',pg_temp.current_platform_permissions(
        array['87c96495-c806-4692-9bc2-250ddb10613c'::uuid])
    )),'workflow','ab200000-0000-4000-8000-000000000001')
$test$,'22023','Private Organization role-authority input is invalid',
  'Activity collision rolls back an otherwise authorized role revision');
select is((select live_revision from vortex_access.organization_roles
  where role_id='74200000-0000-4000-8000-000000000002'),3::bigint,
  'role Activity collision leaves the current role revision unchanged');
select is((select current_version
  from vortex_access.organization_access_versions
  where organization_id='24200000-0000-4000-8000-000000000001'),
  (select current_version from role_version_before),
  'role Activity collision rolls back the Access change');

-- Give the beneficiary both fixed management permissions, then deliberately
-- narrow its own delegated scope to roles.manage. This distinguishes the
-- fixed permission from complete authority over the proposed after-scope.
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant','24200000-0000-4000-8000-000000000001',
  '79200000-0000-4000-8000-000000000001',null,
  '74200000-0000-4000-8000-000000000001',1,'organization_account',
  '54200000-0000-4000-8000-000000000002',null,'standing',
  pg_catalog.clock_timestamp() - interval '1 minute',null,
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000027');
select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000002',
  '54200000-0000-4000-8000-000000000002',
  'a4200000-0000-4000-8000-000000000028');
select lives_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'replace_delegation_scope','76200000-0000-4000-8000-000000000002',2,
    null,null,null,pg_catalog.jsonb_build_object(
      'kind','bounded',
      'permissions',pg_temp.current_platform_permissions(
        array['87c96495-c806-4692-9bc2-250ddb10613c'::uuid]),
      'scopeFingerprint','sha256:' || pg_catalog.repeat('a',64)
    ),null,null,'workflow','aa200000-0000-4000-8000-000000000006')
$test$,'current catalogue scope permits its own exact reduction');

select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000002',
  '54200000-0000-4000-8000-000000000002',
  'a4200000-0000-4000-8000-000000000029');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'grant_delegation','76200000-0000-4000-8000-000000000005',null,
    'organization_account','54200000-0000-4000-8000-000000000002',null,
    pg_catalog.jsonb_build_object('kind','organization_catalogue'),
    pg_catalog.clock_timestamp(),null,'workflow',
    'aa200000-0000-4000-8000-000000000007')
$test$,'42501','Private Organization delegation change is unavailable',
  'fixed assignments.manage cannot stitch with incomplete delegated scope');
select is((select count(*)::bigint
  from vortex_access.organization_delegation_authorities
  where delegation_authority_id='76200000-0000-4000-8000-000000000005'),
  0::bigint,'partial-scope refusal leaves no delegation');

create temporary table authority_version_before on commit drop as
select current_version
from vortex_access.organization_access_versions
where organization_id='24200000-0000-4000-8000-000000000001';
select pg_temp.install_private_authority_context(
  '44200000-0000-4000-8000-000000000001',
  '54200000-0000-4000-8000-000000000001',
  'a4200000-0000-4000-8000-000000000018');
select throws_ok($test$
  select *
  from vortex_access.coordinate_private_organization_delegation_authority_change(
    'grant_delegation','76200000-0000-4000-8000-000000000004',null,
    'organization_account','54200000-0000-4000-8000-000000000002',null,
    pg_catalog.jsonb_build_object('kind','organization_catalogue'),
    pg_catalog.clock_timestamp(),null,'workflow',
    'aa200000-0000-4000-8000-000000000001')
$test$,'22023','Private Organization delegation change input is invalid',
  'Activity collision rolls back an otherwise authorized delegation grant');
select is((select count(*)::bigint
  from vortex_access.organization_delegation_authorities
  where delegation_authority_id='76200000-0000-4000-8000-000000000004'),
  0::bigint,'Activity collision leaves no delegation');
select is((select current_version
  from vortex_access.organization_access_versions
  where organization_id='24200000-0000-4000-8000-000000000001'),
  (select current_version from authority_version_before),
  'Activity collision rolls back the Access change');

set constraints all immediate;
set constraints all deferred;

select * from finish();
rollback;
