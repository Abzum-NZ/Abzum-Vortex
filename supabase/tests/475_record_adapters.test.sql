\ir helpers/definition-release-writer.psql

begin;

set local search_path = pg_catalog, extensions, public;

select no_plan();

-- ============================================================================
-- #401: the fixed record adapters over real provisioned storage, under the real
-- restricted vortex_request role, with `set local role vortex_record_adapter`
-- for change_record (its owner is the only role that may execute it).
--
-- Fixture shape. One tenant; two organisations, each with its own Module and
-- Application roots, because the publication writer keeps an Application's
-- dependency closure inside its own organisation. Organisation one also has a
-- second Application binding the same Module, which is what gives the
-- application direction a shared physical table with two application roots.
--
--   Module M1 (organisation one) declares
--     S  organization_shared, team ownership, every storage column type;
--     C  application_contained, organization_account ownership, a link to S;
--     R1 relationship C -> S, compiled from C's link field;
--     one saved condition over S's yes_no field;
--     the record-scoped permissions every viewer below holds.
--   Application A1 binds M1 and declares one application-owned permission pair,
--   so both owner kinds appear in the declaration the adapter builds.
--   Application A2 binds the same M1 release.
--   Module M2 / Application A3 are organisation two's own copy of that shape.
--
-- Writers used for every fact that has one: append_release (through
-- pg_temp.append_writer_release), coordinate_application_access_change,
-- coordinate_organization_role_change, coordinate_organization_role_assignment_
-- change, coordinate_organization_group_change, coordinate_organization_group_
-- membership_change, create_organization_invitation, accept_organization_
-- invitation, initialize_organization_access_version, initialize_platform_
-- permission_catalogue, coordinate_organization_stewardship_adoption,
-- adopt_shipped_platform_permission_catalogue, and the Module coordinator
-- provision_module_installation_storage for the real storage.
--
-- Direct writes, and why no writer can produce them, each labelled where it
-- appears:
--   * tenants, organisations and each organisation's first account: no
--     provisioning writer exists (#30), and every account writer needs an
--     existing active account to act;
--   * definition roots: create_root generates its own identifier, and these
--     fixtures need fixed ones -- the same reason 455 and 470 insert roots;
--   * binding activation: activation is #43 and is not delivered, so the
--     provisioned binding is advanced to active here;
--   * record rows: the create adapter is #402, so rows are inserted as
--     vortex_record_adapter, which is subject to the same scope policies;
--   * relationship edges: edge writes are #402 as well;
--   * direct record shares: created through #36's private structural writer
--     grant_organization_direct_record_share, which owns the revision check,
--     Activity append and Access invalidation. The protected #37 invocation on
--     top of it needs a facts adapter of its own and is proved in 450.
-- ============================================================================

\set tenant '14750000-0000-4000-8000-000000000001'
\set org_one '24750000-0000-4000-8000-000000000001'
\set org_two '24750000-0000-4000-8000-000000000002'
\set actor '94750000-0000-4000-8000-000000000001'

\set module_one '44750000-0000-4000-8000-000000000001'
\set module_two '44750000-0000-4000-8000-000000000002'
\set app_one '34750000-0000-4000-8000-000000000001'
\set app_two '34750000-0000-4000-8000-000000000002'
\set app_three '34750000-0000-4000-8000-000000000003'

-- Record types and storage contracts. Organisation two's copy uses its own
-- identities, so its rows live in their own physical tables.
\set type_s 'd4750000-0000-4000-8000-000000000001'
\set type_c 'd4750000-0000-4000-8000-000000000002'
\set type_s_two 'd4750000-0000-4000-8000-000000000011'
\set type_c_two 'd4750000-0000-4000-8000-000000000012'
\set storage_s 'b4750000-0000-4000-8000-000000000001'
\set storage_c 'b4750000-0000-4000-8000-000000000002'
\set storage_s_two 'b4750000-0000-4000-8000-000000000011'
\set storage_c_two 'b4750000-0000-4000-8000-000000000012'

-- S's fields, one per storage column type plus a never-readable one.
\set f_text 'f4750000-0000-4000-8000-000000000001'
\set f_flag 'f4750000-0000-4000-8000-000000000002'
\set f_number 'f4750000-0000-4000-8000-000000000003'
\set f_amount 'f4750000-0000-4000-8000-000000000004'
\set f_money 'f4750000-0000-4000-8000-000000000005'
\set f_date 'f4750000-0000-4000-8000-000000000006'
\set f_when 'f4750000-0000-4000-8000-000000000007'
\set f_choices 'f4750000-0000-4000-8000-000000000008'
\set f_person 'f4750000-0000-4000-8000-000000000009'
\set f_doc 'f4750000-0000-4000-8000-00000000000a'
\set f_rows 'f4750000-0000-4000-8000-00000000000b'
\set f_files 'f4750000-0000-4000-8000-00000000000c'
\set f_secret 'f4750000-0000-4000-8000-00000000000d'
-- C's fields.
\set f_title 'f4750000-0000-4000-8000-000000000021'
\set f_link 'f4750000-0000-4000-8000-000000000022'
\set f_note 'f4750000-0000-4000-8000-000000000023'
\set relationship_one 'a4750000-0000-4000-8000-000000000001'
\set condition_one 'a4750000-0000-4000-8000-000000000002'

-- ============================================================================
-- Session-local fixture builders.
-- ============================================================================

create function pg_temp.adapter_sha(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8')), 'hex'
  )
$function$;

create function pg_temp.adapter_field(
  p_field_id uuid,
  p_type text,
  p_settings jsonb default '{}'::jsonb,
  p_required boolean default false
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'fieldId', p_field_id,
    'key', 'k_' || pg_catalog.replace(pg_catalog.lower(p_field_id::text), '-', ''),
    'type', p_type,
    'required', p_required,
    'unique', false,
    'filterable', false,
    'sortable', false,
    'settings', p_settings
  )
$function$;

-- One record-scoped permission declaration.
create function pg_temp.adapter_permission(
  p_permission_id uuid,
  p_key text,
  p_record_type_id uuid,
  p_action_kind text,
  p_record_scope jsonb,
  p_readable uuid[],
  p_changeable uuid[]
)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'permissionId', p_permission_id,
    'key', p_key,
    'label', p_key,
    'description', 'Record adapter fixture permission ' || p_key || '.',
    'recordTypeId', p_record_type_id,
    'recordScope', p_record_scope,
    'fieldPolicy', pg_catalog.jsonb_build_object(
      'readableFieldIds', pg_catalog.to_jsonb(p_readable),
      'changeableFieldIds', pg_catalog.to_jsonb(p_changeable)
    ),
    'actionKind', p_action_kind,
    'administrative', false
  )
$function$;

