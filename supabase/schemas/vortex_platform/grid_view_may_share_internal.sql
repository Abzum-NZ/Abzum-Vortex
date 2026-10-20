create or replace function vortex_platform.grid_view_may_share_internal(
  p_application_root_id uuid,
  p_share_permission jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decided text;
begin
  -- The permission the table names for sharing is decided now, for the person of this request.
  if p_share_permission is null
    or pg_catalog.jsonb_typeof(p_share_permission) <> 'object'
    or not p_share_permission ?& array['ownerKind', 'ownerId', 'permissionId', 'actionKind']
    or p_share_permission ->> 'ownerKind' not in ('application', 'module')
    or not vortex_platform.is_non_nil_uuid(p_share_permission ->> 'ownerId')
    or not vortex_platform.is_non_nil_uuid(p_share_permission ->> 'permissionId')
    or p_share_permission ->> 'applicationRootId' is distinct from p_application_root_id::text then
    return false;
  end if;

  select decision.outcome into decided
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'application.grid_view.share',
      'action', pg_catalog.jsonb_build_object('actionKind', p_share_permission ->> 'actionKind')
        || case when p_share_permission ? 'namedAction'
          then pg_catalog.jsonb_build_object('namedAction', p_share_permission ->> 'namedAction')
          else '{}'::jsonb end,
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', p_application_root_id),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'applicationRootId', p_application_root_id,
        'ownerKind', p_share_permission ->> 'ownerKind',
        'ownerId', p_share_permission ->> 'ownerId',
        'permissionId', p_share_permission ->> 'permissionId'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as decision;
  return decided = 'eligible';
end
$function$;

revoke all on function vortex_platform.grid_view_may_share_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_may_share_internal(uuid, jsonb) is
  'Whether the person of this request holds the application permission that lets them share table views now; owner-only.';

alter function vortex_platform.grid_view_may_share_internal(uuid, jsonb) owner to vortex_owner;
