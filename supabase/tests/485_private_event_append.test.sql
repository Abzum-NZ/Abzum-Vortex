\ir helpers/definition-release-writer.psql

begin;
set local search_path = pg_catalog, extensions, public;
select no_plan();

\set tenant '14850000-0000-4000-8000-000000000001'
\set org '24850000-0000-4000-8000-000000000001'
\set actor '94850000-0000-4000-8000-000000000001'
\set identity '44850000-0000-4000-8000-000000000001'
\set account '54850000-0000-4000-8000-000000000001'
\set module '64850000-0000-4000-8000-000000000001'
\set app_one '34850000-0000-4000-8000-000000000001'
\set app_two '34850000-0000-4000-8000-000000000002'
\set record_type 'd4850000-0000-4000-8000-000000000001'
\set storage 'b4850000-0000-4000-8000-000000000001'
\set record 'a4850000-0000-4000-8000-000000000001'
\set contained_record_type 'd4850000-0000-4000-8000-000000000002'
\set contained_storage 'b4850000-0000-4000-8000-000000000002'
\set contained_record 'a4850000-0000-4000-8000-000000000002'
\set foreign_contained_record 'a4850000-0000-4000-8000-000000000003'
\set safe_field 'f4850000-0000-4000-8000-000000000001'
\set private_field 'f4850000-0000-4000-8000-000000000002'
\set contained_field 'f4850000-0000-4000-8000-000000000003'
\set module_event 'e4850000-0000-4000-8000-000000000001'
\set app_event_one 'e4850000-0000-4000-8000-000000000002'
\set app_event_two 'e4850000-0000-4000-8000-000000000003'

select has_table('vortex_event', 'event_outbox', 'Event owns one private outbox');
select has_function(
  'vortex_event', 'append_record_occurrences', array['uuid', 'uuid', 'jsonb'],
  'Event exposes one fixed append helper'
);
select ok(
  (
    select procedure.prosecdef
      and procedure.provolatile = 'v'
      and procedure.proconfig = array['search_path=""']
      and pg_catalog.pg_get_userbyid(procedure.proowner) = 'postgres'
    from pg_catalog.pg_proc as procedure
    where procedure.oid =
      'vortex_event.append_record_occurrences(uuid,uuid,jsonb)'::regprocedure
  ),
  'the append helper has fixed definer rights and an empty search path'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_record_adapter',
    'vortex_event.append_record_occurrences(uuid,uuid,jsonb)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_event.append_record_occurrences(uuid,uuid,jsonb)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_event.append_record_occurrences(uuid,uuid,jsonb)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'vortex_event.append_record_occurrences(uuid,uuid,jsonb)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'vortex_event.append_record_occurrences(uuid,uuid,jsonb)', 'EXECUTE'
  ),
  'only the existing Record adapter can invoke Event append'
);
select ok(
  pg_catalog.has_function_privilege(
    'postgres', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_record_adapter', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_runtime', 'vortex_module.read_current_active_installation()', 'EXECUTE'
  ),
  'the helper owner reuses the existing Record and request installation reader boundary'
);
select ok(
  not pg_catalog.pg_has_role('vortex_record_adapter', 'postgres', 'member')
  and not pg_catalog.pg_has_role('vortex_request', 'postgres', 'member')
  and not pg_catalog.pg_has_role('vortex_runtime', 'postgres', 'member')
  and not pg_catalog.pg_has_role('authenticated', 'postgres', 'member')
  and not pg_catalog.pg_has_role('service_role', 'postgres', 'member'),
  'no caller role inherits the helper owner authority'
);
select ok(
  not pg_catalog.pg_has_role('vortex_record_adapter', 'postgres', 'set')
  and not pg_catalog.pg_has_role('vortex_request', 'postgres', 'set')
  and not pg_catalog.pg_has_role('vortex_runtime', 'postgres', 'set')
  and not pg_catalog.pg_has_role('authenticated', 'postgres', 'set')
  and not pg_catalog.pg_has_role('service_role', 'postgres', 'set'),
  'no caller role can assume the helper owner'
);
select ok(
  not pg_catalog.has_schema_privilege('vortex_record_adapter', 'pgmq', 'USAGE')
  and not pg_catalog.has_schema_privilege('vortex_request', 'pgmq', 'USAGE')
  and not pg_catalog.has_schema_privilege('vortex_runtime', 'pgmq', 'USAGE')
  and not pg_catalog.has_schema_privilege('authenticated', 'pgmq', 'USAGE')
  and not pg_catalog.has_schema_privilege('service_role', 'pgmq', 'USAGE'),
  'application and Data API roles cannot resolve raw queue functions'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_record_adapter', 'pgmq.q_vortex_event_occurrences', 'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'vortex_request', 'pgmq.q_vortex_event_occurrences', 'SELECT,INSERT,UPDATE,DELETE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'pgmq.q_vortex_event_occurrences', 'SELECT,INSERT,UPDATE,DELETE'
  ),
  'raw queue storage has no caller data privileges'
);
select ok(
  (
    select relation.relpersistence = 'p' and relation.relrowsecurity
      and relation.relforcerowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'pgmq.q_vortex_event_occurrences'::regclass
  ),
  'the Basic queue is logged and forced-RLS private'
);
select ok(
  (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_catalog.pg_class as relation
    where relation.oid = 'vortex_event.event_outbox'::regclass
  )
  and not exists (
    select 1 from pg_catalog.pg_policy as policy
    where policy.polrelid = 'vortex_event.event_outbox'::regclass
  ),
  'the immutable outbox is forced-RLS with no direct role policy'
);

