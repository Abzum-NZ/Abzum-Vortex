-- Remove unreachable flow chains and their private state.
set role vortex_owner;
drop function vortex_access.begin_protected_node_effect(uuid, uuid, uuid, text, text, text);
drop function vortex_access.complete_protected_node_effect(uuid, uuid, uuid, text, text, text, jsonb);
drop function vortex_access.read_flow_execution_binding(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid);
drop function vortex_access.read_flow_execution_binding_for_run(uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid);
drop function vortex_access.flow_execution_binding_authority_internal(uuid, uuid, uuid, text);
drop function vortex_access.flow_execution_binding_to_json_internal(vortex_access.flow_execution_bindings);
drop function vortex_access.read_flow_run_as_principal_for_run(uuid, uuid, uuid, text, uuid);
drop function vortex_access.flow_run_as_principal_to_json_internal(vortex_access.flow_run_as_principals);
drop function vortex_platform.register_workflow_flow_candidate(text, uuid, uuid, text, bigint, bigint, jsonb);
drop function vortex_platform.flow_registration_to_json_internal(vortex_platform.flow_registrations);
drop function vortex_platform.read_protected_node_effect(uuid, uuid, uuid, text, text, text);
drop function vortex_platform.read_protected_workflow_run_registration(uuid);
drop function vortex_platform.refresh_protected_workflow_run_state(uuid, text, timestamptz);
drop function vortex_platform.accept_flow_start_intent(uuid, uuid, bigint, text, text, uuid, bigint, text, uuid, text, uuid, text, text, jsonb, jsonb);
drop function vortex_platform.read_committed_flow_start_intent(uuid);
drop function vortex_platform.start_value_matches_type_internal(text, jsonb);
reset role;
set role vortex_record_adapter;
drop function vortex_record.prepare_flow_record_update(uuid, uuid, uuid, bigint);
reset role;
set role vortex_owner;

drop table vortex_platform.flow_start_intents;
drop table vortex_platform.protected_workflow_runs;
drop table vortex_platform.flow_registrations;
drop table vortex_access.flow_run_as_principals;

-- Rewrite stored bundle manifests and parts to the one current section contract.
alter table vortex_definition.installation_runtime_bundles
  drop constraint installation_runtime_bundles_parts_check;
alter table vortex_definition.installation_runtime_bundles
  add constraint installation_runtime_bundles_parts_check
  check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) >= 7);
update vortex_definition.installation_runtime_bundles as bundle
set parts = (select jsonb_agg(item.value order by item.ordinality)
             from jsonb_array_elements(bundle.parts) with ordinality as item(value, ordinality)
             where item.value ->> 'section' <> 'trigger_index'),
    total_size_bytes = bundle.total_size_bytes -
      (select coalesce(sum((item.value ->> 'byteSize')::bigint), 0)
       from jsonb_array_elements(bundle.parts) as item(value)
       where item.value ->> 'section' = 'trigger_index');
delete from vortex_definition.installation_runtime_bundle_parts where section = 'trigger_index';
alter table vortex_definition.installation_runtime_bundle_parts
  drop constraint installation_runtime_bundle_parts_section_check;
alter table vortex_definition.installation_runtime_bundle_parts
  add constraint installation_runtime_bundle_parts_section_check
  check (section = any (array['pages', 'navigation', 'flows', 'theme', 'component_registry', 'access_plan', 'tool_bundle']));