-- The Module content both organisations publish, with their own identities.
create function pg_temp.adapter_module_content(
  p_type_s uuid,
  p_type_c uuid,
  p_storage_s uuid,
  p_storage_c uuid,
  p_module_root_id uuid,
  p_permissions jsonb
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'name', 'Record adapter fixture',
    'description', 'Two record types, one relationship and one saved condition.',
    'dependencies', '[]'::jsonb,
    'recordTypes', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordTypeId', p_type_s,
        'key', 'shared_type',
        'singularLabel', 'Shared record',
        'pluralLabel', 'Shared records',
        'titleFieldId', 'f4750000-0000-4000-8000-000000000001',
        'storageContractId', p_storage_s,
        'storageScope', 'organization_shared',
        'ownershipMode', 'team',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000001', 'text',
            pg_catalog.jsonb_build_object('maxLength', 200)),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000002', 'yes_no'),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000003', 'whole_number'),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000004', 'decimal_number',
            pg_catalog.jsonb_build_object('digitsBeforeDecimal', 10, 'decimalPlaces', 4)),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000005', 'money',
            pg_catalog.jsonb_build_object('currencyMode', 'fixed', 'currency', 'NZD')),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000006', 'date'),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000007', 'date_time'),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000008', 'several_choices',
            pg_catalog.jsonb_build_object('options', pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object('value', 'one', 'label', 'One'),
              pg_catalog.jsonb_build_object('value', 'two', 'label', 'Two')
            ))),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000009', 'link_to_person',
            pg_catalog.jsonb_build_object(
              'audience', 'organization_accounts', 'applicationRootIdRequired', false
            )),
          pg_temp.adapter_field('f4750000-0000-4000-8000-00000000000a', 'formatted_text',
            pg_catalog.jsonb_build_object(
              'allowedBlocks', pg_catalog.jsonb_build_array('paragraph')
            )),
          pg_temp.adapter_field('f4750000-0000-4000-8000-00000000000b', 'table',
            pg_catalog.jsonb_build_object(
              'minimumRows', 0, 'maximumRows', 10,
              'columns', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'key', 'label', 'type', 'text', 'required', false,
                'settings', pg_catalog.jsonb_build_object('maxLength', 50)
              ))
            )),
          pg_temp.adapter_field('f4750000-0000-4000-8000-00000000000c', 'attachment',
            pg_catalog.jsonb_build_object('multiple', true)),
          pg_temp.adapter_field('f4750000-0000-4000-8000-00000000000d', 'text',
            pg_catalog.jsonb_build_object('maxLength', 200))
        ),
        'relationships', '[]'::jsonb,
        'standardActions', pg_catalog.jsonb_build_array('read', 'update'),
        'customActionIds', '[]'::jsonb
      ),
      pg_catalog.jsonb_build_object(
        'recordTypeId', p_type_c,
        'key', 'contained_type',
        'singularLabel', 'Contained record',
        'pluralLabel', 'Contained records',
        'titleFieldId', 'f4750000-0000-4000-8000-000000000021',
        'storageContractId', p_storage_c,
        'storageScope', 'application_contained',
        'ownershipMode', 'organization_account',
        'fields', pg_catalog.jsonb_build_array(
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000021', 'text',
            pg_catalog.jsonb_build_object('maxLength', 200)),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000022', 'link',
            pg_catalog.jsonb_build_object(
              'target', pg_catalog.jsonb_build_object(
                'state', 'resolved', 'moduleRootId', p_module_root_id,
                'recordTypeId', p_type_s
              ),
              'onParentDelete', 'refuse'
            )),
          pg_temp.adapter_field('f4750000-0000-4000-8000-000000000023', 'text',
            pg_catalog.jsonb_build_object('maxLength', 200))
        ),
        'relationships', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'relationshipId', 'a4750000-0000-4000-8000-000000000001',
          'key', 'contained_to_shared',
          'fromRecordTypeId', p_type_c,
          'fromFieldId', 'f4750000-0000-4000-8000-000000000022',
          'toRecordType', pg_catalog.jsonb_build_object(
            'state', 'resolved', 'moduleRootId', p_module_root_id,
            'recordTypeId', p_type_s
          ),
          'cardinality', 'many_to_one',
          'onParentDelete', 'refuse'
        )),
        'standardActions', pg_catalog.jsonb_build_array('read', 'update'),
        'customActionIds', '[]'::jsonb
      )
    ),
    'permissions', p_permissions,
    'actions', '[]'::jsonb,
    'events', '[]'::jsonb,
    'rules', '[]'::jsonb,
    'sharingConditions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'conditionId', 'a4750000-0000-4000-8000-000000000002',
      'sourceRecordTypeId', p_type_s,
      'key', 'flagged_only',
      'publishedRevision', 1,
      'contractFingerprint', pg_temp.adapter_sha('condition:flagged_only'),
      'parameters', '[]'::jsonb,
      'condition', pg_catalog.jsonb_build_object(
        'kind', 'comparison', 'operator', 'equals',
        'left', pg_catalog.jsonb_build_object(
          'source', 'field', 'fieldId', 'f4750000-0000-4000-8000-000000000002'
        ),
        'right', pg_catalog.jsonb_build_object('source', 'value', 'value', true)
      ),
      'declaredFieldIds', pg_catalog.jsonb_build_array(
        'f4750000-0000-4000-8000-000000000002'
      ),
      'publicationTests', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'name', 'Flagged records only',
        'parameters', '{}'::jsonb,
        'fieldValues', pg_catalog.jsonb_build_object(
          'f4750000-0000-4000-8000-000000000002', true
        ),
        'expected', true
      ))
    )),
    'extensionPoints', '[]'::jsonb
  )
$function$;

-- Direct inserts: the tenant, both organisations and each one's first account.
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  :'tenant', 'record_adapters', 'Record adapters', 'active',
  pg_catalog.clock_timestamp(), :'actor', pg_catalog.clock_timestamp(), 1
);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state,
  created_at, created_by, state_changed_at, revision
) values
  (:'org_one', :'tenant', 'record_adapters_one', 'Record adapters one', 'active',
    pg_catalog.clock_timestamp(), :'actor', pg_catalog.clock_timestamp(), 1),
  (:'org_two', :'tenant', 'record_adapters_two', 'Record adapters two', 'active',
    pg_catalog.clock_timestamp(), :'actor', pg_catalog.clock_timestamp(), 1);

select * from vortex_access.initialize_organization_access_version(
  :'org_one', :'actor', 'c4750000-0000-4000-8000-000000000001'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  :'org_one', :'actor', 'c4750000-0000-4000-8000-000000000002'
);
select * from vortex_access.initialize_organization_access_version(
  :'org_two', :'actor', 'c4750000-0000-4000-8000-000000000003'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  :'org_two', :'actor', 'c4750000-0000-4000-8000-000000000004'
);

select * from vortex_identity.ensure_identity_projection(
  '54750000-0000-4000-8000-0000000000a1', 'c4750000-0000-4000-8000-000000000011'
);
select * from vortex_identity.ensure_identity_projection(
  '54750000-0000-4000-8000-0000000000a2', 'c4750000-0000-4000-8000-000000000012'
);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values
  ('64750000-0000-4000-8000-0000000000a1', :'org_one',
    '54750000-0000-4000-8000-0000000000a1', 'Administrator one', 'active',
    pg_catalog.clock_timestamp() - interval '1 minute', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), :'actor', 'c4750000-0000-4000-8000-000000000021', 1),
  ('64750000-0000-4000-8000-0000000000a2', :'org_two',
    '54750000-0000-4000-8000-0000000000a2', 'Administrator two', 'active',
    pg_catalog.clock_timestamp() - interval '1 minute', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), :'actor', 'c4750000-0000-4000-8000-000000000022', 1);

-- Installation authority for each administrator, through the owning writers.
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  :'org_one', 1, '1.0.0', '1.0.1', :'actor', 'c4750000-0000-4000-8000-000000000031'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  :'org_one', '64750000-0000-4000-8000-0000000000a1',
  '74750000-0000-4000-8000-000000000001', 'adapter_steward_one',
  'Adapter steward one', 'Permanent stewardship for the adapter fixture.',
  '74750000-0000-4000-8000-000000000002', '74750000-0000-4000-8000-000000000003',
  '54750000-0000-4000-8000-0000000000a1', 'c4750000-0000-4000-8000-000000000032'
);
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  :'org_one', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  :'actor', 'c4750000-0000-4000-8000-000000000033'
);
select * from vortex_access.revise_platform_permission_catalogue_metadata(
  :'org_two', 1, '1.0.0', '1.0.1', :'actor', 'c4750000-0000-4000-8000-000000000041'
);
select * from vortex_access.coordinate_organization_stewardship_adoption(
  :'org_two', '64750000-0000-4000-8000-0000000000a2',
  '74750000-0000-4000-8000-000000000011', 'adapter_steward_two',
  'Adapter steward two', 'Permanent stewardship for the adapter fixture.',
  '74750000-0000-4000-8000-000000000012', '74750000-0000-4000-8000-000000000013',
  '54750000-0000-4000-8000-0000000000a2', 'c4750000-0000-4000-8000-000000000042'
);
select * from vortex_access.adopt_shipped_platform_permission_catalogue(
  :'org_two', 2, '1.1.0',
  'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
  :'actor', 'c4750000-0000-4000-8000-000000000043'
);

-- Direct inserts: the definition roots these fixtures need at fixed identities.
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values
  (:'module_one', :'org_one', 'module', 'vortex.record_adapters.module_one',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'app_one', :'org_one', 'application', 'vortex.record_adapters.app_one',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'app_two', :'org_one', 'application', 'vortex.record_adapters.app_two',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'module_two', :'org_two', 'module', 'vortex.record_adapters.module_two',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor'),
  (:'app_three', :'org_two', 'application', 'vortex.record_adapters.app_three',
    pg_catalog.clock_timestamp() - interval '1 minute', :'actor');

-- Every other account comes from an invitation its organisation's administrator
-- issues and the invited identity accepts, both through their owning writers.
create function pg_temp.adapter_account(
  p_organization_id uuid,
  p_inviter_account_id uuid,
  p_identity_id uuid,
  p_display_name text
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $function$
declare
  invited_email text := 'person-' || p_identity_id::text || '@example.test';
  invitation_token text := pg_temp.adapter_sha('invitation:' || p_identity_id::text);
  accepted record;
  tenant_value uuid;
  version_value bigint;
begin
  perform 1 from vortex_identity.ensure_identity_projection(
    p_identity_id, pg_catalog.gen_random_uuid()
  );

  select organization.tenant_id, version.current_version
  into strict tenant_value, version_value
  from vortex_identity.organizations as organization
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where organization.organization_id = p_organization_id;

  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid();
  perform vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'c4750000-0000-4000-8000-0000000000f1',
    'tenantId', tenant_value,
    'organizationId', p_organization_id,
    'organizationAccountId', p_inviter_account_id,
    'identityId', (
      select account.identity_id from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_inviter_account_id
    ),
    'sessionId', 'c4750000-0000-4000-8000-0000000000f2',
    'authenticationStrength', 'single_factor',
    'issuedAt', pg_catalog.statement_timestamp(),
    'expiresAt', pg_catalog.statement_timestamp() + interval '2 hours',
    'accessVersion', version_value,
    'correlationId', pg_catalog.gen_random_uuid(),
    'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
  ));
  perform 1 from vortex_identity.create_organization_invitation(
    invited_email, invitation_token, pg_catalog.clock_timestamp() + interval '1 day'
  );
  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid();

  select result.* into strict accepted
  from vortex_access.accept_organization_invitation(
    invitation_token, p_identity_id, invited_email, p_display_name,
    pg_catalog.gen_random_uuid()
  ) as result;
  if accepted.outcome <> 'accepted' then
    raise exception 'Adapter fixture invitation for % was not accepted: %',
      p_display_name, accepted.outcome;
  end if;
  return accepted.organization_account_id;
end
$function$;

