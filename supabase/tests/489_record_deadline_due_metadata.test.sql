begin;
select plan(21);
set local search_path = extensions, public, pg_catalog;

\set tenant_id 'a4890000-0000-4000-8000-000000000001'
\set organization_id 'a4890000-0000-4000-8000-000000000002'
\set storage_contract_id 'a4890000-0000-4000-8000-000000000003'
\set record_type_id 'a4890000-0000-4000-8000-000000000004'
\set app_one 'a4890000-0000-4000-8000-000000000005'
\set app_two 'a4890000-0000-4000-8000-000000000006'
\set record_id 'a4890000-0000-4000-8000-000000000007'
\set rollback_record_id 'a4890000-0000-4000-8000-000000000008'
\set deadline_one 'a4890000-0000-4000-8000-000000000009'
\set deadline_two 'a4890000-0000-4000-8000-000000000010'
\set command_refused 'a4890000-0000-4000-8000-000000000011'
\set command_replayed 'a4890000-0000-4000-8000-000000000012'

-- This fixture deliberately uses the installed private table and forced-RLS
-- role, while keeping the unrelated Record writer fixture out of this bounded
-- metadata proof. The database-test launcher recursively runs every .sql file
-- beneath supabase/tests, so no separate manifest entry is required.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values (
  :'tenant_id'::uuid, 'deadline_metadata', 'Deadline metadata', 'active',
  pg_catalog.statement_timestamp(), 'a4890000-0000-4000-8000-000000000099'::uuid,
  pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  :'organization_id'::uuid, :'tenant_id'::uuid, 'deadline_metadata', 'Deadline metadata',
  'active', pg_catalog.statement_timestamp(),
  'a4890000-0000-4000-8000-000000000099'::uuid, pg_catalog.statement_timestamp(), 1
);
set local role vortex_record_owner;
insert into vortex_record.storage_catalogue (
  storage_contract_id, physical_schema_token, physical_table_token, module_root_id,
  record_type_id, storage_scope, first_compatible_release_revision,
  last_compatible_release_revision, state, generator_contract_version,
  content_fingerprint, record_type_definition
) values (
  :'storage_contract_id'::uuid, 'record_data', 'rt_b4890000000040008000000000000001',
  'a4890000-0000-4000-8000-000000000013'::uuid, :'record_type_id'::uuid,
  'application_contained', 1, null, 'active', '1.0.0',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}'::jsonb
);
reset role;

select has_table('vortex_record', 'record_deadline_due_metadata',
  'the private deadline metadata table is installed');
select ok((select relforcerowsecurity from pg_catalog.pg_class
  where oid = 'vortex_record.record_deadline_due_metadata'::regclass),
  'deadline metadata forces row-level security even for its owner');
select is((select relowner::regrole::text from pg_catalog.pg_class
  where oid = 'vortex_record.record_deadline_due_metadata'::regclass),
  'vortex_record_adapter',
  'the private adapter remains the metadata table owner');
select ok(exists (
  select 1 from pg_catalog.pg_index
  where indrelid = 'vortex_record.record_deadline_due_metadata'::regclass
    and indnullsnotdistinct
),
  'the natural metadata identity includes nullable application scope');
select ok(has_table_privilege('vortex_record_adapter',
  'vortex_record.record_deadline_due_metadata', 'INSERT'),
  'the private adapter can mutate metadata through forced RLS');
select ok(not has_table_privilege('vortex_runtime',
  'vortex_record.record_deadline_due_metadata', 'SELECT'),
  'runtime cannot read private deadline metadata directly');
select ok(not has_table_privilege('vortex_record_adapter',
  'vortex_identity.organizations', 'REFERENCES'),
  'the migration does not leave the adapter foreign-key privilege on organizations');
select ok(not has_table_privilege('vortex_record_adapter',
  'vortex_record.storage_catalogue', 'REFERENCES'),
  'the migration does not leave the adapter foreign-key privilege on the storage catalogue');
select ok(not has_schema_privilege('vortex_record_adapter', 'vortex_record', 'CREATE'),
  'the temporary schema creation grant is revoked after installation');
select ok(not exists (
  select 1
  from pg_catalog.pg_class as relation
  cross join lateral pg_catalog.aclexplode(coalesce(
    relation.relacl, pg_catalog.acldefault('r', relation.relowner)
  )) as privilege
  where relation.oid = 'vortex_record.storage_catalogue'::regclass
    and privilege.grantee = 'postgres'::regrole
    and privilege.privilege_type = 'REFERENCES'
), 'the table creator retains no direct temporary foreign-key ACL on the storage catalogue');
select ok(not exists (
  select 1
  from pg_catalog.pg_namespace as schema
  cross join lateral pg_catalog.aclexplode(coalesce(
    schema.nspacl, pg_catalog.acldefault('n', schema.nspowner)
  )) as privilege
  where schema.oid = 'vortex_record'::regnamespace
    and privilege.grantee = 'postgres'::regrole
    and privilege.privilege_type = 'CREATE'
), 'the table creator retains no direct temporary schema creation ACL');

