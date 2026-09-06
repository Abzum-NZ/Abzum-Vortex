begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '11295000-0000-4000-8000-000000000001',
  'registration_time_tenant', 'Registration time tenant', 'active',
  pg_catalog.statement_timestamp(), '91295000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '21295000-0000-4000-8000-000000000001',
  '11295000-0000-4000-8000-000000000001', null,
  'registration_time_org', 'Registration time organisation', 'active',
  pg_catalog.statement_timestamp(), '91295000-0000-4000-8000-000000000001',
  pg_catalog.statement_timestamp(), 1
);

select * from vortex_access.initialize_organization_access_version(
  '21295000-0000-4000-8000-000000000001',
  '91295000-0000-4000-8000-000000000001',
  '71295000-0000-4000-8000-000000000001'
);

create function pg_temp.registration_time_permission(p_label text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', '41295000-0000-4000-8000-000000000001'::uuid,
    'key', 'example.records.read',
    'label', p_label,
    'description', 'Read example records.',
    'actionKind', 'read',
    'administrative', false
  )
$function$;

create function pg_temp.registration_time_candidate(
  p_release_revision bigint,
  p_release_version text,
  p_label text,
  p_content_character text,
  p_resolution_character text,
  p_catalogue_character text,
  p_candidate_character text,
  p_meaning_character text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', '21295000-0000-4000-8000-000000000001'::uuid,
    'applicationRootId', '31295000-0000-4000-8000-000000000001'::uuid,
    'applicationRelease', pg_catalog.jsonb_build_object(
      'kind', 'application',
      'definitionKey', 'example.registration_time',
      'rootId', '31295000-0000-4000-8000-000000000001'::uuid,
      'releaseRevision', p_release_revision,
      'releaseVersion', p_release_version,
      'validationContractVersion', '2.15.0',
      'contentFingerprint',
        'sha256:' || pg_catalog.repeat(p_content_character, 64),
      'resolutionFingerprint',
        'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
    ),
    'applicationCatalogueFingerprint',
      'sha256:' || pg_catalog.repeat(p_catalogue_character, 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array(
      '41295000-0000-4000-8000-000000000001'::uuid
    ),
    'entries', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId',
          '31295000-0000-4000-8000-000000000001'::uuid,
        'ownerKind', 'application',
        'ownerId', '31295000-0000-4000-8000-000000000001'::uuid,
        'permission', pg_temp.registration_time_permission(p_label),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application',
          'definitionKey', 'example.registration_time',
          'rootId', '31295000-0000-4000-8000-000000000001'::uuid,
          'releaseRevision', p_release_revision,
          'releaseVersion', p_release_version,
          'validationContractVersion', '2.15.0',
          'contentFingerprint',
            'sha256:' || pg_catalog.repeat(p_content_character, 64),
          'resolutionFingerprint',
            'sha256:' || pg_catalog.repeat(p_resolution_character, 64)
        ),
        'meaningFingerprint',
          'sha256:' || pg_catalog.repeat(p_meaning_character, 64)
      )
    ),
    'candidateFingerprint',
      'sha256:' || pg_catalog.repeat(p_candidate_character, 64)
  )
$function$;

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values (
  '31295000-0000-4000-8000-000000000001',
  '21295000-0000-4000-8000-000000000001',
  'application', 'example.registration_time',
  pg_catalog.statement_timestamp(),
  '91295000-0000-4000-8000-000000000001'
);

insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  (
    '31295000-0000-4000-8000-000000000001', 1, '1.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.registration_time","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('5', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application',
      'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.registration_time_permission('View records')
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object(
      'fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)
    ),
    'sha256:' || pg_catalog.repeat('a', 64),
    'sha256:' || pg_catalog.repeat('b', 64),
    '2.15.0', 'sha256:' || pg_catalog.repeat('6', 64),
    '[]', 'Initial registration-time release',
    pg_catalog.statement_timestamp(),
    '91295000-0000-4000-8000-000000000001'
  ),
  (
    '31295000-0000-4000-8000-000000000001', 2, '2.0.0',
    '{"source_contract_version":"1.0.0","kind":"application","key":"example.registration_time","body":{}}'::jsonb,
    'sha256:' || pg_catalog.repeat('7', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application',
      'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(
            pg_temp.registration_time_permission('Read records')
          )
        )
      )
    ),
    pg_catalog.jsonb_build_object(
      'fingerprint', 'sha256:' || pg_catalog.repeat('1', 64)
    ),
    'sha256:' || pg_catalog.repeat('f', 64),
    'sha256:' || pg_catalog.repeat('1', 64),
    '2.15.0', 'sha256:' || pg_catalog.repeat('8', 64),
    '[]', 'Updated registration-time release',
    pg_catalog.statement_timestamp(),
    '91295000-0000-4000-8000-000000000001'
  );