-- One verified human request context for the current transaction.
create function pg_temp.adapter_context(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_account_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid();

  select pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', 'c4750000-0000-4000-8000-0000000000f1',
    'tenantId', organization.tenant_id,
    'organizationId', p_organization_id,
    'organizationAccountId', p_account_id,
    'identityId', account.identity_id,
    'sessionId', 'c4750000-0000-4000-8000-0000000000f2',
    'authenticationStrength', 'single_factor',
    'issuedAt', pg_catalog.statement_timestamp(),
    'expiresAt', pg_catalog.statement_timestamp() + interval '2 hours',
    'accessVersion', version.current_version,
    'correlationId', 'c4750000-0000-4000-8000-0000000000f3',
    'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
  ) || case
    when p_application_root_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('applicationRootId', p_application_root_id)
  end
  into strict context_value
  from vortex_identity.organizations as organization
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.organization_account_id = p_account_id
  where organization.organization_id = p_organization_id;

  perform vortex_context.initialize(context_value);
end
$function$;

create function pg_temp.adapter_clear_context()
returns void
language sql
volatile
set search_path = ''
as $function$
  delete from vortex_context.request_contexts
  where backend_pid = pg_catalog.pg_backend_pid()
$function$;

-- The registration candidate carrying the Application's own declared
-- permissions and every permission its pinned Module release declares, which is
-- exactly what the coordinated writer requires.
create function pg_temp.adapter_registration_candidate(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_module_root_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  entries jsonb;
begin
  with owners as (
    select 'application'::text as owner_kind, p_application_root_id as owner_id
    union all
    select 'module', p_module_root_id
  ), declared as (
    select owners.owner_kind, owners.owner_id, permission.value as permission_value,
      pg_catalog.jsonb_build_object(
        'kind', root.kind, 'definitionKey', root.key, 'rootId', root.root_id,
        'releaseRevision', release.release_revision,
        'releaseVersion', release.release_version,
        'validationContractVersion', release.validation_contract_version,
        'contentFingerprint', release.content_fingerprint,
        'resolutionFingerprint', release.resolution_fingerprint
      ) as source_release
    from owners
    join vortex_definition.roots as root on root.root_id = owners.owner_id
    join vortex_definition.releases as release on release.root_id = owners.owner_id
    cross join lateral pg_catalog.jsonb_array_elements(
      release.compilation_output #> '{canonical,content,permissions}'
    ) as permission(value)
  )
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', p_application_root_id,
      'ownerKind', declared.owner_kind,
      'ownerId', declared.owner_id,
      'permission', declared.permission_value,
      'sourceRelease', declared.source_release,
      'meaningFingerprint', pg_temp.adapter_sha(
        'meaning:' || (declared.permission_value ->> 'permissionId')
      )
    )
    -- The registration writer compares this array with its own aggregate
    -- ordered by the owner identity as text, so the candidate must sort the
    -- same way. A uuid carries no collation, so the cast is required as well as
    -- correct.
    order by declared.owner_kind collate "C", declared.owner_id::text collate "C",
      (declared.permission_value ->> 'key') collate "C",
      (declared.permission_value ->> 'permissionId') collate "C"
  )
  into entries
  from declared;

  return pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationRelease', (
      select pg_catalog.jsonb_build_object(
        'kind', 'application', 'definitionKey', root.key, 'rootId', root.root_id,
        'releaseRevision', release.release_revision,
        'releaseVersion', release.release_version,
        'validationContractVersion', release.validation_contract_version,
        'contentFingerprint', release.content_fingerprint,
        'resolutionFingerprint', release.resolution_fingerprint
      )
      from vortex_definition.roots as root
      join vortex_definition.releases as release on release.root_id = root.root_id
      where root.root_id = p_application_root_id
    ),
    'applicationCatalogueFingerprint', pg_temp.adapter_sha(
      'catalogue:' || p_application_root_id::text
    ),
    'applicationPermissionIds', (
      select coalesce(
        pg_catalog.jsonb_agg(entry.value #> '{permission,permissionId}'
          order by (entry.value #>> '{permission,key}') collate "C",
            (entry.value #>> '{permission,permissionId}') collate "C"),
        '[]'::jsonb
      )
      from pg_catalog.jsonb_array_elements(entries) as entry(value)
      where entry.value ->> 'ownerKind' = 'application'
        and (entry.value #>> '{permission,administrative}')::boolean = false
    ),
    'entries', entries,
    'candidateFingerprint', pg_temp.adapter_sha(
      'candidate:' || p_application_root_id::text
    )
  );
end
$function$;

-- Registers one Application's permission catalogue through the coordinated
-- Access writer, exactly as installing an application does.
create function pg_temp.adapter_register_application(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_module_root_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  candidate jsonb := pg_temp.adapter_registration_candidate(
    p_organization_id, p_application_root_id, p_module_root_id
  );
  outcome record;
begin
  select result.* into strict outcome
  from vortex_access.coordinate_application_access_change(
    'register', null,
    pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
      'permissionRegistration', candidate,
      'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template', pg_catalog.jsonb_build_object(
          'roleId', pg_catalog.gen_random_uuid(),
          'key', 'adapter_template',
          'name', 'Adapter template',
          'homePageId', pg_catalog.gen_random_uuid(),
          'permissionKeys', (
            select coalesce(
              pg_catalog.jsonb_agg(entry.value #> '{permission,key}' order by entry.ordinality),
              '[]'::jsonb
            )
            from pg_catalog.jsonb_array_elements(candidate -> 'entries')
              with ordinality as entry(value, ordinality)
          ),
          'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
        ),
        'sourceTemplateFingerprint', pg_temp.adapter_sha(
          'template:' || p_application_root_id::text
        ),
        'sourcePermissions', candidate -> 'entries',
        'livePermissions', candidate -> 'entries'
      )),
      'candidateFingerprint', pg_temp.adapter_sha(
        'preparation:' || p_application_root_id::text
      )
    ),
    p_organization_id, p_application_root_id,
    '94750000-0000-4000-8000-000000000001', pg_catalog.gen_random_uuid()
  ) as result;
  if outcome.outcome <> 'changed' then
    raise exception 'Adapter fixture registration of % was not applied',
      p_application_root_id;
  end if;
end
$function$;

-- A standing custom role over exact current permissions, and its assignment,
-- both through their owning writers.
create function pg_temp.adapter_role(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_role_id uuid,
  p_role_key text,
  p_permission_ids uuid[]
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  refs jsonb;
begin
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'kind', 'exact',
    'applicationRootId', entry.application_root_id,
    'ownerKind', entry.owner_kind,
    'ownerId', entry.owner_id,
    'permissionId', entry.permission_id,
    'acceptedRegistrationRevision', registration.revision,
    'catalogueFingerprint', registration.permission_catalogue_fingerprint,
    'continuityRevision', continuity.continuity_revision,
    'meaningFingerprint', entry.meaning_fingerprint
  ) order by entry.application_root_id, entry.owner_kind collate "C",
    entry.owner_id, entry.permission_id)
  into refs
  from vortex_access.permission_registrations as registration
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = registration.organization_id
    and entry.registration_kind = registration.registration_kind
    and entry.registration_owner_id = registration.registration_owner_id
    and entry.registration_revision = registration.revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where registration.organization_id = p_organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = p_application_root_id
    and registration.state = 'active'
    and entry.permission_id = any (p_permission_ids);
  if pg_catalog.jsonb_array_length(coalesce(refs, '[]'::jsonb))
    <> pg_catalog.cardinality(p_permission_ids) then
    raise exception 'Adapter fixture role % names a permission that is not current',
      p_role_key;
  end if;

  perform 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0',
      'candidate', pg_catalog.jsonb_build_object(
        'operation', 'create_custom',
        'organizationId', p_organization_id,
        'roleId', p_role_id,
        'key', p_role_key,
        'label', 'Adapter ' || p_role_key,
        'description', 'Record adapter fixture role ' || p_role_key || '.',
        'privilegeClassification', 'standard',
        'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
        'permissions', refs
      ),
      'roleCandidateFingerprint', pg_temp.adapter_sha('role:' || p_role_id::text)
    ),
    '94750000-0000-4000-8000-000000000001', pg_catalog.gen_random_uuid()
  );
end
$function$;

create function pg_temp.adapter_assign(
  p_organization_id uuid,
  p_assignment_id uuid,
  p_role_id uuid,
  p_account_id uuid,
  p_group_id uuid default null
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  role_revision bigint;
begin
  select role.live_revision into strict role_revision
  from vortex_access.organization_roles as role
  where role.organization_id = p_organization_id and role.role_id = p_role_id;

  perform 1 from vortex_access.coordinate_organization_role_assignment_change(
    'grant', p_organization_id, p_assignment_id, null, p_role_id, role_revision,
    case when p_group_id is null then 'organization_account' else 'group' end,
    p_account_id, p_group_id, 'standing',
    pg_catalog.clock_timestamp() - interval '1 minute', null,
    '94750000-0000-4000-8000-000000000001', pg_catalog.gen_random_uuid()
  );
end
$function$;

-- Organisation two publishes its own minimal Module: the publication writer
-- keeps an Application's dependency closure inside its own organisation, and a
-- relationship identity is a primary key in the storage mappings, so a copy of
-- Module M1's relationship could never be provisioned beside it.
create function pg_temp.adapter_minimal_module_content(
  p_type_id uuid,
  p_storage_id uuid,
  p_permission_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'name', 'Record adapter fixture, organisation two',
    'description', 'One organisation-shared record type in the second organisation.',
    'dependencies', '[]'::jsonb,
    'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_type_id,
      'key', 'shared_type_two',
      'singularLabel', 'Shared record',
      'pluralLabel', 'Shared records',
      'titleFieldId', 'f4750000-0000-4000-8000-000000000001',
      'storageContractId', p_storage_id,
      'storageScope', 'organization_shared',
      'ownershipMode', 'team',
      'fields', pg_catalog.jsonb_build_array(
        pg_temp.adapter_field('f4750000-0000-4000-8000-000000000001', 'text',
          pg_catalog.jsonb_build_object('maxLength', 200)),
        pg_temp.adapter_field('f4750000-0000-4000-8000-000000000002', 'yes_no')
      ),
      'relationships', '[]'::jsonb,
      'standardActions', pg_catalog.jsonb_build_array('read', 'update'),
      'customActionIds', '[]'::jsonb
    )),
    'permissions', pg_catalog.jsonb_build_array(pg_temp.adapter_permission(
      p_permission_id, 'record_adapters.two.read', p_type_id, 'read',
      pg_catalog.jsonb_build_object(
        'routes', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('kind', 'all_records')
        )
      ),
      array['f4750000-0000-4000-8000-000000000001']::uuid[], array[]::uuid[]
    )),
    'actions', '[]'::jsonb,
    'events', '[]'::jsonb,
    'rules', '[]'::jsonb,
    'sharingConditions', '[]'::jsonb,
    'extensionPoints', '[]'::jsonb
  )
