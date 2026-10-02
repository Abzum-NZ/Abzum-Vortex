create or replace function vortex_identity.organization_and_tenant_are_active_internal(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id = p_organization_id
      and organization.state = 'active'
      and tenant.state = 'active'
  );
$function$;

revoke all on function vortex_identity.organization_and_tenant_are_active_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.organization_and_tenant_are_active_internal(uuid)
  to vortex_invalidation_owner;

comment on function vortex_identity.organization_and_tenant_are_active_internal(uuid) is
  'Private exact active organisation and tenant liveness predicate; exposes no account, actor or tenant data.';

alter function vortex_identity.organization_and_tenant_are_active_internal(uuid)
  owner to vortex_identity_owner;
