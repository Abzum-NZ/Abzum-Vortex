create or replace function vortex_access.organization_permissions_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', vortex_access.required_platform_permission('platform.organization.permissions.read'),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization permission catalogue is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

revoke execute on function vortex_access.organization_permissions_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.organization_permissions_administration_scope() is
  'Private fixed permissions-read authorization for the current registered permission catalogue.';

alter function vortex_access.organization_permissions_administration_scope() owner to vortex_owner;
