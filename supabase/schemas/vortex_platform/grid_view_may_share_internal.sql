create or replace function vortex_platform.grid_view_may_share_internal()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decided text;
begin
  select decision.outcome into decided
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.records.views.share',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.records.views.share'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as decision;
  return decided = 'eligible';
end
$function$;

revoke all on function vortex_platform.grid_view_may_share_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_platform.grid_view_may_share_internal() owner to vortex_owner;
