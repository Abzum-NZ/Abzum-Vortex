\ir helpers/private-schema-assertions.psql

begin;

set local search_path = pg_catalog, extensions, public;
grant usage on schema extensions to vortex_runtime, vortex_request;

select no_plan();

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '14850000-0000-4000-8000-000000000001', 'runtime_settings',
  'Runtime settings', 'active', pg_catalog.clock_timestamp(),
  '94850000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values
  ('24850000-0000-4000-8000-000000000001',
    '14850000-0000-4000-8000-000000000001', 'runtime_settings',
    'Runtime settings', 'active', pg_catalog.clock_timestamp(),
    '94850000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1),
  ('24850000-0000-4000-8000-000000000002',
    '14850000-0000-4000-8000-000000000001', 'runtime_settings_other',
    'Other runtime settings', 'active', pg_catalog.clock_timestamp(),
    '94850000-0000-4000-8000-000000000001', pg_catalog.clock_timestamp(), 1);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '44850000-0000-4000-8000-000000000001', 'active',
  pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  '94850000-0000-4000-0000-000000000001',
  'a4850000-0000-4000-8000-000000000001', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  '54850000-0000-4000-8000-000000000001',
  '24850000-0000-4000-8000-000000000001',
  '44850000-0000-4000-8000-000000000001', 'Runtime settings account',
  'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(), '94850000-0000-4000-8000-000000000001',
  'a4850000-0000-4000-8000-000000000002', 1
);
select vortex_access.initialize_organization_access_version(
  '24850000-0000-4000-8000-000000000001',
  '94850000-0000-4000-8000-000000000001',
  'a4850000-0000-4000-8000-000000000003'
);

select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_identity.organization_runtime_settings', 'select,insert,update,delete'
  ),
  'request role has no direct runtime-settings table access'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_identity.read_current_organization_runtime_settings_internal(uuid)', 'execute'
  ),
  'request role cannot call the private Identity reader'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.read_current_organization_runtime_settings_for_application()', 'execute'
  ),
  'request role can call only the Access-owned exact-context reader'
);

-- Catalogue initialization advances Access version, so it precedes the
-- version captured for this request context.
select * from vortex_access.initialize_platform_permission_catalogue(
  '24850000-0000-4000-8000-000000000001',
  '54850000-0000-4000-8000-000000000001',
  'a4850000-0000-4000-8000-000000000005'
);

-- An application request may start before its organisation has completed
-- explicit setup. The authorised reader reports that absence; it does not
-- invent a default or expose another organisation's row.
select current_version as initial_access_version
from vortex_access.organization_access_versions
where organization_id = '24850000-0000-4000-8000-000000000001' \gset
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '84850000-0000-4000-8000-000000000001',
  'tenantId', '14850000-0000-4000-8000-000000000001',
  'organizationId', '24850000-0000-4000-8000-000000000001',
  'organizationAccountId', '54850000-0000-4000-8000-000000000001',
  'identityId', '44850000-0000-4000-8000-000000000001',
  'sessionId', '74850000-0000-4000-8000-000000000001',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', :initial_access_version,
  'correlationId', 'a4850000-0000-4000-8000-000000000004'
));
set local role vortex_request;
select ok(not exists (select 1 from vortex_access.read_current_organization_runtime_settings_for_application()), 'an authorised current-settings reader returns no row until explicit setup exists');
reset role;

