create or replace function vortex_definition.require_custom_code_manage_internal(p_recent_sign_in boolean)
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
      'operationKey', 'platform.organization.custom_code.manage',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission(
        'platform.organization.custom_code.manage'
      ),
      -- The recent sign-in the TypeScript builder authority asks of an installation of custom code;
      -- an uninstall asks for none.
      'recentAuthentication', case when p_recent_sign_in
        then pg_catalog.jsonb_build_object('kind', 'primary', 'maximumAgeSeconds', 900)
        else pg_catalog.jsonb_build_object('kind', 'none') end,
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  -- Missing permission is named before a stale sign-in: signing in again cannot help without it.
  if decision.outcome = 'refused' and decision.reason_code = 'authentication_unsatisfied' then
    raise exception using errcode = 'V3150',
      message = 'Changing custom code needs a recent sign-in';
  end if;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.custom_code.manage'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.access_version is distinct from (context_value ->> 'accessVersion')::bigint
    or decision.organization_id is distinct from (context_value ->> 'organizationId')::uuid
    or decision.organization_account_id
      is distinct from (context_value ->> 'organizationAccountId')::uuid
    or decision.correlation_id is distinct from (context_value ->> 'correlationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Changing custom code needs the custom code permission';
  end if;
end
$function$;

alter function vortex_definition.require_custom_code_manage_internal(boolean)
  owner to vortex_owner;

revoke all on function vortex_definition.require_custom_code_manage_internal(boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.require_custom_code_manage_internal(boolean)
  to postgres;

comment on function vortex_definition.require_custom_code_manage_internal(boolean) is
  'Private check for installing, upgrading from or to, or uninstalling an Application that places custom components: the current person holds platform.organization.custom_code.manage and, when asked, signed in within 15 minutes.';
