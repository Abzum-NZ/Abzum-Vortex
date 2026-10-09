begin;

set local role vortex_module_owner;

create or replace function vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare
  checked_context jsonb;
  selected_org uuid;
  selected_app uuid;
  selected_revision bigint;
  active_count integer;
  registered_app record;
  registered_identity jsonb;
  bindings jsonb;
  pin_facts jsonb;
  pin_hash text;
  identity_value jsonb;
  before_identity jsonb;
  item jsonb;
  installation jsonb;
  application_evidence jsonb;
  module_evidence jsonb;
  release_identity jsonb;
begin
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',binding.content_fingerprint,
      'resolutionFingerprint',binding.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  if p_expected_identity is distinct from identity_value then
    raise exception using errcode='40001', message='Active Application identity changed';
  end if;
  before_identity:=identity_value;
  for item in select pin.value from pg_catalog.jsonb_array_elements(bindings) as pin(value)
    order by (pin.value ->> 'moduleRootId')::uuid
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vortex_module.binding:' || selected_org::text || ':' || selected_app::text || ':' ||
        (item ->> 'moduleRootId'),0));
    perform 1 from vortex_module.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.module_root_id=(item ->> 'moduleRootId')::uuid for update;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',binding.content_fingerprint,
      'resolutionFingerprint',binding.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
    if identity_value is distinct from before_identity then
      raise exception using errcode='40001', message='Active Application identity changed while waiting';
    end if;
  end loop;
  installation:=vortex_module.read_active_installation_for_scope_internal(selected_org,selected_app);
  if (installation ->> 'applicationReleaseRevision')::bigint is distinct from selected_revision
    or exists(select 1 from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as current(value)
      where not exists(select 1 from pg_catalog.jsonb_array_elements(bindings) as expected(value)
        where current.value -> 'moduleRootId'=expected.value -> 'moduleRootId'
          and current.value -> 'moduleReleaseRevision'=expected.value -> 'moduleReleaseRevision'
          and current.value -> 'bindingRevision'=expected.value -> 'bindingRevision'
          and current.value ->> 'state'='active'))
    or pg_catalog.jsonb_array_length(installation -> 'moduleBindings')<>active_count then
    raise exception using errcode='40001', message='Active Application pin closure changed';
  end if;
  application_evidence:=vortex_definition.project_consumer_release_evidence('application',selected_app,selected_revision);
  release_identity:=pg_catalog.jsonb_build_object(
    'rootId',application_evidence -> 'rootId','definitionKey',application_evidence -> 'key',
    'releaseRevision',application_evidence -> 'releaseRevision','releaseVersion',application_evidence -> 'releaseVersion',
    'validationContractVersion',application_evidence -> 'validationContractVersion',
    'contentFingerprint',application_evidence -> 'contentFingerprint',
    'resolutionFingerprint',application_evidence -> 'resolutionFingerprint');
  if application_evidence ->> 'kind' is distinct from 'application'
    or (application_evidence ->> 'organizationId')::uuid is distinct from selected_org
    or release_identity is distinct from registered_identity then
    raise exception using errcode='23514', message='Active Application publication differs';
  end if;
  select pg_catalog.jsonb_agg(vortex_definition.project_consumer_release_evidence(
    'module',(pin.value ->> 'moduleRootId')::uuid,(pin.value ->> 'moduleReleaseRevision')::bigint)
    order by (pin.value ->> 'moduleRootId')::uuid)
  into module_evidence from pg_catalog.jsonb_array_elements(bindings) as pin(value);
  if pg_catalog.jsonb_array_length(module_evidence)<>active_count or exists(
    select 1 from pg_catalog.jsonb_array_elements(module_evidence) as module(value)
    where module.value ->> 'kind' is distinct from 'module'
      or (module.value ->> 'organizationId')::uuid is distinct from selected_org
      or not exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
        where pin.value -> 'moduleRootId'=module.value -> 'rootId'
          and pin.value -> 'moduleReleaseRevision'=module.value -> 'releaseRevision'
          and pin.value -> 'contentFingerprint'=module.value -> 'contentFingerprint'
          and pin.value -> 'resolutionFingerprint'=module.value -> 'resolutionFingerprint')) then
    raise exception using errcode='23514', message='Active Module publication differs';
  end if;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',binding.content_fingerprint,
      'resolutionFingerprint',binding.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  if identity_value is distinct from before_identity then
    raise exception using errcode='40001', message='Active Application mapping changed';
  end if;
  return pg_catalog.jsonb_build_object('identity',identity_value,'installation',installation,
    'application',application_evidence,'modules',module_evidence);