set local role vortex_runtime;
select results_eq(
  $$select currency, revision from vortex_identity.initialize_organization_runtime_settings(
    '24850000-0000-4000-8000-000000000001', 'en-NZ', 'Pacific/Auckland',
    'NZD', 'medium', 'auto'
  )$$,
  $$values ('NZD'::text, 1::bigint)$$,
  'trusted explicit setup creates the first settings row'
);
select results_eq(
  $$select currency, revision from vortex_identity.initialize_organization_runtime_settings(
    '24850000-0000-4000-8000-000000000001', 'en-NZ', 'Pacific/Auckland',
    'NZD', 'medium', 'auto'
  )$$,
  $$values ('NZD'::text, 1::bigint)$$,
  'identical trusted setup retry returns the existing settings row'
);
select throws_ok(
  $$select * from vortex_identity.initialize_organization_runtime_settings(
    '24850000-0000-4000-8000-000000000001', 'en-US', 'Pacific/Auckland',
    'NZD', 'medium', 'auto'
  )$$,
  '40001'::char(5), 'Organization runtime settings are already initialized differently',
  'conflicting trusted setup is refused rather than changing existing settings'
);
reset role;
select results_eq(
  $$select language, currency, revision
    from vortex_identity.organization_runtime_settings
    where organization_id = '24850000-0000-4000-8000-000000000001'$$,
  $$values ('en-NZ'::text, 'NZD'::text, 1::bigint)$$,
  'a conflicting trusted setup leaves the existing settings row unchanged'
);
set local role vortex_runtime;
select throws_ok(
  $$select * from vortex_identity.initialize_organization_runtime_settings(
    '24850000-0000-4000-8000-000000000001', 'en-NZ', 'Pacific/Auckland',
    'ZZZ', 'medium', 'auto'
  )$$,
  '22023'::char(5), 'Organization runtime settings are invalid',
  'unsupported currency is refused at the database boundary'
);
select results_eq(
  $$select language, currency from vortex_identity.initialize_organization_runtime_settings(
    '24850000-0000-4000-8000-000000000002',
    'en-US-u-ca-gregory-co-phonebk-nu-latn-x-example', 'Pacific/Auckland',
    'USD', 'medium', 'auto'
  )$$,
  $$values (
    'en-US-u-ca-gregory-co-phonebk-nu-latn-x-example'::text, 'USD'::text
  )$$,
  'trusted setup accepts the 47-character canonical BCP-47 language tag'
);
select throws_ok(
  $$select * from vortex_identity.initialize_organization_runtime_settings(
    '24850000-0000-4000-8000-000000000099', 'en-NZ', 'Pacific/Auckland',
    'NZD', 'medium', 'auto'
  )$$,
  '22023'::char(5), 'Organization runtime settings initialization is unavailable',
  'trusted setup refuses a nonexistent organisation'
);
reset role;

create function pg_temp.seed_runtime_settings_manage_role()
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.clock_timestamp();
begin
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision,
    created_by, created_at
  ) values (
    '24850000-0000-4000-8000-000000000001',
    '64850000-0000-4000-8000-000000000001', 'custom',
    'runtime_settings_manager', 1,
    '54850000-0000-4000-8000-000000000001', operation_at
  );

  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id,
    '64850000-0000-4000-8000-000000000001'::uuid, 1, 1, 'custom',
    null, entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.registration_kind, entry.registration_owner_id,
    entry.registration_revision, registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id is not distinct from
      entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from
      entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '24850000-0000-4000-8000-000000000001'
    and entry.permission_id = 'c658c254-2884-414a-9012-512c0cfe4b34';

  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '24850000-0000-4000-8000-000000000001',
    '64850000-0000-4000-8000-000000000001', 1, 'custom',
    'active', 'privileged', 'standing', 1, 1, null, null, null,
    'runtime_settings_manager', 'Runtime settings manager',
    'Fixture role with only runtime-settings manage authority.',
    '54850000-0000-4000-8000-000000000001', operation_at,
    'a4850000-0000-4000-8000-000000000006'
  );

  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    '24850000-0000-4000-8000-000000000001',
    '74850000-0000-4000-8000-000000000002',
    '64850000-0000-4000-8000-000000000001', 'organization_account',
    '54850000-0000-4000-8000-000000000001', null, 'standing', 1,
    operation_at - interval '1 minute', operation_at + interval '30 minutes',
    'live', '54850000-0000-4000-8000-000000000001', operation_at,
    'a4850000-0000-4000-8000-000000000007',
    '54850000-0000-4000-8000-000000000001', operation_at,
    'a4850000-0000-4000-8000-000000000007'
  );
end
$function$;

select pg_temp.seed_runtime_settings_manage_role();

create temporary table runtime_settings_access_versions on commit drop as
select organization_id, current_version
from vortex_access.organization_access_versions
where organization_id = '24850000-0000-4000-8000-000000000001';

