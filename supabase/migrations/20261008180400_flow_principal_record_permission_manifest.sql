begin;
set local role postgres;

alter table vortex_access.flow_run_as_principals
  add column record_permissions jsonb not null default '[]'::jsonb;

alter table vortex_access.flow_run_as_principals
  add constraint flow_run_as_principals_record_permissions_valid check (
    pg_catalog.jsonb_typeof(record_permissions) = 'array'
    and pg_catalog.jsonb_array_length(record_permissions) <= 128
  );

comment on table vortex_access.flow_run_as_principals is
  'Append-only revisions mapping one compiled flow run-as binding to an organisation account or registered System actor; System revisions may carry a bounded source-validated Record permission manifest, which grants no execution rights itself.';

comment on column vortex_access.flow_run_as_principals.record_permissions is
  'Owner-validated exact published-node permission manifest captured by this immutable principal revision; empty is unprivileged and a cache or result receipt is not current-use authority.';

drop function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
);
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

create or replace function vortex_access.refresh_system_record_execution_grant_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_flow_id uuid,
  p_system_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  access_version bigint;
  principal vortex_access.flow_run_as_principals%rowtype;
  validated_manifest jsonb;
  has_live_manifest boolean := false;
  actor_registered boolean := false;
  current_grant vortex_access.system_actor_grants%rowtype;
  selected_scope_key text;
  changed_at_value timestamptz;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_system_actor_id::text) then
    raise exception using errcode = '22023',
      message = 'System Record grant refresh scope is invalid';
  end if;

  select version.current_version into access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'System Record grant refresh scope is unavailable';
  end if;

  selected_scope_key := 'application:' || pg_catalog.lower(p_application_root_id::text);
  for principal in
    select stored.*
    from vortex_access.flow_run_as_principals as stored
    where stored.organization_id = p_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.flow_id = p_flow_id
      and stored.actor_kind = 'system'
      and stored.actor_system_actor_id = p_system_actor_id
      and stored.is_current
      and stored.state = 'active'
      and (stored.expires_at is null or stored.expires_at > pg_catalog.clock_timestamp())
    order by stored.execution_binding_id
    for share
  loop
    validated_manifest := vortex_access.system_record_permission_registration_authority_internal(
      'cache_scan',
      pg_catalog.jsonb_build_object(
        'executionBindingId', principal.execution_binding_id,
        'organizationId', principal.organization_id,
        'applicationRootId', principal.application_root_id,
        'releaseVersion', principal.release_version,
        'flowId', principal.flow_id,
        'actorKind', principal.actor_kind,
        'actorId', principal.actor_system_actor_id,
        'organizationAccountId', null,
        'accessVersion', access_version,
        'correlationId', principal.recorded_correlation_id,
        'principalRevision', principal.revision
      ),
      principal.record_permissions,
      null
    );
    if pg_catalog.jsonb_typeof(validated_manifest) = 'array'
      and pg_catalog.jsonb_array_length(validated_manifest) > 0 then
      has_live_manifest := true;
      exit;
    end if;
  end loop;

  select exists (
    select 1
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.system_actor_id = p_system_actor_id
      and actor_grant.organization_id = p_organization_id
      and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
      and actor_grant.state = 'active'
  ) into actor_registered;

  select actor_grant.* into current_grant
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.system_actor_id = p_system_actor_id
    and actor_grant.operation_key = 'record.apply_changes'
    and actor_grant.organization_id = p_organization_id
    and actor_grant.flow_id = p_flow_id
    and actor_grant.scope_key = selected_scope_key
  for update;
  changed_at_value := pg_catalog.statement_timestamp();

  if has_live_manifest and actor_registered then
    if found then
      update vortex_access.system_actor_grants as actor_grant
      set state = 'active', changed_at = changed_at_value
      where actor_grant.system_actor_grant_id = current_grant.system_actor_grant_id
        and (actor_grant.state <> 'active' or actor_grant.changed_at <> changed_at_value);
    else
      insert into vortex_access.system_actor_grants (
        system_actor_grant_id, system_actor_id, operation_key,
        organization_id, flow_id, scope_key, state, granted_at, changed_at
      ) values (
        pg_catalog.gen_random_uuid(), p_system_actor_id, 'record.apply_changes',
        p_organization_id, p_flow_id, selected_scope_key, 'active',
        changed_at_value, changed_at_value
      );
    end if;
  elsif found and current_grant.state <> 'revoked' then
    update vortex_access.system_actor_grants as actor_grant
    set state = 'revoked', changed_at = changed_at_value
    where actor_grant.system_actor_grant_id = current_grant.system_actor_grant_id;
  end if;
