create or replace function vortex_platform.assert_connection_administration_authority(
  p_context jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
  operation_value constant text := 'platform.organization.connections.manage';
  failure_sqlstate text;
  failure_message text;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_value,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', vortex_access.platform_permission_owner_id(),
        'permissionId', vortex_access.platform_permission_id('platform.organization.connections.manage')
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_value
    or decision.organization_id is distinct from (p_context ->> 'organizationId')::uuid
    or decision.organization_account_id is distinct from
      (p_context ->> 'organizationAccountId')::uuid
    or decision.access_version is distinct from (p_context ->> 'accessVersion')::bigint
    or decision.correlation_id is distinct from (p_context ->> 'correlationId')::uuid then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  end if;
exception
  -- Only a refused permission decision is the safe denial; any other failure
  -- is a defect and keeps its SQLSTATE and message.
  when sqlstate '42501' then
    raise exception using
      errcode = '42501',
      message = 'Connection administration is unavailable';
  when others then
    get stacked diagnostics failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise warning 'Connection administration authority check failed: SQLSTATE %, %',
      failure_sqlstate, failure_message;
    raise;
end
$function$;

revoke all on function vortex_platform.assert_connection_administration_authority(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_platform.assert_connection_administration_authority(jsonb) is null;
alter function vortex_platform.assert_connection_administration_authority(jsonb) owner to vortex_owner;