set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'system', 'tenantId', :'tenant_id'::uuid,
  'organizationId', :'organization_id'::uuid, 'applicationRootId', :'app_one'::uuid,
  'systemActorId', 'a4890000-0000-4000-8000-000000000099'::uuid,
  'sessionId', 'a4890000-0000-4000-8000-000000000014'::uuid,
  'authenticationStrength', 'service', 'issuedAt', pg_catalog.statement_timestamp(),
  'expiresAt', pg_catalog.statement_timestamp() + interval '1 hour',
  'accessVersion', 1, 'correlationId', 'a4890000-0000-4000-8000-000000000015'::uuid
));
reset role;
set local role vortex_record_adapter;
-- The restricted roles cannot resolve pgTAP helpers, so each restricted
-- operation is captured while its role is active and asserted after reset role.
create temporary table adapter_metadata_errors (
  case_name text primary key,
  returned_sqlstate text not null
) on commit drop;
do $capture$
declare
  caught_sqlstate text;
begin
  insert into vortex_record.record_deadline_due_metadata (
    organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
    application_root_id, record_concurrency_number, deadline_calculation_field_id, transition_at
  ) values (
    'a4890000-0000-4000-8000-000000000002', 'a4890000-0000-4000-8000-000000000003',
    'organization_shared', 'a4890000-0000-4000-8000-000000000007',
    'a4890000-0000-4000-8000-000000000004', 'a4890000-0000-4000-8000-000000000005',
    1, 'a4890000-0000-4000-8000-000000000009', '2026-09-23T00:00:00Z'
  );
exception when others then
  get stacked diagnostics caught_sqlstate = returned_sqlstate;
  insert into adapter_metadata_errors values ('shared_scope_with_application_root', caught_sqlstate);
end
$capture$;
insert into vortex_record.record_deadline_due_metadata (
  organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
  application_root_id, record_concurrency_number, deadline_calculation_field_id, transition_at
) values (
  :'organization_id'::uuid, :'storage_contract_id'::uuid, 'application_contained',
  :'record_id'::uuid, :'record_type_id'::uuid, :'app_one'::uuid, 1,
  :'deadline_one'::uuid, '2026-09-23T00:00:00Z'
);
reset role;

select is((select returned_sqlstate from adapter_metadata_errors
  where case_name = 'shared_scope_with_application_root'), '23514',
  'the stored scope shape rejects a shared row carrying an application root');

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'system', 'tenantId', :'tenant_id'::uuid,
  'organizationId', :'organization_id'::uuid, 'applicationRootId', :'app_two'::uuid,
  'systemActorId', 'a4890000-0000-4000-8000-000000000099'::uuid,
  'sessionId', 'a4890000-0000-4000-8000-000000000016'::uuid,
  'authenticationStrength', 'service', 'issuedAt', pg_catalog.statement_timestamp(),
  'expiresAt', pg_catalog.statement_timestamp() + interval '1 hour',
  'accessVersion', 1, 'correlationId', 'a4890000-0000-4000-8000-000000000017'::uuid
));
reset role;
set local role vortex_record_adapter;
insert into vortex_record.record_deadline_due_metadata (
  organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
  application_root_id, record_concurrency_number, deadline_calculation_field_id, transition_at
) values (
  :'organization_id'::uuid, :'storage_contract_id'::uuid, 'application_contained',
  :'record_id'::uuid, :'record_type_id'::uuid, :'app_two'::uuid, 1,
  :'deadline_two'::uuid, '2026-09-24T00:00:00Z'
);
reset role;
select is((select count(*)::integer from vortex_record.record_deadline_due_metadata
  where record_id = :'record_id'::uuid), 2,
  'the same record UUID has isolated metadata rows in two applications');

delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'system', 'tenantId', :'tenant_id'::uuid,
  'organizationId', :'organization_id'::uuid, 'applicationRootId', :'app_one'::uuid,
  'systemActorId', 'a4890000-0000-4000-8000-000000000099'::uuid,
  'sessionId', 'a4890000-0000-4000-8000-000000000018'::uuid,
  'authenticationStrength', 'service', 'issuedAt', pg_catalog.statement_timestamp(),
  'expiresAt', pg_catalog.statement_timestamp() + interval '1 hour',
  'accessVersion', 1, 'correlationId', 'a4890000-0000-4000-8000-000000000019'::uuid
));
reset role;
set local role vortex_record_adapter;
create temporary table adapter_visible_metadata on commit drop as
select (select count(*)::integer from vortex_record.record_deadline_due_metadata
  where record_id = :'record_id'::uuid) as visible_count;