$function$;

-- ============================================================================
-- Releases, published through vortex_definition.append_release.
-- ============================================================================

select pg_temp.append_writer_release(
  :'module_one', '2.0.0', '[]'::jsonb,
  pg_temp.adapter_module_content(
    :'type_s', :'type_c', :'storage_s', :'storage_c', :'module_one',
    pg_catalog.jsonb_build_array(
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000001',
        'record_adapters.shared.read_all', :'type_s', 'read',
        '{"routes":[{"kind":"all_records"}]}'::jsonb,
        array[:'f_text', :'f_flag', :'f_number', :'f_amount', :'f_money', :'f_date',
          :'f_when', :'f_choices', :'f_person', :'f_doc', :'f_rows', :'f_files']::uuid[],
        array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000002',
        'record_adapters.shared.update_all', :'type_s', 'update',
        '{"routes":[{"kind":"all_records"}]}'::jsonb,
        array[:'f_text', :'f_flag', :'f_number', :'f_amount', :'f_money', :'f_date',
          :'f_when', :'f_choices', :'f_person', :'f_doc', :'f_rows', :'f_files']::uuid[],
        array[:'f_text', :'f_flag', :'f_number', :'f_amount', :'f_money', :'f_date',
          :'f_when', :'f_choices', :'f_person', :'f_doc', :'f_rows', :'f_files']::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000003',
        'record_adapters.shared.read_own', :'type_s', 'read',
        '{"routes":[{"kind":"ownership"}]}'::jsonb,
        array[:'f_text', :'f_flag']::uuid[], array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000004',
        'record_adapters.shared.update_own', :'type_s', 'update',
        '{"routes":[{"kind":"ownership"}]}'::jsonb,
        array[:'f_text', :'f_flag']::uuid[], array[:'f_text']::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000005',
        'record_adapters.shared.read_share', :'type_s', 'read',
        '{"routes":[{"kind":"direct_share"}]}'::jsonb,
        array[:'f_text', :'f_number', :'f_money']::uuid[], array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000006',
        'record_adapters.shared.update_share', :'type_s', 'update',
        '{"routes":[{"kind":"direct_share"}]}'::jsonb,
        array[:'f_text', :'f_number', :'f_money']::uuid[],
        array[:'f_text', :'f_number']::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000007',
        'record_adapters.shared.read_related', :'type_s', 'read',
        pg_catalog.jsonb_build_object('routes', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'kind', 'relationship',
            'relationshipId', :'relationship_one',
            'sourcePermissionId', 'e4750000-0000-4000-8000-00000000000a'
          )
        )),
        array[:'f_text']::uuid[], array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000008',
        'record_adapters.shared.read_flagged', :'type_s', 'read',
        pg_catalog.jsonb_build_object(
          'routes', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('kind', 'all_records')
          ),
          'savedCondition', pg_catalog.jsonb_build_object(
            'conditionId', :'condition_one',
            'publishedRevision', 1,
            'contractFingerprint', pg_temp.adapter_sha('condition:flagged_only'),
            'parameterBindings', '[]'::jsonb
          )
        ),
        array[:'f_text', :'f_flag']::uuid[], array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-000000000009',
        'record_adapters.shared.update_flagged', :'type_s', 'update',
        pg_catalog.jsonb_build_object(
          'routes', pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('kind', 'all_records')
          ),
          'savedCondition', pg_catalog.jsonb_build_object(
            'conditionId', :'condition_one',
            'publishedRevision', 1,
            'contractFingerprint', pg_temp.adapter_sha('condition:flagged_only'),
            'parameterBindings', '[]'::jsonb
          )
        ),
        array[:'f_text', :'f_flag']::uuid[], array[:'f_text', :'f_flag']::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-00000000000a',
        'record_adapters.contained.read_own', :'type_c', 'read',
        '{"routes":[{"kind":"ownership"}]}'::jsonb,
        array[:'f_title', :'f_link', :'f_note']::uuid[], array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-00000000000b',
        'record_adapters.contained.update_own', :'type_c', 'update',
        '{"routes":[{"kind":"ownership"}]}'::jsonb,
        array[:'f_title', :'f_link', :'f_note']::uuid[],
        array[:'f_title', :'f_link', :'f_note']::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-00000000000c',
        'record_adapters.contained.read_all', :'type_c', 'read',
        '{"routes":[{"kind":"all_records"}]}'::jsonb,
        array[:'f_title', :'f_link', :'f_note']::uuid[], array[]::uuid[]),
      pg_temp.adapter_permission('e4750000-0000-4000-8000-00000000000d',
        'record_adapters.contained.update_all', :'type_c', 'update',
        '{"routes":[{"kind":"all_records"}]}'::jsonb,
        array[:'f_title', :'f_link', :'f_note']::uuid[],
        array[:'f_title', :'f_note']::uuid[])
    )
  ),
  '2.0.0'
);

-- Both Applications of organisation one bind the same exact Module release, so
-- the application direction runs over one shared physical table. A1 also
-- declares an application-owned permission, so both owner kinds appear in the
-- declaration the adapter builds.
select pg_temp.append_writer_release(
  :'app_one', '1.0.0',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(:'module_one', 1)),
  pg_catalog.jsonb_build_object(
    'permissions', pg_catalog.jsonb_build_array(pg_temp.adapter_permission(
      'e4750000-0000-4000-8000-000000000010',
      'record_adapters.app_one.shared_read', :'type_s', 'read',
      '{"routes":[{"kind":"all_records"}]}'::jsonb,
      array[:'f_text']::uuid[], array[]::uuid[]
    ))
  ),
  '1.0.0'
);
select pg_temp.append_writer_release(
  :'app_two', '1.0.0',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(:'module_one', 1)),
  pg_catalog.jsonb_build_object('permissions', '[]'::jsonb),
  '1.0.0'
);
select pg_temp.append_writer_release(
  :'module_two', '2.0.0', '[]'::jsonb,
  pg_temp.adapter_minimal_module_content(
    :'type_s_two', :'storage_s_two', 'e4750000-0000-4000-8000-000000000101'
  ),
  '2.0.0'
);
select pg_temp.append_writer_release(
  :'app_three', '1.0.0',
  pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(:'module_two', 1)),
  pg_catalog.jsonb_build_object('permissions', '[]'::jsonb),
  '1.0.0'
);

select pg_temp.adapter_register_application(:'org_one', :'app_one', :'module_one');
select pg_temp.adapter_register_application(:'org_one', :'app_two', :'module_one');
select pg_temp.adapter_register_application(:'org_two', :'app_three', :'module_two');

-- ============================================================================
-- Accounts, Groups and roles, each through its owning writer.
-- ============================================================================

select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000001', 'Group member') as member_account \gset
select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000002', 'Contained owner') as owner_account \gset
select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000003', 'Share recipient') as share_account \gset
select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000004', 'Relationship reader') as related_account \gset
select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000005', 'Condition reader') as condition_account \gset
select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000006', 'Everything reader') as all_account \gset
select pg_temp.adapter_account(:'org_one', '64750000-0000-4000-8000-0000000000a1',
  '54750000-0000-4000-8000-000000000007', 'Outsider') as outsider_account \gset
select pg_temp.adapter_account(:'org_two', '64750000-0000-4000-8000-0000000000a2',
  '54750000-0000-4000-8000-000000000008', 'Second organisation reader') as other_account \gset

select * from vortex_access.coordinate_organization_group_change(
  'create_group', :'org_one', '84750000-0000-4000-8000-000000000001', null,
  'adapter_group', 'Adapter group', :'actor', 'c4750000-0000-4000-8000-000000000051'
);
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', :'org_one', '84750000-0000-4000-8000-000000000011', null,
  '84750000-0000-4000-8000-000000000001', :'member_account',
  pg_catalog.clock_timestamp() - interval '1 minute', null, null,
  :'actor', 'c4750000-0000-4000-8000-000000000052'
);
select * from vortex_access.coordinate_organization_group_change(
  'create_group', :'org_two', '84750000-0000-4000-8000-000000000002', null,
  'adapter_group_two', 'Adapter group two', :'actor',
  'c4750000-0000-4000-8000-000000000053'
);