update vortex_definition.roots
set current_release_revision = 2
where root_id = '31295000-0000-4000-8000-000000000001';

create temporary table initial_registration on commit drop as
select *
from vortex_access.apply_application_permission_registration_v1_internal(
  'register',
  null,
  pg_temp.registration_time_candidate(
    1, '1.0.0', 'View records', 'a', 'b', 'c', 'd', 'e'
  ),
  '91295000-0000-4000-8000-000000000002',
  '71295000-0000-4000-8000-000000000002'
);

select results_eq(
  $$
    select registration_revision, access_version
    from initial_registration
  $$,
  $$ values (1::bigint, 2::bigint) $$,
  'creation still appends revision one and one Access increment'
);

create temporary table future_registration_time on commit drop as
select pg_catalog.clock_timestamp() + interval '1 day' as changed_at;

-- Model a complete previous revision whose observation was made while the
-- database clock was ahead. The existing protector accepts this one exact
-- revision and its current/history evidence remains internally consistent.
insert into vortex_access.permission_registration_revisions (
  organization_id, registration_kind, registration_owner_id, revision,
  state, operation, source_definition_key, source_version, source_revision,
  validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint, permission_catalogue_fingerprint,
  candidate_fingerprint, changed_at, changed_by, change_correlation_id
)
select revision.organization_id, revision.registration_kind,
  revision.registration_owner_id, 2, revision.state, 'update',
  revision.source_definition_key, revision.source_version,
  revision.source_revision, revision.validation_contract_version,
  revision.source_content_fingerprint, revision.source_resolution_fingerprint,
  revision.permission_catalogue_fingerprint, revision.candidate_fingerprint,
  future.changed_at, '91295000-0000-4000-8000-000000000003',
  '71295000-0000-4000-8000-000000000003'
from vortex_access.permission_registration_revisions as revision
cross join future_registration_time as future
where revision.organization_id =
    '21295000-0000-4000-8000-000000000001'
  and revision.registration_kind = 'application'
  and revision.registration_owner_id =
    '31295000-0000-4000-8000-000000000001'
  and revision.revision = 1;

insert into vortex_access.permission_catalogue_entries
select entry.organization_id, entry.registration_kind,
  entry.registration_owner_id, 2, entry.application_root_id,
  entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.permission_key, entry.label, entry.description,
  entry.record_type_id, entry.action_kind, entry.named_action,
  entry.administrative, entry.source_kind, entry.source_definition_key,
  entry.source_root_id, entry.source_version, entry.source_revision,
  entry.source_validation_contract_version,
  entry.source_content_fingerprint, entry.source_resolution_fingerprint,
  entry.source_catalogue_fingerprint, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id =
    '21295000-0000-4000-8000-000000000001'
  and entry.registration_kind = 'application'
  and entry.registration_owner_id =
    '31295000-0000-4000-8000-000000000001'
  and entry.registration_revision = 1;

update vortex_access.permission_registrations
set revision = 2,
    changed_at = (select changed_at from future_registration_time),
    changed_by = '91295000-0000-4000-8000-000000000003',
    change_correlation_id = '71295000-0000-4000-8000-000000000003'
where organization_id = '21295000-0000-4000-8000-000000000001'
  and registration_kind = 'application'
  and registration_owner_id =
    '31295000-0000-4000-8000-000000000001';

update vortex_access.organization_access_versions
set current_version = current_version + 1,
    changed_at = (select changed_at from future_registration_time),
    changed_by = '91295000-0000-4000-8000-000000000003',
    change_correlation_id = '71295000-0000-4000-8000-000000000003',
    change_reason = 'application_access_changed'
where organization_id = '21295000-0000-4000-8000-000000000001';

select throws_ok(
  $$
    update vortex_access.permission_registrations
    set revision = revision + 1,
        changed_at = pg_catalog.statement_timestamp(),
        changed_by = '91295000-0000-4000-8000-000000000004',
        change_correlation_id =
          '71295000-0000-4000-8000-000000000004'
    where organization_id =
        '21295000-0000-4000-8000-000000000001'
      and registration_kind = 'application'
      and registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  $$,
  '23514'::char(5),
  'Permission registration updates require one permanent-scope revision',
  'an incomplete direct update carrying an older audit time is refused'
);

select results_eq(
  $$
    select revision, changed_at, changed_by, change_correlation_id
    from vortex_access.permission_registrations
    where organization_id =
        '21295000-0000-4000-8000-000000000001'
      and registration_kind = 'application'
      and registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  $$,
  $$
    select 2::bigint, future.changed_at,
      '91295000-0000-4000-8000-000000000003'::uuid,
      '71295000-0000-4000-8000-000000000003'::uuid
    from future_registration_time as future
  $$,
  'the refused incomplete direct update leaves the current registration unchanged'
);