create function pg_temp.event_field(
  p_field_id uuid, p_key text, p_personal_data text
)
returns jsonb
language sql immutable set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field_id, 'key', p_key, 'label', p_key,
    'type', 'text', 'required', false, 'unique', false,
    'filterable', true, 'sortable', true,
    'personalData', p_personal_data, 'publicDisplay', 'refused',
    'settings', pg_catalog.jsonb_build_object('maxLength', 120)
  )
$function$;

create function pg_temp.module_content()
returns jsonb
language sql stable set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'name', 'Event append proof module',
    'description', 'Neutral event append proof.',
    'dependencies', '[]'::jsonb,
    'recordTypes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordTypeId', 'd4850000-0000-4000-8000-000000000001'::uuid,
        'key', 'item', 'singularLabel', 'Item', 'pluralLabel', 'Items',
        'titleFieldId', 'f4850000-0000-4000-8000-000000000001'::uuid,
        'storageContractId', 'b4850000-0000-4000-8000-000000000001'::uuid,
        'storageScope', 'organization_shared', 'ownershipMode', 'none',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.event_field('f4850000-0000-4000-8000-000000000001'::uuid, 'title', 'none'),
          pg_temp.event_field('f4850000-0000-4000-8000-000000000002'::uuid, 'private_note', 'personal')
        ),
        'relationships', '[]'::jsonb,
        'standardActions', pg_catalog.jsonb_build_array('create', 'read', 'update'),
        'customActionIds', '[]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'recordTypeId', 'd4850000-0000-4000-8000-000000000002'::uuid,
        'key', 'contained_item', 'singularLabel', 'Contained item',
        'pluralLabel', 'Contained items',
        'titleFieldId', 'f4850000-0000-4000-8000-000000000003'::uuid,
        'storageContractId', 'b4850000-0000-4000-8000-000000000002'::uuid,
        'storageScope', 'application_contained', 'ownershipMode', 'none',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.event_field('f4850000-0000-4000-8000-000000000003'::uuid, 'title', 'none')
        ),
        'relationships', '[]'::jsonb,
        'standardActions', pg_catalog.jsonb_build_array('create', 'read', 'update'),
        'customActionIds', '[]'::jsonb
      )
    ),
    'permissions', '[]'::jsonb, 'actions', '[]'::jsonb,
    'events', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'eventId', 'e4850000-0000-4000-8000-000000000001'::uuid,
      'key', 'example.item.reviewed',
      'recordTypeId', 'd4850000-0000-4000-8000-000000000001'::uuid,
      'carriedFieldIds', pg_catalog.jsonb_build_array('f4850000-0000-4000-8000-000000000001'::uuid),
      'personalOrSensitiveValuesAllowed', false
    )),
    'rules', '[]'::jsonb, 'sharingConditions', '[]'::jsonb,
    'extensionPoints', '[]'::jsonb
  )