select pg_temp.adapter_role(:'org_one', :'app_one', '74750000-0000-4000-8000-000000000021',
  'adapter_owner_route',
  array['e4750000-0000-4000-8000-000000000003',
    'e4750000-0000-4000-8000-000000000004']::uuid[]);
select pg_temp.adapter_role(:'org_one', :'app_one', '74750000-0000-4000-8000-000000000022',
  'adapter_contained_owner',
  array['e4750000-0000-4000-8000-00000000000a',
    'e4750000-0000-4000-8000-00000000000b']::uuid[]);
select pg_temp.adapter_role(:'org_one', :'app_one', '74750000-0000-4000-8000-000000000023',
  'adapter_share_route',
  array['e4750000-0000-4000-8000-000000000005',
    'e4750000-0000-4000-8000-000000000006']::uuid[]);
-- The relationship route is only as good as its source permission: that source
-- permission is ownership-routed on the contained record, so this reader must
-- own the contained row the edge starts from. It also holds the contained
-- update permission, which is what the link-field refusal below exercises.
select pg_temp.adapter_role(:'org_one', :'app_one', '74750000-0000-4000-8000-000000000024',
  'adapter_relationship_route',
  array['e4750000-0000-4000-8000-000000000007',
    'e4750000-0000-4000-8000-00000000000a',
    'e4750000-0000-4000-8000-00000000000b']::uuid[]);
select pg_temp.adapter_role(:'org_one', :'app_one', '74750000-0000-4000-8000-000000000025',
  'adapter_condition_route',
  array['e4750000-0000-4000-8000-000000000008',
    'e4750000-0000-4000-8000-000000000009']::uuid[]);
select pg_temp.adapter_role(:'org_one', :'app_one', '74750000-0000-4000-8000-000000000026',
  'adapter_all_records',
  array['e4750000-0000-4000-8000-000000000001',
    'e4750000-0000-4000-8000-000000000002',
    'e4750000-0000-4000-8000-00000000000c',
    'e4750000-0000-4000-8000-00000000000d',
    'e4750000-0000-4000-8000-000000000010']::uuid[]);
select pg_temp.adapter_role(:'org_two', :'app_three', '74750000-0000-4000-8000-000000000031',
  'adapter_other_organization',
  array['e4750000-0000-4000-8000-000000000101']::uuid[]);

select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000041',
  '74750000-0000-4000-8000-000000000021', :'member_account');
select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000042',
  '74750000-0000-4000-8000-000000000022', :'owner_account');
select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000043',
  '74750000-0000-4000-8000-000000000023', :'share_account');
select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000044',
  '74750000-0000-4000-8000-000000000024', :'related_account');
select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000045',
  '74750000-0000-4000-8000-000000000025', :'condition_account');
select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000046',
  '74750000-0000-4000-8000-000000000026', :'all_account');
-- An Application's permissions are registered under that Application, so a role
-- built over A1's catalogue entries confers nothing in A2. The second
-- application direction needs its own role over A2's own entries.
select pg_temp.adapter_role(:'org_one', :'app_two', '74750000-0000-4000-8000-000000000027',
  'adapter_all_records_second_app',
  array['e4750000-0000-4000-8000-000000000001',
    'e4750000-0000-4000-8000-000000000002',
    'e4750000-0000-4000-8000-00000000000c',
    'e4750000-0000-4000-8000-00000000000d']::uuid[]);
select pg_temp.adapter_assign(:'org_one', '74750000-0000-4000-8000-000000000048',
  '74750000-0000-4000-8000-000000000027', :'all_account');
select pg_temp.adapter_assign(:'org_two', '74750000-0000-4000-8000-000000000047',
  '74750000-0000-4000-8000-000000000031', :'other_account');

-- Direct inserts: installation authority. A role over the shipped platform
-- install permission is built the same way 455 and the storage-provisioning
-- proof build theirs, because the role writer takes application-owned
-- permissions and this one is platform-owned.
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
) values
  (:'org_one', '74750000-0000-4000-8000-000000000051', 'custom',
    'application_installer', 1, :'actor', pg_catalog.statement_timestamp()),
  (:'org_two', '74750000-0000-4000-8000-000000000052', 'custom',
    'application_installer', 1, :'actor', pg_catalog.statement_timestamp());
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  role_application_root_id, application_root_id, owner_kind, owner_id,
  permission_id, registration_kind, registration_owner_id,
  accepted_registration_revision, catalogue_fingerprint, continuity_revision,
  meaning_fingerprint
)
select entry.organization_id,
  case when entry.organization_id = :'org_one'
    then '74750000-0000-4000-8000-000000000051'::uuid
    else '74750000-0000-4000-8000-000000000052'::uuid end,
  1, 1, 'custom', null, entry.application_root_id, entry.owner_kind, entry.owner_id,
  entry.permission_id, entry.registration_kind, entry.registration_owner_id,
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
where entry.organization_id in (:'org_one', :'org_two')
  and entry.registration_kind = 'platform'
  and entry.registration_revision = 3
  and entry.permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba';
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  authority_continuity_revision, role_key, label, description,
  changed_by, changed_at, change_correlation_id
) values
  (:'org_one', '74750000-0000-4000-8000-000000000051', 1, 'custom', 'active',
    'privileged', 'standing', 1, 1, 'application_installer', 'Application installer',
    'Current storage lifecycle authority.', :'actor',
    pg_catalog.statement_timestamp(), 'c4750000-0000-4000-8000-000000000061'),
  (:'org_two', '74750000-0000-4000-8000-000000000052', 1, 'custom', 'active',
    'privileged', 'standing', 1, 1, 'application_installer', 'Application installer',
    'Current storage lifecycle authority.', :'actor',
    pg_catalog.statement_timestamp(), 'c4750000-0000-4000-8000-000000000062');
insert into vortex_access.organization_role_assignments (
  organization_id, role_assignment_id, role_id, assignee_kind,
  organization_account_id, assignment_kind, revision, starts_at, state,
  granted_by, granted_at, grant_correlation_id, changed_by, changed_at,
  change_correlation_id
) values
  (:'org_one', '74750000-0000-4000-8000-000000000053',
    '74750000-0000-4000-8000-000000000051', 'organization_account',
    '64750000-0000-4000-8000-0000000000a1', 'standing', 1,
    pg_catalog.statement_timestamp() - interval '1 minute', 'live', :'actor',
    pg_catalog.statement_timestamp(), 'c4750000-0000-4000-8000-000000000063',
    :'actor', pg_catalog.statement_timestamp(), 'c4750000-0000-4000-8000-000000000063'),
  (:'org_two', '74750000-0000-4000-8000-000000000054',
    '74750000-0000-4000-8000-000000000052', 'organization_account',
    '64750000-0000-4000-8000-0000000000a2', 'standing', 1,
    pg_catalog.statement_timestamp() - interval '1 minute', 'live', :'actor',
    pg_catalog.statement_timestamp(), 'c4750000-0000-4000-8000-000000000064',
    :'actor', pg_catalog.statement_timestamp(), 'c4750000-0000-4000-8000-000000000064');

-- ============================================================================
-- Real storage, through the Module coordinator under the restricted request
-- role. Both Applications of organisation one bind the same Module release, so
-- the second provisioning reuses the first's tables.
-- ============================================================================

select pg_temp.adapter_context(:'org_one', null, '64750000-0000-4000-8000-0000000000a1');
set local role vortex_request;
select * from vortex_module.provision_module_installation_storage(
  :'app_one', 1, :'module_one', 1, null
);
reset role;
select pg_temp.adapter_context(:'org_one', null, '64750000-0000-4000-8000-0000000000a1');
set local role vortex_request;
select * from vortex_module.provision_module_installation_storage(
  :'app_two', 1, :'module_one', 1, null
);
reset role;
select pg_temp.adapter_context(:'org_two', null, '64750000-0000-4000-8000-0000000000a2');
set local role vortex_request;
select * from vortex_module.provision_module_installation_storage(
  :'app_three', 1, :'module_two', 1, null
);
reset role;
select pg_temp.adapter_clear_context();

-- Direct update: activation is #43 and is not delivered, so the provisioned
-- bindings are advanced to active here. The active-installation reader owns
-- every other rule about them.
set local role vortex_module_owner;
update vortex_module.installation_bindings set state = 'active'
where organization_id in (:'org_one', :'org_two');
reset role;

-- ============================================================================
-- Direct inserts: record rows. The create adapter is #402, so rows are written
-- as vortex_record_adapter, which is subject to the same four scope policies
-- the adapters are.
-- ============================================================================

