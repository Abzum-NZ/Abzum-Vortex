-- Add the application-bound form of the delivered human organisation resolver.
-- The existing resolver acquires the Access lock before Identity locks. This
-- wrapper preserves that order and checks application availability while the
-- organisation's Access version remains locked for the transaction.
create function vortex_access.resolve_human_application_scope(
  p_identity_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  application_root_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  if not exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = resolved_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = p_application_root_id
      and registration.state = 'active'
  ) then
    raise exception using errcode = '42501',
      message = 'Application selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_application_scope(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_human_application_scope(uuid, uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_application_scope(uuid, uuid, uuid) is
  'Resolves one exact active human organisation scope and active application registration under the organisation Access lock.';