create or replace function vortex_definition.assert_prepared_installation_runtime_bundle(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb,
  p_pin_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  prepared_source jsonb;
  source_manifest jsonb;
  application_content jsonb;
  expected_access_plan jsonb;
  access_plan_text text;
  access_plan_value jsonb;
  stored_bundle vortex_definition.installation_runtime_bundles%rowtype;
  part_item record;
  metadata_item jsonb;
  metadata_count integer;
  stored_part_count integer;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  total_size_value bigint := 0;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_pin_fingerprint is null
    or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1 then
    raise exception using errcode = '22023',
      message = 'Prepared runtime bundle assertion is invalid';
  end if;
  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Prepared runtime bundle authority is unavailable';
  end if;
  prepared_source := vortex_definition.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Prepared runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  select stored.* into strict stored_bundle
  from vortex_definition.installation_runtime_bundles as stored
  where stored.organization_id = selected_organization_id
    and stored.application_root_id = p_application_root_id
    and stored.application_release_revision = p_application_release_revision
    and stored.bundle_format_version = 2;
  if stored_bundle.pin_fingerprint is distinct from p_pin_fingerprint
    or stored_bundle.source_manifest is distinct from source_manifest then
    raise exception using errcode = '23505',
      message = 'Prepared runtime bundle identity differs';
  end if;

  if pg_catalog.jsonb_typeof(stored_bundle.parts) is distinct from 'array'
    or pg_catalog.jsonb_array_length(stored_bundle.parts) < pg_catalog.cardinality(expected_sections)
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle parts are incomplete';
  end if;
  select pg_catalog.count(*)::integer into metadata_count
  from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value);
  select pg_catalog.count(*)::integer into stored_part_count
  from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = 2;
  if metadata_count is distinct from stored_part_count then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle part count differs';
  end if;
  for metadata_item in
    select item.value from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(metadata_item) is distinct from 'object'
      or not metadata_item ?& array['section','ordinal','byteSize','sha256']
      or metadata_item - array['section','ordinal','byteSize','sha256'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(metadata_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(metadata_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(metadata_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(metadata_item -> 'sha256') is distinct from 'string'
      or not (metadata_item ->> 'section' = any (expected_sections))
      or (metadata_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(metadata_item ->> 'ordinal') > 10
      or (metadata_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(metadata_item ->> 'byteSize') > 7
      or (metadata_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle part metadata is invalid';
    end if;
    section_value := metadata_item ->> 'section';
    ordinal_value := (metadata_item ->> 'ordinal')::bigint;
    byte_size_value := (metadata_item ->> 'byteSize')::bigint;
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle part metadata exceeds its limit';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle total size exceeds its limit';
    end if;
    select part.* into strict part_item
    from vortex_definition.installation_runtime_bundle_parts as part
    where part.organization_id = selected_organization_id
      and part.application_root_id = p_application_root_id
      and part.application_release_revision = p_application_release_revision
      and part.bundle_format_version = 2
      and part.section = section_value
      and part.ordinal = ordinal_value::integer;
    if pg_catalog.octet_length(part_item.content_bytes) is distinct from byte_size_value
      or ('sha256:' || pg_catalog.encode(
        extensions.digest(part_item.content_bytes, 'sha256'), 'hex'
      )) is distinct from metadata_item ->> 'sha256' then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle bytes do not match their manifest';
    end if;
  end loop;
  if total_size_value is distinct from stored_bundle.total_size_bytes
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle metadata is incomplete';
  end if;

  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  select pg_catalog.string_agg(pg_catalog.convert_from(part.content_bytes, 'UTF8'), ''
    order by part.ordinal)
  into access_plan_text
  from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = 2
    and part.section = 'access_plan';
  begin
    access_plan_value := access_plan_text::jsonb;
  exception when others then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle access plan is invalid';
  end;
  if access_plan_value is distinct from expected_access_plan then
    raise exception using errcode = '23505',
      message = 'Prepared runtime bundle Record plan differs from current source';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'verified',
    'organizationId', selected_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'bundleFormatVersion', 2,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared runtime bundle is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle evidence is ambiguous';
end
$function$;
alter function vortex_definition.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text) owner to vortex_owner;


alter function vortex_definition.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  owner to vortex_owner;
revoke all on function vortex_definition.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  to vortex_request;
comment on function vortex_definition.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text) is
  'Re-derives first-install source and plan identity, then verifies the complete immutable format-2 bundle and its stored bytes before activation.';

create or replace function vortex_definition.read_installation_runtime_bundle_parts(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_sections jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  allowed_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  requested_sections text[];
  parts_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is null or p_bundle_format_version < 1
    or p_sections is null or pg_catalog.jsonb_typeof(p_sections) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_sections) not between 1 and
    pg_catalog.cardinality(allowed_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_sections) as requested(value)
      where pg_catalog.jsonb_typeof(requested.value) is distinct from 'string'
        or not ((requested.value #>> '{}') = any (allowed_sections))
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_sections) as requested(value)
      group by requested.value
      having pg_catalog.count(*) > 1
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle read command is invalid';
  end if;
  select pg_catalog.array_agg(requested.value #>> '{}' order by requested.ordinality)
  into requested_sections
  from pg_catalog.jsonb_array_elements(p_sections) with ordinality as requested(value, ordinality);

  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Installation runtime bundle organisation is unavailable';
  end if;

  if not exists (
    select 1 from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', part.section,
      'ordinal', part.ordinal,
      'byteSize', pg_catalog.octet_length(part.content_bytes),
      'sha256', 'sha256:' || pg_catalog.encode(
        extensions.digest(part.content_bytes, 'sha256'), 'hex'
      ),
      'content', pg_catalog.convert_from(part.content_bytes, 'UTF8')
    ) order by pg_catalog.array_position(requested_sections, part.section), part.ordinal
  ), '[]'::jsonb)
  into parts_value
  from vortex_definition.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = p_bundle_format_version
    and part.section = any (requested_sections);

  return parts_value;
end
$function$;

alter function vortex_definition.read_installation_runtime_bundle_parts(uuid,bigint,integer,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) to vortex_request;
comment on function vortex_definition.read_installation_runtime_bundle_parts(
  uuid, bigint, integer, jsonb
) is
  'Reads selected immutable runtime bundle parts by exact key inside the verified organisation context.';

create or replace function vortex_definition.write_installation_runtime_bundle(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_bundle_format_version integer,
  p_pin_fingerprint text,
  p_parts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  permission_decision record;
  delegation_decision record;
  checked_context jsonb;
  selected_organization_id uuid;
  part_item jsonb;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  content_text text;
  content_bytes bytea;
  sha256_value text;
  total_size_value bigint := 0;
  parts_manifest jsonb;
  inserted_rows bigint;
  stored_bundle vortex_definition.installation_runtime_bundles%rowtype;
  expected_module_bindings jsonb;
  prepared_source jsonb;
  source_manifest jsonb;
  section_payloads jsonb := '{}'::jsonb;
  section_text text;
  application_content jsonb;
  expected_modules jsonb;
  expected_access_plan jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_bundle_format_version is distinct from 2
    or p_pin_fingerprint is null or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_parts is null or pg_catalog.jsonb_typeof(p_parts) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_parts) < pg_catalog.cardinality(expected_sections) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle command is invalid';
  end if;

  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Module installation authority is unavailable';
  end if;

  select evaluated.* into strict delegation_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.applications.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  if delegation_decision.outcome is distinct from 'eligible'
    or delegation_decision.organization_id <> permission_decision.organization_id
    or delegation_decision.organization_account_id <> permission_decision.organization_account_id
    or delegation_decision.access_version <> permission_decision.access_version
    or delegation_decision.correlation_id <> permission_decision.correlation_id then
    raise exception using errcode = '42501',
      message = 'Module installation delegation is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Module installation context changed';
  end if;
  selected_organization_id := permission_decision.organization_id;

  if not exists (
    select 1
    from vortex_definition.roots as root
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = p_application_release_revision
    where root.root_id = p_application_root_id
      and root.organization_id = selected_organization_id
      and root.kind = 'application'
      and release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      )
      and release.compilation_output #>> '{kind}' = 'application'
      and release.compilation_output #>> '{canonical,envelope,rootId}' =
        p_application_root_id::text
      and release.compilation_output #>> '{validationContractVersion}' = any (
        vortex_definition.accepted_contract_version('application')
      )
  ) then
    raise exception using errcode = 'P0002',
      message = 'Installation Application release is unavailable';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId', binding.module_root_id,
      'moduleReleaseRevision', binding.module_release_revision,
      'bindingRevision', binding.binding_revision,
      'state', binding.state
    ) order by binding.module_root_id), '[]'::jsonb)
  into expected_module_bindings
  from vortex_definition.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = p_application_root_id
    and binding.state = 'provisioned';
  prepared_source := vortex_definition.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or (prepared_source ->> 'applicationRootId')::uuid is distinct from p_application_root_id
    or (prepared_source ->> 'applicationReleaseRevision')::bigint is distinct from p_application_release_revision
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Installation runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  for section_value in
    select required.section
    from pg_catalog.unnest(expected_sections) as required(section)
  loop
    select pg_catalog.string_agg(item.value ->> 'content', '' order by
      (item.value ->> 'ordinal')::integer)
    into section_text
    from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    where item.value ->> 'section' = section_value;
    if section_text is null then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is unavailable';
    end if;
    begin
      section_payloads := section_payloads || pg_catalog.jsonb_build_object(
        section_value, section_text::jsonb
      );
    exception when others then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is invalid';
    end;
  end loop;
  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  if application_content is null then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle Application content is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'identity', pg_catalog.jsonb_build_object(
        'kind', module.value -> 'kind',
        'organizationId', module.value -> 'organizationId',
        'rootId', module.value -> 'rootId',
        'definitionKey', module.value -> 'key',
        'releaseRevision', module.value -> 'releaseRevision',
        'releaseVersion', module.value -> 'releaseVersion',
        'validationContractVersion', module.value -> 'validationContractVersion',
        'contentFingerprint', module.value -> 'contentFingerprint',
        'resolutionFingerprint', module.value -> 'resolutionFingerprint',
        'dependencyManifest', module.value -> 'dependencyManifest'
      ),
      'content', module.value #> '{compilationOutput,canonical,content}'
    ) order by (module.value ->> 'rootId') collate "C"), '[]'::jsonb)
  into expected_modules
  from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value);
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  if section_payloads -> 'navigation' is distinct from application_content -> 'navigation'
    or section_payloads -> 'flows' is distinct from pg_catalog.jsonb_build_object(
      'flows', application_content -> 'flows',
      'flowBindings', application_content -> 'flowBindings'
    )
    or section_payloads -> 'theme' is distinct from application_content -> 'theme'
    or section_payloads -> 'component_registry' is distinct from application_content -> 'platformBlockDependencies'
    or section_payloads -> 'tool_bundle' is distinct from prepared_source #> '{application,compilationOutput,toolBundle}'
    or section_payloads -> 'access_plan' is distinct from expected_access_plan
    or section_payloads #> '{pages,application,identity}' is distinct from (
      pg_catalog.jsonb_build_object(
        'kind', prepared_source #> '{application,kind}',
        'organizationId', prepared_source #> '{application,organizationId}',
        'rootId', prepared_source #> '{application,rootId}',
        'definitionKey', prepared_source #> '{application,key}',
        'releaseRevision', prepared_source #> '{application,releaseRevision}',
        'releaseVersion', prepared_source #> '{application,releaseVersion}',
        'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
        'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
        'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}',
        'dependencyManifest', prepared_source #> '{application,dependencyManifest}',
        'platformCompatibilityVersion',
          prepared_source #> '{application,compilationOutput,platformCompatibilityVersion}'
      )
    )
    or section_payloads #> '{pages,application,content}' is distinct from
      application_content - array[
        'navigation', 'flows', 'flowBindings', 'theme',
        'platformBlockDependencies', 'shells', 'pages'
      ]::text[]
    or section_payloads #> '{pages,application,shells}' is distinct from application_content -> 'shells'
    or section_payloads #> '{pages,application,pages}' is distinct from application_content -> 'pages'
    or section_payloads #> '{pages,modules}' is distinct from expected_modules
    or pg_catalog.jsonb_typeof(section_payloads #> '{pages,resolvedCompositions}') is distinct from 'array'
    or pg_catalog.jsonb_array_length(section_payloads #> '{pages,resolvedCompositions}') <>
      pg_catalog.jsonb_array_length(application_content -> 'pages') then
    raise exception using errcode = '23514',
      message = 'Installation runtime bundle sections do not match current immutable source';
  end if;
  for part_item in
    select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(part_item) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    if not (part_item ?& array['section', 'ordinal', 'byteSize', 'sha256', 'content'])
      or part_item - array['section', 'ordinal', 'byteSize', 'sha256', 'content'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(part_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'sha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'content') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;

    section_value := part_item ->> 'section';
    if not (section_value = any (expected_sections))
      or (part_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(part_item ->> 'ordinal') > 10
      or (part_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(part_item ->> 'byteSize') > 7 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    ordinal_value := (part_item ->> 'ordinal')::bigint;
    byte_size_value := (part_item ->> 'byteSize')::bigint;
    content_text := part_item ->> 'content';
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part exceeds its limit';
    end if;

    content_bytes := pg_catalog.convert_to(content_text, 'UTF8');
    if pg_catalog.octet_length(content_bytes) <> byte_size_value then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part size is invalid';
    end if;
    sha256_value := 'sha256:' || pg_catalog.encode(
      extensions.digest(content_bytes, 'sha256'), 'hex'
    );
    if (part_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$'
      or sha256_value <> (part_item ->> 'sha256') then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part fingerprint is invalid';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle is too large';
    end if;
  end loop;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle sections are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', item.value ->> 'section',
      'ordinal', (item.value ->> 'ordinal')::integer,
      'byteSize', (item.value ->> 'byteSize')::bigint,
      'sha256', item.value ->> 'sha256'
    ) order by pg_catalog.array_position(
      expected_sections, item.value ->> 'section'
    ), (item.value ->> 'ordinal')::integer
  )
  into parts_manifest
  from pg_catalog.jsonb_array_elements(p_parts) as item(value);

  insert into vortex_definition.installation_runtime_bundles (
    organization_id, application_root_id, application_release_revision,
    bundle_format_version, pin_fingerprint, source_manifest, parts, total_size_bytes
  ) values (
    selected_organization_id, p_application_root_id, p_application_release_revision,
    p_bundle_format_version, p_pin_fingerprint, source_manifest, parts_manifest, total_size_value
  ) on conflict (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ) do nothing;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    select stored.* into stored_bundle
    from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation runtime bundle changed concurrently';
    end if;
    if stored_bundle.pin_fingerprint <> p_pin_fingerprint
      or stored_bundle.source_manifest is distinct from source_manifest
      or stored_bundle.parts is distinct from parts_manifest
      or stored_bundle.total_size_bytes is distinct from total_size_value
      or (select pg_catalog.count(*) from vortex_definition.installation_runtime_bundle_parts as part
        where part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version)
        <> pg_catalog.jsonb_array_length(p_parts)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        left join vortex_definition.installation_runtime_bundle_parts as part
          on part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version
          and part.section = item.value ->> 'section'
          and part.ordinal = (item.value ->> 'ordinal')::integer
        where part.content_bytes is distinct from pg_catalog.convert_to(item.value ->> 'content', 'UTF8')
      ) then
      raise exception using errcode = '23505',
        message = 'Installation runtime bundle pin fingerprint differs';
    end if;
  else
    for part_item in
      select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    loop
      insert into vortex_definition.installation_runtime_bundle_parts (
        organization_id, application_root_id, application_release_revision,
        bundle_format_version, section, ordinal, content_bytes
      ) values (
        selected_organization_id, p_application_root_id, p_application_release_revision,
        p_bundle_format_version, part_item ->> 'section',
        (part_item ->> 'ordinal')::integer,
        pg_catalog.convert_to(part_item ->> 'content', 'UTF8')
      );
    end loop;

    select stored.* into strict stored_bundle
    from vortex_definition.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle evidence is ambiguous';
end
$function$;

alter function vortex_definition.write_installation_runtime_bundle(uuid,bigint,integer,text,jsonb) owner to vortex_owner;

revoke all on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) to vortex_request;
comment on function vortex_definition.write_installation_runtime_bundle(
  uuid, bigint, integer, text, jsonb
) is
  'Atomically stores one immutable runtime bundle for an authorised exact Application release and pin fingerprint.';



reset role;
