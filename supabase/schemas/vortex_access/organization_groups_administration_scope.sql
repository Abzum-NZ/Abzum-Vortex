create or replace function vortex_access.organization_groups_administration_scope()
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
      'operationKey', 'platform.organization.groups.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '290ae49f-4cab-4159-9c20-6e664f07d50b'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization Group administration is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

revoke execute on function vortex_access.organization_groups_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.organization_groups_administration_scope()
  to postgres;

comment on function vortex_access.organization_groups_administration_scope() is
  'Private fixed teams-read authorization for protected Group administration projections.';

alter function vortex_access.organization_groups_administration_scope()
  owner to vortex_access_owner;
