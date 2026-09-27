create or replace function vortex_access.read_own_profile()
returns table (
  organization_account_id uuid,
  revision bigint,
  display_name text,
  language text,
  time_zone text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  checked_access_version bigint;
  own_account vortex_identity.organization_accounts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;

  if context_value ? 'delegatedContext' or context_value ? 'supportContext' then
    raise exception using errcode = '42501',
      message = 'Organization account profile read is unavailable';
  end if;

  select version.current_version into checked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active';
  if not found or checked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization account profile read is unavailable';
  end if;

  select account.* into own_account
  from vortex_identity.organization_accounts as account
  where account.organization_id = context_organization_id
    and account.organization_account_id = context_account_id
    and account.state = 'active';
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization account profile read is unavailable';
  end if;

  return query select own_account.organization_account_id, own_account.revision,
    own_account.display_name, own_account.language, own_account.time_zone;
end
$function$;

revoke all on function vortex_access.read_own_profile()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.read_own_profile() to vortex_request;

comment on function vortex_access.read_own_profile() is
  'Protected read of the current human request context account profile, limited to that active organisation account and refusing delegated or support contexts.';