$function$;

create function pg_temp.application_content(p_root_id uuid, p_event_id uuid)
returns jsonb
language sql immutable set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'name', 'Event append proof application',
    'events', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'eventId', p_event_id,
      'key', 'example.application.item.reviewed',
      'recordTypeId', 'd4850000-0000-4000-8000-000000000001'::uuid,
      'carriedFieldIds', '[]'::jsonb,
      'personalOrSensitiveValuesAllowed', false
    ))
  )
$function$;

create function pg_temp.event_context(p_application_root_id uuid, p_correlation_id uuid)
returns void
language plpgsql volatile set search_path = ''
as $function$
declare
  current_access_version bigint;
begin
  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid();
  select version.current_version into strict current_access_version
  from vortex_access.organization_access_versions as version
  where version.organization_id = '24850000-0000-4000-8000-000000000001'::uuid;
  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human', 'identityAuthorityId', '94850000-0000-4000-8000-000000000001'::uuid,
    'tenantId', '14850000-0000-4000-8000-000000000001'::uuid,
    'organizationId', '24850000-0000-4000-8000-000000000001'::uuid,
    'organizationAccountId', '54850000-0000-4000-8000-000000000001'::uuid,
    'identityId', '44850000-0000-4000-8000-000000000001'::uuid,
    'applicationRootId', p_application_root_id,
    'sessionId', '75850000-0000-4000-8000-000000000001'::uuid,
    'authenticationStrength', 'single_factor',
    'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.statement_timestamp() + interval '1 hour',
    'accessVersion', current_access_version,
    'correlationId', p_correlation_id,
    'accessTokenIssuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
    'primaryAuthenticatedAt', pg_catalog.statement_timestamp() - interval '1 minute'
  ));
end
$function$;

create function pg_temp.standard_occurrence(
  p_occurrence_id uuid, p_event_kind text, p_payload jsonb default null
)
returns jsonb
language sql immutable set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'occurrenceId', p_occurrence_id,
    'descriptor', pg_catalog.jsonb_build_object(
      'kind', 'standard', 'eventKind', p_event_kind,
      'recordTypeId', 'd4850000-0000-4000-8000-000000000001'::uuid
    ),
    'payload', coalesce(
      p_payload, pg_catalog.jsonb_build_object('kind', p_event_kind)
    )
  )
$function$;

create function pg_temp.module_occurrence(
  p_occurrence_id uuid, p_carried_values jsonb
)
returns jsonb
language sql immutable set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'occurrenceId', p_occurrence_id,
    'descriptor', pg_catalog.jsonb_build_object(
      'kind', 'declared',
      'owner', pg_catalog.jsonb_build_object(
        'kind', 'module', 'moduleRootId', '64850000-0000-4000-8000-000000000001'::uuid
      ),
      'declarationId', 'e4850000-0000-4000-8000-000000000001'::uuid,
      'key', 'example.item.reviewed',
      'recordTypeId', 'd4850000-0000-4000-8000-000000000001'::uuid,
      'carriedFieldIds', pg_catalog.jsonb_build_array('f4850000-0000-4000-8000-000000000001'::uuid)
    ),
    'payload', pg_catalog.jsonb_build_object(
      'kind', 'declared', 'carriedValues', p_carried_values
    )
  )
$function$;

create function pg_temp.standard_occurrence_for(
  p_occurrence_id uuid, p_event_kind text, p_record_type_id uuid,
  p_payload jsonb default null
)
returns jsonb
language sql immutable set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'occurrenceId', p_occurrence_id,
    'descriptor', pg_catalog.jsonb_build_object(
      'kind', 'standard', 'eventKind', p_event_kind,
      'recordTypeId', p_record_type_id
    ),
    'payload', coalesce(
      p_payload, pg_catalog.jsonb_build_object('kind', p_event_kind)
    )
  )
$function$;

grant execute on function pg_temp.standard_occurrence(uuid, text, jsonb),
  pg_temp.module_occurrence(uuid, jsonb),
  pg_temp.standard_occurrence_for(uuid, text, uuid, jsonb)
  to vortex_record_adapter;

insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  :'tenant', 'event_append', 'Event append', 'active',
  pg_catalog.statement_timestamp(), :'actor', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at,
  created_by, state_changed_at, revision
) values (
  :'org', :'tenant', 'event_append', 'Event append', 'active',
  pg_catalog.statement_timestamp(), :'actor', pg_catalog.statement_timestamp(), 1
);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  :'identity', 'active', pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), :'actor',
  '85850000-0000-4000-8000-000000000001', 1
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values (
  :'account', :'org', :'identity', 'Event actor', 'active',
  pg_catalog.statement_timestamp() - interval '1 minute',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), :'actor',
  '85850000-0000-4000-8000-000000000002', 1
);
select * from vortex_access.initialize_organization_access_version(
  :'org', :'actor', '85850000-0000-4000-8000-000000000003'
);

insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (:'module', :'org', 'module', 'example.event_append', pg_catalog.statement_timestamp(), :'actor'),
  (:'app_one', :'org', 'application', 'example.event_app_one', pg_catalog.statement_timestamp(), :'actor'),
  (:'app_two', :'org', 'application', 'example.event_app_two', pg_catalog.statement_timestamp(), :'actor');

select is(
  pg_temp.append_writer_release(:'module', '2.0.0', '[]'::jsonb, pg_temp.module_content(), '2.0.0'),
  1::bigint, 'the Module V2 release is published through the canonical writer'
);
select is(
  pg_temp.append_writer_release(
    :'app_one', '1.0.0', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_array(:'module'::uuid, 1)
    ), pg_temp.application_content(:'app_one', :'app_event_one'), '1.0.0'
  ), 1::bigint, 'the first exact Application release is published'
);
select is(
  pg_temp.append_writer_release(
    :'app_two', '1.0.0', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_array(:'module'::uuid, 1)
    ), pg_temp.application_content(:'app_two', :'app_event_two'), '1.0.0'
  ), 1::bigint, 'the second exact Application release is published'
);

set local role vortex_module_owner;
select * from vortex_record.provision_exact_module_storage(:'module', 1);
insert into vortex_module.installation_bindings (
  organization_id, application_root_id, module_root_id, binding_revision,
  application_release_revision, module_release_revision, state,
  content_fingerprint, resolution_fingerprint, generator_contract_version,
  storage_contract_ids
)
select :'org', application.application_root_id, :'module', 1, 1, 1, 'active',
  release.content_fingerprint, release.resolution_fingerprint, '1.0.0',
  array[:'storage'::uuid, :'contained_storage'::uuid]
from (values (:'app_one'::uuid), (:'app_two'::uuid)) as application(application_root_id)
cross join vortex_definition.releases as release
where release.root_id = :'module'::uuid and release.release_revision = 1;
reset role;
select is(
  (select provision.release_revision from vortex_record.release_provisions as provision
    where provision.module_root_id = :'module'::uuid),
  1::bigint, 'the exact Module release provisions real Record storage'
);
select ok(
  pg_catalog.has_table_privilege(
    'postgres', 'record_data.rt_b4850000000040008000000000000001', 'SELECT,UPDATE'
  ),
  'the helper owner can take the mandatory lock on newly provisioned Record rows'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', 'record_data.rt_b4850000000040008000000000000001', 'SELECT,UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'vortex_runtime', 'record_data.rt_b4850000000040008000000000000001', 'SELECT,UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'authenticated', 'record_data.rt_b4850000000040008000000000000001', 'SELECT,UPDATE'
  )
  and not pg_catalog.has_table_privilege(
    'service_role', 'record_data.rt_b4850000000040008000000000000001', 'SELECT,UPDATE'
  ),
  'the internal row-lock grant does not expose generated storage to request or Data API roles'
);

select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000010');
set local role vortex_record_adapter;
insert into record_data.rt_b4850000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id, lifecycle_state,
  concurrency_number, created_at, created_by, updated_at, updated_by,
  f_f4850000000040008000000000000001,
  f_f4850000000040008000000000000002
) values (
  :'org', :'module', :'record_type', :'storage', :'record', null, 1,
  null, null, 'active', 1, pg_catalog.statement_timestamp(), :'account',
  pg_catalog.statement_timestamp(), :'account', 'Initial', 'Private'
);
insert into record_data.rt_b4850000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id, lifecycle_state,
  concurrency_number, created_at, created_by, updated_at, updated_by,
  f_f4850000000040008000000000000003
) values
  (
    :'org', :'module', :'contained_record_type', :'contained_storage',
    :'contained_record', :'app_one', 1, null, null, 'active', 1,
    pg_catalog.statement_timestamp(), :'account', pg_catalog.statement_timestamp(),
    :'account', 'App one'
  ),
  (
    :'org', :'module', :'contained_record_type', :'contained_storage',
    :'foreign_contained_record', :'app_one', 1, null, null, 'active', 1,
    pg_catalog.statement_timestamp(), :'account', pg_catalog.statement_timestamp(),
    :'account', 'App one only'
  );
