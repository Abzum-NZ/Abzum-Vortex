create or replace function vortex_module.assert_preview_installation_authority_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  checked_context jsonb;
begin
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.definition_drafts.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '0548c061-b1a9-48e5-a04a-eb1d0dae0644'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  checked_context := vortex_access.validated_human_request_context();
  if permission_decision.outcome is distinct from 'eligible'
    or checked_context is null
    or (checked_context ->> 'organizationId')::uuid
      is distinct from permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid
      is distinct from permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint
      is distinct from permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid
      is distinct from permission_decision.correlation_id then
    raise exception using errcode = '42501', message = 'Preview installation authority is unavailable';
  end if;
  return checked_context;
end
$function$;

alter function vortex_module.assert_preview_installation_authority_internal() owner to vortex_module_owner;

revoke all on function vortex_module.assert_preview_installation_authority_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_module.assert_preview_installation_authority_internal()
  to vortex_module_owner;
comment on function vortex_module.assert_preview_installation_authority_internal() is
  'Validates the current human request context and definition-draft management permission for private preview installation operations.';
