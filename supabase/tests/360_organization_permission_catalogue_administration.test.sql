\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

create function pg_temp.install_permission_administration_context(
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
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '23600000-0000-4000-8000-000000000001';

  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '83600000-0000-4000-8000-000000000001',
    'tenantId', '13600000-0000-4000-8000-000000000001',
    'organizationId', '23600000-0000-4000-8000-000000000001',
    'organizationAccountId', p_organization_account_id,
    'identityId', p_identity_id,
    'sessionId', '63600000-0000-4000-8000-000000000099',
    'authenticationStrength', 'multi_factor',
    'issuedAt', operation_at,
    'expiresAt', operation_at + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', 'a3600000-0000-4000-8000-000000000001'
  ));
end
$function$;

create function pg_temp.seed_permission_registration(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_current_revision bigint,
  p_current_state text,
  p_module_id uuid,
  p_permission_id uuid,
  p_key text,
  p_current_label text,
  p_fingerprint_character text
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  selected_revision bigint;
  selected_label text;
begin
  if p_current_revision not in (1, 2)
    or p_current_state not in ('active', 'withdrawn') then
    raise exception using errcode = '22023', message = 'Test registration input is invalid';
  end if;

  for selected_revision in 1..p_current_revision loop
    selected_label := case when selected_revision = p_current_revision
      then p_current_label else 'Historical module permission' end;

    insert into vortex_access.permission_registration_revisions (
      organization_id, registration_kind, registration_owner_id, revision,
      state, operation, source_definition_key, source_version, source_revision,
      validation_contract_version, source_content_fingerprint,
      source_resolution_fingerprint, permission_catalogue_fingerprint,
      candidate_fingerprint, changed_at, changed_by, change_correlation_id
    ) values (
      p_organization_id, 'application', p_application_root_id,
      selected_revision,
      case when selected_revision = p_current_revision then p_current_state else 'active' end,
      case
        when selected_revision = 1 then 'register'
        when p_current_state = 'withdrawn' then 'withdraw'
        else 'update'
      end,
      'example.permission_administration',
      case when selected_revision = 1 then '1.0.0' else '1.1.0' end,
      selected_revision, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64),
      'sha256:' || pg_catalog.repeat('2', 64),
      'sha256:' || pg_catalog.repeat('3', 64), operation_at,
      '93600000-0000-4000-8000-000000000001',
      'a3600000-0000-4000-8000-000000000010'
    );

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
      selected_revision, p_application_root_id, 'module', p_module_id,
      p_permission_id, p_key, selected_label,
      'Review records through the registered module permission.',
      '53600000-0000-4000-8000-000000000001', 'named', 'review', false,
      'module', 'example.permission_administration', p_module_id,
      case when selected_revision = 1 then '1.0.0' else '1.1.0' end,
      selected_revision, '1.0.0',
      'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
      'sha256:' || pg_catalog.repeat('1', 64), null,
      'sha256:' || pg_catalog.repeat('4', 64)
    );
  end loop;

  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    p_organization_id, 'application', p_application_root_id, p_current_state,
    p_current_revision, 'example.permission_administration',
    case when p_current_revision = 1 then '1.0.0' else '1.1.0' end,
    p_current_revision, '1.0.0',
    'sha256:' || pg_catalog.repeat(p_fingerprint_character, 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64), operation_at,
    '93600000-0000-4000-8000-000000000001',
    'a3600000-0000-4000-8000-000000000010'
  );
end
$function$;