reset role;
select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000019');
set local role vortex_record_adapter;
insert into record_data.rt_b4850000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id,
  record_id, application_root_id, definition_revision,
  owner_organisation_account_id, owner_group_id, lifecycle_state,
  concurrency_number, created_at, created_by, updated_at, updated_by,
  f_f4850000000040008000000000000003
) values (
  :'org', :'module', :'contained_record_type', :'contained_storage',
  :'contained_record', :'app_two', 1, null, null, 'active', 1,
  pg_catalog.statement_timestamp(), :'account', pg_catalog.statement_timestamp(),
  :'account', 'App two'
);
reset role;
select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000010');
set local role vortex_record_adapter;

select vortex_event.append_record_occurrences(:'storage', :'record', '[]'::jsonb);
select vortex_event.append_record_occurrences(
  :'storage', :'record', pg_catalog.jsonb_build_array(
    pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000001', 'created'),
    pg_temp.module_occurrence(
      '95850000-0000-4000-8000-000000000002',
      pg_catalog.jsonb_build_object(:'safe_field'::text, 'Initial')
    )
  )
);
reset role;

select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox),
  2, 'an empty batch has no effect and the closed batch appends only its two envelopes'
);
select is(
  (select pg_catalog.max(record_sequence) from vortex_event.event_outbox),
  2::bigint, 'a batch receives consecutive sequence values'
);
select is(
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences),
  2, 'the same transaction appends one logged queue message per envelope'
);
select is(
  (
    select pg_catalog.jsonb_object_keys(message) from pgmq.q_vortex_event_occurrences
    order by 1 limit 1
  ),
  'contractVersion', 'the minimum queue envelope starts with the contract version key'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from pgmq.q_vortex_event_occurrences as queue
    cross join lateral pg_catalog.jsonb_object_keys(queue.message)
    where queue.msg_id = (select pg_catalog.min(candidate.msg_id)
      from pgmq.q_vortex_event_occurrences as candidate)
  ),
  2, 'queue messages contain only contract version and occurrence identity'
);
select is(
  (
    select envelope #>> '{installation,applicationRootId}'
    from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000001'
  ),
  :'app_one', 'the Application identity comes from trusted request context'
);
select is(
  (
    select envelope ->> 'actorId' from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000001'
  ),
  :'account', 'the actor comes from the validated current account'
);
select is(
  (
    select envelope ->> 'correlationId' from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000001'
  ),
  '85850000-0000-4000-8000-000000000010',
  'the correlation identity comes from validated context'
);

