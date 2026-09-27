create or replace function vortex_access.save_organization_settings_record_for_administration(
  p_record_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  decision record;
  saved record;
  default_application_root_id_value uuid;
begin
  if p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Organization settings record save requires an Application context';
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  if p_record_id is distinct from context_organization_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.update',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.runtime_settings.update'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  if p_core_values ? 'default_application_root_id'
    and pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'null' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') <> 'string'
      or not pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    default_application_root_id_value :=
      (p_core_values ->> 'default_application_root_id')::uuid;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid
      or not exists (
        select 1
        from vortex_access.permission_registrations as registration
        join vortex_definition.roots as root
          on root.root_id = registration.registration_owner_id
          and root.organization_id = registration.organization_id
          and root.kind = 'application'
        where registration.organization_id = context_organization_id
          and registration.registration_kind = 'application'
          and registration.registration_owner_id = default_application_root_id_value
          and registration.state = 'active'
          and exists (
            select 1
            from vortex_definition.releases as release
            where release.root_id = root.root_id
              and release.release_revision = registration.source_revision
              and release.content_fingerprint = registration.source_content_fingerprint
              and release.resolution_fingerprint = registration.source_resolution_fingerprint
              and release.compilation_output ->> 'kind' = 'application'
          )
          and exists (
            select 1
            from vortex_module.installation_bindings as binding
            where binding.organization_id = context_organization_id
              and binding.application_root_id = default_application_root_id_value
              and binding.application_release_revision = registration.source_revision
              and binding.state = 'active'
          )
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
  end if;

  select updated.* into strict saved
  from vortex_identity.save_organization_runtime_settings_record_internal(
    context_organization_id, p_expected_revision, p_core_values, p_extension_values
  ) as updated;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', saved.organization_id,
    'concurrencyNumber', saved.revision,
    'correlationId', context_correlation_id
  );
exception
  when serialization_failure or deadlock_detected then
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_access.save_organization_settings_record_for_administration(
  uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.save_organization_settings_record_for_administration(
  uuid, bigint, jsonb, jsonb
) to vortex_record_adapter;

comment on function vortex_access.save_organization_settings_record_for_administration(
  uuid, bigint, jsonb, jsonb
) is
  'Protected organisation settings record writer requiring runtime-settings.manage and an exact current revision; the request organisation supplies the singleton identity and extensions are merged with the invariant settings in one transaction.';
