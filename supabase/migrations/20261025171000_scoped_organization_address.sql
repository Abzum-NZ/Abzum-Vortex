set local role vortex_owner;

create or replace function vortex_identity.read_organization_at_address(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text
)
returns table (
  organization_id uuid,
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
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_tenant_short_name is null
    or p_organization_short_name is null then
    raise exception using errcode = '22023',
      message = 'Organization address is invalid';
  end if;

  if not exists (
    select 1 from vortex_identity.identity_projections as identity
    where identity.identity_id = p_identity_id and identity.state = 'active'
  ) then
    raise exception using errcode = '42501',
      message = 'Organization address identity is unavailable';
  end if;
  is_super_administrator :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      p_identity_id, evaluated_at
    ) is not null;

  return query
  select organization.organization_id, account.display_name
  from vortex_identity.tenants as tenant
  join vortex_identity.organizations as organization
    on organization.tenant_id = tenant.tenant_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = p_identity_id
  where tenant.short_name = p_tenant_short_name
    and organization.short_name = p_organization_short_name
    and organization.state = 'active'
    and tenant.state = 'active'
    and (
      (account.organization_account_id is not null and account.state = 'active')
      or is_super_administrator
    );
end
$function$;

revoke execute on function vortex_identity.read_organization_at_address(uuid, text, text)
  from public, anon, authenticated, service_role, vortex_request;

grant execute on function vortex_identity.read_organization_at_address(uuid, text, text)
  to vortex_runtime;

comment on function vortex_identity.read_organization_at_address(uuid, text, text) is
  'Returns only the addressed active organization and account label for an active local account or a named Vortex super administrator.';

alter function vortex_identity.read_organization_at_address(uuid, text, text) owner to vortex_owner;

grant execute on function vortex_identity.read_organization_at_address(uuid, text, text) to postgres;

reset role;
