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
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
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
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
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
      'contentFingerprint',module_release.content_fingerprint,
      'resolutionFingerprint',module_release.resolution_fingerprint) order by binding.module_root_id)
  into bindings,pin_facts from vortex_module.installation_bindings as binding
  join vortex_definition.releases as module_release
    on module_release.root_id=binding.module_root_id
    and module_release.release_revision=binding.module_release_revision
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

create or replace function vortex_module.read_active_shared_record_consumers_internal(
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_access_version bigint;
  candidate_application_root_id uuid;
  application_installation jsonb;
  application_root vortex_definition.roots%rowtype;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  module_binding_fact jsonb;
  module_binding vortex_module.installation_bindings%rowtype;
  module_root vortex_definition.roots%rowtype;
  module_release vortex_definition.releases%rowtype;
  storage_provision record;
  module_bindings jsonb;
  targets jsonb := '[]'::jsonb;
  target jsonb;
  target_record_types jsonb;
  target_record_type_count integer;
  own_module_binding_count integer;
  binding_count integer;
begin
  if p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Shared record consumer selection is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(context_value) is distinct from 'object'
    or not (context_value ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'accessVersion', 'correlationId'
    ])
    or context_value ->> 'callerKind' is distinct from 'human'
    or not vortex_context.is_non_nil_uuid(context_value ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(context_value ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(context_value ->> 'organizationAccountId')
    or not vortex_context.is_non_nil_uuid(context_value ->> 'applicationRootId')
    or not vortex_context.is_non_nil_uuid(context_value ->> 'correlationId')
    or not pg_catalog.pg_input_is_valid(context_value ->> 'accessVersion', 'bigint')
    or (context_value ->> 'accessVersion')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Shared record consumer request context is unavailable';
  end if;
  selected_organization_id := (context_value ->> 'organizationId')::uuid;
  selected_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  selected_access_version := (context_value ->> 'accessVersion')::bigint;

  <<application_loop>>
  for candidate_application_root_id in
    select distinct binding.application_root_id
    from vortex_module.installation_bindings as binding
    where binding.organization_id = selected_organization_id
      and binding.module_root_id = p_module_root_id
      and binding.state = 'active'
    order by binding.application_root_id
  loop
    select snapshot.* into permission_snapshot
    from vortex_access.read_application_permission_snapshot(
      selected_organization_id, candidate_application_root_id
    ) as snapshot;
    if not found then
      continue application_loop;
    end if;

    select root.* into application_root
    from vortex_definition.roots as root
    where root.root_id = candidate_application_root_id;
    if not found
      or application_root.kind is distinct from 'application'
      or application_root.organization_id is distinct from selected_organization_id
      or application_root.key is null or application_root.key = '' then
      continue application_loop;
    end if;

    if not pg_catalog.pg_input_is_valid(permission_snapshot.release_revision::text, 'bigint')
      or permission_snapshot.release_revision not between 1 and 9007199254740991 then
      continue application_loop;
    end if;
    select release.* into application_release
    from vortex_definition.releases as release
    where release.root_id = candidate_application_root_id
      and release.release_revision = permission_snapshot.release_revision;
    if not found
      or application_release.validation_contract_version is null
      or not (application_release.validation_contract_version = any (
        vortex_definition.accepted_contract_version('application')
      ))
      or application_release.release_version is null
      or application_release.release_version = ''
      or application_release.content_fingerprint is null
      or application_release.content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or application_release.resolution_fingerprint is null
      or application_release.resolution_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      or pg_catalog.jsonb_typeof(application_release.compilation_output) is distinct from 'object'
      or application_release.compilation_output ->> 'kind' is distinct from 'application'
      or application_release.compilation_output ->> 'validationContractVersion'
        is distinct from application_release.validation_contract_version
      or application_release.compilation_output #>> '{canonical,envelope,rootId}'
        is distinct from candidate_application_root_id::text
      or application_release.compilation_output #>> '{canonical,envelope,kind}'
        is distinct from 'application'
      or application_release.compilation_output #>> '{canonical,envelope,validationContractVersion}'
        is distinct from application_release.validation_contract_version then
      continue application_loop;
    end if;

    if permission_snapshot.organization_id is distinct from selected_organization_id
      or permission_snapshot.application_root_id is distinct from candidate_application_root_id
      or permission_snapshot.registration_revision is null
      or permission_snapshot.registration_revision not between 1 and 9007199254740991
      or permission_snapshot.release_revision is distinct from application_release.release_revision
      or permission_snapshot.definition_key is distinct from application_root.key
      or permission_snapshot.release_version is distinct from application_release.release_version
      or permission_snapshot.validation_contract_version
        is distinct from application_release.validation_contract_version
      or permission_snapshot.content_fingerprint is distinct from application_release.content_fingerprint
      or permission_snapshot.resolution_fingerprint is distinct from application_release.resolution_fingerprint
      or permission_snapshot.catalogue_fingerprint is null
      or permission_snapshot.catalogue_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
      continue application_loop;
    end if;

    begin
      application_installation := vortex_module.read_active_installation_for_scope_internal(
        selected_organization_id, candidate_application_root_id
      );
    exception
      when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
        continue application_loop;
    end;

    if pg_catalog.jsonb_typeof(application_installation) is distinct from 'object'
      or not (application_installation ?& array[
        'organizationId', 'applicationRootId', 'applicationReleaseRevision', 'moduleBindings'
      ])
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(application_installation)) <> 4
      or application_installation ->> 'organizationId' is distinct from selected_organization_id::text
      or application_installation ->> 'applicationRootId' is distinct from candidate_application_root_id::text
      or application_installation ->> 'applicationReleaseRevision'
        is distinct from application_release.release_revision::text
      or pg_catalog.jsonb_typeof(application_installation -> 'moduleBindings') is distinct from 'array'
      or pg_catalog.jsonb_array_length(application_installation -> 'moduleBindings') = 0 then
      raise exception using errcode = '55000',
        message = 'Active shared record consumer evidence is malformed';
    end if;

    select pg_catalog.count(*)::integer into binding_count
    from pg_catalog.jsonb_array_elements(application_installation -> 'moduleBindings') as item(value);
    module_bindings := '[]'::jsonb;
    own_module_binding_count := 0;

    for module_binding_fact in
      select item.value
      from pg_catalog.jsonb_array_elements(application_installation -> 'moduleBindings') as item(value)
      order by (item.value ->> 'moduleRootId')::uuid
    loop
      if pg_catalog.jsonb_typeof(module_binding_fact) is distinct from 'object'
        or not (module_binding_fact ?& array[
          'organizationId', 'applicationRootId', 'moduleRootId', 'bindingRevision',
          'applicationReleaseRevision', 'moduleReleaseRevision', 'state'
        ])
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_binding_fact)) <> 7
        or not vortex_context.is_non_nil_uuid(module_binding_fact ->> 'moduleRootId')
        or not pg_catalog.pg_input_is_valid(module_binding_fact ->> 'bindingRevision', 'bigint')
        or (module_binding_fact ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
        or not pg_catalog.pg_input_is_valid(module_binding_fact ->> 'moduleReleaseRevision', 'bigint')
        or (module_binding_fact ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or module_binding_fact ->> 'organizationId' is distinct from selected_organization_id::text
        or module_binding_fact ->> 'applicationRootId' is distinct from candidate_application_root_id::text
        or module_binding_fact ->> 'applicationReleaseRevision'
          is distinct from application_release.release_revision::text
        or module_binding_fact ->> 'state' is distinct from 'active' then
        raise exception using errcode = '55000',
          message = 'Active shared record consumer binding evidence is malformed';
      end if;

      select binding.* into module_binding
      from vortex_module.installation_bindings as binding
      where binding.organization_id = selected_organization_id
        and binding.application_root_id = candidate_application_root_id
        and binding.module_root_id = (module_binding_fact ->> 'moduleRootId')::uuid;
      if not found
        or module_binding.state is distinct from 'active'
        or module_binding.binding_revision is distinct from (module_binding_fact ->> 'bindingRevision')::bigint
        or module_binding.application_release_revision is distinct from application_release.release_revision
        or module_binding.module_release_revision is distinct from (module_binding_fact ->> 'moduleReleaseRevision')::bigint then
        raise exception using errcode = '40001',
          message = 'Active shared record consumer binding changed during selection';
      end if;

      select root.* into module_root
      from vortex_definition.roots as root
      where root.root_id = module_binding.module_root_id;
      if not found or module_root.kind is distinct from 'module'
        or module_root.key is null or module_root.key = '' then
        continue application_loop;
      end if;
      select release.* into module_release
      from vortex_definition.releases as release
      where release.root_id = module_binding.module_root_id
        and release.release_revision = module_binding.module_release_revision;
      if not found
        or module_release.validation_contract_version is null
        or not (module_release.validation_contract_version = any (
          vortex_definition.accepted_contract_version('module')
        ))
        or module_release.release_version is null
        or module_release.release_version = ''
        or module_release.content_fingerprint is null
        or module_release.content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or module_release.resolution_fingerprint is null
        or module_release.resolution_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or pg_catalog.jsonb_typeof(module_release.compilation_output) is distinct from 'object'
        or module_release.compilation_output ->> 'kind' is distinct from 'module'
        or module_release.compilation_output ->> 'validationContractVersion'
          is distinct from module_release.validation_contract_version
        or module_release.compilation_output #>> '{canonical,envelope,rootId}'
          is distinct from module_binding.module_root_id::text
        or module_release.compilation_output #>> '{canonical,envelope,kind}'
          is distinct from 'module'
        or module_release.compilation_output #>> '{canonical,envelope,validationContractVersion}'
          is distinct from module_release.validation_contract_version then
        continue application_loop;
      end if;

      begin
        select provision.* into strict storage_provision
        from vortex_record.read_exact_module_storage_provision(
          module_binding.module_root_id, module_binding.module_release_revision
        ) as provision;
      exception
        when no_data_found then
          continue application_loop;
      end;
      if storage_provision.module_root_id is distinct from module_binding.module_root_id
        or storage_provision.release_revision is distinct from module_binding.module_release_revision
        or storage_provision.storage_contract_ids is null
        or pg_catalog.cardinality(storage_provision.storage_contract_ids) = 0
        or module_binding.storage_contract_ids is distinct from storage_provision.storage_contract_ids
        or exists (
          select 1
          from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
          where stored.contract_id is null
            or stored.contract_id = '00000000-0000-0000-0000-000000000000'::uuid
        )
        or exists (
          select 1
          from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
          group by stored.contract_id having pg_catalog.count(*) <> 1
        )
        or storage_provision.storage_contract_ids is distinct from (
          select pg_catalog.array_agg(stored.contract_id order by stored.contract_id)
          from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
        ) then
        continue application_loop;
      end if;

      if module_binding.module_root_id = p_module_root_id then
        own_module_binding_count := own_module_binding_count + 1;
        target_record_types := module_release.compilation_output #> '{canonical,content,recordTypes}';
        if pg_catalog.jsonb_typeof(target_record_types) is distinct from 'array' then
          raise exception using errcode = '55000',
            message = 'Shared record type release evidence is malformed';
        end if;
        select pg_catalog.count(*)::integer into target_record_type_count
        from pg_catalog.jsonb_array_elements(target_record_types) as item(value)
        where item.value ->> 'recordTypeId' = p_record_type_id::text;
        if target_record_type_count <> 1 or not exists (
          select 1
          from pg_catalog.jsonb_array_elements(target_record_types) as item(value)
          where item.value ->> 'recordTypeId' = p_record_type_id::text
            and item.value ->> 'storageContractId' = p_storage_contract_id::text
            and item.value ->> 'storageScope' = 'organization_shared'
        ) then
          continue application_loop;
        end if;
        if not (p_storage_contract_id = any (storage_provision.storage_contract_ids)) then
          continue application_loop;
        end if;
      end if;

      module_bindings := module_bindings || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_binding.module_root_id,
          'bindingRevision', module_binding.binding_revision,
          'applicationReleaseRevision', module_binding.application_release_revision,
          'moduleReleaseRevision', module_binding.module_release_revision,
          'state', module_binding.state,
          'contentFingerprint', module_release.content_fingerprint,
          'resolutionFingerprint', module_release.resolution_fingerprint,
          'generatorContractVersion', '1.0.0',
          'storageContractIds', pg_catalog.to_jsonb(storage_provision.storage_contract_ids)
        )
      );
    end loop;

    if own_module_binding_count <> 1
      or pg_catalog.jsonb_array_length(module_bindings) <> binding_count then
      continue application_loop;
    end if;

    target := pg_catalog.jsonb_build_object(
      'applicationRootId', candidate_application_root_id,
      'applicationReleaseRevision', application_release.release_revision,
      'moduleRootId', p_module_root_id,
      'moduleReleaseRevision', (
        select binding.module_release_revision
        from vortex_module.installation_bindings as binding
        where binding.organization_id = selected_organization_id
          and binding.application_root_id = candidate_application_root_id
          and binding.module_root_id = p_module_root_id
          and binding.state = 'active'
      ),
      'bindingRevision', (
        select binding.binding_revision
        from vortex_module.installation_bindings as binding
        where binding.organization_id = selected_organization_id
          and binding.application_root_id = candidate_application_root_id
          and binding.module_root_id = p_module_root_id
          and binding.state = 'active'
      ),
      'recordTypeId', p_record_type_id,
      'storageContractId', p_storage_contract_id,
      'registrationRevision', permission_snapshot.registration_revision,
      'definitionKey', application_root.key,
      'releaseVersion', application_release.release_version,
      'validationContractVersion', application_release.validation_contract_version,
      'contentFingerprint', application_release.content_fingerprint,
      'resolutionFingerprint', application_release.resolution_fingerprint,
      'catalogueFingerprint', permission_snapshot.catalogue_fingerprint,
      'moduleBindings', module_bindings
    );
    targets := targets || pg_catalog.jsonb_build_array(target);
  end loop;

  if pg_catalog.jsonb_array_length(targets) = 0 then
    raise exception using errcode = '42501',
      message = 'No active shared record consumer is available';
  end if;
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(targets) as item(value)
    where item.value ->> 'applicationRootId' = selected_application_root_id::text
  ) then
    raise exception using errcode = '42501',
      message = 'Origin Application is not a proved shared record consumer';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'accessVersion', selected_access_version,
    'targets', targets
  );
