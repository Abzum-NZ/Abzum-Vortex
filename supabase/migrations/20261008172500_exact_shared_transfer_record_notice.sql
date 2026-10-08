-- #2095: publish exact organization-shared transfer notices only after the protected transfer is structurally complete.
-- The Access epoch lock, complete Module consumer selector and terminal writer
-- are the three canonical bodies below; runtime failure is contained to notices.

begin;

reset role;

create or replace function vortex_access.lock_human_request_access_version_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_context jsonb;
  rechecked_context jsonb;
  locked_access_version bigint;
begin
  initial_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(initial_context) is distinct from 'object'
    or not (initial_context ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'accessVersion', 'correlationId'
    ])
    or initial_context ->> 'callerKind' is distinct from 'human'
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'tenantId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'organizationId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'organizationAccountId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'applicationRootId')
    or not vortex_context.is_non_nil_uuid(initial_context ->> 'correlationId')
    or not pg_catalog.pg_input_is_valid(initial_context ->> 'accessVersion', 'bigint')
    or (initial_context ->> 'accessVersion')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Human ownership transfer access scope is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (initial_context ->> 'organizationId')::uuid
    and organization.tenant_id = (initial_context ->> 'tenantId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;

  if not found then
    raise exception using errcode = '42501',
      message = 'Human ownership transfer access scope is unavailable';
  end if;
  if locked_access_version is distinct from (initial_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Human ownership transfer access version changed';
  end if;

  rechecked_context := vortex_access.validated_human_request_context();
  if rechecked_context is distinct from initial_context then
    raise exception using errcode = '40001',
      message = 'Human ownership transfer context changed while acquiring access lock';
  end if;

  return initial_context;
end
$function$;

alter function vortex_access.lock_human_request_access_version_internal() owner to postgres;

revoke all on function vortex_access.lock_human_request_access_version_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_access_owner, vortex_definition_owner, vortex_identity_owner,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.lock_human_request_access_version_internal()
  to vortex_record_adapter;
comment on function vortex_access.lock_human_request_access_version_internal() is
  'Locks the exact active Human organization access version with a shared row lock and revalidates the full original request context.';

set local role vortex_module_owner;

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

reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  -- The terminal delete, restore and ownership-transfer writes now run inside the
  -- one protected apply_record_changes operation. Each branch is the exact body
  -- its own writer used to carry, so its receipt, fingerprint, Activity and
  -- Events are unchanged; only the entry point moved. The delete and restore
  -- branches complete the record_lifecycle receipt the protected preflight
  -- already claimed and, for a delete, already soft-deleted behind; the transfer
  -- branch owns and claims its own record_save receipt as before.
  if p_operation = 'delete' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
    if receipt.command_id is null
      or receipt.state is distinct from 'pending'
      or receipt.operation is distinct from 'delete'
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id
      or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;

    -- Closure identity and revisions are re-derived under the held locks rather
    -- than taken from the caller.
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'delete', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001',
        message = 'Protected record delete closure changed';
    end if;
    perform vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, false, p_mutations
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = receipt.organization_id
        and effect.application_root_id = receipt.application_root_id
        and effect.actor_organization_account_id = receipt.actor_organization_account_id
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_event.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then receipt.occurrence_id
            else pg_catalog.gen_random_uuid() end,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', event_kind,
            'recordTypeId', effect_row.record_type_id
          ),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Protected record delete Event append failed';
      end if;
    end loop;

    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
      into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_lifecycle_activity_internal(
      receipt.activity_id, 'delete', subject_ids
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_lifecycle', p_command_id, null, p_expected_concurrency_number + 1,
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
    if receipt.command_id is null
      or receipt.state is distinct from 'pending'
      or receipt.operation is distinct from 'restore'
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id
      or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;

    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'restore', p_record_type_id, p_record_id, p_command_id, null
    );
    if preparation ->> 'outcome' is distinct from 'prepared'
      or (
        select (item.value ->> 'concurrencyNumber')::bigint
        from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
        where item.value ->> 'recordKey' = 'root'
      ) is distinct from p_expected_concurrency_number + 1 then
      raise exception using errcode = '40001',
        message = 'Protected record restore closure changed';
    end if;
    revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
      preparation, true, p_mutations
    );
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    perform vortex_record.append_record_lifecycle_activity_internal(
      receipt.activity_id, 'restore', array[p_record_id]::uuid[]
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_lifecycle', p_command_id, null, restored_revision,
      'Protected record restore receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    command_fingerprint_value := vortex_record.ownership_transfer_command_fingerprint_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      target_kind, target_id, 'public', null
    );

    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, 'transfer_ownership', command_fingerprint_value,
      p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_module.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_ownership_transfer_activity_internal(
        p_activity_id, organization_id_value, 'refused'
      );
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
    event_result := vortex_event.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id, p_record_id, updated_concurrency_number,
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_invalidation.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_context.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_context.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_module.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_context.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_context.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_context.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_context.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_context.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_module.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_invalidation.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The terminal delete, restore and ownership-transfer record-change writes, applied inside the one protected operation: each keeps its own receipt kind, fingerprint, Activity and Event, and completes the preflight its protected preflight (delete and restore) or itself (ownership transfer) claimed.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
