begin;

alter function vortex_access.organization_accounts_administration_scope() owner to vortex_access_owner;
set local role vortex_access_owner;

create or replace function vortex_access.organization_accounts_administration_scope()
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
      'operationKey', 'platform.organization.accounts.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '02c772e5-2921-4300-ad90-4f5772a7fa46'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.accounts.read'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null then
    raise exception using errcode = '42501',
      message = 'Organization account administration is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

comment on function vortex_access.organization_accounts_administration_scope() is null;

alter function vortex_access.organization_accounts_administration_scope() owner to vortex_access_owner;

revoke execute on function vortex_access.organization_accounts_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

grant execute on function vortex_access.organization_accounts_administration_scope() to postgres;

reset role;
commit;