end
$function$;

alter function vortex_module.read_active_shared_record_consumers_internal(uuid, uuid, uuid)
  owner to vortex_module_owner;

revoke all on function vortex_module.read_active_shared_record_consumers_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_access_owner, vortex_definition_owner;
grant execute on function vortex_module.read_active_shared_record_consumers_internal(uuid, uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_module.read_active_shared_record_consumers_internal(uuid, uuid, uuid) is
  'Selects every exact active App consumer of one organization-shared record from the complete installed Module lineage and active exact release registration.';

create or replace function vortex_module.read_provisioned_lifecycle_setup_targets_internal(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_authority record;
  current_authority record;
  install_decision record;
  install_scope_decision record;
  initial_context jsonb;
  current_context jsonb;
  completion_time timestamptz;
  context_expires_at timestamptz;
  delegated_expires_at timestamptz;
  application_definition_key text;
  application_release vortex_definition.releases%rowtype;
  permission_snapshot record;
  pin record;
  locked_binding vortex_module.installation_bindings%rowtype;
  module_release vortex_definition.releases%rowtype;
  storage_provision record;
  expected_module_root_id uuid;
  expected_binding_revision bigint;
  previous_module_root_id uuid;
  module_root_text text;
  binding_revision_text text;
  closure_count bigint;
  expected_count integer;
  module_bindings jsonb := '[]'::jsonb;
  normalized_pins jsonb;
  all_storage_contract_ids uuid[] := array[]::uuid[];
  union_storage_contract_ids uuid[];
  storage_contract_id_count bigint;
  distinct_storage_contract_id_count bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup command is invalid';
  end if;

  if p_expected_module_bindings is null
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;
  expected_count := pg_catalog.jsonb_array_length(p_expected_module_bindings);
  if expected_count < 1 or expected_count > 10000 then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;

  previous_module_root_id := null;
  for pin in
    select item.value
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value)
  loop
    if pg_catalog.jsonb_typeof(pin.value) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    if not (pin.value ?& array['moduleRootId', 'bindingRevision'])
      or pin.value - array['moduleRootId', 'bindingRevision'] <> '{}'::jsonb
      or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(pin.value)) <> 2 then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    if pg_catalog.jsonb_typeof(pin.value -> 'moduleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(pin.value -> 'bindingRevision') is distinct from 'number' then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;

    module_root_text := pin.value ->> 'moduleRootId';
    if module_root_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not pg_catalog.pg_input_is_valid(module_root_text, 'uuid') then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    expected_module_root_id := module_root_text::uuid;
    if expected_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
      or module_root_text is distinct from expected_module_root_id::text then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;

    binding_revision_text := pin.value ->> 'bindingRevision';
    if binding_revision_text !~ '^[1-9][0-9]*$'
      or not pg_catalog.pg_input_is_valid(binding_revision_text, 'bigint') then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    expected_binding_revision := binding_revision_text::bigint;
    if expected_binding_revision not between 1 and 9007199254740991
      or (previous_module_root_id is not null
        and previous_module_root_id >= expected_module_root_id) then
      raise exception using errcode = '22023',
        message = 'Provisioned Application lifecycle setup binding pins are invalid';
    end if;
    previous_module_root_id := expected_module_root_id;
  end loop;

  select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'moduleRootId', (item.value ->> 'moduleRootId')::uuid,
        'bindingRevision', (item.value ->> 'bindingRevision')::bigint
      )
      order by (item.value ->> 'moduleRootId')::uuid
    )
  into strict normalized_pins
  from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as item(value);
  if p_expected_module_bindings is distinct from normalized_pins then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup binding pins are invalid';
  end if;

  select locked.* into strict initial_authority
  from vortex_access.lock_application_installation_authority() as locked;
  initial_context := vortex_access.validated_human_request_context();
  if initial_context ->> 'callerKind' is distinct from 'human'
    or (initial_context ->> 'organizationId')::uuid is distinct from initial_authority.organization_id
    or (initial_context ->> 'organizationAccountId')::uuid is distinct from initial_authority.organization_account_id
    or (initial_context ->> 'accessVersion')::bigint is distinct from initial_authority.access_version
    or (initial_context ->> 'correlationId')::uuid is distinct from initial_authority.correlation_id
    or (initial_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '42501',
      message = 'Provisioned Application lifecycle setup authority is unavailable';
  end if;

  select release.* into strict application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application'
    and release.release_revision = p_application_release_revision;

  select root.key into strict application_definition_key
  from vortex_definition.roots as root
  where root.root_id = p_application_root_id
    and root.organization_id = initial_authority.organization_id
    and root.kind = 'application';

  if not application_release.validation_contract_version = any (
      vortex_definition.accepted_contract_version('application')
    )
    or application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_application_root_id::text
    or application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from application_release.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact Application release is unavailable';
  end if;

  select snapshot.* into strict permission_snapshot
  from vortex_access.read_application_permission_snapshot(
    initial_authority.organization_id, p_application_root_id
  ) as snapshot;
  if permission_snapshot.organization_id is distinct from initial_authority.organization_id
    or permission_snapshot.application_root_id is distinct from p_application_root_id
    or permission_snapshot.registration_revision not between 1 and 9007199254740991
    or permission_snapshot.release_revision is distinct from p_application_release_revision
    or permission_snapshot.definition_key is distinct from application_definition_key
    or permission_snapshot.release_version is distinct from application_release.release_version
    or permission_snapshot.validation_contract_version is distinct from application_release.validation_contract_version
    or permission_snapshot.content_fingerprint is distinct from application_release.content_fingerprint
    or permission_snapshot.resolution_fingerprint is distinct from application_release.resolution_fingerprint then
    raise exception using errcode = '40001',
      message = 'Application permission registration is stale or unavailable';
  end if;

  select pg_catalog.count(*) into closure_count
  from vortex_definition.reachable_module_dependency_edges(
    p_application_root_id, p_application_release_revision
  );
  if closure_count < 1
    or closure_count > 10000
    or closure_count <> expected_count
    or exists (
      select 1
      from vortex_definition.reachable_module_dependency_edges(
        p_application_root_id, p_application_release_revision
      ) as required
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
        where (expected.value ->> 'moduleRootId')::uuid = required.target_root_id
      )
    ) then
    raise exception using errcode = '23514',
      message = 'Application installation binding set is incomplete';
  end if;

  for pin in
    select required.target_root_id
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || initial_authority.organization_id::text || ':' ||
          p_application_root_id::text || ':' || pin.target_root_id::text,
        0
      )
    );
  end loop;

  for pin in
    select required.target_root_id
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    perform 1
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id
    for share;
  end loop;

  for locked_binding in
    select binding.*
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state <> 'detached'
    order by binding.module_root_id
    for share
  loop
    if locked_binding.state <> 'detached'
      and not exists (
        select 1
        from vortex_definition.reachable_module_dependency_edges(
          p_application_root_id, p_application_release_revision
        ) as required
        where required.target_root_id = locked_binding.module_root_id
      ) then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed or are incomplete';
    end if;
  end loop;

  for pin in
    select required.*
    from vortex_definition.reachable_module_dependency_edges(
      p_application_root_id, p_application_release_revision
    ) as required
    order by required.target_root_id
  loop
    select (expected.value ->> 'bindingRevision')::bigint
    into strict expected_binding_revision
    from pg_catalog.jsonb_array_elements(p_expected_module_bindings) as expected(value)
    where (expected.value ->> 'moduleRootId')::uuid = pin.target_root_id;

    select binding.* into strict locked_binding
    from vortex_module.installation_bindings as binding
    where binding.organization_id = initial_authority.organization_id
      and binding.application_root_id = p_application_root_id
      and binding.module_root_id = pin.target_root_id;

    select release.* into strict module_release
    from vortex_definition.releases as release
    where release.root_id = locked_binding.module_root_id
      and release.release_revision = locked_binding.module_release_revision;

    if locked_binding.binding_revision is distinct from expected_binding_revision
      or locked_binding.application_release_revision is distinct from p_application_release_revision
      or locked_binding.module_release_revision is distinct from pin.target_release_revision
      or locked_binding.state is distinct from 'provisioned'
      or module_release.content_fingerprint is distinct from pin.dependency_content_fingerprint
      or module_release.resolution_fingerprint is distinct from pin.evidence_fingerprint then
      raise exception using errcode = '40001',
        message = 'Application installation bindings changed or are incomplete';
    end if;

    select provision.* into strict storage_provision
    from vortex_record.read_exact_module_storage_provision(
      pin.target_root_id, pin.target_release_revision
    ) as provision;
    if storage_provision.module_root_id is distinct from pin.target_root_id
      or storage_provision.release_revision is distinct from pin.target_release_revision
      or storage_provision.storage_contract_ids is null
      or (
        pg_catalog.cardinality(storage_provision.storage_contract_ids) > 0
        and (
          pg_catalog.array_ndims(storage_provision.storage_contract_ids) is distinct from 1
          or pg_catalog.array_lower(storage_provision.storage_contract_ids, 1) is distinct from 1
        )
      )
      or locked_binding.storage_contract_ids is distinct from storage_provision.storage_contract_ids
      or exists (
        select 1
        from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id)
        where stored.contract_id is null
          or stored.contract_id = '00000000-0000-0000-0000-000000000000'::uuid
      ) then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence changed or is incomplete';
    end if;

    select pg_catalog.count(*),
      pg_catalog.count(distinct stored.contract_id)
    into storage_contract_id_count, distinct_storage_contract_id_count
    from pg_catalog.unnest(storage_provision.storage_contract_ids) as stored(contract_id);
    if storage_contract_id_count <> distinct_storage_contract_id_count then
      raise exception using errcode = '40001',
        message = 'Application installation storage evidence is invalid';
    end if;

    all_storage_contract_ids := all_storage_contract_ids || storage_provision.storage_contract_ids;
    module_bindings := module_bindings || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', pin.target_root_id,
        'moduleReleaseRevision', pin.target_release_revision,
        'bindingRevision', locked_binding.binding_revision,
        'state', 'provisioned',
        'storageContractIds', pg_catalog.to_jsonb(storage_provision.storage_contract_ids)
      )
    );
  end loop;

  select coalesce(
      pg_catalog.array_agg(distinct stored.contract_id order by stored.contract_id),
      array[]::uuid[]
    )
  into union_storage_contract_ids
  from pg_catalog.unnest(all_storage_contract_ids) as stored(contract_id);

  select locked.* into strict current_authority
  from vortex_access.lock_application_installation_authority() as locked;
  select evaluated.* into strict install_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  select evaluated.* into strict install_scope_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install_scope',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object('kind', 'organization_catalogue'),
        'after', pg_catalog.jsonb_build_object('kind', 'organization_catalogue')
      )
    )
  ) as evaluated;
  current_context := vortex_access.validated_human_request_context();
  if current_authority.organization_id is distinct from initial_authority.organization_id
    or current_authority.organization_account_id is distinct from initial_authority.organization_account_id
    or current_authority.access_version is distinct from initial_authority.access_version
    or current_authority.correlation_id is distinct from initial_authority.correlation_id
    or current_context is distinct from initial_context
    or current_context ->> 'callerKind' is distinct from 'human'
    or (current_context ->> 'organizationId')::uuid is distinct from current_authority.organization_id
    or (current_context ->> 'organizationAccountId')::uuid is distinct from current_authority.organization_account_id
    or (current_context ->> 'accessVersion')::bigint is distinct from current_authority.access_version
    or (current_context ->> 'correlationId')::uuid is distinct from current_authority.correlation_id
    or (current_context ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    raise exception using errcode = '40001',
      message = 'Application installation authority changed';
  end if;

  if install_decision.outcome is distinct from 'eligible'
    or install_decision.operation_key is distinct from
      'platform.organization.applications.install'
    or install_decision.target_kind is distinct from 'organization'
    or install_decision.target_application_root_id is not null
    or install_decision.organization_id is distinct from current_authority.organization_id
    or install_decision.organization_account_id is distinct from current_authority.organization_account_id
    or install_decision.access_version is distinct from current_authority.access_version
    or install_decision.correlation_id is distinct from current_authority.correlation_id
    or install_decision.reason_code is not null
    or install_scope_decision.outcome is distinct from 'eligible'
    or install_scope_decision.operation_key is distinct from
      'platform.organization.applications.install_scope'
    or install_scope_decision.target_kind is distinct from 'organization'
    or install_scope_decision.target_application_root_id is not null
    or install_scope_decision.organization_id is distinct from current_authority.organization_id
    or install_scope_decision.organization_account_id is distinct from
      current_authority.organization_account_id
    or install_scope_decision.access_version is distinct from current_authority.access_version
    or install_scope_decision.correlation_id is distinct from current_authority.correlation_id
    or install_scope_decision.reason_code is not null then
    raise exception using errcode = '42501',
      message = 'Application installation authority is unavailable';
  end if;

  completion_time := pg_catalog.clock_timestamp();
  context_expires_at := (current_context ->> 'expiresAt')::timestamptz;
  if install_decision.checked_at is null
    or install_decision.checked_at > completion_time
    or install_decision.valid_until is null
    or install_decision.valid_until <= completion_time
    or install_scope_decision.checked_at is null
    or install_scope_decision.checked_at > completion_time
    or install_scope_decision.valid_until is null
    or install_scope_decision.valid_until <= completion_time
    or not pg_catalog.isfinite(context_expires_at)
    or context_expires_at <= completion_time then
    raise exception using errcode = '42501',
      message = 'Application installation context expired';
  end if;
  if current_context ? 'delegatedContext' then
    delegated_expires_at := (current_context #>> '{delegatedContext,expiresAt}')::timestamptz;
    if not pg_catalog.isfinite(delegated_expires_at)
      or delegated_expires_at <= completion_time then
      raise exception using errcode = '42501',
        message = 'Application installation delegation expired';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', initial_authority.organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'registrationRevision', permission_snapshot.registration_revision,
    'moduleBindings', module_bindings,
    'storageContractIds', pg_catalog.to_jsonb(union_storage_contract_ids)
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Application lifecycle setup evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Application lifecycle setup evidence is ambiguous';
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023',
      message = 'Provisioned Application lifecycle setup command is invalid';
end
$function$;

alter function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid,bigint,jsonb)
  owner to vortex_module_owner;

revoke all on function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_access_owner, vortex_definition_owner,
    vortex_invalidation_owner;
grant execute on function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb)
  to vortex_record_owner;
comment on function vortex_module.read_provisioned_lifecycle_setup_targets_internal(uuid, bigint, jsonb) is
  'Module-owned complete exact provisioned lifecycle setup targets for the authorized Record setup reader.';

commit;
