-- #1016: carry the tenant and organisation short names in the launcher entry.
--
-- The sign-in launcher resolves an identity's active organisation accounts and
-- now links each one straight to the canonical /{tenant}/{organisation} address
-- so the address page can open the default application. That address needs the
-- tenant and organisation short names, which the original launcher read
-- (20260905043000_organization_request_context.sql) did not return.
--
-- The output columns of a returns-table function are part of its signature, so
-- the live reader is dropped and reinstalled with its complete current body plus
-- the two short-name columns. Everything else (active-state filtering, ordering,
-- security definer, search path and access control) is unchanged.

drop function vortex_identity.list_organization_launcher(uuid);

create function vortex_identity.list_organization_launcher(p_identity_id uuid)
returns table (
  organization_id uuid,
  tenant_short_name text,
  tenant_display_name text,
  organization_short_name text,
  organization_display_name text,
  account_display_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Launcher identity is invalid';
  end if;

  return query
  select organization.organization_id, tenant.short_name, tenant.display_name,
    organization.short_name, organization.display_name, account.display_name
  from vortex_identity.identity_projections as projection
  join vortex_identity.organization_accounts as account
    on account.identity_id = projection.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where projection.identity_id = p_identity_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  order by tenant.display_name, tenant.tenant_id,
    organization.display_name, organization.organization_id,
    account.display_name nulls last, account.organization_account_id;
end
$function$;

revoke execute on function vortex_identity.list_organization_launcher(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.list_organization_launcher(uuid)
  to vortex_runtime;
comment on function vortex_identity.list_organization_launcher(uuid) is
  'Returns only safe labels, organisation identifiers and the tenant/organisation short names for one active identity launcher.';
