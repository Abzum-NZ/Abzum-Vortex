create or replace function vortex_identity.list_organization_launcher(p_identity_id uuid)
returns table (
  organization_id uuid,
  tenant_short_name text,
  tenant_display_name text,
  organization_short_name text,
  organization_display_name text,
  account_display_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  is_super_administrator boolean;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Launcher identity is invalid';
  end if;

  if not exists (
    select 1 from vortex_identity.identity_projections as identity
    where identity.identity_id = p_identity_id and identity.state = 'active'
  ) then
    raise exception using errcode = '42501',
      message = 'Launcher identity is unavailable';
  end if;
  is_super_administrator :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      p_identity_id, evaluated_at
    ) is not null;

  return query
  select organization.organization_id, tenant.short_name,
    tenant.display_name, organization.short_name,
    organization.display_name, account.display_name
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = p_identity_id
  where organization.state = 'active'
    and tenant.state = 'active'
    and (
      (account.organization_account_id is not null and account.state = 'active')
      or is_super_administrator
    )
  order by tenant.display_name, tenant.tenant_id,
    organization.display_name, organization.organization_id,
    account.display_name nulls last, account.organization_account_id;
end
$function$;

revoke execute on function vortex_identity.list_organization_launcher(uuid)
  from public, anon, authenticated, service_role, vortex_request;

grant execute on function vortex_identity.list_organization_launcher(uuid)
  to vortex_runtime;

comment on function vortex_identity.list_organization_launcher(uuid) is
  'Returns safe organisation labels for active local accounts and every active organisation available to a named Vortex super administrator.';