select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000011');
set local role vortex_record_adapter;
select vortex_event.append_record_occurrences(
  :'storage', :'record', pg_catalog.jsonb_build_array(
    pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000003', 'changed',
      pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.jsonb_build_array(:'safe_field'::uuid)
      )
    )
  )
);
reset role;
select is(
  (select record_sequence from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000003'),
  3::bigint, 'a consuming Application continues the shared record sequence'
);

select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000014');
set local role vortex_record_adapter;
select vortex_event.append_record_occurrences(
  :'contained_storage', :'contained_record', pg_catalog.jsonb_build_array(
    pg_temp.standard_occurrence_for(
      '95850000-0000-4000-8000-000000000020', 'created', :'contained_record_type'
    )
  )
);
reset role;
select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000015');
set local role vortex_record_adapter;
select vortex_event.append_record_occurrences(
  :'contained_storage', :'contained_record', pg_catalog.jsonb_build_array(
    pg_temp.standard_occurrence_for(
      '95850000-0000-4000-8000-000000000021', 'created', :'contained_record_type'
    )
  )
);
reset role;
select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000016');
set local role vortex_record_adapter;
select vortex_event.append_record_occurrences(
  :'contained_storage', :'contained_record', pg_catalog.jsonb_build_array(
    pg_temp.standard_occurrence_for(
      '95850000-0000-4000-8000-000000000022', 'changed', :'contained_record_type',
      pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.jsonb_build_array(:'contained_field'::uuid)
      )
    )
  )
);
reset role;
select is(
  (
    select pg_catalog.string_agg(
      envelope #>> '{installation,applicationRootId}' || ':' || record_sequence,
      ',' order by occurrence_id
    )
    from vortex_event.event_outbox
    where occurrence_id between
      '95850000-0000-4000-8000-000000000020'::uuid and
      '95850000-0000-4000-8000-000000000022'::uuid
  ),
  :'app_one' || ':1,' || :'app_two' || ':1,' || :'app_one' || ':2',
  'application-contained records keep an independent sequence for each Application'
);
select is(
  (
    select pg_catalog.count(*)::integer
    from vortex_event.event_outbox
    where occurrence_id between
      '95850000-0000-4000-8000-000000000020'::uuid and
      '95850000-0000-4000-8000-000000000022'::uuid
      and sequence_application_root_id::text =
        envelope #>> '{installation,applicationRootId}'
  ),
  3, 'contained sequence scope is the exact consuming Application'
);

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000099',
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000023', 'created')
    )
  );
  raise exception 'expected missing record refusal';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'Event record is unavailable' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000023') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000023'),
  0, 'a missing record creates no outbox or queue effect'
);

select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000017');
set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000002',
    'a4850000-0000-4000-8000-000000000003',
    pg_catalog.jsonb_build_array(pg_temp.standard_occurrence_for(
      '95850000-0000-4000-8000-000000000024', 'created',
      'd4850000-0000-4000-8000-000000000002'
    ))
  );
  raise exception 'expected foreign record refusal';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'Event record is unavailable' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000024') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000024'),
  0, 'a record contained by another Application creates no outbox or queue effect'
);

select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000018');
set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000002',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(pg_temp.standard_occurrence_for(
      '95850000-0000-4000-8000-000000000025', 'created',
      'd4850000-0000-4000-8000-000000000002'
    ))
  );
  raise exception 'expected wrong storage refusal';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'Event record is unavailable' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000025') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000025'),
  0, 'a real but wrong storage target creates no outbox or queue effect'
);

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId','95850000-0000-4000-8000-000000000004',
      'descriptor',pg_catalog.jsonb_build_object(
        'kind','standard','eventKind','created',
        'recordTypeId','d4850000-0000-4000-8000-000000000001'
      ),
      'payload',pg_catalog.jsonb_build_object('kind','created'),
      'actorId','54850000-0000-4000-8000-000000000099'
    )));
  raise exception 'expected caller claim refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Event occurrence batch is invalid' then raise; end if;
end
$proof$;
reset role;
select pass('caller-supplied actor, release, sequence or correlation claims are refused');

set local role vortex_record_adapter;
do $proof$
declare
  occurrence jsonb;
begin
  occurrence := pg_temp.module_occurrence(
    '95850000-0000-4000-8000-000000000026', '{}'::jsonb
  );
  occurrence := pg_catalog.jsonb_set(
    occurrence, '{descriptor,declarationId}',
    '"e4850000-0000-4000-8000-000000000099"'::jsonb
  );
  occurrence := pg_catalog.jsonb_set(
    occurrence, '{descriptor,key}', '"example.item.undeclared"'::jsonb
  );
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(occurrence)
  );
  raise exception 'expected undeclared Event refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Installed Event declaration is invalid' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000026') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000026'),
  0, 'an undeclared descriptor creates no outbox or queue effect'
);

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000027','created'),
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000027','created')
    )
  );
  raise exception 'expected within-batch duplicate refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Event occurrence identities are invalid' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000027') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000027'),
  0, 'duplicate identities inside one new batch create no effect'
);

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(pg_temp.standard_occurrence(
      '95850000-0000-4000-8000-000000000028', 'changed',
      pg_catalog.jsonb_build_object(
        'kind', null,
        'changedFieldIds', pg_catalog.jsonb_build_array(
          'f4850000-0000-4000-8000-000000000001'::uuid
        )
      )
    ))
  );
  raise exception 'expected null payload discriminator refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Installed Event payload is invalid' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000028') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000028'),
  0, 'a null required payload discriminator creates no effect'
);