set local role vortex_request;
select results_eq(
  $$select organization_id, currency, revision
    from vortex_access.read_current_organization_runtime_settings_for_application()$$,
  $$values (
    '24850000-0000-4000-8000-000000000001'::uuid, 'NZD'::text, 1::bigint
  )$$,
  'ordinary authorised request reads only its established organisation settings'
);
reset role;

create temporary table runtime_settings_baseline on commit drop as
select organization_id, language, time_zone, currency, date_format,
  number_format, initialized_at, changed_at, revision
from vortex_identity.organization_runtime_settings
where organization_id in (
  '24850000-0000-4000-8000-000000000001'::uuid,
  '24850000-0000-4000-8000-000000000002'::uuid
);

-- Each refusal below runs inside its own savepoint.  Staging is deliberately
-- available once per backend and top-level transaction, so rolling back the
-- savepoint removes the staged row before the next independent request.
create function pg_temp.runtime_settings_are_unchanged()
returns boolean
language sql
stable
set search_path = ''
as $function$
  select
    not exists (
      (
        select organization_id, language, time_zone, currency, date_format,
          number_format, initialized_at, changed_at, revision
        from vortex_identity.organization_runtime_settings
        where organization_id in (
          '24850000-0000-4000-8000-000000000001'::uuid,
          '24850000-0000-4000-8000-000000000002'::uuid
        )
        except
        select organization_id, language, time_zone, currency, date_format,
          number_format, initialized_at, changed_at, revision
        from pg_temp.runtime_settings_baseline
      )
      union all
      (
        select organization_id, language, time_zone, currency, date_format,
          number_format, initialized_at, changed_at, revision
        from pg_temp.runtime_settings_baseline
        except
        select organization_id, language, time_zone, currency, date_format,
          number_format, initialized_at, changed_at, revision
        from vortex_identity.organization_runtime_settings
        where organization_id in (
          '24850000-0000-4000-8000-000000000001'::uuid,
          '24850000-0000-4000-8000-000000000002'::uuid
        )
      )
    );
$function$;

select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_identity.stage_organization_runtime_settings_update(jsonb)',
    'execute'
  ),
  'the request role has no execute privilege for the trusted staging operation'
);
set local role vortex_request;
select throws_ok(
  $$select vortex_identity.stage_organization_runtime_settings_update(
    pg_catalog.jsonb_build_object(
      'organizationId', '24850000-0000-4000-8000-000000000001',
      'language', 'en-NZ', 'timeZone', 'Pacific/Auckland', 'currency', 'AUD',
      'dateFormat', 'medium', 'numberFormat', 'auto', 'revision', 1
    )
  )$$,
  '42501'::char(5),
  'permission denied for schema vortex_identity',
  'the request role cannot invoke the trusted staging operation'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a refused request staging attempt leaves persisted settings unchanged'
);

select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request',
    'vortex_identity.organization_runtime_settings_update_staging',
    'insert, update, delete'
  ),
  'the request role has no direct write privilege for the private staging table'
);
set local role vortex_request;
select throws_ok(
  $$insert into vortex_identity.organization_runtime_settings_update_staging (
    backend_pid, transaction_id, settings
  ) values (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), '{}'::jsonb
  )$$,
  '42501'::char(5),
  'permission denied for schema vortex_identity',
  'the request role cannot write the private staging table'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a refused direct staging-table write leaves persisted settings unchanged'
);

savepoint runtime_settings_without_stage;
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.update_organization_runtime_settings_for_administration(1)$$,
  '42501'::char(5), 'Organization runtime settings update is unavailable',
  'a request cannot update settings without a transaction-bound staged change'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a no-staging refusal leaves persisted settings unchanged'
);
rollback to savepoint runtime_settings_without_stage;

savepoint runtime_settings_without_manage_permission;
delete from vortex_access.organization_role_assignments
where organization_id = '24850000-0000-4000-8000-000000000001'
  and role_assignment_id = '74850000-0000-4000-8000-000000000002';
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '24850000-0000-4000-8000-000000000001',
    'language', 'en-NZ', 'timeZone', 'Pacific/Auckland', 'currency', 'AUD',
    'dateFormat', 'medium', 'numberFormat', 'auto', 'revision', 1
  )
);
reset role;
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.update_organization_runtime_settings_for_administration(1)$$,
  '42501'::char(5), 'Organization runtime settings update is unavailable',
  'a request without the fixed manage permission cannot update staged settings'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a no-manage-permission refusal leaves persisted settings unchanged'
);
rollback to savepoint runtime_settings_without_manage_permission;

