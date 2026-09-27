create or replace function vortex_access.organization_runtime_settings_manage_is_current()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  decision record;
begin
  context_value := vortex_access.validated_human_request_context();
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
  return decision.outcome = 'eligible'
    and decision.operation_key = 'platform.organization.runtime_settings.update'
    and decision.organization_id = (context_value ->> 'organizationId')::uuid
    and decision.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and decision.access_version = (context_value ->> 'accessVersion')::bigint
    and decision.correlation_id = (context_value ->> 'correlationId')::uuid;
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or invalid_text_representation then
    return false;
end
$function$;

revoke all on function vortex_access.organization_runtime_settings_manage_is_current()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.organization_runtime_settings_manage_is_current()
  to vortex_record_adapter;

comment on function vortex_access.organization_runtime_settings_manage_is_current() is
  'Checks the verified request for the current platform.organization.runtime_settings.manage permission and returns only the exact eligibility result.';