select has_function(
  'vortex_access', 'list_organization_permissions_for_administration',
  array['uuid', 'text', 'uuid', 'uuid', 'integer'],
  'Access exposes one bounded protected permission catalogue list'
);
select has_function(
  'vortex_access', 'read_organization_permission_for_administration',
  array['uuid', 'text', 'uuid', 'uuid'],
  'Access exposes one exact protected permission catalogue detail read'
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
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid in (
      'vortex_access.list_organization_permissions_for_administration(uuid,text,uuid,uuid,integer)'::regprocedure,
      'vortex_access.read_organization_permission_for_administration(uuid,text,uuid,uuid)'::regprocedure
    )
  ),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'name', 'list_organization_permissions_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'read_organization_permission_for_administration',
      'owner', 'postgres', 'securityDefiner', true, 'volatility', 'v',
      'configuration', array['search_path=""']
    )
  ),
  'both permission reads are narrow owner-held protected projections'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.list_organization_permissions_for_administration(uuid,text,uuid,uuid,integer)',
    'EXECUTE'
  ) and pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_organization_permission_for_administration(uuid,text,uuid,uuid)',
    'EXECUTE'
  ),
  'request role can execute both protected permission projections'
);
select ok(
  not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.list_organization_permissions_for_administration(uuid,text,uuid,uuid,integer)',
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    caller.role_name,
    'vortex_access.read_organization_permission_for_administration(uuid,text,uuid,uuid)',
    'EXECUTE'
  ),
  caller.role_name || ' cannot execute protected permission projections'
)
from (values
  ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime')
) as caller(role_name)
order by caller.role_name collate "C";
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.organization_permissions_administration_scope()', 'EXECUTE'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.permission_catalogue_entries', 'SELECT'
  ) and not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_access.permission_registrations', 'SELECT'
  ),
  'request role cannot bypass the fixed decision or safe projection'
);

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '13600000-0000-4000-8000-000000000001', 'permission_administration',
  'Permission administration', 'active', pg_catalog.statement_timestamp(),
  '93600000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (
    '23600000-0000-4000-8000-000000000001',
    '13600000-0000-4000-8000-000000000001', 'permission_administration',
    'Permission administration', 'active', pg_catalog.statement_timestamp(),
    '93600000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  ),
  (
    '23600000-0000-4000-8000-000000000002',
    '13600000-0000-4000-8000-000000000001', 'foreign_permissions',
    'Foreign permissions', 'active', pg_catalog.statement_timestamp(),
    '93600000-0000-4000-8000-000000000001',
    pg_catalog.statement_timestamp(), 1
  );
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '43600000-0000-4000-8000-000000000001', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '93600000-0000-4000-8000-000000000001',
    'a3600000-0000-4000-8000-000000000002', 1
  ),
  (
    '43600000-0000-4000-8000-000000000002', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    '93600000-0000-4000-8000-000000000001',
    'a3600000-0000-4000-8000-000000000003', 1
  );
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name,
  state, activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  (
    '53600000-0000-4000-8000-000000000010',
    '23600000-0000-4000-8000-000000000001',
    '43600000-0000-4000-8000-000000000001', 'Permission steward', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '93600000-0000-4000-8000-000000000001',
    'a3600000-0000-4000-8000-000000000004', 1
  ),
  (
    '53600000-0000-4000-8000-000000000020',
    '23600000-0000-4000-8000-000000000001',
    '43600000-0000-4000-8000-000000000002', 'No permission authority', 'active',
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '93600000-0000-4000-8000-000000000001',
    'a3600000-0000-4000-8000-000000000005', 1
  );