create temporary table corrected_update on commit drop as
select *
from vortex_access.apply_application_permission_registration_v1_internal(
  'update',
  2,
  pg_temp.registration_time_candidate(
    2, '2.0.0', 'Read records', 'f', '1', '2', '3', '4'
  ),
  '91295000-0000-4000-8000-000000000004',
  '71295000-0000-4000-8000-000000000004'
);

select results_eq(
  $$
    select registration_revision, access_version
    from corrected_update
  $$,
  $$ values (3::bigint, 4::bigint) $$,
  'a corrected update appends one revision and one Access increment'
);

select is(
  (
    select current_registration.changed_at
    from vortex_access.permission_registrations as current_registration
    where current_registration.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and current_registration.registration_kind = 'application'
      and current_registration.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  ),
  (
    select history.changed_at
    from vortex_access.permission_registration_revisions as history
    where history.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and history.registration_kind = 'application'
      and history.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
      and history.revision = 3
  ),
  'the update writes one identical observation to current and immutable evidence'
);

select is(
  (
    select changed_at
    from vortex_access.permission_registrations
    where organization_id = '21295000-0000-4000-8000-000000000001'
      and registration_kind = 'application'
      and registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  ),
  (select changed_at from future_registration_time),
  'the update retains the later prior observation time'
);

create temporary table corrected_withdrawal on commit drop as
select *
from vortex_access.withdraw_application_permission_registration_v1_internal(
  '21295000-0000-4000-8000-000000000001',
  '31295000-0000-4000-8000-000000000001',
  3,
  '91295000-0000-4000-8000-000000000005',
  '71295000-0000-4000-8000-000000000005'
);

select results_eq(
  $$
    select registration_state, registration_revision, access_version
    from corrected_withdrawal
  $$,
  $$ values ('withdrawn'::text, 4::bigint, 5::bigint) $$,
  'a corrected withdrawal appends one revision and one Access increment'
);

select is(
  (
    select current_registration.changed_at
    from vortex_access.permission_registrations as current_registration
    where current_registration.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and current_registration.registration_kind = 'application'
      and current_registration.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  ),
  (
    select history.changed_at
    from vortex_access.permission_registration_revisions as history
    where history.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and history.registration_kind = 'application'
      and history.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
      and history.revision = 4
  ),
  'withdrawal keeps current and immutable audit evidence identical'
);

create temporary table corrected_reactivation on commit drop as
select *
from vortex_access.apply_application_permission_registration_v1_internal(
  'reactivate',
  4,
  pg_temp.registration_time_candidate(
    2, '2.0.0', 'Read records', 'f', '1', '2', '3', '4'
  ),
  '91295000-0000-4000-8000-000000000006',
  '71295000-0000-4000-8000-000000000006'
);

select results_eq(
  $$
    select registration_state, registration_revision, access_version
    from corrected_reactivation
  $$,
  $$ values ('active'::text, 5::bigint, 6::bigint) $$,
  'a corrected reactivation appends one revision and one Access increment'
);

select results_eq(
  $$
    select history.revision, history.operation, history.state,
      history.changed_at
    from vortex_access.permission_registration_revisions as history
    where history.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and history.registration_kind = 'application'
      and history.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
      and history.revision >= 2
    order by history.revision
  $$,
  $$
    select expected.revision, expected.operation, expected.state,
      future.changed_at
    from (
      values
        (2::bigint, 'update'::text, 'active'::text),
        (3::bigint, 'update'::text, 'active'::text),
        (4::bigint, 'withdraw'::text, 'withdrawn'::text),
        (5::bigint, 'reactivate'::text, 'active'::text)
    ) as expected(revision, operation, state)
    cross join future_registration_time as future
    order by expected.revision
  $$,
  'every post-fixture revision retains ordered operation and nondecreasing audit evidence'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.permission_registration_revisions as history
    where history.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and history.registration_kind = 'application'
      and history.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
      and (history.revision, history.changed_by,
        history.change_correlation_id) in (
          (3::bigint,
            '91295000-0000-4000-8000-000000000004'::uuid,
            '71295000-0000-4000-8000-000000000004'::uuid),
          (4::bigint,
            '91295000-0000-4000-8000-000000000005'::uuid,
            '71295000-0000-4000-8000-000000000005'::uuid),
          (5::bigint,
            '91295000-0000-4000-8000-000000000006'::uuid,
            '71295000-0000-4000-8000-000000000006'::uuid)
        )
  ),
  3,
  'update, withdrawal and reactivation retain their exact actor and correlation evidence'
);

