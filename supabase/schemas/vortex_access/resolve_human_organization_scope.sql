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
  eligible_account_id uuid;
  resolved_access_version bigint;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_account_id, resolved_access_version
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = identity.identity_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
    and (
      account.state = 'active'
      or (account.organization_account_id is null
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null)
    )
  for share of version;

  if not found then
    if exists (
      select 1
      from vortex_identity.identity_projections as identity
      join vortex_identity.organizations as organization
        on organization.organization_id = p_organization_id
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = organization.organization_id
        and account.identity_id = identity.identity_id
      where identity.identity_id = p_identity_id
        and identity.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
        and account.state = 'suspended'
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null
    ) then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id
  into resolved_tenant_id, resolved_organization_id, resolved_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id, p_organization_id
  ) as scope;
  if not found
    or resolved_tenant_id is distinct from eligible_tenant_id
    or resolved_organization_id is distinct from eligible_organization_id
    or (eligible_account_id is not null
      and resolved_account_id is distinct from eligible_account_id) then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_account_id, resolved_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_organization_scope(uuid, uuid) is
  'Resolves one active account-bound organisation scope under its Access lock, provisioning missing local accounts only for assigned Vortex super administrators.';
