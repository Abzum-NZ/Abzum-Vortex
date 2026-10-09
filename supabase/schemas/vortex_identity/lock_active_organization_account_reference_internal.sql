-- Private Identity projection lock for a Record-owned person-reference purpose.
create or replace function vortex_identity.lock_active_organization_account_reference_internal(
  p_tenant_id uuid, p_organization_id uuid, p_organization_account_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare locked_id uuid;
begin
  if p_tenant_id is null or p_organization_id is null or p_organization_account_id is null
    or p_tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  select account.organization_account_id into locked_id
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection on projection.identity_id = account.identity_id
  join vortex_identity.organizations as organization on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where account.organization_account_id = p_organization_account_id
    and account.organization_id = p_organization_id and tenant.tenant_id = p_tenant_id
    and account.state = 'active' and projection.state = 'active'
    and organization.state = 'active' and tenant.state = 'active'
  for share of account, projection;
  return found and locked_id = p_organization_account_id;
end
$function$;
alter function vortex_identity.lock_active_organization_account_reference_internal(uuid,uuid,uuid)
  owner to vortex_identity_owner;
revoke all on function vortex_identity.lock_active_organization_account_reference_internal(uuid,uuid,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.lock_active_organization_account_reference_internal(uuid,uuid,uuid)
  to vortex_record_adapter;
comment on function vortex_identity.lock_active_organization_account_reference_internal(uuid,uuid,uuid)
  is 'Private Identity-owned active same-tenant organisation-account and identity SHARE lock; the Record adapter supplies a protected named-action purpose and locks candidate account ids in ascending order. Returns only existence, never identity contents.';