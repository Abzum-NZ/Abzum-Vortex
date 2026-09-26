create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid,
  p_active_members_only boolean
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  -- Two fixed visibility modes, chosen only by the Access-owned reader. The
  -- administration mode returns every account of the organisation. The member
  -- mode applies today's account-choice rule: only active accounts whose
  -- identity, organisation and tenant are active, and only the display name and
  -- state, exactly the facts any active member may already list.
  select account.organization_account_id, account.display_name, account.state,
    case when p_active_members_only then null else account.language end,
    case when p_active_members_only then null else account.time_zone end,
    account.revision
  from vortex_identity.organization_accounts as account
  join vortex_identity.identity_projections as projection
    on projection.identity_id = account.identity_id
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where account.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and p_active_members_only is not null
    and (
      not p_active_members_only
      or (
        account.state = 'active'
        and projection.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
      )
    )
  order by account.organization_account_id
$function$;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_accounts_projection_internal(uuid, boolean) is
  'Identity-owned set-returning safe organisation-account projection bounded to the given organisation: every account in administration mode, or only active accounts with their display name and state in member mode; identity, originating invitation and state-change evidence are never exposed, and the already-decided request scope is the only visibility.';
