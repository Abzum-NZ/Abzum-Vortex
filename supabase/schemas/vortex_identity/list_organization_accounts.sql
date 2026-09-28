create or replace function vortex_identity.list_organization_accounts(p_identity_id uuid)
returns table (
  organization_account_id uuid,
  organization_id uuid,
  identity_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  invitation_id uuid,
  activated_at timestamptz,
  suspended_at timestamptz,
  closed_at timestamptz,
  changed_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select account.organization_account_id, account.organization_id, account.identity_id,
    account.display_name, account.state, account.language, account.time_zone,
    account.originating_invitation_id, account.activated_at, account.suspended_at,
    account.closed_at, account.changed_at, account.state_changed_at,
    account.state_changed_by, account.state_change_correlation_id, account.revision
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection
    on projection.identity_id = account.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where account.identity_id = p_identity_id
    and projection.state = 'active'
    and account.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  order by account.organization_id, account.organization_account_id
$function$;

revoke all on function vortex_identity.list_organization_accounts(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_accounts(uuid) is null;

alter function vortex_identity.list_organization_accounts(uuid) owner to vortex_identity_owner;
