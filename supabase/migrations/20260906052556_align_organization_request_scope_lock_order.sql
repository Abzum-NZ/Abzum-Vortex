-- Align the request resolver with Access-first protected writers. The initial
-- Identity probe acquires no row locks, so an ineligible or foreign scope cannot
-- hold another organisation's governance row. The authoritative Identity helper
-- rechecks and locks the exact same scope only after Access is held.
create or replace function vortex_access.resolve_human_organization_scope(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
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
  eligible_tenant_id uuid;
  eligible_organization_id uuid;
  eligible_organization_account_id uuid;
  resolved_access_version bigint;
  authoritative_tenant_id uuid;
  authoritative_organization_id uuid;
  authoritative_organization_account_id uuid;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Organisation selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_organization_account_id, resolved_access_version
  from vortex_identity.identity_projections as projection
  join vortex_identity.organization_accounts as account
    on account.identity_id = projection.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where projection.identity_id = p_identity_id
    and organization.organization_id = p_organization_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of version;

  if not found then
    raise exception using errcode = '42501', message = 'Organisation selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id, scope.organization_account_id
  into authoritative_tenant_id, authoritative_organization_id,
    authoritative_organization_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id,
    p_organization_id
  ) as scope;

  if not found
    or authoritative_tenant_id is distinct from eligible_tenant_id
    or authoritative_organization_id is distinct from eligible_organization_id
    or authoritative_organization_account_id is distinct from
      eligible_organization_account_id then
    raise exception using errcode = '42501', message = 'Organisation selection is unavailable';
  end if;

  return query select authoritative_tenant_id, authoritative_organization_id,
    authoritative_organization_account_id, resolved_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_organization_scope(uuid, uuid) is
  'Resolves one exact active Identity scope after locking its Access version first, then authoritatively rechecks that same scope.';
