create or replace function vortex_access.list_pending_invitations_for_identity(
  p_identity_id uuid,
  p_verified_email text
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  organization_display_name text,
  tenant_display_name text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_verified_email is null
    or p_verified_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_verified_email)) then
    raise exception using errcode = '22023', message = 'Pending invitation lookup is invalid';
  end if;
  -- The invitations a signed-in person may accept: sent to their verified email, still pending,
  -- in an active organisation where they hold no active account. At most 20, soonest expiry first.
  return query
  select invitation.invitation_id, invitation.organization_id, organization.display_name,
    tenant.display_name, invitation.expires_at
  from vortex_identity.organization_invitations as invitation
  join vortex_identity.organizations as organization
    on organization.organization_id = invitation.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where invitation.invited_email = p_verified_email
    and invitation.accepted_at is null
    and invitation.revoked_at is null
    and invitation.expires_at > pg_catalog.statement_timestamp()
    and organization.state = 'active'
    and tenant.state = 'active'
    and not exists (
      select 1
      from vortex_identity.organization_accounts as account
      where account.organization_id = invitation.organization_id
        and account.identity_id = p_identity_id
        and account.state = 'active'
    )
  order by invitation.expires_at, invitation.invitation_id
  limit 20;
end
$function$;

revoke all on function vortex_access.list_pending_invitations_for_identity(uuid, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
-- The server reads it for the verified identity of the signed-in session, outside any
-- organisation request (the person has no organisation account yet).
grant execute on function vortex_access.list_pending_invitations_for_identity(uuid, text)
  to vortex_runtime, postgres;
alter function vortex_access.list_pending_invitations_for_identity(uuid, text) owner to vortex_owner;
