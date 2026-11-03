create or replace function vortex_definition.require_system_application_step_up_internal()
returns void
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
      'operationKey', 'platform.organization.system_applications.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.system_applications.manage'
      ),
      'recentAuthentication',
        pg_catalog.jsonb_build_object('kind', 'multi_factor', 'maximumAgeSeconds', 3600),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  -- A platform system Application carries the steward's way to manage access: publishing or
  -- discarding a change to it needs a recent two-step verification, as the role and group
  -- changes do.
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.system_applications.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id
      is distinct from (context_value ->> 'organizationAccountId')::uuid
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Changing a platform application needs a recent two-step verification',
      hint = 'multi_factor_required';
  end if;
end
$function$;

alter function vortex_definition.require_system_application_step_up_internal()
  owner to vortex_owner;

revoke all on function vortex_definition.require_system_application_step_up_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.require_system_application_step_up_internal()
  to postgres;

comment on function vortex_definition.require_system_application_step_up_internal() is
  'Private step-up for publishing or discarding a change to a platform system Application: the current person holds system_applications.manage with a two-step verification within the hour.';