savepoint runtime_settings_stale_revision;
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '24850000-0000-4000-8000-000000000001',
    'language', 'en-NZ', 'timeZone', 'Pacific/Auckland', 'currency', 'AUD',
    'dateFormat', 'medium', 'numberFormat', 'auto', 'revision', 2
  )
);
reset role;
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.update_organization_runtime_settings_for_administration(2)$$,
  '40001'::char(5), 'Organization runtime settings are stale or unavailable',
  'a stale expected settings revision is refused after authorization'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a stale-revision refusal leaves persisted settings unchanged'
);
rollback to savepoint runtime_settings_stale_revision;

savepoint runtime_settings_staged_organization_mismatch;
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '24850000-0000-4000-8000-000000000002',
    'language', 'en-NZ', 'timeZone', 'Pacific/Auckland', 'currency', 'AUD',
    'dateFormat', 'medium', 'numberFormat', 'auto', 'revision', 1
  )
);
reset role;
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.update_organization_runtime_settings_for_administration(1)$$,
  '42501'::char(5), 'Organization runtime settings update is unavailable',
  'a staged change for another organisation cannot update the request organisation'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a staged-organisation-mismatch refusal leaves persisted settings unchanged'
);
rollback to savepoint runtime_settings_staged_organization_mismatch;

savepoint runtime_settings_staged_revision_mismatch;
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '24850000-0000-4000-8000-000000000001',
    'language', 'en-NZ', 'timeZone', 'Pacific/Auckland', 'currency', 'AUD',
    'dateFormat', 'medium', 'numberFormat', 'auto', 'revision', 2
  )
);
reset role;
set local role vortex_request;
select throws_ok(
  $$select * from vortex_access.update_organization_runtime_settings_for_administration(1)$$,
  '42501'::char(5), 'Organization runtime settings update is unavailable',
  'a staged revision must match the request expected revision'
);
reset role;
select ok(
  pg_temp.runtime_settings_are_unchanged(),
  'a staged-revision-mismatch refusal leaves persisted settings unchanged'
);
rollback to savepoint runtime_settings_staged_revision_mismatch;

-- A trusted runtime stages a complete, contract-shaped change.  The request
-- role can then apply only that staged change, for its already-established
-- organisation, through the fixed platform permission.
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '24850000-0000-4000-8000-000000000001',
    'language', 'en-US-u-ca-gregory-co-phonebk-nu-latn-x-example',
    'timeZone', 'Pacific/Auckland',
    'currency', 'AUD',
    'dateFormat', 'medium',
    'numberFormat', 'auto',
    'revision', 1
  )
);
reset role;

set local role vortex_request;
select results_eq(
  $$select organization_id, settings ->> 'language', settings ->> 'currency',
      (settings ->> 'revision')::bigint
    from vortex_access.update_organization_runtime_settings_for_administration(1)$$,
  $$values (
    '24850000-0000-4000-8000-000000000001'::uuid,
    'en-US-u-ca-gregory-co-phonebk-nu-latn-x-example'::text,
    'AUD'::text, 2::bigint
  )$$,
  'a request with the fixed standing runtime-settings manage permission applies its staged canonical BCP-47 language tag'
);
reset role;

select results_eq(
  $$select currency, revision
    from vortex_identity.organization_runtime_settings
    where organization_id = '24850000-0000-4000-8000-000000000002'$$,
  $$values ('USD'::text, 1::bigint)$$,
  'the protected update leaves another organisation settings row unchanged'
);
select is(
  (
    select current_version
    from vortex_access.organization_access_versions
    where organization_id = '24850000-0000-4000-8000-000000000001'
  ),
  (select current_version from runtime_settings_access_versions),
  'a runtime-settings update does not change the organisation access version'
);

select * from finish();

rollback;
