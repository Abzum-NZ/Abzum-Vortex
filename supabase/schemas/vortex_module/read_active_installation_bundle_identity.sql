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