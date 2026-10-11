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