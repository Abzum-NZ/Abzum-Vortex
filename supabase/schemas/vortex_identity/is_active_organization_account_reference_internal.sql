create or replace function vortex_identity.is_active_organization_account_reference_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where tenant.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and account.organization_account_id = p_organization_account_id
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
  )
$function$;

revoke all on function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) to vortex_record_adapter;

comment on function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) is null;

alter function vortex_identity.is_active_organization_account_reference_internal(uuid, uuid, uuid) owner to vortex_identity_owner;