exception when no_data_found or too_many_rows then
  raise exception using errcode='P0002', message='Active Application mapping is unavailable';
end
$function$;
alter function vortex_module.lock_active_installation_runtime_mapping_internal(jsonb) owner to vortex_module_owner;
revoke all on function vortex_module.lock_active_installation_runtime_mapping_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner;
grant execute on function vortex_module.lock_active_installation_runtime_mapping_internal(jsonb) to vortex_module_owner, vortex_record_adapter;
comment on function vortex_module.lock_active_installation_runtime_mapping_internal(jsonb) is 'Locks and proves exact active publication mapping under the current HUMAN request; expected identity is only a guard.';

reset role;

set local role vortex_record_owner;

grant create on schema vortex_record to vortex_record_adapter;

reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.resolve_active_bundle_record_access_plan_internal(p_expected_identity jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare

  plan_key_value text;
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  release_storage_contract_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  plan jsonb;
  p_installation jsonb;
  active_mapping jsonb;
  final_mapping jsonb;
  storage_item record;
  stable_plan jsonb;
  stored_plan_row vortex_record.installation_access_plans%rowtype;
  inserted_rows bigint;
  mapping_fingerprint_value text;
  pin_fingerprint_value text;
begin
  active_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  p_installation:=active_mapping -> 'installation';
  organization_id_value:=(p_installation ->> 'organizationId')::uuid;
  application_root_id_value:=(p_installation ->> 'applicationRootId')::uuid;
  application_release_revision_value:=(p_installation ->> 'applicationReleaseRevision')::bigint;
  -- This fixed active-only composer exposes no preview or binding-state override.
  pin_fingerprint_value:=active_mapping #>> '{identity,pinFingerprint}';
  -- Reuse the storage mutators' existing advisory key, without requesting
  -- row-lock UPDATE authority on SELECT-only storage catalogue tables.
  for storage_item in
    select distinct (record_type.value ->> 'storageContractId')::uuid as storage_id
    from pg_catalog.jsonb_array_elements(active_mapping -> 'modules') as module(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      module.value #> '{compilationOutput,canonical,content,recordTypes}') as record_type(value)
    order by storage_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vortex_record.storage:' || storage_item.storage_id::text,0));
    final_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
    if final_mapping is distinct from active_mapping then
      raise exception using errcode='40001', message='Active Record mapping changed while waiting';
    end if;
  end loop;
  -- Step 1: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    -- Canonical binding order, so the plan content never depends on the order
    -- a caller happened to supply and always matches the plan key's order.
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      release_storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;
      storage_contract_value := release_storage_contract_value;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        -- A system projection is read only through the protected reader
        -- registered for exactly the key its installed definition declares (the
        -- catalogue key references the closed registry); a generated record
        -- type is never read through a projection, and a disagreeing key
        -- refuses.
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}'))
        or not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and release_storage_contract_value = any (provision.storage_contract_ids)
        ) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(%I))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  select release.compilation_output #> '{canonical,content}'
  into strict release_content from vortex_definition.releases as release
  where release.root_id=application_root_id_value
    and release.release_revision=application_release_revision_value;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', application_root_id_value,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  plan := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'applicationReleaseRevision', application_release_revision_value,
    'recordTypes', type_meta,
    'relationships', relationship_by_id,
    'sharingConditions', condition_list,
    'permissions', permission_by_id
  );


  mapping_fingerprint_value:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'recordTypes',plan -> 'recordTypes','relationships',plan -> 'relationships',
      'sharingConditions',plan -> 'sharingConditions','permissions',plan -> 'permissions')::text,'UTF8')),'hex');
  plan_key_value:='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    'vortex.installation-runtime-bundle.prepared-record-access-plan.v2|' ||
      organization_id_value::text || '|' || application_root_id_value::text || '|' ||
      application_release_revision_value::text || '|2|' || pin_fingerprint_value,'UTF8')),'hex');
  stable_plan:=pg_catalog.jsonb_build_object('planKey',plan_key_value,
    'mappingFingerprint',mapping_fingerprint_value,'plan',plan);
  insert into vortex_record.installation_access_plans(
    plan_key,organization_id,application_root_id,application_release_revision,plan)
  values(plan_key_value,organization_id_value,application_root_id_value,
    application_release_revision_value,stable_plan)
  on conflict(plan_key) do nothing;
  get diagnostics inserted_rows=row_count;
  if inserted_rows=0 then
    select stored.* into strict stored_plan_row
    from vortex_record.installation_access_plans as stored where stored.plan_key=plan_key_value for update;
    if stored_plan_row.organization_id is distinct from organization_id_value
      or stored_plan_row.application_root_id is distinct from application_root_id_value
      or stored_plan_row.application_release_revision is distinct from application_release_revision_value
      or stored_plan_row.plan is distinct from stable_plan then
      raise exception using errcode='23505', message='Active Record plan immutable identity differs';
    end if;
  end if;
  final_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  if final_mapping is distinct from active_mapping then
    raise exception using errcode='40001', message='Active Record mapping changed';
  end if;
  return stable_plan;