end
$function$;

alter function vortex_access.refresh_system_record_execution_grant_internal(
  uuid, uuid, uuid, uuid
) owner to postgres;

revoke all on function vortex_access.refresh_system_record_execution_grant_internal(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.refresh_system_record_execution_grant_internal(
  uuid, uuid, uuid, uuid
) is
  'Recomputes one exact System actor Record execution-purpose cache from all live source-valid principal manifests and never creates an actor or changes another grant tuple.';

create or replace function vortex_access.flow_run_as_principal_to_json_internal(
  p_principal vortex_access.flow_run_as_principals
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'executionBindingId', p_principal.execution_binding_id,
    'organizationId', p_principal.organization_id,
    'applicationRootId', p_principal.application_root_id,
    'releaseVersion', p_principal.release_version,
    'flowId', p_principal.flow_id,
    'actor', case p_principal.actor_kind
      when 'specified_account' then pg_catalog.jsonb_build_object(
        'kind', 'specified_account',
        'organizationAccountId', p_principal.actor_organization_account_id)
      else pg_catalog.jsonb_build_object(
        'kind', 'system', 'systemActorId', p_principal.actor_system_actor_id)
    end,
    'state', p_principal.state,
    'revision', p_principal.revision,
    'recordPermissions', p_principal.record_permissions,
    'recordedAt', vortex_context.format_timestamp_utc(p_principal.recorded_at)
  )
  || case when p_principal.expires_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'expiresAt', vortex_context.format_timestamp_utc(p_principal.expires_at)) end
  || case when p_principal.revoked_at is null then '{}'::jsonb else pg_catalog.jsonb_build_object(
    'revokedAt', vortex_context.format_timestamp_utc(p_principal.revoked_at)) end
$function$;

revoke all on function vortex_access.flow_run_as_principal_to_json_internal(
  vortex_access.flow_run_as_principals
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.flow_run_as_principal_to_json_internal(
  vortex_access.flow_run_as_principals
) is
  'Projects one stored flow run-as principal revision and its exact Record permission manifest into canonical JSON.';

create or replace function vortex_access.read_flow_run_as_principal_for_run(
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid
)
returns table (
  outcome text,
  result jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_principal vortex_access.flow_run_as_principals%rowtype;
  actor_state text;
  locked_access_version bigint;
  validated_record_permissions jsonb;
begin
  if p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal read command is invalid';
  end if;

  -- Lock the organisation epoch before the principal or any Module/source row so Access and
  -- installation mutations settle before this exact current snapshot proceeds.
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;
  if not found then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  -- Share-lock the exact current revision after the Access epoch. A concurrent replace or revoke
  -- either commits first and becomes the row this statement sees, or waits for this transaction.
  for attempt in 1..2 loop
    select principal.* into current_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.organization_id = p_organization_id
      and principal.application_root_id = p_application_root_id
      and principal.release_version = p_release_version
      and principal.flow_id = p_flow_id
      and principal.is_current
    for share;
    exit when found;
  end loop;

  if current_principal.execution_binding_id is null
    or current_principal.state <> 'active'
    or (current_principal.expires_at is not null
      and current_principal.expires_at <= pg_catalog.clock_timestamp()) then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.actor_kind = 'specified_account' then
    select account.state into actor_state
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = current_principal.actor_organization_account_id
      and account.organization_id = current_principal.organization_id
    for share of account;
    if actor_state is distinct from 'active' then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  else
    select actor_grant.state into actor_state
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.system_actor_id = current_principal.actor_system_actor_id
      and actor_grant.organization_id = current_principal.organization_id
      and (actor_grant.flow_id is null or actor_grant.flow_id = current_principal.flow_id)
      and actor_grant.state = 'active'
    order by (actor_grant.flow_id = current_principal.flow_id) desc
    limit 1
    for share of actor_grant;
    if actor_state is distinct from 'active' then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  end if;

  if not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.organization_id = current_principal.organization_id
      and organization.state = 'active'
  ) then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.expires_at is not null
    and current_principal.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if current_principal.actor_kind = 'system'
    and pg_catalog.jsonb_array_length(current_principal.record_permissions) > 0 then
    validated_record_permissions :=
      vortex_access.system_record_permission_registration_authority_internal(
        'observe',
        pg_catalog.jsonb_build_object(
          'executionBindingId', current_principal.execution_binding_id,
          'organizationId', current_principal.organization_id,
          'applicationRootId', current_principal.application_root_id,
          'releaseVersion', current_principal.release_version,
          'flowId', current_principal.flow_id,
          'actorKind', current_principal.actor_kind,
          'actorId', current_principal.actor_system_actor_id,
          'organizationAccountId', null,
          'accessVersion', locked_access_version,
          'correlationId', current_principal.recorded_correlation_id,
          'principalRevision', current_principal.revision
        ),
        current_principal.record_permissions,
        null
      );
    if validated_record_permissions is null
      or validated_record_permissions is distinct from current_principal.record_permissions then
      return query select 'unavailable'::text, null::jsonb;
      return;
    end if;
  end if;

  if current_principal.expires_at is not null
    and current_principal.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  return query select 'available'::text,
    vortex_access.flow_run_as_principal_to_json_internal(current_principal);
end
$function$;

revoke all on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) to vortex_runtime;