select * from vortex_access.initialize_organization_access_version(
  '23600000-0000-4000-8000-000000000001',
  '93600000-0000-4000-8000-000000000001',
  'a3600000-0000-4000-8000-000000000006'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '23600000-0000-4000-8000-000000000001',
  '93600000-0000-4000-8000-000000000001',
  'a3600000-0000-4000-8000-000000000007'
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
where entry.organization_id = '23600000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'platform';
select * from vortex_access.coordinate_organization_stewardship_adoption(
  '23600000-0000-4000-8000-000000000001',
  '53600000-0000-4000-8000-000000000010',
  '63600000-0000-4000-8000-000000000001',
  'permission_administration_steward', 'Permission administration steward',
  'Minimum authority for the protected permission catalogue fixture.',
  '73600000-0000-4000-8000-000000000001',
  '83600000-0000-4000-8000-000000000001',
  '93600000-0000-4000-8000-000000000001',
  'a3600000-0000-4000-8000-000000000008'
);

select pg_temp.seed_permission_registration(
  '23600000-0000-4000-8000-000000000001',
  '33600000-0000-4000-8000-000000000001', 2, 'active',
  '43600000-0000-4000-8000-000000000100',
  '53600000-0000-4000-8000-000000000100',
  'example.shared.records.review', 'Current app one module permission', '5'
);
select pg_temp.seed_permission_registration(
  '23600000-0000-4000-8000-000000000001',
  '33600000-0000-4000-8000-000000000002', 1, 'active',
  '43600000-0000-4000-8000-000000000100',
  '53600000-0000-4000-8000-000000000100',
  'example.shared.records.review', 'App two module permission', '6'
);
select pg_temp.seed_permission_registration(
  '23600000-0000-4000-8000-000000000001',
  '33600000-0000-4000-8000-000000000003', 2, 'withdrawn',
  '43600000-0000-4000-8000-000000000200',
  '53600000-0000-4000-8000-000000000200',
  'example.withdrawn.records.review', 'Withdrawn permission', '7'
);
select pg_temp.seed_permission_registration(
  '23600000-0000-4000-8000-000000000002',
  '33600000-0000-4000-8000-000000000004', 1, 'active',
  '43600000-0000-4000-8000-000000000300',
  '53600000-0000-4000-8000-000000000300',
  'example.foreign.records.review', 'Foreign permission', '8'
);

set constraints all immediate;
set constraints all deferred;

grant usage on schema extensions to vortex_request;
select pg_temp.install_permission_administration_context(
  '43600000-0000-4000-8000-000000000001',
  '53600000-0000-4000-8000-000000000010'
);
set local role vortex_request;

select results_eq(
  $$
    select permissions -> 0 -> 'reference',
      next_after_application_root_id, next_after_owner_kind,
      next_after_owner_id, next_after_permission_id, access_version
    from vortex_access.list_organization_permissions_for_administration(
      null, null, null, null, 1
    )
  $$,
  $$values (
    '{"applicationRootId":"33600000-0000-4000-8000-000000000001","ownerKind":"module","ownerId":"43600000-0000-4000-8000-000000000100","permissionId":"53600000-0000-4000-8000-000000000100"}'::jsonb,
    '33600000-0000-4000-8000-000000000001'::uuid, 'module'::text,
    '43600000-0000-4000-8000-000000000100'::uuid,
    '53600000-0000-4000-8000-000000000100'::uuid, 3::bigint
  )$$,
  'authorized request receives the first contextual entry and complete cursor'
);
select results_eq(
  $$
    select permissions -> 0 -> 'reference', next_after_application_root_id
    from vortex_access.list_organization_permissions_for_administration(
      '33600000-0000-4000-8000-000000000001', 'module',
      '43600000-0000-4000-8000-000000000100',
      '53600000-0000-4000-8000-000000000100', 1
    )
  $$,
  $$values (
    '{"applicationRootId":"33600000-0000-4000-8000-000000000002","ownerKind":"module","ownerId":"43600000-0000-4000-8000-000000000100","permissionId":"53600000-0000-4000-8000-000000000100"}'::jsonb,
    '33600000-0000-4000-8000-000000000002'::uuid
  )$$,
  'the same module permission in a second application remains a distinct entry'
);
select results_eq(
  $$
    select permissions -> 0 -> 'reference' ? 'applicationRootId',
      next_after_application_root_id, next_after_owner_kind
    from vortex_access.list_organization_permissions_for_administration(
      '33600000-0000-4000-8000-000000000002', 'module',
      '43600000-0000-4000-8000-000000000100',
      '53600000-0000-4000-8000-000000000100', 1
    )
  $$,
  $$values (false, null::uuid, 'platform'::text)$$,
  'explicit NULLS LAST ordering crosses from application context to platform entries'
);
select is(
  (
    select outcome || '|' || (permission_summary ->> 'label') || '|' ||
      (permission_summary #>> '{action,actionKind}') || '|' ||
      (permission_summary #>> '{action,namedAction}') || '|' ||
      (permission_summary ->> 'recordTypeId') || '|' || access_version::text
    from vortex_access.read_organization_permission_for_administration(
      '33600000-0000-4000-8000-000000000001', 'module',
      '43600000-0000-4000-8000-000000000100',
      '53600000-0000-4000-8000-000000000100'
    )
  ),
  'available|Current app one module permission|named|review|53600000-0000-4000-8000-000000000001|3',
  'detail returns the current declaration and declared action metadata only'
);
select is(
  (
    select pg_catalog.array_agg(key order by key)::text
    from vortex_access.read_organization_permission_for_administration(
      '33600000-0000-4000-8000-000000000001', 'module',
      '43600000-0000-4000-8000-000000000100',
      '53600000-0000-4000-8000-000000000100'
    ) as detail
    cross join lateral pg_catalog.jsonb_object_keys(detail.permission_summary) as key
  ),
  '{action,administrative,description,key,label,recordTypeId,reference}',
  'safe detail omits scope, source, fingerprints, registration and audit evidence'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.list_organization_permissions_for_administration(
      null, null, null, null, 100
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.permissions) as item
    where item ->> 'key' = 'example.shared.records.review'
  ),
  2::bigint,
  'registered declarations remain visible independently of role acceptance'
);
select is(
  (
    select pg_catalog.count(*)
    from vortex_access.list_organization_permissions_for_administration(
      null, null, null, null, 100
    ) as page
    cross join lateral pg_catalog.jsonb_array_elements(page.permissions) as item
    where item ->> 'label' = 'Historical module permission'
      or item ->> 'key' = 'example.withdrawn.records.review'
  ),
  0::bigint,
  'historical and withdrawn registration entries are absent'
);
select results_eq(
  $$
    select outcome, permission_summary, access_version
    from vortex_access.read_organization_permission_for_administration(
      '33600000-0000-4000-8000-000000000003', 'module',
      '43600000-0000-4000-8000-000000000200',
      '53600000-0000-4000-8000-000000000200'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb, 3::bigint)$$,
  'withdrawn current detail is unavailable'
);
select results_eq(
  $$
    select outcome, permission_summary, access_version
    from vortex_access.read_organization_permission_for_administration(
      '33600000-0000-4000-8000-000000000004', 'module',
      '43600000-0000-4000-8000-000000000300',
      '53600000-0000-4000-8000-000000000300'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb, 3::bigint)$$,
  'a foreign contextual reference is unavailable without leaking its existence'
);
select results_eq(
  $$
    select outcome, permission_summary, access_version
    from vortex_access.read_organization_permission_for_administration(
      null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
      'ffffffff-ffff-4fff-8fff-ffffffffffff'
    )
  $$,
  $$values ('unavailable'::text, null::jsonb, 3::bigint)$$,
  'an unknown exact permission reference is unavailable'
);
select throws_ok(
  $$select * from vortex_access.list_organization_permissions_for_administration(
    null, 'module', '43600000-0000-4000-8000-000000000100',
    '53600000-0000-4000-8000-000000000100', 10
  )$$,
  '22023', 'Organization permission catalogue page input is invalid',
  'an incomplete contextual cursor refuses before reading storage'
);
select throws_ok(
  $$select * from vortex_access.list_organization_permissions_for_administration(
    '33600000-0000-4000-8000-000000000001', null,
    '43600000-0000-4000-8000-000000000100',
    '53600000-0000-4000-8000-000000000100', 10
  )$$,
  '22023', 'Organization permission catalogue page input is invalid',
  'a partial cursor with a missing owner kind refuses closed'
);
select throws_ok(
  $$select * from vortex_access.read_organization_permission_for_administration(
    '33600000-0000-4000-8000-000000000001', null,
    '43600000-0000-4000-8000-000000000100',
    '53600000-0000-4000-8000-000000000100'
  )$$,
  '22023', 'Organization permission catalogue detail input is invalid',
  'a detail reference with a missing owner kind refuses closed'
);

reset role;
select pg_temp.install_permission_administration_context(
  '43600000-0000-4000-8000-000000000002',
  '53600000-0000-4000-8000-000000000020'
);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.list_organization_permissions_for_administration(
    null, null, null, null, 10
  )$$,
  '42501', 'Organization permission catalogue is unavailable',
  'an active account without permissions-read cannot list catalogue entries'
);
select throws_ok(
  $$select * from vortex_access.read_organization_permission_for_administration(
    null, 'platform', 'cabe121e-0baf-4084-9471-cce915d460a8',
    '687d5649-62ee-43dd-b684-b8af3a5394c1'
  )$$,
  '42501', 'Organization permission catalogue is unavailable',
  'an active account without permissions-read cannot read exact detail'
);
reset role;

set constraints all immediate;
select * from finish();
rollback;