set local role vortex_record_adapter;
do $proof$
declare
  occurrence jsonb;
begin
  occurrence := pg_temp.module_occurrence(
    '95850000-0000-4000-8000-000000000029', '{}'::jsonb
  );
  occurrence := pg_catalog.jsonb_set(
    occurrence, '{descriptor,owner,moduleRootId}', 'null'::jsonb
  );
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(occurrence)
  );
  raise exception 'expected null owner identity refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Installed Event descriptor is invalid' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000029') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000029'),
  0, 'a null required owner identity creates no effect'
);

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(pg_temp.standard_occurrence(
      '95850000-0000-4000-8000-000000000030', 'changed',
      pg_catalog.jsonb_build_object('kind', 'changed', 'changedFieldIds', null)
    ))
  );
  raise exception 'expected malformed payload refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Installed Event payload is invalid' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000030') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000030'),
  0, 'a malformed required payload collection creates no effect'
);

set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'provisioned'
where organization_id = :'org'::uuid
  and application_root_id = :'app_two'::uuid
  and module_root_id = :'module'::uuid;
reset role;
select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000031');
set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000031','created')
    )
  );
  raise exception 'expected inactive installation refusal';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'Active Application installation is unavailable' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000031') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000031'),
  0, 'an inactive installation creates no Event effect'
);

set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'detached'
where organization_id = :'org'::uuid
  and application_root_id = :'app_two'::uuid
  and module_root_id = :'module'::uuid;
reset role;
select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000032');
set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000032','created')
    )
  );
  raise exception 'expected detached installation refusal';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'Active Application installation is unavailable' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000032') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000032'),
  0, 'a detached installation creates no Event effect'
);

set local role vortex_module_owner;
update vortex_module.installation_bindings
set state = 'active', content_fingerprint = 'sha256:' || pg_catalog.repeat('f', 64)
where organization_id = :'org'::uuid
  and application_root_id = :'app_two'::uuid
  and module_root_id = :'module'::uuid;
reset role;
select pg_temp.event_context(:'app_two', '85850000-0000-4000-8000-000000000033');
set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000033','created')
    )
  );
  raise exception 'expected substituted installation refusal';
exception when sqlstate '55000' then
  if sqlerrm <> 'Active Application Module bindings are incomplete' then raise; end if;
end
$proof$;
reset role;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000033') +
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000033'),
  0, 'substituted installation evidence creates no Event effect'
);
set local role vortex_module_owner;
update vortex_module.installation_bindings as binding
set content_fingerprint = release.content_fingerprint
from vortex_definition.releases as release
where binding.organization_id = :'org'::uuid
  and binding.application_root_id = :'app_two'::uuid
  and binding.module_root_id = :'module'::uuid
  and release.root_id = :'module'::uuid
  and release.release_revision = 1;
reset role;
select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000034');

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId','95850000-0000-4000-8000-000000000005',
      'descriptor',pg_catalog.jsonb_build_object(
        'kind','standard','eventKind','state_changed',
        'recordTypeId','d4850000-0000-4000-8000-000000000001'
      ),
      'payload',pg_catalog.jsonb_build_object(
        'kind','state_changed','fieldId','f4850000-0000-4000-8000-000000000002',
        'newValue','Private'
      )
    )));
  raise exception 'expected classified value refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Installed Event payload is invalid' then raise; end if;
end
$proof$;
reset role;
select pass('classified field values cannot enter standard Event evidence');

set local role vortex_record_adapter;
select vortex_event.append_record_occurrences(
  :'storage', :'record', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'occurrenceId','95850000-0000-4000-8000-000000000006',
    'descriptor',pg_catalog.jsonb_build_object(
      'kind','standard','eventKind','state_changed','recordTypeId',:'record_type'::uuid
    ),
    'payload',pg_catalog.jsonb_build_object(
      'kind','state_changed','fieldId',:'private_field'::uuid
    )
  ))
);
reset role;
select pass('classified field state may be announced without its value');