select ok(
  exists (
    select 1
    from vortex_access.permission_registrations as current_registration
    join vortex_access.permission_registration_revisions as history
      on history.organization_id = current_registration.organization_id
      and history.registration_kind = current_registration.registration_kind
      and history.registration_owner_id =
        current_registration.registration_owner_id
      and history.revision = current_registration.revision
    where current_registration.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and current_registration.registration_kind = 'application'
      and current_registration.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
      and current_registration.state = history.state
      and current_registration.source_definition_key =
        history.source_definition_key
      and current_registration.source_version = history.source_version
      and current_registration.source_revision = history.source_revision
      and current_registration.validation_contract_version =
        history.validation_contract_version
      and current_registration.source_content_fingerprint =
        history.source_content_fingerprint
      and current_registration.source_resolution_fingerprint =
        history.source_resolution_fingerprint
      and current_registration.permission_catalogue_fingerprint =
        history.permission_catalogue_fingerprint
      and current_registration.candidate_fingerprint =
        history.candidate_fingerprint
      and current_registration.changed_at = history.changed_at
      and current_registration.changed_by = history.changed_by
      and current_registration.change_correlation_id =
        history.change_correlation_id
  ),
  'the current registration exactly matches its latest immutable revision evidence'
);

select results_eq(
  $$
    select current_version, changed_at, changed_by,
      change_correlation_id, change_reason
    from vortex_access.organization_access_versions
    where organization_id =
      '21295000-0000-4000-8000-000000000001'
  $$,
  $$
    select 6::bigint, future.changed_at,
      '91295000-0000-4000-8000-000000000006'::uuid,
      '71295000-0000-4000-8000-000000000006'::uuid,
      'application_access_changed'::text
    from future_registration_time as future
  $$,
  'the corrected operations retain exact one-step Access evidence at the same later observation'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_access.permission_catalogue_entries
    where organization_id =
        '21295000-0000-4000-8000-000000000001'
      and registration_kind = 'application'
      and registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  ),
  5,
  'each successful registration revision has one exact immutable permission entry'
);

create temporary table stale_before on commit drop as
select
  (select pg_catalog.to_jsonb(registration.*)
   from vortex_access.permission_registrations as registration
   where registration.organization_id =
       '21295000-0000-4000-8000-000000000001'
     and registration.registration_kind = 'application'
     and registration.registration_owner_id =
       '31295000-0000-4000-8000-000000000001') as registration,
  (select pg_catalog.count(*)
   from vortex_access.permission_registration_revisions as history
   where history.organization_id =
       '21295000-0000-4000-8000-000000000001'
     and history.registration_kind = 'application'
     and history.registration_owner_id =
       '31295000-0000-4000-8000-000000000001') as history_count,
  (select pg_catalog.to_jsonb(version.*)
   from vortex_access.organization_access_versions as version
   where version.organization_id =
       '21295000-0000-4000-8000-000000000001') as access_version;

select throws_ok(
  pg_catalog.format(
    'select * from vortex_access.apply_application_permission_registration_v1_internal(%L, %s, %L::jsonb, %L, %L)',
    'update',
    4,
    pg_temp.registration_time_candidate(
      2, '2.0.0', 'Read records', 'f', '1', '2', '3', '4'
    ),
    '91295000-0000-4000-8000-000000000007',
    '71295000-0000-4000-8000-000000000007'
  ),
  '40001'::char(5),
  'Application permission registration revision is stale or unavailable',
  'a stale expected revision remains stale'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'registration', pg_catalog.to_jsonb(registration.*),
      'historyCount', (
        select pg_catalog.count(*)
        from vortex_access.permission_registration_revisions as history
        where history.organization_id =
            '21295000-0000-4000-8000-000000000001'
          and history.registration_kind = 'application'
          and history.registration_owner_id =
            '31295000-0000-4000-8000-000000000001'
      ),
      'accessVersion', pg_catalog.to_jsonb(version.*)
    )
    from vortex_access.permission_registrations as registration
    join vortex_access.organization_access_versions as version
      on version.organization_id = registration.organization_id
    where registration.organization_id =
        '21295000-0000-4000-8000-000000000001'
      and registration.registration_kind = 'application'
      and registration.registration_owner_id =
        '31295000-0000-4000-8000-000000000001'
  ),
  (
    select pg_catalog.jsonb_build_object(
      'registration', snapshot.registration,
      'historyCount', snapshot.history_count,
      'accessVersion', snapshot.access_version
    )
    from stale_before as snapshot
  ),
  'stale refusal preserves registration history and Access evidence'
);

select ok(
  not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid)',
    'EXECUTE'
  )
  and (
    select pg_catalog.bool_and(
      function.prosecdef
      and function.proconfig @> array['search_path=""']
    )
    from pg_catalog.pg_proc as function
    where function.oid in (
      'vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)'::regprocedure,
      'vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid)'::regprocedure
    )
  ),
  'the replacement preserves private SECURITY DEFINER and empty-search-path boundaries'
);

set constraints all immediate;

select * from finish();

rollback;