select pg_temp.adapter_context(:'org_one', :'app_one', '64750000-0000-4000-8000-0000000000a1');
set local role vortex_record_adapter;
insert into record_data.rt_b4750000000040008000000000000001 (
  organisation_id, module_root_id, record_type_id, storage_contract_id, record_id,
  application_root_id, definition_revision, owner_group_id, lifecycle_state,
  concurrency_number, created_at, created_by, updated_at, updated_by,
  f_f4750000000040008000000000000001, f_f4750000000040008000000000000002,
  f_f4750000000040008000000000000003, f_f4750000000040008000000000000004,
  f_f4750000000040008000000000000005, f_f4750000000040008000000000000006,
  f_f4750000000040008000000000000007, f_f4750000000040008000000000000008,
  f_f4750000000040008000000000000009, f_f475000000004000800000000000000a,
  f_f475000000004000800000000000000b, f_f475000000004000800000000000000c,
  f_f475000000004000800000000000000d
) values
  (:'org_one', :'module_one', :'type_s', :'storage_s',
    'd5750000-0000-4000-8000-000000000001', null, 1,
    '84750000-0000-4000-8000-000000000001', 'active', 1,
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    'Shared one', true, 42, 12.5,
    '{"amount":"12.5","currency":"NZD"}'::jsonb, '2026-03-04',
    '2026-03-04T05:06:07Z', '["one"]'::jsonb,
    pg_catalog.jsonb_build_object('organizationAccountId', :'member_account'),
    '{"blocks":[]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Never readable'),
  (:'org_one', :'module_one', :'type_s', :'storage_s',
    'd5750000-0000-4000-8000-000000000002', null, 1,
    '84750000-0000-4000-8000-000000000001', 'active', 1,
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    'Shared two', false, 7, 1.25,
    '{"amount":"1.25","currency":"NZD"}'::jsonb, '2026-03-05',
    '2026-03-05T06:07:08Z', '["two"]'::jsonb, null,
    '{"blocks":[]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Never readable two'),
  (:'org_one', :'module_one', :'type_s', :'storage_s',
    'd5750000-0000-4000-8000-000000000003', null, 1,
    '84750000-0000-4000-8000-000000000001', 'active', 1,
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    'Shared three', true, 9, 3.5,
    '{"amount":"3.5","currency":"NZD"}'::jsonb, '2026-03-06',
    '2026-03-06T07:08:09Z', '[]'::jsonb, null,
    '{"blocks":[]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Never readable three'),
  (:'org_one', :'module_one', :'type_s', :'storage_s',
    'd5750000-0000-4000-8000-000000000004', null, 1,
    '84750000-0000-4000-8000-000000000001', 'active', 1,
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a1',
    'Shared four', true, 11, 4.25,
    '{"amount":"4.25","currency":"NZD"}'::jsonb, '2026-03-07',
    '2026-03-07T08:09:10Z', '[]'::jsonb, null,
    '{"blocks":[]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Never readable four');
insert into record_data.rt_b4750000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id, record_id,
  application_root_id, definition_revision, owner_organisation_account_id,
  lifecycle_state, concurrency_number, created_at, created_by, updated_at,
  updated_by, f_f4750000000040008000000000000021,
  f_f4750000000040008000000000000022, f_f4750000000040008000000000000023
) values (
  :'org_one', :'module_one', :'type_c', :'storage_c',
  'd5750000-0000-4000-8000-000000000011', :'app_one', 1, :'related_account',
  'active', 1, pg_catalog.statement_timestamp(),
  '64750000-0000-4000-8000-0000000000a1', pg_catalog.statement_timestamp(),
  '64750000-0000-4000-8000-0000000000a1', 'Contained one',
  pg_catalog.jsonb_build_object(
    'recordTypeId', :'type_s', 'recordId', 'd5750000-0000-4000-8000-000000000004'
  ),
  'Contained note'
);
reset role;

select pg_temp.adapter_context(:'org_one', :'app_two', '64750000-0000-4000-8000-0000000000a1');
set local role vortex_record_adapter;
insert into record_data.rt_b4750000000040008000000000000002 (
  organisation_id, module_root_id, record_type_id, storage_contract_id, record_id,
  application_root_id, definition_revision, owner_organisation_account_id,
  lifecycle_state, concurrency_number, created_at, created_by, updated_at,
  updated_by, f_f4750000000040008000000000000021,
  f_f4750000000040008000000000000022, f_f4750000000040008000000000000023
) values (
  :'org_one', :'module_one', :'type_c', :'storage_c',
  'd5750000-0000-4000-8000-000000000012', :'app_two', 1, :'owner_account',
  'active', 1, pg_catalog.statement_timestamp(),
  '64750000-0000-4000-8000-0000000000a1', pg_catalog.statement_timestamp(),
  '64750000-0000-4000-8000-0000000000a1', 'Contained two',
  pg_catalog.jsonb_build_object(
    'recordTypeId', :'type_s', 'recordId', 'd5750000-0000-4000-8000-000000000004'
  ),
  'Contained note two'
);
reset role;

select pg_temp.adapter_context(:'org_two', :'app_three', '64750000-0000-4000-8000-0000000000a2');
set local role vortex_record_adapter;
insert into record_data.rt_b4750000000040008000000000000011 (
  organisation_id, module_root_id, record_type_id, storage_contract_id, record_id,
  application_root_id, definition_revision, owner_group_id, lifecycle_state,
  concurrency_number, created_at, created_by, updated_at, updated_by,
  f_f4750000000040008000000000000001, f_f4750000000040008000000000000002
) values (
  :'org_two', :'module_two', :'type_s_two', :'storage_s_two',
  'd5750000-0000-4000-8000-000000000021', null, 1,
  '84750000-0000-4000-8000-000000000002', 'active', 1,
  pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a2',
  pg_catalog.statement_timestamp(), '64750000-0000-4000-8000-0000000000a2',
  'Second organisation record', true
);
reset role;
select pg_temp.adapter_clear_context();

-- Direct insert: the relationship edge behind the relationship route. Edge
-- writes are #402; the scope trigger still checks both endpoints here.
set local role vortex_record_owner;
insert into vortex_record.relationship_edges (
  relationship_id, from_organisation_id, to_organisation_id,
  from_application_root_id, to_application_root_id, from_storage_contract_id,
  from_record_id, to_storage_contract_id, to_record_id
) values (
  :'relationship_one', :'org_one', :'org_one', :'app_one', null,
  :'storage_c', 'd5750000-0000-4000-8000-000000000011',
  :'storage_s', 'd5750000-0000-4000-8000-000000000004'
);
reset role;

-- The narrowed direct share, through #36's private structural writer, which
-- owns the revision check, the Activity append and the Access invalidation.
-- The protected #37 invocation that sits on top of it needs a facts adapter of
-- its own and is proved in 450, not here. The share narrows the permission's
-- own field policy further: readable text and money, changeable text only.
select * from vortex_access.grant_organization_direct_record_share(
  :'org_one', 'd5750000-0000-4000-8000-000000000031', 'organization_shared', null,
  :'module_one', :'type_s', :'storage_s', 'd5750000-0000-4000-8000-000000000003',
  'organization_account', :'share_account', null,
  array[:'f_text', :'f_money']::uuid[], array[:'f_text']::uuid[],
  pg_catalog.clock_timestamp() - interval '1 minute', null,
  'Record adapter fixture share.', '64750000-0000-4000-8000-0000000000a1',
  'c4750000-0000-4000-8000-000000000071', 'web',
  'c4750000-0000-4000-8000-000000000072'
);

-- Test-only pgTAP visibility while vortex_request is the active role,
-- following the same line in 445, 450 and 455. It grants no Vortex privilege.
grant usage on schema extensions to vortex_request;

-- ============================================================================
-- (i) Boundary inventory. What the request role cannot reach matters as much as
-- what the adapters allow, so this runs before any allowed case.
-- ============================================================================

select is(
  (
    select coalesce(pg_catalog.array_agg(distinct table_name.relname::text order by table_name.relname::text), array[]::text[])
    from pg_catalog.pg_class as table_name
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as needed(privilege)
    where table_name.relnamespace = 'record_data'::regnamespace
      and table_name.relkind = 'r'
      and pg_catalog.has_table_privilege('vortex_request', table_name.oid, needed.privilege)
  ),
  array[]::text[],
  'the request role holds no privilege on any generated record table'
);
select ok(
  (
    select pg_catalog.count(*) > 0 and pg_catalog.bool_and(
      policy_count = 4 and policy_roles = array['vortex_record_adapter']::name[]
    )
    from (
      select (
          select pg_catalog.count(*) from pg_catalog.pg_policy as policy
          where policy.polrelid = table_name.oid
        ) as policy_count,
        (
          select coalesce(pg_catalog.array_agg(distinct role_name.rolname order by role_name.rolname), array[]::name[])
          from pg_catalog.pg_policy as policy
          cross join lateral pg_catalog.unnest(policy.polroles) as assigned(role_oid)
          join pg_catalog.pg_roles as role_name on role_name.oid = assigned.role_oid
          where policy.polrelid = table_name.oid
        ) as policy_roles
      from pg_catalog.pg_class as table_name
      where table_name.relnamespace = 'record_data'::regnamespace
        and table_name.relkind = 'r'
    ) as generated
  ),
  'every generated record table has exactly four policies, all to the adapter owner'
);
select ok(
  not pg_catalog.has_function_privilege('vortex_request', candidate.signature, 'EXECUTE'),
  'the request role cannot execute ' || candidate.signature
)
from (values
  ('vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[])'),
  ('vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint)'),
  ('vortex_record.canonical_record_value_matches(jsonb,text,text)'),
  ('vortex_access.evaluate_organization_record_access_internal(jsonb,uuid,jsonb)'),
  ('vortex_access.evaluate_record_permission_row_scope_internal(jsonb,timestamptz,timestamptz,uuid,jsonb,jsonb,uuid,jsonb,uuid[])'),
  ('vortex_access.resolve_record_field_bounds_internal(jsonb)')
) as candidate(signature)
order by candidate.signature collate "C";
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request', 'vortex_record.read_record(uuid,uuid)', 'EXECUTE'
  ),
  'the request role reaches exactly one object in the Record schema: the read adapter'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_record_adapter',
    'vortex_record.provision_exact_module_storage(uuid,bigint)', 'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'vortex_record_adapter',
    'vortex_module.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint)',
    'EXECUTE'
  ),
  'the adapter owner cannot provision storage'
);
select is(
  (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'name', procedure_row.proname,
        'owner', owner_role.rolname,
        'securityDefiner', procedure_row.prosecdef,
        'configuration', procedure_row.proconfig
      ) order by procedure_row.proname collate "C"
    )
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid in (
      'vortex_record.read_record(uuid,uuid)'::regprocedure,
      'vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[])'::regprocedure
    )
  ),
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'name', 'change_record', 'owner', 'vortex_record_adapter',
      'securityDefiner', true, 'configuration', array['search_path=""']
    ),
    pg_catalog.jsonb_build_object(
      'name', 'read_record', 'owner', 'vortex_record_adapter',
      'securityDefiner', true, 'configuration', array['search_path=""']
    )
  ),
  'both adapters are owned by the adapter role, definer-rights and empty-search-path'
);