exception when no_data_found or too_many_rows then
  raise exception using errcode='55000', message='Active Record plan evidence is unavailable';
end
$function$;
alter function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner;
grant execute on function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb) to vortex_record_adapter, vortex_module_owner;
comment on function vortex_record.resolve_active_bundle_record_access_plan_internal(jsonb) is 'Derives the full active declared Record plan under current binding and storage locks, using the same immutable format2 plan identity as first preparation.';

reset role;

set local role vortex_record_owner;

revoke create on schema vortex_record from vortex_record_adapter;

reset role;

set local role vortex_module_owner;

create or replace function vortex_module.resolve_addressed_active_application_identity(p_application_key text)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare
  checked_context jsonb;
  final_context jsonb;
  selected_root uuid;
  installation jsonb;
  registered_app record;
begin
  if p_application_key is null or pg_catalog.length(p_application_key) not between 3 and 120
    or p_application_key !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$' or exists(select 1 from pg_catalog.unnest(pg_catalog.string_to_array(p_application_key,'.')) as segment(value) where pg_catalog.length(segment.value)>40) then
    raise exception using errcode='22023', message='Application address is invalid';
  end if;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Application address is unavailable';
  end if;
  select root.root_id into strict selected_root from vortex_definition.roots as root
  where root.organization_id=(checked_context ->> 'organizationId')::uuid
    and root.kind='application' and root.key=p_application_key;
  installation:=vortex_module.read_active_installation_for_scope_internal(
    (checked_context ->> 'organizationId')::uuid,selected_root);
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(
    (checked_context ->> 'organizationId')::uuid,selected_root) as snapshot;
  if registered_app.release_revision is distinct from (installation ->> 'applicationReleaseRevision')::bigint
    or registered_app.definition_key is distinct from p_application_key
    or exists(select 1 from vortex_module.installation_bindings as binding
      where binding.organization_id=(checked_context ->> 'organizationId')::uuid
        and binding.application_root_id=selected_root and binding.state not in ('active','detached')) then
    raise exception using errcode='40001', message='Application address changed';
  end if;
  final_context:=vortex_access.validated_human_request_context();
  if final_context is distinct from checked_context
    or pg_catalog.clock_timestamp()>=(final_context ->> 'expiresAt')::timestamptz
    or (final_context ? 'delegatedContext' and pg_catalog.clock_timestamp()>=(final_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (final_context ? 'supportContext' and pg_catalog.clock_timestamp()>=(final_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='40001', message='Application address context changed';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId',checked_context -> 'organizationId','applicationRootId',selected_root,
    'definitionKey',p_application_key,'applicationReleaseRevision',installation -> 'applicationReleaseRevision');
exception when no_data_found or too_many_rows then
  raise exception using errcode='P0002', message='Application address is unavailable';
end
$function$;
alter function vortex_module.resolve_addressed_active_application_identity(text) owner to vortex_module_owner;
revoke all on function vortex_module.resolve_addressed_active_application_identity(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner;
grant execute on function vortex_module.resolve_addressed_active_application_identity(text) to vortex_module_owner, vortex_request;
comment on function vortex_module.resolve_addressed_active_application_identity(text) is 'Returns one exact active Application address under the current HUMAN organization request, without a Page grant.';

create or replace function vortex_module.read_active_installation_bundle_identity()
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare
  checked_context jsonb;
  selected_org uuid;
  selected_app uuid;
  selected_revision bigint;
  active_count integer;
  registered_app record;
  registered_identity jsonb;
  bindings jsonb;
  pin_facts jsonb;
  pin_hash text;
  identity_value jsonb;
  before_identity jsonb;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
  bundle_index jsonb;
  current_manifest jsonb;
  manifest_pins jsonb;
  mapping jsonb;
  stable_plan jsonb;
  active_source jsonb;
  source_manifest jsonb;
begin
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',binding.content_fingerprint,
      'resolutionFingerprint',binding.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  before_identity:=identity_value;
  select stored.* into stored_bundle from vortex_module.installation_runtime_bundles as stored
  where stored.organization_id=selected_org and stored.application_root_id=selected_app
    and stored.application_release_revision=selected_revision and stored.bundle_format_version=2;
  if found then
    current_manifest:=stored_bundle.source_manifest;
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',module.value -> 'rootId','moduleReleaseRevision',module.value -> 'releaseRevision',
      'contentFingerprint',module.value -> 'contentFingerprint',
      'resolutionFingerprint',module.value -> 'resolutionFingerprint')
      order by (module.value ->> 'rootId')::uuid)
    into manifest_pins from pg_catalog.jsonb_array_elements(current_manifest -> 'modules') as module(value);
    if current_manifest ->> 'bundleFormatVersion' is distinct from '2'
      or current_manifest -> 'application' is distinct from registered_identity
      or current_manifest ->> 'pinFingerprint' is distinct from pin_hash
      or stored_bundle.pin_fingerprint is distinct from pin_hash
      or manifest_pins is distinct from pin_facts
      or pg_catalog.jsonb_typeof(current_manifest -> 'preparedRecordAccessPlan') is distinct from 'object'
      or current_manifest #>> '{preparedRecordAccessPlan,planKey}' is distinct from (
        'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          'vortex.installation-runtime-bundle.prepared-record-access-plan.v2|' ||
            selected_org::text || '|' || selected_app::text || '|' ||
            selected_revision::text || '|2|' || pin_hash,'UTF8')),'hex'))
      or current_manifest #>> '{preparedRecordAccessPlan,mappingFingerprint}' is null
      or (current_manifest #>> '{preparedRecordAccessPlan,planKey}') !~ '^sha256:[a-f0-9]{64}$'
      or (current_manifest #>> '{preparedRecordAccessPlan,mappingFingerprint}') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode='23514', message='Active runtime bundle manifest differs';
    end if;
    bundle_index:=vortex_module.read_installation_runtime_bundle_index(selected_app,selected_revision,2);
  else
    -- Missing format2 takes a genuine locked active-only cold source path.
    -- The mapping locker derives identity inline and cannot recurse into this reader.
    mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(before_identity);
    stable_plan:=vortex_record.resolve_active_bundle_record_access_plan_internal(before_identity);
    active_source:=pg_catalog.jsonb_build_object(
      'organizationId',mapping #> '{identity,organizationId}',
      'applicationRootId',mapping #> '{identity,applicationRootId}',
      'applicationReleaseRevision',mapping #> '{identity,applicationReleaseRevision}',
      'accessVersion',mapping #> '{identity,accessVersion}',
      'correlationId',mapping #> '{identity,correlationId}',
      'pinFingerprint',mapping #> '{identity,pinFingerprint}',
      'mappingFingerprint',stable_plan -> 'mappingFingerprint',
      'moduleBindings',mapping #> '{identity,moduleBindings}',
      'application',mapping -> 'application','modules',mapping -> 'modules',
      'preparedRecordAccessPlan',stable_plan);
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', active_source #> '{application,rootId}',
      'definitionKey', active_source #> '{application,key}',
      'releaseRevision', active_source #> '{application,releaseRevision}',
      'releaseVersion', active_source #> '{application,releaseVersion}',
      'validationContractVersion', active_source #> '{application,validationContractVersion}',
      'contentFingerprint', active_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', active_source #> '{application,resolutionFingerprint}'
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
      from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', active_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', active_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', active_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );

    active_source:=active_source || pg_catalog.jsonb_build_object('sourceManifest',source_manifest);
  end if;
  checked_context:=vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or not checked_context ? 'applicationRootId'
    or pg_catalog.clock_timestamp()>=(checked_context ->> 'expiresAt')::timestamptz
    or (checked_context ? 'delegatedContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{delegatedContext,expiresAt}')::timestamptz)
    or (checked_context ? 'supportContext' and
      pg_catalog.clock_timestamp()>=(checked_context #>> '{supportContext,expiresAt}')::timestamptz) then
    raise exception using errcode='42501', message='Active Application context is unavailable';
  end if;
  selected_org:=(checked_context ->> 'organizationId')::uuid;
  selected_app:=(checked_context ->> 'applicationRootId')::uuid;
  select pg_catalog.min(binding.application_release_revision),pg_catalog.count(*)::integer
  into selected_revision,active_count from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if active_count not between 1 and 10000 or selected_revision is null or exists(
    select 1 from vortex_module.installation_bindings as binding
    where binding.organization_id=selected_org and binding.application_root_id=selected_app
      and binding.state<>'detached'
      and (binding.state<>'active' or binding.application_release_revision<>selected_revision)) then
    raise exception using errcode='P0002', message='Active Application installation is unavailable';
  end if;
  select snapshot.* into strict registered_app
  from vortex_access.read_application_permission_snapshot(selected_org,selected_app) as snapshot;
  if registered_app.release_revision is distinct from selected_revision then
    raise exception using errcode='40001', message='Active Application registration changed';
  end if;
  registered_identity:=pg_catalog.jsonb_build_object(
    'rootId',selected_app,'definitionKey',registered_app.definition_key,
    'releaseRevision',selected_revision,'releaseVersion',registered_app.release_version,
    'validationContractVersion',registered_app.validation_contract_version,
    'contentFingerprint',registered_app.content_fingerprint,
    'resolutionFingerprint',registered_app.resolution_fingerprint);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'bindingRevision',binding.binding_revision,'state',binding.state) order by binding.module_root_id),
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'moduleRootId',binding.module_root_id,'moduleReleaseRevision',binding.module_release_revision,
      'contentFingerprint',binding.content_fingerprint,
      'resolutionFingerprint',binding.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  where binding.organization_id=selected_org and binding.application_root_id=selected_app
    and binding.state='active';
  if exists(select 1 from pg_catalog.jsonb_array_elements(pin_facts) as pin(value)
    where (pin.value ->> 'contentFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or (pin.value ->> 'resolutionFingerprint') !~ '^sha256:[a-f0-9]{64}$'
      or pin.value ->> 'contentFingerprint' is null
      or pin.value ->> 'resolutionFingerprint' is null) then
    raise exception using errcode='55000', message='Active Application pins are unavailable';
  end if;
  pin_hash:='sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pin_facts::text,'UTF8')),'hex');
  identity_value:=pg_catalog.jsonb_build_object(
    'tenantId',checked_context -> 'tenantId','organizationId',selected_org,
    'organizationAccountId',checked_context -> 'organizationAccountId',
    'identityId',checked_context -> 'identityId','sessionId',checked_context -> 'sessionId',
    'accessVersion',checked_context -> 'accessVersion','correlationId',checked_context -> 'correlationId',
    'applicationRootId',selected_app,'applicationReleaseRevision',selected_revision,
    'registeredApplication',registered_identity,'moduleBindings',bindings,
    'pinFacts',pin_facts,'pinFingerprint',pin_hash);
  if identity_value is distinct from before_identity then
    raise exception using errcode='40001', message='Active runtime bundle identity changed';
  end if;
  return pg_catalog.jsonb_build_object('identity',identity_value,
    'bundleIndex',bundle_index,'repairNeeded',bundle_index is null,'coldSource',active_source);
exception when no_data_found or too_many_rows then
  raise exception using errcode='P0002', message='Active runtime bundle identity is unavailable';
end
$function$;
alter function vortex_module.read_active_installation_bundle_identity() owner to vortex_module_owner;
revoke all on function vortex_module.read_active_installation_bundle_identity()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner;
grant execute on function vortex_module.read_active_installation_bundle_identity() to vortex_module_owner, vortex_request;
comment on function vortex_module.read_active_installation_bundle_identity() is 'Returns fresh active format2 identity and index, or a private exact locked active cold source for the same HUMAN request; carries no viewer permission decision.';

create or replace function vortex_module.repair_active_installation_runtime_bundle_internal(
  p_expected_identity jsonb,
  p_parts jsonb
)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare

  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
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
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
  source_manifest jsonb;
  section_payloads jsonb := '{}'::jsonb;
  section_text text;
  application_content jsonb;
  expected_modules jsonb;
  expected_trigger_index jsonb;
  expected_access_plan jsonb;
  p_application_root_id uuid;
  p_application_release_revision bigint;
  p_bundle_format_version integer:=2;
  p_pin_fingerprint text;
  active_source jsonb;
  mapping jsonb;
  final_mapping jsonb;
  stable_plan jsonb;
begin
  if pg_catalog.jsonb_typeof(p_expected_identity) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parts) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_parts)<pg_catalog.cardinality(expected_sections) then
    raise exception using errcode='22023', message='Active runtime repair command is invalid';
  end if;
  -- This current HUMAN viewer path deliberately has no installation/manage
  -- decision, delegated installer scope or provisioned-binding authority.
  mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  stable_plan:=vortex_record.resolve_active_bundle_record_access_plan_internal(p_expected_identity);
  p_application_root_id:=(mapping #>> '{identity,applicationRootId}')::uuid;
  p_application_release_revision:=(mapping #>> '{identity,applicationReleaseRevision}')::bigint;
  p_pin_fingerprint:=mapping #>> '{identity,pinFingerprint}';
  selected_organization_id:=(mapping #>> '{identity,organizationId}')::uuid;
  active_source:=pg_catalog.jsonb_build_object(
    'organizationId',mapping #> '{identity,organizationId}',
    'applicationRootId',mapping #> '{identity,applicationRootId}',
    'applicationReleaseRevision',mapping #> '{identity,applicationReleaseRevision}',
    'pinFingerprint',mapping #> '{identity,pinFingerprint}',
    'application',mapping -> 'application','modules',mapping -> 'modules',
    'preparedRecordAccessPlan',stable_plan);
  -- Exclusive bundle lock follows already-held binding and storage locks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_module.runtime_bundle:' || selected_organization_id::text || ':' ||
      p_application_root_id::text || ':' || p_application_release_revision::text || ':2',0));
  final_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  if final_mapping is distinct from mapping then
    raise exception using errcode='40001', message='Active runtime repair changed while waiting';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', active_source #> '{application,rootId}',
      'definitionKey', active_source #> '{application,key}',
      'releaseRevision', active_source #> '{application,releaseRevision}',
      'releaseVersion', active_source #> '{application,releaseVersion}',
      'validationContractVersion', active_source #> '{application,validationContractVersion}',
      'contentFingerprint', active_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', active_source #> '{application,resolutionFingerprint}'
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
      from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', active_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', active_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', active_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
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
  application_content := active_source #> '{application,compilationOutput,canonical,content}';
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
  from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'flowId', flow.value -> 'id', 'trigger', trigger.value
    ) order by (flow.value ->> 'id') collate "C", (trigger.value ->> 'id') collate "C"), '[]'::jsonb)
  into expected_trigger_index
  from pg_catalog.jsonb_array_elements(application_content -> 'flows') as flow(value)
  cross join lateral pg_catalog.jsonb_array_elements(flow.value -> 'triggers') as trigger(value);
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', active_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  if section_payloads -> 'navigation' is distinct from application_content -> 'navigation'
    or section_payloads -> 'flows' is distinct from pg_catalog.jsonb_build_object(
      'flows', application_content -> 'flows',
      'flowBindings', application_content -> 'flowBindings'
    )
    or section_payloads -> 'trigger_index' is distinct from expected_trigger_index
    or section_payloads -> 'theme' is distinct from application_content -> 'theme'
    or section_payloads -> 'component_registry' is distinct from application_content -> 'platformBlockDependencies'
    or section_payloads -> 'tool_bundle' is distinct from active_source #> '{application,compilationOutput,toolBundle}'
    or section_payloads -> 'access_plan' is distinct from expected_access_plan
    or section_payloads #> '{pages,application,identity}' is distinct from (
      pg_catalog.jsonb_build_object(
        'kind', active_source #> '{application,kind}',
        'organizationId', active_source #> '{application,organizationId}',
        'rootId', active_source #> '{application,rootId}',
        'definitionKey', active_source #> '{application,key}',
        'releaseRevision', active_source #> '{application,releaseRevision}',
        'releaseVersion', active_source #> '{application,releaseVersion}',
        'validationContractVersion', active_source #> '{application,validationContractVersion}',
        'contentFingerprint', active_source #> '{application,contentFingerprint}',
        'resolutionFingerprint', active_source #> '{application,resolutionFingerprint}',
        'dependencyManifest', active_source #> '{application,dependencyManifest}'
      )
      || case
        when active_source #> '{application,compilationOutput,platformCompatibilityVersion}' is null
          then '{}'::jsonb
        else pg_catalog.jsonb_build_object(
          'platformCompatibilityVersion',
          active_source #> '{application,compilationOutput,platformCompatibilityVersion}'
        )
      end
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

  insert into vortex_module.installation_runtime_bundles (
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
    from vortex_module.installation_runtime_bundles as stored
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
      or (select pg_catalog.count(*) from vortex_module.installation_runtime_bundle_parts as part
        where part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version)
        <> pg_catalog.jsonb_array_length(p_parts)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        left join vortex_module.installation_runtime_bundle_parts as part
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
      insert into vortex_module.installation_runtime_bundle_parts (
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
    from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
  end if;

  final_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  if final_mapping is distinct from mapping then
    raise exception using errcode='40001', message='Active runtime repair identity changed';
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


alter function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb) owner to vortex_module_owner;
revoke all on function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner;
grant execute on function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb) to vortex_module_owner, vortex_request;
comment on function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb) is 'Atomically repairs only the current active immutable format2 bundle under a current HUMAN viewer transaction, with complete source and byte replay equality and no installation authority.';

reset role;

commit;