insert into vortex_record.record_deadline_due_metadata (
  organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
  application_root_id, record_concurrency_number, deadline_calculation_field_id, transition_at
) values (
  :'organization_id'::uuid, :'storage_contract_id'::uuid, 'application_contained',
  :'record_id'::uuid, :'record_type_id'::uuid, :'app_one'::uuid, 2,
  :'deadline_two'::uuid, '2026-09-25T00:00:00Z'
) on conflict (organization_id, storage_contract_id, record_id, application_root_id)
do update set record_concurrency_number = excluded.record_concurrency_number,
  deadline_calculation_field_id = excluded.deadline_calculation_field_id,
  transition_at = excluded.transition_at;
reset role;
select is((select visible_count from adapter_visible_metadata), 1,
  'forced RLS hides the other application metadata row');
select is((select pg_catalog.concat_ws('|', record_concurrency_number::text,
  deadline_calculation_field_id::text) from vortex_record.record_deadline_due_metadata
  where record_id = :'record_id'::uuid and application_root_id = :'app_two'::uuid),
  pg_catalog.concat_ws('|', '1', :'deadline_two'),
  'an application-one replacement leaves application-two metadata unchanged');

set local role vortex_record_adapter;
delete from vortex_record.record_deadline_due_metadata
where organization_id = :'organization_id'::uuid
  and storage_contract_id = :'storage_contract_id'::uuid
  and record_id = :'record_id'::uuid
  and application_root_id is not distinct from :'app_one'::uuid;
reset role;
select is((select count(*)::integer from vortex_record.record_deadline_due_metadata
  where record_id = :'record_id'::uuid), 1,
  'an application-one cancellation cannot delete application-two metadata');

-- The postgres fixture role neither owns the shared writer nor holds schema
-- CREATE after installation. Replace it as its owner, using a schema CREATE
-- grant that exists only inside this rolled-back test transaction.
reset role;
set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
create or replace function vortex_record.save_base_record_with_relationship_totals(
  p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid,
  p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb,
  p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_parent_mutations jsonb
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
begin
  if p_command_id = 'a4890000-0000-4000-8000-000000000011'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'saved', 'replayed', true);
end
$function$;
reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
set local role vortex_runtime;
create temporary table composer_results on commit drop as
select
  (vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
    :'command_refused'::uuid, 'update', :'record_type_id'::uuid, :'record_id'::uuid, 1,
    '{}'::jsonb, '{}'::jsonb, null, null, null, '[]'::jsonb,
    pg_catalog.jsonb_build_object('calculationFieldId', :'deadline_one'::uuid,
      'transitionAt', '2026-09-26T00:00:00Z')
  ) ->> 'outcome') as refused_outcome,
  (vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
    :'command_replayed'::uuid, 'update', :'record_type_id'::uuid, :'record_id'::uuid, 1,
    '{}'::jsonb, '{}'::jsonb, null, null, null, '[]'::jsonb,
    pg_catalog.jsonb_build_object('calculationFieldId', :'deadline_one'::uuid,
      'transitionAt', '2026-09-26T00:00:00Z')
  ) ->> 'replayed') as replayed_flag;
reset role;
select is((select refused_outcome from composer_results), 'refused',
  'a real metadata composer refusal returns before any metadata mutation');
select is((select replayed_flag from composer_results), 'true',
  'a real metadata composer replay returns before any metadata mutation');
select is((select count(*)::integer from vortex_record.record_deadline_due_metadata
  where record_id = :'record_id'::uuid), 1,
  'refused and replayed composer paths leave the retained application row untouched');

set local role vortex_record_adapter;
create function pg_temp.rollback_metadata_write()
returns void language plpgsql volatile set search_path = '' as $function$
begin
  insert into vortex_record.record_deadline_due_metadata (
    organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
    application_root_id, record_concurrency_number, deadline_calculation_field_id, transition_at
  ) values (
    'a4890000-0000-4000-8000-000000000002', 'a4890000-0000-4000-8000-000000000003',
    'application_contained', 'a4890000-0000-4000-8000-000000000008',
    'a4890000-0000-4000-8000-000000000004', 'a4890000-0000-4000-8000-000000000005',
    1, 'a4890000-0000-4000-8000-000000000009', '2026-09-27T00:00:00Z'
  );
  raise exception 'force deadline metadata rollback';
end
$function$;
create temporary table rollback_errors (
  returned_sqlstate text not null,
  message_text text not null
) on commit drop;
do $capture$
declare
  caught_sqlstate text;
  caught_message text;
begin
  perform pg_temp.rollback_metadata_write();
exception when others then
  get stacked diagnostics
    caught_sqlstate = returned_sqlstate,
    caught_message = message_text;
  insert into rollback_errors values (caught_sqlstate, caught_message);
end
$capture$;
reset role;
select is((select returned_sqlstate || '|' || message_text from rollback_errors),
  'P0001|force deadline metadata rollback',
  'a transaction failure rolls back a metadata write');
select is((select count(*)::integer from vortex_record.record_deadline_due_metadata
  where record_id = :'rollback_record_id'::uuid), 0,
  'the rollback leaves no deadline metadata row behind');

select * from finish();
rollback;