-- ============================================================================
-- (a) and (b) The read matrix, under the real vortex_request role.
-- ============================================================================

-- A Group member reaches the team-owned record through the ownership route, and
-- sees exactly that permission's two fields. Every other field of the record --
-- including the one no policy anywhere names -- is absent, not blank.
select pg_temp.adapter_context(:'org_one', :'app_one', :'member_account');
set local role vortex_request;
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid),
  pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', 'd5750000-0000-4000-8000-000000000001',
    'concurrencyNumber', 1,
    'values', pg_catalog.jsonb_build_object(
      :'f_text', 'Shared one', :'f_flag', true
    )
  ),
  'a Group member reads the team-owned record and only its permission''s fields'
);
reset role;

-- The same record read under a permission that names twelve fields: the
-- never-named field stays absent there too.
select pg_temp.adapter_context(:'org_one', :'app_one', :'all_account');
set local role vortex_request;
select is(
  (
    select coalesce(pg_catalog.array_agg(value_key order by value_key collate "C"), array[]::text[])
    from pg_catalog.jsonb_object_keys(
      vortex_record.read_record(
        :'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid
      ) -> 'values'
    ) as projected(value_key)
  ),
  array[:'f_text', :'f_flag', :'f_number', :'f_amount', :'f_money', :'f_date',
    :'f_when', :'f_choices', :'f_person', :'f_doc', :'f_rows', :'f_files']::text[],
  'an all-records reader sees every named field and never the unnamed one'
);
select is(
  vortex_record.read_record(
    :'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid
  ) -> 'values' -> :'f_secret',
  null::jsonb,
  'a field no policy names is absent from the projection'
);
reset role;

-- An account with no permission at all, a record that does not exist, and a
-- record of the other organisation are one refusal, so none is an oracle.
select pg_temp.adapter_context(:'org_one', :'app_one', :'outsider_account');
set local role vortex_request;
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'an account holding no permission is refused'
);
reset role;
select pg_temp.adapter_context(:'org_one', :'app_one', :'all_account');
set local role vortex_request;
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-0000000000ff'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'a record that does not exist is refused in exactly the same shape'
);
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000021'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'a record identifier belonging to the other organisation is refused identically'
);
reset role;

-- The other organisation direction: its own reader, its own installed record
-- type, and an identifier from organisation one.
select pg_temp.adapter_context(:'org_two', :'app_three', :'other_account');
set local role vortex_request;
select is(
  vortex_record.read_record(
    :'type_s_two'::uuid, 'd5750000-0000-4000-8000-000000000021'::uuid
  ) ->> 'outcome',
  'allowed',
  'the second organisation reads its own record'
);
select is(
  vortex_record.read_record(
    :'type_s_two'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid
  ),
  '{"outcome":"refused"}'::jsonb,
  'an identifier from the first organisation is refused in the second'
);
reset role;

-- Both application directions over one shared physical table: each contained
-- record is readable in its own application and refused in the other.
select pg_temp.adapter_context(:'org_one', :'app_one', :'all_account');
set local role vortex_request;
select is(
  vortex_record.read_record(
    :'type_c'::uuid, 'd5750000-0000-4000-8000-000000000011'::uuid
  ) ->> 'outcome',
  'allowed',
  'an application-contained record is readable in its own application'
);
select is(
  vortex_record.read_record(:'type_c'::uuid, 'd5750000-0000-4000-8000-000000000012'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'the other application''s row in the same table is refused'
);
reset role;
select pg_temp.adapter_context(:'org_one', :'app_two', :'all_account');
set local role vortex_request;
select is(
  vortex_record.read_record(
    :'type_c'::uuid, 'd5750000-0000-4000-8000-000000000012'::uuid
  ) ->> 'outcome',
  'allowed',
  'the same reader in the second application reads that application''s row'
);
select is(
  vortex_record.read_record(:'type_c'::uuid, 'd5750000-0000-4000-8000-000000000011'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'and is refused the first application''s row'
);
reset role;

-- A narrowed direct share: the recipient's permission names three fields, the
-- share names two, and the projection is the intersection.
select pg_temp.adapter_context(:'org_one', :'app_one', :'share_account');
set local role vortex_request;
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000003'::uuid),
  pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', 'd5750000-0000-4000-8000-000000000003',
    'concurrencyNumber', 1,
    'values', pg_catalog.jsonb_build_object(
      :'f_text', 'Shared three',
      :'f_money', '{"amount":"3.5","currency":"NZD"}'::jsonb
    )
  ),
  'a direct-share recipient sees the share''s own narrowed field set'
);
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'a record that was never shared with that recipient is refused'
);
reset role;

-- A relationship route: the reader owns the contained record whose link names
-- the shared record, and reaches it through that route alone.
select pg_temp.adapter_context(:'org_one', :'app_one', :'related_account');
set local role vortex_request;
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000004'::uuid),
  pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', 'd5750000-0000-4000-8000-000000000004',
    'concurrencyNumber', 1,
    'values', pg_catalog.jsonb_build_object(:'f_text', 'Shared four')
  ),
  'a relationship-routed permission admits the linked record'
);
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'the same reader is refused a record no edge reaches'
);
reset role;

-- A saved condition narrows an all-records route: the flagged record is
-- admitted and the unflagged one is not.
select pg_temp.adapter_context(:'org_one', :'app_one', :'condition_account');
set local role vortex_request;
select is(
  vortex_record.read_record(
    :'type_s'::uuid, 'd5750000-0000-4000-8000-000000000001'::uuid
  ) ->> 'outcome',
  'allowed',
  'a saved-condition-narrowed reader reads the record the condition admits'
);
select is(
  vortex_record.read_record(:'type_s'::uuid, 'd5750000-0000-4000-8000-000000000002'::uuid),
  '{"outcome":"refused"}'::jsonb,
  'and is refused the record the condition excludes'
);
reset role;

-- ============================================================================
-- (c) to (g) The change adapter, under its owner. Every result is captured
-- inside the role block and asserted outside it, so no pgTAP function is ever
-- called as the adapter owner and that role gains nothing for the test's sake.
-- ============================================================================

-- Ground truth before any change: read as the adapter owner, which is the only
-- role with a privilege on the table at all.
select pg_temp.adapter_context(:'org_one', :'app_one', :'member_account');
set local role vortex_record_adapter;
create temporary table shared_one_before on commit drop as
select concurrency_number, definition_revision, updated_by,
  f_f4750000000040008000000000000001 as text_value,
  f_f4750000000040008000000000000002 as flag_value,
  f_f4750000000040008000000000000003 as number_value
from record_data.rt_b4750000000040008000000000000001
where record_id = 'd5750000-0000-4000-8000-000000000001';

-- One permitted and one forbidden submitted field refuse the whole change.
create temporary table change_mixed on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 1,
  pg_catalog.jsonb_build_object(
    'f4750000-0000-4000-8000-000000000001', 'Refused change',
    'f4750000-0000-4000-8000-000000000002', false
  ),
  array['f4750000-0000-4000-8000-000000000001',
    'f4750000-0000-4000-8000-000000000002']::uuid[]
) as result;
create temporary table shared_one_after_mixed on commit drop as
select concurrency_number, definition_revision, updated_by,
  f_f4750000000040008000000000000001 as text_value,
  f_f4750000000040008000000000000002 as flag_value,
  f_f4750000000040008000000000000003 as number_value
from record_data.rt_b4750000000040008000000000000001
where record_id = 'd5750000-0000-4000-8000-000000000001';
reset role;

select is(
  (select result from change_mixed),
  '{"outcome":"refused","reasonCode":"field_not_changeable"}'::jsonb,
  'one submitted field outside the changeable set refuses the whole change'
);
select results_eq(
  'select * from shared_one_after_mixed',
  'select * from shared_one_before',
  'the refused change leaves the stored row exactly as it was'
);

-- A value the caller did not submit may sit outside the changeable set: that is
-- the declared rule output #47 classifies, which an adapter cannot tell from
-- the final row alone.
select pg_temp.adapter_context(:'org_one', :'app_one', :'member_account');
set local role vortex_record_adapter;
create temporary table change_generated on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 1,
  pg_catalog.jsonb_build_object(
    'f4750000-0000-4000-8000-000000000001', 'Member changed',
    'f4750000-0000-4000-8000-000000000003', 99
  ),
  array['f4750000-0000-4000-8000-000000000001']::uuid[]
) as result;
create temporary table shared_one_after_generated on commit drop as
select concurrency_number, definition_revision, updated_by,
  f_f4750000000040008000000000000001 as text_value,
  f_f4750000000040008000000000000003 as number_value
from record_data.rt_b4750000000040008000000000000001
where record_id = 'd5750000-0000-4000-8000-000000000001';
reset role;

