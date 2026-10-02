create or replace function vortex_identity.has_active_identity_organization_account_internal(
  p_identity_id uuid,
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
    from vortex_identity.identity_projections as projection
    join vortex_identity.organization_accounts as account
      on account.identity_id = projection.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where projection.identity_id = p_identity_id
      and organization.organization_id = p_organization_id
      and projection.state = 'active'
      and account.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
  );
$function$;

revoke all on function vortex_identity.has_active_identity_organization_account_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.has_active_identity_organization_account_internal(uuid, uuid)
  to vortex_invalidation_owner;

comment on function vortex_identity.has_active_identity_organization_account_internal(uuid, uuid) is
  'Private exact active Identity account membership predicate for one identity and organisation; exposes only its Boolean liveness result.';

alter function vortex_identity.has_active_identity_organization_account_internal(uuid, uuid)
  owner to vortex_identity_owner;
