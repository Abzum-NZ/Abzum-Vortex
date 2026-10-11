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
          is distinct from module_release.validation_contract_version
        or module_binding.content_fingerprint is distinct from module_release.content_fingerprint
        or module_binding.resolution_fingerprint is distinct from module_release.resolution_fingerprint
        -- The current release_provisions/installation_bindings constraints and
        -- provisioner both pin this generator contract; it is not caller input.
        or module_binding.generator_contract_version is distinct from '1.0.0' then
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
          'contentFingerprint', module_binding.content_fingerprint,
          'resolutionFingerprint', module_binding.resolution_fingerprint,
          'generatorContractVersion', module_binding.generator_contract_version,
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
