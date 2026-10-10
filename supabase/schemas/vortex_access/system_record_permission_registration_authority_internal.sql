create or replace function vortex_access.system_record_permission_registration_authority_internal(
  p_mode text,
  p_scope jsonb,
  p_before_manifest jsonb,
  p_candidate_manifest jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_organization_id uuid;
  scope_application_root_id uuid;
  scope_flow_id uuid;
  scope_binding_id uuid;
  scope_release_version text;
  scope_actor_kind text;
  scope_actor_id uuid;
  scope_account_id uuid;
  scope_access_version bigint;
  scope_correlation_id uuid;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  selected_installation jsonb;
  locked_installation jsonb;
  selected_application_release_revision bigint;
  selected_release vortex_definition.releases%rowtype;
  selected_flow jsonb;
  selected_flow_count bigint;
  selected_dependency jsonb;
  dependency_count bigint;
  matching_task_count bigint;
  module_binding jsonb;
  locked_module_binding vortex_module.installation_bindings%rowtype;
  permission_registration vortex_access.permission_registrations%rowtype;
  permission_entry vortex_access.permission_catalogue_entries%rowtype;
  input_manifest jsonb;
  input_entry jsonb;
  intent_entry jsonb;
  expected_registration jsonb;
  expected_published jsonb;
  operation_value jsonb;
  permission_value jsonb;
  source_value jsonb;
  effective_readable jsonb;
  effective_changeable jsonb;
  effective_policy jsonb;
  installed_bindings jsonb;
  stored_entry jsonb;
  normalized_manifest jsonb := '[]'::jsonb;
  before_permissions jsonb := '[]'::jsonb;
  after_permissions jsonb := '[]'::jsonb;
  before_scope jsonb;
  after_scope jsonb;
  permission_decision record;
  previous_sort_key text;
  current_sort_key text;
  invalid_manifest boolean := false;
  now_value timestamptz;
begin
  if p_mode is null or p_mode not in ('register', 'revoke', 'observe', 'cache_scan')
    or p_scope is null or pg_catalog.jsonb_typeof(p_scope) is distinct from 'object'
    or p_before_manifest is null
    or pg_catalog.jsonb_typeof(p_before_manifest) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'System Record permission authority scope is invalid';
  end if;
  if p_mode in ('observe', 'cache_scan') and p_candidate_manifest is not null then
    return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
  end if;

  scope_organization_id := (p_scope ->> 'organizationId')::uuid;
  scope_application_root_id := (p_scope ->> 'applicationRootId')::uuid;
  scope_flow_id := (p_scope ->> 'flowId')::uuid;
  scope_binding_id := (p_scope ->> 'executionBindingId')::uuid;
  scope_release_version := p_scope ->> 'releaseVersion';
  scope_actor_kind := p_scope ->> 'actorKind';
  scope_actor_id := (p_scope ->> 'actorId')::uuid;
  scope_account_id := (p_scope ->> 'organizationAccountId')::uuid;
  scope_access_version := (p_scope ->> 'accessVersion')::bigint;
  scope_correlation_id := (p_scope ->> 'correlationId')::uuid;
  now_value := pg_catalog.clock_timestamp();

  if scope_organization_id is null
    or not vortex_context.is_non_nil_uuid(scope_organization_id::text)
    or scope_application_root_id is null
    or not vortex_context.is_non_nil_uuid(scope_application_root_id::text)
    or scope_flow_id is null or not vortex_context.is_non_nil_uuid(scope_flow_id::text)
    or scope_binding_id is null or not vortex_context.is_non_nil_uuid(scope_binding_id::text)
    or scope_release_version is null
    or scope_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or scope_actor_kind is null or scope_actor_kind not in ('specified_account', 'system')
    or scope_actor_id is null or not vortex_context.is_non_nil_uuid(scope_actor_id::text) then
    raise exception using errcode = '22023',
      message = 'System Record permission authority scope is invalid';
  end if;

  if scope_access_version is null or scope_access_version not between 1 and 9007199254740991
    or scope_correlation_id is null
    or not vortex_context.is_non_nil_uuid(scope_correlation_id::text)
    or (p_mode in ('register', 'revoke') and (
      scope_account_id is null or not vortex_context.is_non_nil_uuid(scope_account_id::text)
    ))
    or (p_mode in ('observe', 'cache_scan') and scope_account_id is not null) then
    raise exception using errcode = '22023',
      message = 'System Record permission authority context is invalid';
  end if;

  if p_mode in ('observe', 'cache_scan') then
    if scope_actor_kind <> 'system'
      or (p_scope ->> 'principalRevision') is null
      or (p_scope ->> 'principalRevision') !~ '^[1-9][0-9]*$' then
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;
    select principal.* into current_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = scope_binding_id
      and principal.organization_id = scope_organization_id
      and principal.application_root_id = scope_application_root_id
      and principal.release_version = scope_release_version
      and principal.flow_id = scope_flow_id
      and principal.actor_kind = 'system'
      and principal.actor_system_actor_id = scope_actor_id
      and principal.revision = (p_scope ->> 'principalRevision')::bigint
      and principal.recorded_correlation_id = scope_correlation_id
      and principal.is_current
      and principal.state = 'active'
    for share;
    if not found or (current_principal.expires_at is not null
      and current_principal.expires_at <= now_value) then
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;
    if not exists (
      select 1 from vortex_access.system_actor_grants as actor_grant
      where actor_grant.system_actor_id = scope_actor_id
        and actor_grant.organization_id = scope_organization_id
        and (actor_grant.flow_id is null or actor_grant.flow_id = scope_flow_id)
        and actor_grant.state = 'active'
      for share
    ) then
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;
    input_manifest := p_before_manifest;
  elsif p_mode = 'register' then
    if p_candidate_manifest is null
      or pg_catalog.jsonb_typeof(p_candidate_manifest) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_candidate_manifest) > 128
      or (scope_actor_kind = 'specified_account'
        and pg_catalog.jsonb_array_length(p_candidate_manifest) <> 0) then
      raise exception using errcode = '22023',
        message = 'System Record permission manifest is invalid';
    end if;
    input_manifest := p_candidate_manifest;
    if p_scope ->> 'replay' = 'true' then
      normalized_manifest := p_candidate_manifest;
    end if;
  elsif p_mode = 'revoke' then
    if p_candidate_manifest is not null
      and p_candidate_manifest is distinct from '[]'::jsonb then
      raise exception using errcode = '22023',
        message = 'System Record permission revoke scope is invalid';
    end if;
    if pg_catalog.jsonb_array_length(p_before_manifest) = 0 then
      return p_before_manifest;
    end if;
    if scope_actor_kind <> 'system' then
      raise exception using errcode = '22023',
        message = 'Only a System principal may carry Record permissions';
    end if;
  end if;

  if p_mode = 'revoke' then
    input_manifest := p_before_manifest;
  end if;

  if pg_catalog.jsonb_array_length(input_manifest) = 0 then
    if p_mode = 'register' then
      normalized_manifest := '[]'::jsonb;
    elsif p_mode = 'observe' then
      return '[]'::jsonb;
    elsif p_mode = 'cache_scan' then
      return '[]'::jsonb;
    else
      return p_before_manifest;
    end if;
  end if;

  if p_mode in ('register', 'observe', 'cache_scan')
    and pg_catalog.jsonb_array_length(input_manifest) > 0
    and not (p_mode = 'register' and p_scope ->> 'replay' = 'true') then
    if scope_actor_kind <> 'system' then
      if p_mode = 'register' then
        raise exception using errcode = '22023',
          message = 'Only a System principal may carry Record permissions';
      end if;
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;

    if p_mode = 'register' then
      selected_application_release_revision :=
        (input_manifest -> 0 -> 'expectedPublished' ->> 'applicationReleaseRevision')::bigint;
    else
      selected_application_release_revision :=
        (input_manifest -> 0 -> 'expectedPublished' ->> 'applicationReleaseRevision')::bigint;
    end if;
    if selected_application_release_revision not between 1 and 9007199254740991 then
      if p_mode = 'register' then
        raise exception using errcode = '22023',
          message = 'System Record permission release revision is invalid';
      end if;
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;

    begin
      selected_installation := vortex_module.read_active_installation_for_scope_internal(
        scope_organization_id, scope_application_root_id
      );
    exception
      when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission installation is stale';
        end if;
        return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end;

    if (selected_installation ->> 'applicationReleaseRevision')::bigint
      is distinct from selected_application_release_revision
      or pg_catalog.jsonb_typeof(selected_installation -> 'moduleBindings') is distinct from 'array'
      or pg_catalog.jsonb_array_length(selected_installation -> 'moduleBindings') = 0 then
      if p_mode = 'register' then
        raise exception using errcode = '40001',
          message = 'System Record permission installation is stale';
      end if;
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;

    for module_binding in
      select item.value
      from pg_catalog.jsonb_array_elements(selected_installation -> 'moduleBindings') as item(value)
      order by (item.value ->> 'moduleRootId')::uuid
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'vortex_module.binding:' || scope_organization_id::text || ':' ||
            scope_application_root_id::text || ':' ||
            (module_binding ->> 'moduleRootId')::uuid::text,
          0
        )
      );
      select binding.* into locked_module_binding
      from vortex_module.installation_bindings as binding
      where binding.organization_id = scope_organization_id
        and binding.application_root_id = scope_application_root_id
        and binding.module_root_id = (module_binding ->> 'moduleRootId')::uuid
      for share;
      if not found
        or locked_module_binding.state is distinct from 'active'
        or locked_module_binding.binding_revision is distinct from
          (module_binding ->> 'bindingRevision')::bigint
        or locked_module_binding.application_release_revision is distinct from
          (module_binding ->> 'applicationReleaseRevision')::bigint
        or locked_module_binding.module_release_revision is distinct from
          (module_binding ->> 'moduleReleaseRevision')::bigint then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission Module binding is stale';
        end if;
        return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
      end if;
    end loop;

    begin
      locked_installation := vortex_module.read_active_installation_for_scope_internal(
        scope_organization_id, scope_application_root_id
      );
    exception
      when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission installation changed';
        end if;
        return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end;
    if locked_installation is distinct from selected_installation then
      if p_mode = 'register' then
        raise exception using errcode = '40001',
          message = 'System Record permission installation changed';
      end if;
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', (item.value ->> 'organizationId')::uuid,
      'applicationRootId', (item.value ->> 'applicationRootId')::uuid,
      'moduleRootId', (item.value ->> 'moduleRootId')::uuid,
      'bindingRevision', (item.value ->> 'bindingRevision')::bigint,
      'applicationReleaseRevision', (item.value ->> 'applicationReleaseRevision')::bigint,
      'moduleReleaseRevision', (item.value ->> 'moduleReleaseRevision')::bigint,
      'state', item.value ->> 'state'
    ) order by (item.value ->> 'moduleRootId')::uuid)
    into installed_bindings
    from pg_catalog.jsonb_array_elements(locked_installation -> 'moduleBindings') as item(value);

    for input_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(input_manifest) as item(value)
    loop
      if p_mode in ('observe', 'cache_scan') then
        intent_entry := input_entry - array[
          'effectiveFieldPolicy', 'meaningFingerprint', 'installedModuleBindings'
        ]::text[];
        if input_entry - array[
          'nodeId', 'operation', 'permission', 'requestedFieldPolicy',
          'expectedPublished', 'expectedRegistration', 'effectiveFieldPolicy',
          'meaningFingerprint', 'installedModuleBindings'
        ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(input_entry -> 'effectiveFieldPolicy') is distinct from 'object'
          or not vortex_access.permission_field_policy_is_valid(input_entry -> 'effectiveFieldPolicy')
          or pg_catalog.jsonb_typeof(input_entry -> 'meaningFingerprint') is distinct from 'string'
          or pg_catalog.jsonb_typeof(input_entry -> 'installedModuleBindings') is distinct from 'array' then
          invalid_manifest := true;
          exit;
        end if;
      else
        intent_entry := input_entry;
      end if;

      if pg_catalog.jsonb_typeof(intent_entry) is distinct from 'object'
        or intent_entry - array[
          'nodeId', 'operation', 'permission', 'requestedFieldPolicy',
          'expectedPublished', 'expectedRegistration'
        ]::text[] <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(intent_entry)) <> 6
        or pg_catalog.jsonb_typeof(intent_entry -> 'nodeId') is distinct from 'string'
        or pg_catalog.char_length(intent_entry ->> 'nodeId') not between 1 and 40
        or (intent_entry ->> 'nodeId') !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
        or pg_catalog.jsonb_typeof(intent_entry -> 'operation') is distinct from 'object'
        or intent_entry -> 'operation' - array['owner', 'operationId']::text[] <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(intent_entry -> 'operation')) <> 2
        or pg_catalog.jsonb_typeof(intent_entry #> '{operation,owner}') is distinct from 'object'
        or pg_catalog.jsonb_typeof(intent_entry #> '{operation,operationId}') is distinct from 'string'
        or not vortex_context.is_non_nil_uuid(intent_entry #>> '{operation,operationId}')
        or intent_entry #>> '{operation,operationId}' <>
          pg_catalog.lower(intent_entry #>> '{operation,operationId}')
        or pg_catalog.jsonb_typeof(intent_entry -> 'permission') is distinct from 'object'
        or intent_entry -> 'permission' - array[
          'applicationRootId', 'ownerKind', 'ownerId', 'permissionId'
        ]::text[] <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(intent_entry -> 'permission')) <> 4
        or pg_catalog.jsonb_typeof(intent_entry #> '{permission,applicationRootId}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{permission,ownerKind}') is distinct from 'string'
        or intent_entry #>> '{permission,ownerKind}' not in ('application', 'module')
        or pg_catalog.jsonb_typeof(intent_entry #> '{permission,ownerId}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{permission,permissionId}') is distinct from 'string'
        or not vortex_context.is_non_nil_uuid(intent_entry #>> '{permission,applicationRootId}')
        or not vortex_context.is_non_nil_uuid(intent_entry #>> '{permission,ownerId}')
        or not vortex_context.is_non_nil_uuid(intent_entry #>> '{permission,permissionId}')
        or (intent_entry #>> '{permission,applicationRootId}') <>
          pg_catalog.lower(intent_entry #>> '{permission,applicationRootId}')
        or (intent_entry #>> '{permission,ownerId}') <>
          pg_catalog.lower(intent_entry #>> '{permission,ownerId}')
        or (intent_entry #>> '{permission,permissionId}') <>
          pg_catalog.lower(intent_entry #>> '{permission,permissionId}')
        or (intent_entry #>> '{permission,applicationRootId}')::uuid <> scope_application_root_id
        or pg_catalog.jsonb_typeof(intent_entry -> 'requestedFieldPolicy') is distinct from 'object'
        or not vortex_access.permission_field_policy_is_valid(intent_entry -> 'requestedFieldPolicy')
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(
            intent_entry #> '{requestedFieldPolicy,readableFieldIds}'
          ) as requested(value)
          where requested.value <> pg_catalog.lower(requested.value)
        )
        or exists (
          select 1
          from pg_catalog.jsonb_array_elements_text(
            intent_entry #> '{requestedFieldPolicy,changeableFieldIds}'
          ) as requested(value)
          where requested.value <> pg_catalog.lower(requested.value)
        )
        or pg_catalog.jsonb_typeof(intent_entry -> 'expectedPublished') is distinct from 'object'
        or intent_entry -> 'expectedPublished' - array[
          'applicationReleaseRevision', 'releaseVersion', 'contentFingerprint',
          'resolutionFingerprint'
        ]::text[] <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(intent_entry -> 'expectedPublished')) <> 4
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedPublished,applicationReleaseRevision}') is distinct from 'number'
        or (intent_entry #>> '{expectedPublished,applicationReleaseRevision}') !~ '^[1-9][0-9]*$'
        or (intent_entry #>> '{expectedPublished,applicationReleaseRevision}')::numeric > 9007199254740991
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedPublished,releaseVersion}') is distinct from 'string'
        or (intent_entry #>> '{expectedPublished,releaseVersion}') !~
          '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedPublished,contentFingerprint}') is distinct from 'string'
        or (intent_entry #>> '{expectedPublished,contentFingerprint}') !~ '^sha256:[a-f0-9]{64}$'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedPublished,resolutionFingerprint}') is distinct from 'string'
        or (intent_entry #>> '{expectedPublished,resolutionFingerprint}') !~ '^sha256:[a-f0-9]{64}$'
        or pg_catalog.jsonb_typeof(intent_entry -> 'expectedRegistration') is distinct from 'object'
        or intent_entry -> 'expectedRegistration' - array[
          'registrationKind', 'registrationOwnerId', 'registrationRevision', 'source'
        ]::text[] <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(intent_entry -> 'expectedRegistration')) <> 4
        or intent_entry #>> '{expectedRegistration,registrationKind}' <> 'application'
        or (intent_entry #>> '{expectedRegistration,registrationOwnerId}') <> scope_application_root_id::text
        or not vortex_context.is_non_nil_uuid(intent_entry #>> '{expectedRegistration,registrationOwnerId}')
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,registrationRevision}') is distinct from 'number'
        or (intent_entry #>> '{expectedRegistration,registrationRevision}') !~ '^[1-9][0-9]*$'
        or (intent_entry #>> '{expectedRegistration,registrationRevision}')::numeric > 9007199254740991
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source}') is distinct from 'object'
        or intent_entry #> '{expectedRegistration,source}' - array[
          'kind', 'definitionKey', 'rootId', 'releaseVersion', 'releaseRevision',
          'validationContractVersion', 'contentFingerprint', 'resolutionFingerprint'
        ]::text[] <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(
          intent_entry #> '{expectedRegistration,source}')) <> 8
        or intent_entry #>> '{expectedRegistration,source,kind}' <>
          intent_entry #>> '{permission,ownerKind}'
        or intent_entry #>> '{expectedRegistration,source,rootId}' <>
          intent_entry #>> '{permission,ownerId}'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,definitionKey}') is distinct from 'string'
        or pg_catalog.char_length(intent_entry #>> '{expectedRegistration,source,definitionKey}') not between 3 and 120
        or (intent_entry #>> '{expectedRegistration,source,definitionKey}') !~
          '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
        or exists (
          select 1
          from pg_catalog.unnest(pg_catalog.string_to_array(
            intent_entry #>> '{expectedRegistration,source,definitionKey}', '.'
          )) as segment(value)
          where pg_catalog.char_length(segment.value) > 40
        )
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,releaseVersion}') is distinct from 'string'
        or (intent_entry #>> '{expectedRegistration,source,releaseVersion}') !~
          '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,releaseRevision}') is distinct from 'number'
        or (intent_entry #>> '{expectedRegistration,source,releaseRevision}') !~ '^[1-9][0-9]*$'
        or (intent_entry #>> '{expectedRegistration,source,releaseRevision}')::numeric > 9007199254740991
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,validationContractVersion}') is distinct from 'string'
        or (intent_entry #>> '{expectedRegistration,source,validationContractVersion}') !~
          '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
        or (intent_entry #>> '{expectedRegistration,source,contentFingerprint}') !~ '^sha256:[a-f0-9]{64}$'
        or (intent_entry #>> '{expectedRegistration,source,resolutionFingerprint}') !~ '^sha256:[a-f0-9]{64}$'
        or pg_catalog.jsonb_typeof(intent_entry #> '{operation,owner,kind}') is distinct from 'string'
        or intent_entry #>> '{operation,owner,kind}' not in ('application', 'module')
        or (intent_entry #> '{operation,owner}') - (case
          when intent_entry #>> '{operation,owner,kind}' = 'application'
            then array['kind', 'applicationRootId']::text[]
          else array['kind', 'moduleRootId']::text[]
        end) <> '{}'::jsonb
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(
          intent_entry #> '{operation,owner}')) <> 2
        or not vortex_context.is_non_nil_uuid(case
          when intent_entry #>> '{operation,owner,kind}' = 'application'
            then intent_entry #>> '{operation,owner,applicationRootId}'
          else intent_entry #>> '{operation,owner,moduleRootId}'
        end)
        or (case
          when intent_entry #>> '{operation,owner,kind}' = 'application'
            then intent_entry #>> '{operation,owner,applicationRootId}'
          else intent_entry #>> '{operation,owner,moduleRootId}'
        end) <> pg_catalog.lower(case
          when intent_entry #>> '{operation,owner,kind}' = 'application'
            then intent_entry #>> '{operation,owner,applicationRootId}'
          else intent_entry #>> '{operation,owner,moduleRootId}'
        end)
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,registrationKind}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,registrationOwnerId}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,kind}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,rootId}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,contentFingerprint}') is distinct from 'string'
        or pg_catalog.jsonb_typeof(intent_entry #> '{expectedRegistration,source,resolutionFingerprint}') is distinct from 'string'
        or (intent_entry #>> '{expectedRegistration,source,rootId}') <>
          (intent_entry #>> '{permission,ownerId}') then
        if p_mode = 'register' then
          raise exception using errcode = '22023',
            message = 'System Record permission entry is invalid';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      current_sort_key := pg_catalog.concat_ws(E'\x1f',
        intent_entry ->> 'nodeId',
        intent_entry #>> '{permission,ownerKind}',
        intent_entry #>> '{permission,ownerId}',
        intent_entry #>> '{operation,operationId}',
        intent_entry #>> '{permission,permissionId}'
      );
      if previous_sort_key is not null and previous_sort_key >= current_sort_key then
        if p_mode = 'register' then
          raise exception using errcode = '22023',
            message = 'System Record permission entries are not canonical';
        end if;
        invalid_manifest := true;
        exit;
      end if;
      previous_sort_key := current_sort_key;

      if (intent_entry #>> '{expectedPublished,applicationReleaseRevision}')::bigint
          is distinct from selected_application_release_revision
        or intent_entry #>> '{expectedPublished,releaseVersion}' is distinct from scope_release_version then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission Application release is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      select release.* into selected_release
      from vortex_definition.releases as release
      join vortex_definition.roots as root on root.root_id = release.root_id
      where release.root_id = scope_application_root_id
        and release.release_revision = selected_application_release_revision
        and release.release_version = scope_release_version
        and root.organization_id = scope_organization_id
        and root.kind = 'application'
        and release.validation_contract_version = any (
          vortex_definition.accepted_contract_version('application')
        )
        and release.compilation_output #>> '{kind}' = 'application'
        and release.compilation_output #>> '{canonical,envelope,rootId}' =
          scope_application_root_id::text
        and release.compilation_output #>> '{validationContractVersion}' = any (
          vortex_definition.accepted_contract_version('application')
        );
      if not found
        or selected_release.content_fingerprint is distinct from
          intent_entry #>> '{expectedPublished,contentFingerprint}'
        or selected_release.resolution_fingerprint is distinct from
          intent_entry #>> '{expectedPublished,resolutionFingerprint}' then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission published Application release is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      select pg_catalog.count(*) into selected_flow_count
      from pg_catalog.jsonb_array_elements(
        selected_release.compilation_output #> '{canonical,content,flows}'
      ) as flow(value)
      where (flow.value ->> 'id')::uuid = scope_flow_id
        and flow.value ->> 'execution' = 'durable'
        and flow.value #>> '{runAs,kind}' = 'system'
        and (flow.value #>> '{runAs,executionBindingId}')::uuid = scope_binding_id
        and flow.value -> 'runAs' - array['kind', 'executionBindingId']::text[] = '{}'::jsonb;
      if selected_flow_count <> 1 then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission flow binding is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;
      select flow.value into strict selected_flow
      from pg_catalog.jsonb_array_elements(
        selected_release.compilation_output #> '{canonical,content,flows}'
      ) as flow(value)
      where (flow.value ->> 'id')::uuid = scope_flow_id
        and flow.value ->> 'execution' = 'durable'
        and flow.value #>> '{runAs,kind}' = 'system'
        and (flow.value #>> '{runAs,executionBindingId}')::uuid = scope_binding_id
        and flow.value -> 'runAs' - array['kind', 'executionBindingId']::text[] = '{}'::jsonb;

      with recursive tasks(value) as (
        select task.value
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(selected_flow -> 'tasks') = 'array'
            then selected_flow -> 'tasks' else '[]'::jsonb end) as task(value)
        union all
        select task.value
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(selected_flow -> 'errors') = 'array'
            then selected_flow -> 'errors' else '[]'::jsonb end) as task(value)
        union all
        select task.value
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(selected_flow -> 'finally') = 'array'
            then selected_flow -> 'finally' else '[]'::jsonb end) as task(value)
        union all
        select child.value
        from tasks as parent
        cross join lateral (
          select nested.value from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(parent.value -> 'tasks') = 'array'
              then parent.value -> 'tasks' else '[]'::jsonb end) as nested(value)
          union all
          select nested.value from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(parent.value -> 'then') = 'array'
              then parent.value -> 'then' else '[]'::jsonb end) as nested(value)
          union all
          select nested.value from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(parent.value -> 'else') = 'array'
              then parent.value -> 'else' else '[]'::jsonb end) as nested(value)
          union all
          select nested.value from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(parent.value -> 'default') = 'array'
              then parent.value -> 'default' else '[]'::jsonb end) as nested(value)
          union all
          select nested_task.value
          from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(parent.value -> 'cases') = 'array'
              then parent.value -> 'cases' else '[]'::jsonb end) as candidate(value)
          cross join lateral pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(candidate.value -> 'tasks') = 'array'
              then candidate.value -> 'tasks' else '[]'::jsonb end) as nested_task(value)
          union all
          select branch_task.value
          from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(parent.value -> 'branches') = 'array'
              then parent.value -> 'branches' else '[]'::jsonb end) as branch(value)
          cross join lateral pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(branch.value) = 'array'
              then branch.value else '[]'::jsonb end) as branch_task(value)
        ) as child(value)
      )
      select pg_catalog.count(*) into matching_task_count
      from tasks as task
      where task.value ->> 'id' = intent_entry ->> 'nodeId'
        and task.value ->> 'type' = 'record.save';
      if matching_task_count <> 1 then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission node is not one published record.save task';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      select pg_catalog.count(*)
      into dependency_count
      from vortex_definition.release_dependencies as dependency
      where dependency.root_id = scope_application_root_id
        and dependency.release_revision = selected_application_release_revision
        and dependency.dependency_kind = 'application_flow_node'
        and dependency.dependency_entry ->> 'applicationRootId' = scope_application_root_id::text
        and dependency.dependency_entry ->> 'flowId' = scope_flow_id::text
        and dependency.dependency_entry ->> 'nodeId' = intent_entry ->> 'nodeId'
        and dependency.dependency_entry ->> 'releaseVersion' = selected_release.release_version
        and dependency.dependency_entry ->> 'contentFingerprint' = selected_release.content_fingerprint
        and dependency.dependency_entry ->> 'resolutionFingerprint' = selected_release.resolution_fingerprint
        and dependency.dependency_entry ->> 'grantable' = 'true'
        and dependency.dependency_entry -> 'operations' @> pg_catalog.jsonb_build_array(
          intent_entry -> 'operation'
        );
      if dependency_count = 1 then
        select dependency.dependency_entry into strict selected_dependency
        from vortex_definition.release_dependencies as dependency
        where dependency.root_id = scope_application_root_id
          and dependency.release_revision = selected_application_release_revision
          and dependency.dependency_kind = 'application_flow_node'
          and dependency.dependency_entry ->> 'applicationRootId' = scope_application_root_id::text
          and dependency.dependency_entry ->> 'flowId' = scope_flow_id::text
          and dependency.dependency_entry ->> 'nodeId' = intent_entry ->> 'nodeId'
          and dependency.dependency_entry ->> 'releaseVersion' = selected_release.release_version
          and dependency.dependency_entry ->> 'contentFingerprint' = selected_release.content_fingerprint
          and dependency.dependency_entry ->> 'resolutionFingerprint' = selected_release.resolution_fingerprint
          and dependency.dependency_entry ->> 'grantable' = 'true'
          and dependency.dependency_entry -> 'operations' @> pg_catalog.jsonb_build_array(
            intent_entry -> 'operation'
          );
      end if;
      if dependency_count <> 1 or selected_dependency is null then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission published node operation is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      if intent_entry #>> '{operation,owner,kind}' = 'application'
        and (intent_entry #>> '{operation,owner,applicationRootId}')::uuid
          is distinct from scope_application_root_id then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission operation owner is stale';
        end if;
        invalid_manifest := true;
        exit;
      elsif intent_entry #>> '{operation,owner,kind}' = 'module'
        and not exists (
          select 1 from pg_catalog.jsonb_array_elements(installed_bindings) as binding(value)
          where binding.value ->> 'moduleRootId' =
            intent_entry #>> '{operation,owner,moduleRootId}'
        ) then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission operation Module is not installed';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      permission_value := intent_entry -> 'permission';
      select registration.* into permission_registration
      from vortex_access.permission_registrations as registration
      where registration.organization_id = scope_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = scope_application_root_id
        and registration.state = 'active'
      for share;
      if not found
        or permission_registration.revision is distinct from
          (intent_entry #>> '{expectedRegistration,registrationRevision}')::bigint
        or permission_registration.registration_owner_id is distinct from
          (intent_entry #>> '{expectedRegistration,registrationOwnerId}')::uuid then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission registration is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      select catalogue.* into permission_entry
      from vortex_access.permission_catalogue_entries as catalogue
      where catalogue.organization_id = scope_organization_id
        and catalogue.registration_kind = permission_registration.registration_kind
        and catalogue.registration_owner_id = permission_registration.registration_owner_id
        and catalogue.registration_revision = permission_registration.revision
        and catalogue.application_root_id = (permission_value ->> 'applicationRootId')::uuid
        and catalogue.owner_kind = permission_value ->> 'ownerKind'
        and catalogue.owner_id = (permission_value ->> 'ownerId')::uuid
        and catalogue.permission_id = (permission_value ->> 'permissionId')::uuid
      for share;
      if not found
        or permission_entry.source_kind is distinct from
          intent_entry #>> '{expectedRegistration,source,kind}'
        or permission_entry.source_definition_key is distinct from
          intent_entry #>> '{expectedRegistration,source,definitionKey}'
        or permission_entry.source_root_id is distinct from
          (intent_entry #>> '{expectedRegistration,source,rootId}')::uuid
        or permission_entry.source_version is distinct from
          intent_entry #>> '{expectedRegistration,source,releaseVersion}'
        or permission_entry.source_revision is distinct from
          (intent_entry #>> '{expectedRegistration,source,releaseRevision}')::bigint
        or permission_entry.source_validation_contract_version is distinct from
          intent_entry #>> '{expectedRegistration,source,validationContractVersion}'
        or permission_entry.source_content_fingerprint is distinct from
          intent_entry #>> '{expectedRegistration,source,contentFingerprint}'
        or permission_entry.source_resolution_fingerprint is distinct from
          intent_entry #>> '{expectedRegistration,source,resolutionFingerprint}'
        or permission_entry.source_root_id is distinct from permission_entry.owner_id
        or permission_entry.source_kind is distinct from permission_entry.owner_kind then
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission source is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;

      -- Bind the catalogue witness to the immutable release that is actually installed.
      -- The witness comparison above remains the stale-intent check; it is not authority.
      if permission_entry.source_kind = 'application' then
        if permission_entry.source_root_id is distinct from scope_application_root_id
          or permission_entry.source_definition_key is distinct from (
            select application_root.key
            from vortex_definition.roots as application_root
            where application_root.root_id = scope_application_root_id
              and application_root.organization_id = scope_organization_id
              and application_root.kind = 'application'
          )
          or permission_entry.source_version is distinct from selected_release.release_version
          or permission_entry.source_revision is distinct from selected_release.release_revision
          or permission_entry.source_validation_contract_version is distinct from
            selected_release.validation_contract_version
          or permission_entry.source_content_fingerprint is distinct from
            selected_release.content_fingerprint
          or permission_entry.source_resolution_fingerprint is distinct from
            selected_release.resolution_fingerprint then
          if p_mode = 'register' then
            raise exception using errcode = '40001',
              message = 'System Record permission source is stale';
          end if;
          invalid_manifest := true;
          exit;
        end if;
      elsif permission_entry.source_kind = 'module' then
        if not exists (
          select 1
          from pg_catalog.jsonb_array_elements(installed_bindings) as binding(value)
          join vortex_definition.roots as module_root
            on module_root.root_id = (binding.value ->> 'moduleRootId')::uuid
          join vortex_definition.releases as module_release
            on module_release.root_id = module_root.root_id
            and module_release.release_revision =
              (binding.value ->> 'moduleReleaseRevision')::bigint
          where binding.value ->> 'state' = 'active'
            and (binding.value ->> 'organizationId')::uuid = scope_organization_id
            and (binding.value ->> 'applicationRootId')::uuid = scope_application_root_id
            and (binding.value ->> 'applicationReleaseRevision')::bigint =
              selected_application_release_revision
            and module_root.kind = 'module'
            and module_root.root_id = permission_entry.source_root_id
            and module_root.key = permission_entry.source_definition_key
            and module_release.release_version = permission_entry.source_version
            and module_release.release_revision = permission_entry.source_revision
            and module_release.validation_contract_version =
              permission_entry.source_validation_contract_version
            and module_release.content_fingerprint =
              permission_entry.source_content_fingerprint
            and module_release.resolution_fingerprint =
              permission_entry.source_resolution_fingerprint
        ) then
          if p_mode = 'register' then
            raise exception using errcode = '40001',
              message = 'System Record permission source is stale';
          end if;
          invalid_manifest := true;
          exit;
        end if;
      else
        if p_mode = 'register' then
          raise exception using errcode = '40001',
            message = 'System Record permission source is stale';
        end if;
        invalid_manifest := true;
        exit;
      end if;
      if permission_entry.field_policy is null then
        if pg_catalog.jsonb_array_length(
          intent_entry #> '{requestedFieldPolicy,readableFieldIds}'
        ) > 0 or pg_catalog.jsonb_array_length(
          intent_entry #> '{requestedFieldPolicy,changeableFieldIds}'
        ) > 0 then
          if p_mode = 'register' then
            raise exception using errcode = '40001',
              message = 'System Record permission field policy is stale';
          end if;
          invalid_manifest := true;
          exit;
        end if;
        effective_readable := '[]'::jsonb;
        effective_changeable := '[]'::jsonb;
      else
        if not vortex_access.permission_field_policy_is_valid(permission_entry.field_policy)
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(
              intent_entry #> '{requestedFieldPolicy,readableFieldIds}'
            ) as requested(value)
            where not exists (
              select 1 from pg_catalog.jsonb_array_elements_text(
                permission_entry.field_policy -> 'readableFieldIds'
              ) as allowed(value)
              where pg_catalog.lower(allowed.value) = pg_catalog.lower(requested.value)
            )
          )
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements_text(
              intent_entry #> '{requestedFieldPolicy,changeableFieldIds}'
            ) as requested(value)
            where not exists (
              select 1 from pg_catalog.jsonb_array_elements_text(
                permission_entry.field_policy -> 'changeableFieldIds'
              ) as allowed(value)
              where pg_catalog.lower(allowed.value) = pg_catalog.lower(requested.value)
            )
          ) then
          if p_mode = 'register' then
            raise exception using errcode = '40001',
              message = 'System Record permission field policy is stale';
          end if;
          invalid_manifest := true;
          exit;
        end if;
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pg_catalog.lower(requested.value))
          order by pg_catalog.lower(requested.value) collate "C"), '[]'::jsonb)
        into effective_readable
        from pg_catalog.jsonb_array_elements_text(
          intent_entry #> '{requestedFieldPolicy,readableFieldIds}'
        ) as requested(value)
        where exists (
          select 1 from pg_catalog.jsonb_array_elements_text(
            permission_entry.field_policy -> 'readableFieldIds'
          ) as allowed(value)
          where pg_catalog.lower(allowed.value) = pg_catalog.lower(requested.value)
        );
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(pg_catalog.lower(requested.value))
          order by pg_catalog.lower(requested.value) collate "C"), '[]'::jsonb)
        into effective_changeable
        from pg_catalog.jsonb_array_elements_text(
          intent_entry #> '{requestedFieldPolicy,changeableFieldIds}'
        ) as requested(value)
        where exists (
          select 1 from pg_catalog.jsonb_array_elements_text(
            permission_entry.field_policy -> 'changeableFieldIds'
          ) as allowed(value)
          where pg_catalog.lower(allowed.value) = pg_catalog.lower(requested.value)
        );
      end if;
      effective_policy := pg_catalog.jsonb_build_object(
        'readableFieldIds', effective_readable,
        'changeableFieldIds', effective_changeable
      );

      source_value := pg_catalog.jsonb_build_object(
        'kind', permission_entry.source_kind,
        'definitionKey', permission_entry.source_definition_key,
        'rootId', permission_entry.source_root_id,
        'releaseVersion', permission_entry.source_version,
        'releaseRevision', permission_entry.source_revision,
        'validationContractVersion', permission_entry.source_validation_contract_version,
        'contentFingerprint', permission_entry.source_content_fingerprint,
        'resolutionFingerprint', permission_entry.source_resolution_fingerprint
      );
      expected_registration := pg_catalog.jsonb_build_object(
        'registrationKind', permission_registration.registration_kind,
        'registrationOwnerId', permission_registration.registration_owner_id,
        'registrationRevision', permission_registration.revision,
        'source', source_value
      );
      expected_published := pg_catalog.jsonb_build_object(
        'applicationReleaseRevision', selected_release.release_revision,
        'releaseVersion', selected_release.release_version,
        'contentFingerprint', selected_release.content_fingerprint,
        'resolutionFingerprint', selected_release.resolution_fingerprint
      );
      operation_value := intent_entry -> 'operation';
      stored_entry := pg_catalog.jsonb_build_object(
        'nodeId', intent_entry -> 'nodeId',
        'operation', operation_value,
        'permission', pg_catalog.jsonb_build_object(
          'applicationRootId', permission_entry.application_root_id,
          'ownerKind', permission_entry.owner_kind,
          'ownerId', permission_entry.owner_id,
          'permissionId', permission_entry.permission_id
        ),
        'requestedFieldPolicy', intent_entry -> 'requestedFieldPolicy',
        'expectedPublished', expected_published,
        'expectedRegistration', expected_registration,
        'effectiveFieldPolicy', effective_policy,
        'meaningFingerprint', permission_entry.meaning_fingerprint,
        'installedModuleBindings', installed_bindings
      );
      if p_mode in ('observe', 'cache_scan') and stored_entry is distinct from input_entry then
        invalid_manifest := true;
        exit;
      end if;
      normalized_manifest := normalized_manifest || pg_catalog.jsonb_build_array(stored_entry);
    end loop;

    if invalid_manifest then
      return case when p_mode = 'cache_scan' then '[]'::jsonb else null::jsonb end;
    end if;
  end if;

  if p_mode in ('register', 'revoke') then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'applicationRootId', permission.value #>> '{permission,applicationRootId}',
      'ownerKind', permission.value #>> '{permission,ownerKind}',
      'ownerId', permission.value #>> '{permission,ownerId}',
      'permissionId', permission.value #>> '{permission,permissionId}'
    ) order by
      permission.value #>> '{permission,applicationRootId}',
      permission.value #>> '{permission,ownerKind}',
      permission.value #>> '{permission,ownerId}',
      permission.value #>> '{permission,permissionId}'), '[]'::jsonb)
    into before_permissions
    from pg_catalog.jsonb_array_elements(p_before_manifest) as permission(value);
    if p_mode = 'register' then
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId', permission.value #>> '{permission,applicationRootId}',
        'ownerKind', permission.value #>> '{permission,ownerKind}',
        'ownerId', permission.value #>> '{permission,ownerId}',
        'permissionId', permission.value #>> '{permission,permissionId}'
      ) order by
        permission.value #>> '{permission,applicationRootId}',
        permission.value #>> '{permission,ownerKind}',
        permission.value #>> '{permission,ownerId}',
        permission.value #>> '{permission,permissionId}'), '[]'::jsonb)
      into after_permissions
      from pg_catalog.jsonb_array_elements(normalized_manifest) as permission(value);
    end if;

    if pg_catalog.jsonb_array_length(before_permissions) > 0
      or pg_catalog.jsonb_array_length(after_permissions) > 0 then
      before_scope := vortex_access.private_management_scope_from_permission_evidence(
        before_permissions
      );
      after_scope := vortex_access.private_management_scope_from_permission_evidence(
        after_permissions
      );
      select decision.* into strict permission_decision
      from vortex_access.evaluate_organization_permission_eligibility(
        pg_catalog.jsonb_build_object(
          'operationKey', case p_mode
            when 'register' then 'platform.organization.flow_run_as_principals.record_permissions.register'
            else 'platform.organization.flow_run_as_principals.record_permissions.revoke'
          end,
          'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
          'target', pg_catalog.jsonb_build_object('kind', 'organization'),
          'requiredPermission', pg_catalog.jsonb_build_object(
            'ownerKind', 'platform',
            'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
            'permissionId', '87c96495-c806-4692-9bc2-250ddb10613c'
          ),
          'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
          'authority', pg_catalog.jsonb_build_object(
            'kind', 'delegated_management', 'before', before_scope, 'after', after_scope
          )
        )
      ) as decision;
      if permission_decision.outcome is distinct from 'eligible'
        or permission_decision.operation_key is distinct from (case p_mode
          when 'register' then 'platform.organization.flow_run_as_principals.record_permissions.register'
          else 'platform.organization.flow_run_as_principals.record_permissions.revoke'
        end)
        or permission_decision.target_kind is distinct from 'organization'
        or permission_decision.target_application_root_id is not null
        or permission_decision.organization_id is distinct from scope_organization_id
        or permission_decision.organization_account_id is distinct from scope_account_id
        or permission_decision.access_version is distinct from scope_access_version
        or permission_decision.correlation_id is distinct from scope_correlation_id
        or permission_decision.reason_code is not null then
        raise exception using errcode = '42501',
          message = 'System Record permission management authority is unavailable';
      end if;
    end if;
  end if;

  if p_mode = 'register' then
    return normalized_manifest;
  elsif p_mode = 'revoke' then
    return p_before_manifest;
  elsif p_mode = 'observe' then
    if current_principal.expires_at is not null
      and current_principal.expires_at <= pg_catalog.clock_timestamp() then
      return null;
    end if;
    return normalized_manifest;
  else
    if current_principal.expires_at is not null
      and current_principal.expires_at <= pg_catalog.clock_timestamp() then
      return '[]'::jsonb;
    end if;
    return normalized_manifest;
  end if;
end
$function$;

alter function vortex_access.system_record_permission_registration_authority_internal(
  text, jsonb, jsonb, jsonb
) owner to postgres;

revoke all on function vortex_access.system_record_permission_registration_authority_internal(
  text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.system_record_permission_registration_authority_internal(
  text, jsonb, jsonb, jsonb
) is
  'Validates exact current published System-flow Record permission manifests, source and installation evidence, and the separate existing organisation permission-management authority; it grants no execution rights itself.';
