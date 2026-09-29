create or replace function vortex_identity.validate_tenant_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_state text;
begin
  select tenant.state
  into current_state
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id;

  if not found then
    return null;
  end if;

  if current_state in ('archived', 'removal_pending')
    and exists (
      select 1
      from vortex_identity.organizations as organization
      where organization.tenant_id = new.tenant_id
        and organization.state in ('active', 'suspended')
    ) then
    raise exception using
      errcode = '23514',
      message = 'An archived or removal-pending tenant cannot retain unresolved organisations';
  end if;

  return null;
end
$function$;

revoke execute on function vortex_identity.validate_tenant_lifecycle() from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.validate_tenant_lifecycle() is null;

alter function vortex_identity.validate_tenant_lifecycle() owner to vortex_identity_owner;