comment on function vortex_access.read_flow_run_as_principal_for_run(
  uuid, uuid, uuid, text, uuid
) is
  'Runtime-only exact-scope read of an active flow run-as principal after the Access epoch; stale source-bound Record permission manifests return unavailable.';

create or replace function vortex_access.register_flow_run_as_principal(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid,
  p_record_permissions jsonb
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  context_value jsonb;
  locked_access_version bigint;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
  operation_at timestamptz;
  receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
  record_permission_manifest jsonb;
  before_record_permissions jsonb := '[]'::jsonb;
  had_current_principal boolean := false;
  record_permission_scope jsonb;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_account', 'system')
    or (p_actor_kind = 'specified_account' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null))
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text)
    or p_record_permissions is null
    or pg_catalog.jsonb_typeof(p_record_permissions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_record_permissions) > 128
    or (p_actor_kind = 'specified_account'
      and pg_catalog.jsonb_array_length(p_record_permissions) <> 0) then
    raise exception using errcode = '22023', message = 'Flow run-as principal command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (context_value ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Flow run-as principal administration is unavailable';
  end if;
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Flow run-as principal scope is unavailable';
  end if;
  if locked_access_version is distinct from (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Flow run-as principal access authority changed';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'grant'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'register_flow_run_as_principal',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_application_root_id::text,
      p_release_version,
      p_flow_id::text,
      p_actor_kind,
      coalesce(p_actor_account_id::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      coalesce(vortex_context.format_timestamp_utc(p_expires_at), ''),
      coalesce(p_expected_revision::text, ''),
      p_record_permissions::text
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'register_flow_run_as_principal'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_execution_binding_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow run-as principal duplicate conflicts';
    end if;
    select principal.* into stored_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = receipt.subject_revisions[1]
      and principal.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow run-as principal replay is unavailable';
    end if;
    record_permission_scope := pg_catalog.jsonb_build_object(
      'executionBindingId', stored_principal.execution_binding_id,
      'organizationId', stored_principal.organization_id,
      'applicationRootId', stored_principal.application_root_id,
      'releaseVersion', stored_principal.release_version,
      'flowId', stored_principal.flow_id,
      'actorKind', stored_principal.actor_kind,
      'actorId', coalesce(stored_principal.actor_system_actor_id,
        stored_principal.actor_organization_account_id),
      'organizationAccountId', p_actor_organization_account_id,
      'accessVersion', authority.access_version,
      'correlationId', authority.correlation_id,
      'replay', true
    );
    perform vortex_access.system_record_permission_registration_authority_internal(
      'register', record_permission_scope, stored_principal.record_permissions,
      p_record_permissions
    );
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  -- An account principal must be active in the named organisation. A System principal must
  -- already have an active Access registration scoped to that organisation and flow.
  if p_actor_kind = 'specified_account' and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_actor_account_id
        and account.organization_id = p_organization_id
        and account.state = 'active'
    )
    or p_actor_kind = 'system' and not exists (
      select 1 from vortex_access.system_actor_grants as actor_grant
      where actor_grant.system_actor_id = p_actor_system_actor_id
        and actor_grant.organization_id = p_organization_id
        and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
        and actor_grant.state = 'active'
    ) then
    raise exception using errcode = '42501', message = 'Flow run-as principal actor is unavailable';
  end if;

  select principal.* into current_principal
  from vortex_access.flow_run_as_principals as principal
  where principal.execution_binding_id = p_execution_binding_id
    and principal.is_current
  for update;

  if found then
    had_current_principal := true;
    before_record_permissions := current_principal.record_permissions;
    if current_principal.organization_id is distinct from p_organization_id then
      raise exception using errcode = '42501', message = 'Flow run-as principal scope is unavailable';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = '23505', message = 'Flow run-as principal already exists';
    end if;
    if current_principal.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'A revoked flow run-as principal cannot be revived';
    end if;
    if current_principal.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is stale';
    end if;
    if current_principal.application_root_id is distinct from p_application_root_id
      or current_principal.release_version is distinct from p_release_version
      or current_principal.flow_id is distinct from p_flow_id then
      raise exception using errcode = '22023', message = 'Flow run-as principal scope is immutable';
    end if;
    if current_principal.revision >= 9007199254740991 then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is exhausted';
    end if;
    next_revision := current_principal.revision + 1;
  else
    had_current_principal := false;
    if p_expected_revision is not null then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal is unavailable';
    end if;
    next_revision := 1;
  end if;

  record_permission_scope := pg_catalog.jsonb_build_object(
    'executionBindingId', p_execution_binding_id,
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'releaseVersion', p_release_version,
    'flowId', p_flow_id,
    'actorKind', p_actor_kind,
    'actorId', coalesce(p_actor_system_actor_id, p_actor_account_id),
    'organizationAccountId', p_actor_organization_account_id,
    'accessVersion', authority.access_version,
    'correlationId', authority.correlation_id
  );
  record_permission_manifest := vortex_access.system_record_permission_registration_authority_internal(
    'register', record_permission_scope, before_record_permissions, p_record_permissions
  );
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow run-as principal expiry must be in the future';
  end if;

  if next_revision > 1 then
    update vortex_access.flow_run_as_principals as principal
    set is_current = false
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = current_principal.revision;
  end if;

  insert into vortex_access.flow_run_as_principals (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version, flow_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at,
    record_permissions
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version, p_flow_id,
    p_actor_kind, p_actor_account_id, p_actor_system_actor_id,
    p_expires_at, 'active', operation_at, p_actor_organization_account_id,
    authority.correlation_id, null, record_permission_manifest
  ) returning * into stored_principal;

  if had_current_principal and current_principal.actor_kind = 'system' then
    perform vortex_access.refresh_system_record_execution_grant_internal(
      p_organization_id, p_application_root_id, p_flow_id,
      current_principal.actor_system_actor_id
    );
  end if;
  if p_actor_kind = 'system'
    and (not had_current_principal
      or current_principal.actor_kind <> 'system'
      or current_principal.actor_system_actor_id is distinct from p_actor_system_actor_id) then
    perform vortex_access.refresh_system_record_execution_grant_internal(
      p_organization_id, p_application_root_id, p_flow_id, p_actor_system_actor_id
    );
  end if;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    case when next_revision = 1
      then 'register_flow_run_as_principal'
      else 'replace_flow_run_as_principal'
    end,
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow run-as principal Activity is stale';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    receipt_id, p_actor_organization_account_id, authority.tenant_id,
    'register_flow_run_as_principal', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid, jsonb
) to vortex_request;