select is(
  (select result ->> 'outcome' from change_generated),
  'allowed',
  'a non-submitted generated value outside the changeable set is accepted'
);
select is(
  (select result -> 'values' from change_generated),
  pg_catalog.jsonb_build_object(
    :'f_text', 'Member changed', :'f_flag', true
  ),
  'the change returns the readable projection of what it wrote'
);
select is(
  (
    select pg_catalog.concat_ws(':', concurrency_number::text, text_value,
      number_value::text)
    from shared_one_after_generated
  ),
  '2:Member changed:99',
  'the write advances the concurrency number and stores both values'
);
select is(
  (select updated_by from shared_one_after_generated),
  :'member_account'::uuid,
  'the change stamp names the acting account from the verified context'
);

-- (d) A stale concurrency number is a conflict, and writes nothing.
select pg_temp.adapter_context(:'org_one', :'app_one', :'member_account');
set local role vortex_record_adapter;
create temporary table change_stale on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 1,
  pg_catalog.jsonb_build_object(
    'f4750000-0000-4000-8000-000000000001', 'Stale change'
  ),
  array['f4750000-0000-4000-8000-000000000001']::uuid[]
) as result;
create temporary table shared_one_after_stale on commit drop as
select concurrency_number,
  f_f4750000000040008000000000000001 as text_value
from record_data.rt_b4750000000040008000000000000001
where record_id = 'd5750000-0000-4000-8000-000000000001';
reset role;

select is(
  (select result from change_stale),
  pg_catalog.jsonb_build_object('outcome', 'conflict', 'concurrencyNumber', 2),
  'a stale concurrency number returns conflict and names the current number'
);
select is(
  (select pg_catalog.concat_ws(':', concurrency_number::text, text_value)
    from shared_one_after_stale),
  '2:Member changed',
  'the conflicted change wrote nothing'
);

-- (e) Proposed values that leave every route the caller holds are refused on
-- the proposed-row decision, after the old row admitted the change.
select pg_temp.adapter_context(:'org_one', :'app_one', :'condition_account');
set local role vortex_record_adapter;
create temporary table change_condition on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 2,
  pg_catalog.jsonb_build_object('f4750000-0000-4000-8000-000000000002', false),
  array['f4750000-0000-4000-8000-000000000002']::uuid[]
) as result;
create temporary table shared_one_after_condition on commit drop as
select concurrency_number, f_f4750000000040008000000000000002 as flag_value
from record_data.rt_b4750000000040008000000000000001
where record_id = 'd5750000-0000-4000-8000-000000000001';
reset role;

select is(
  (select result from change_condition),
  '{"outcome":"refused","reasonCode":"proposed_record_refused"}'::jsonb,
  'a proposed row that leaves every access route is refused on the proposed-row decision'
);
select is(
  (select pg_catalog.concat_ws(':', concurrency_number::text, flag_value::text)
    from shared_one_after_condition),
  '2:true',
  'that refusal wrote nothing'
);

-- (c) An unknown identifier and a system column are the same refusal, because
-- neither is a field of this record type.
select pg_temp.adapter_context(:'org_one', :'app_one', :'all_account');
set local role vortex_record_adapter;
create temporary table change_unknown on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 2,
  pg_catalog.jsonb_build_object(
    'f4750000-0000-4000-8000-0000000000ee', 'Unknown field'
  ),
  array[]::uuid[]
) as result;
create temporary table change_system_column on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 2,
  pg_catalog.jsonb_build_object('concurrency_number', 99),
  array[]::uuid[]
) as result;
create temporary table change_decimal on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 2,
  pg_catalog.jsonb_build_object('f4750000-0000-4000-8000-000000000004', '12.50'),
  array['f4750000-0000-4000-8000-000000000004']::uuid[]
) as result;
create temporary table change_ill_typed on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000001'::uuid, 2,
  pg_catalog.jsonb_build_object('f4750000-0000-4000-8000-000000000001', 42),
  array['f4750000-0000-4000-8000-000000000001']::uuid[]
) as result;
reset role;

select is(
  (select result from change_unknown),
  '{"outcome":"refused","reasonCode":"unknown_field"}'::jsonb,
  'an identifier that is not a field of the exact installed definition refuses'
);
select is(
  (select result from change_system_column),
  '{"outcome":"refused","reasonCode":"unknown_field"}'::jsonb,
  'a system column is not addressable as a field'
);
select is(
  (select result from change_decimal),
  '{"outcome":"refused","reasonCode":"value_invalid"}'::jsonb,
  'a decimal that is not canonical exact text refuses the whole change'
);
select is(
  (select result from change_ill_typed),
  '{"outcome":"refused","reasonCode":"value_invalid"}'::jsonb,
  'a value of the wrong JSON type refuses the whole change'
);

-- (c) A link field carries a relationship edge, and edge writes are #402's, so
-- the change refuses with its own code rather than dropping the link silently.
select pg_temp.adapter_context(:'org_one', :'app_one', :'related_account');
set local role vortex_record_adapter;
create temporary table change_link on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000002'::uuid,
  'd5750000-0000-4000-8000-000000000011'::uuid, 1,
  pg_catalog.jsonb_build_object(
    'f4750000-0000-4000-8000-000000000022', pg_catalog.jsonb_build_object(
      'recordTypeId', 'd4750000-0000-4000-8000-000000000001',
      'recordId', 'd5750000-0000-4000-8000-000000000003'
    )
  ),
  array['f4750000-0000-4000-8000-000000000022']::uuid[]
) as result;
reset role;
select is(
  (select result from change_link),
  '{"outcome":"refused","reasonCode":"link_change_unsupported"}'::jsonb,
  'a link-field change refuses with its own fixed code'
);

-- (g) Every storage column type round-trips through the adapters: written as
-- canonical V2 JSON, read back as the same canonical V2 JSON. The date-time is
-- written with a +13:00 offset and read back as the same instant in UTC.
select pg_temp.adapter_context(:'org_one', :'app_one', :'all_account');
set local role vortex_record_adapter;
create temporary table change_round_trip on commit drop as
select vortex_record.change_record(
  'd4750000-0000-4000-8000-000000000001'::uuid,
  'd5750000-0000-4000-8000-000000000003'::uuid, 1,
  pg_catalog.jsonb_build_object(
    'f4750000-0000-4000-8000-000000000001', 'Round trip',
    'f4750000-0000-4000-8000-000000000002', false,
    'f4750000-0000-4000-8000-000000000003', 7,
    'f4750000-0000-4000-8000-000000000004', '0.125',
    'f4750000-0000-4000-8000-000000000005',
      pg_catalog.jsonb_build_object('amount', '99.5', 'currency', 'NZD'),
    'f4750000-0000-4000-8000-000000000006', '2026-12-31',
    'f4750000-0000-4000-8000-000000000007', '2026-12-31T23:59:58+13:00',
    'f4750000-0000-4000-8000-000000000008', pg_catalog.jsonb_build_array('one', 'two'),
    'f4750000-0000-4000-8000-000000000009', pg_catalog.jsonb_build_object(
      'organizationAccountId', :'member_account'
    ),
    'f4750000-0000-4000-8000-00000000000a', '{"blocks":[]}'::jsonb,
    'f4750000-0000-4000-8000-00000000000b', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('label', 'One')
    ),
    'f4750000-0000-4000-8000-00000000000c', pg_catalog.jsonb_build_array(
      'd5750000-0000-4000-8000-0000000000c1'
    )
  ),
  array['f4750000-0000-4000-8000-000000000001',
    'f4750000-0000-4000-8000-000000000002',
    'f4750000-0000-4000-8000-000000000003',
    'f4750000-0000-4000-8000-000000000004',
    'f4750000-0000-4000-8000-000000000005',
    'f4750000-0000-4000-8000-000000000006',
    'f4750000-0000-4000-8000-000000000007',
    'f4750000-0000-4000-8000-000000000008',
    'f4750000-0000-4000-8000-000000000009',
    'f4750000-0000-4000-8000-00000000000a',
    'f4750000-0000-4000-8000-00000000000b',
    'f4750000-0000-4000-8000-00000000000c']::uuid[]
) as result;
reset role;

select is(
  (select result ->> 'outcome' from change_round_trip),
  'allowed',
  'every declared column type accepts its canonical V2 value'
);
select pg_temp.adapter_context(:'org_one', :'app_one', :'all_account');
set local role vortex_request;
select is(
  vortex_record.read_record(
    :'type_s'::uuid, 'd5750000-0000-4000-8000-000000000003'::uuid
  ) -> 'values',
  pg_catalog.jsonb_build_object(
    :'f_text', 'Round trip',
    :'f_flag', false,
    :'f_number', 7,
    :'f_amount', '0.125',
    :'f_money', pg_catalog.jsonb_build_object('amount', '99.5', 'currency', 'NZD'),
    :'f_date', '2026-12-31',
    :'f_when', '2026-12-31T10:59:58.000000Z',
    :'f_choices', pg_catalog.jsonb_build_array('one', 'two'),
    :'f_person', pg_catalog.jsonb_build_object(
      'organizationAccountId', :'member_account'
    ),
    :'f_doc', '{"blocks":[]}'::jsonb,
    :'f_rows', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('label', 'One')
    ),
    :'f_files', pg_catalog.jsonb_build_array('d5750000-0000-4000-8000-0000000000c1')
  ),
  'every column type reads back as the canonical V2 value that was written'
);
reset role;

select * from finish();
rollback;