set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(pg_temp.module_occurrence(
      '95850000-0000-4000-8000-000000000007',
      pg_catalog.jsonb_build_object(
        'f4850000-0000-4000-8000-000000000002','Private'
      )
    )));
  raise exception 'expected custom classified value refusal';
exception when sqlstate '22023' then
  if sqlerrm <> 'Installed Event payload is invalid' then raise; end if;
end
$proof$;
reset role;
select pass('classified fields cannot enter a custom Event payload');

select throws_ok(
  $$update vortex_event.event_outbox set record_sequence = 99
    where occurrence_id = '95850000-0000-4000-8000-000000000001'$$,
  '23514', 'Event outbox evidence is immutable',
  'outbox evidence cannot be updated even by its owner'
);
select throws_ok(
  $$delete from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000001'$$,
  '23514', 'Event outbox evidence is immutable',
  'outbox evidence cannot be deleted even by its owner'
);

select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000012');
set local role vortex_record_adapter;
do $proof$
begin
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001',
    'a4850000-0000-4000-8000-000000000001',
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000008','created'),
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000001','created')
    ));
  raise exception 'expected duplicate occurrence refusal';
exception when unique_violation then null;
end
$proof$;
reset role;
select pass('an existing occurrence identity makes the entire batch fail');
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000008'),
  0, 'the earlier outbox insert in a duplicate batch is rolled back'
);
select is(
  (select pg_catalog.count(*)::integer from pgmq.q_vortex_event_occurrences
    where message ->> 'occurrenceId' = '95850000-0000-4000-8000-000000000008'),
  0, 'the earlier queue insert in a duplicate batch is rolled back'
);

create function pg_temp.refuse_queue_insert()
returns trigger language plpgsql set search_path = ''
as $function$
begin
  raise exception using errcode = '55000', message = 'forced queue refusal';
end
$function$;
create trigger event_append_force_queue_failure
before insert on pgmq.q_vortex_event_occurrences
for each row execute function pg_temp.refuse_queue_insert();
create function pg_temp.change_and_append()
returns void language plpgsql set search_path = ''
as $function$
begin
  update record_data.rt_b4850000000040008000000000000001
  set f_f4850000000040008000000000000001 = 'Must roll back',
      concurrency_number = concurrency_number + 1,
      updated_at = pg_catalog.statement_timestamp(),
      updated_by = '54850000-0000-4000-8000-000000000001'::uuid
  where organisation_id = '24850000-0000-4000-8000-000000000001'::uuid
    and record_id = 'a4850000-0000-4000-8000-000000000001'::uuid;
  perform vortex_event.append_record_occurrences(
    'b4850000-0000-4000-8000-000000000001'::uuid,
    'a4850000-0000-4000-8000-000000000001'::uuid,
    pg_catalog.jsonb_build_array(
      pg_temp.standard_occurrence('95850000-0000-4000-8000-000000000009','changed',
        pg_catalog.jsonb_build_object(
          'kind','changed','changedFieldIds',
          pg_catalog.jsonb_build_array('f4850000-0000-4000-8000-000000000001'::uuid)
        )
      )
    )
  );
end
$function$;
grant execute on function pg_temp.change_and_append() to vortex_record_adapter;

select pg_temp.event_context(:'app_one', '85850000-0000-4000-8000-000000000013');
set local role vortex_record_adapter;
do $proof$
begin
  perform pg_temp.change_and_append();
  raise exception 'expected queue refusal';
exception when sqlstate '55000' then
  if sqlerrm <> 'forced queue refusal' then raise; end if;
end
$proof$;
reset role;
select pass('a queue failure rejects the combined Record change and Event append');
select is(
  (select f_f4850000000040008000000000000001
   from record_data.rt_b4850000000040008000000000000001
   where organisation_id = :'org'::uuid and record_id = :'record'::uuid),
  'Initial', 'the Record change rolls back when its Event cannot be queued'
);
drop trigger event_append_force_queue_failure on pgmq.q_vortex_event_occurrences;
select is(
  (select pg_catalog.count(*)::integer from vortex_event.event_outbox
    where occurrence_id = '95850000-0000-4000-8000-000000000009'),
  0, 'forced queue failure leaves no outbox evidence'
);

select * from finish();
rollback;