comment on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid, jsonb
) is
  'Registers or replaces one exact compiled flow run-as principal and its current published System-flow Record permission manifest under both existing management authorities.';

create or replace function vortex_access.revoke_flow_run_as_principal(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  context_value jsonb;
  locked_access_version bigint;
  command_fingerprint text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
  operation_at timestamptz;
  receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
  record_permission_scope jsonb;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_context.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal revoke command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if (context_value ->> 'identityId')::uuid is distinct from p_actor_identity_id
    or (context_value ->> 'organizationAccountId')::uuid is distinct from p_actor_organization_account_id
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id then
    raise exception using errcode = '42501',
      message = 'Flow run-as principal administration is unavailable';
  end if;
  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found then
    raise exception using errcode = '42501',
      message = 'Flow run-as principal scope is unavailable';
  end if;
  if locked_access_version is distinct from (context_value ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Flow run-as principal access authority changed';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'revoke'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'revoke_flow_run_as_principal',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_expected_revision::text
    ), 'UTF8'),
    'sha256'), 'hex');

  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_organization_account_id
    and stored.tenant_id = authority.tenant_id
    and stored.operation_key = 'revoke_flow_run_as_principal'
    and stored.duplicate_key = p_duplicate_key
  for update;

  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_execution_binding_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow run-as principal duplicate conflicts';
    end if;
    select principal.* into stored_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = receipt.subject_revisions[1]
      and principal.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow run-as principal replay is unavailable';
    end if;
    record_permission_scope := pg_catalog.jsonb_build_object(
      'executionBindingId', stored_principal.execution_binding_id,
      'organizationId', stored_principal.organization_id,
      'applicationRootId', stored_principal.application_root_id,
      'releaseVersion', stored_principal.release_version,
      'flowId', stored_principal.flow_id,
      'actorKind', stored_principal.actor_kind,
      'actorId', coalesce(stored_principal.actor_system_actor_id,
        stored_principal.actor_organization_account_id),
      'organizationAccountId', p_actor_organization_account_id,
      'accessVersion', authority.access_version,
      'correlationId', authority.correlation_id
    );
    perform vortex_access.system_record_permission_registration_authority_internal(
      'revoke', record_permission_scope, stored_principal.record_permissions, '[]'::jsonb
    );
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select principal.* into current_principal
  from vortex_access.flow_run_as_principals as principal
  where principal.execution_binding_id = p_execution_binding_id
    and principal.organization_id = p_organization_id
    and principal.is_current
  for update;

  if not found or current_principal.state = 'revoked' then
    raise exception using errcode = 'V3101', message = 'Flow run-as principal is unavailable';
  end if;
  if current_principal.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is stale';
  end if;
  if current_principal.revision >= 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is exhausted';
  end if;

  record_permission_scope := pg_catalog.jsonb_build_object(
    'executionBindingId', current_principal.execution_binding_id,
    'organizationId', current_principal.organization_id,
    'applicationRootId', current_principal.application_root_id,
    'releaseVersion', current_principal.release_version,
    'flowId', current_principal.flow_id,
    'actorKind', current_principal.actor_kind,
    'actorId', coalesce(current_principal.actor_system_actor_id,
      current_principal.actor_organization_account_id),
    'organizationAccountId', p_actor_organization_account_id,
    'accessVersion', authority.access_version,
    'correlationId', authority.correlation_id
  );
  perform vortex_access.system_record_permission_registration_authority_internal(
    'revoke', record_permission_scope, current_principal.record_permissions, '[]'::jsonb
  );

  operation_at := pg_catalog.clock_timestamp();
  next_revision := current_principal.revision + 1;

  update vortex_access.flow_run_as_principals as principal
  set is_current = false
  where principal.execution_binding_id = p_execution_binding_id
    and principal.revision = current_principal.revision;

  insert into vortex_access.flow_run_as_principals (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version, flow_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at,
    record_permissions
  ) values (
    current_principal.execution_binding_id, next_revision, true,
    current_principal.organization_id, current_principal.application_root_id,
    current_principal.release_version, current_principal.flow_id,
    current_principal.actor_kind, current_principal.actor_organization_account_id,
    current_principal.actor_system_actor_id, current_principal.expires_at, 'revoked',
    operation_at, p_actor_organization_account_id, authority.correlation_id, operation_at,
    current_principal.record_permissions
  ) returning * into stored_principal;

  if current_principal.actor_kind = 'system' then
    perform vortex_access.refresh_system_record_execution_grant_internal(
      p_organization_id, current_principal.application_root_id,
      current_principal.flow_id, current_principal.actor_system_actor_id
    );
  end if;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_activity.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_run_as_principal',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_context.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow run-as principal Activity is stale';
  end if;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    receipt_id, p_actor_organization_account_id, authority.tenant_id,
    'revoke_flow_run_as_principal', p_duplicate_key, command_fingerprint,
    array[p_execution_binding_id], array[next_revision], operation_at
  );

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow run-as principal at its next revision under the existing execution-binding authority and refreshes only its source-valid Record cache tuple.';

reset role;
commit;
