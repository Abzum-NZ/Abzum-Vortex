create or replace function vortex_identity.list_organization_invitations_projection_internal(
  p_organization_id uuid
)
returns table (
  invitation_id uuid,
  invited_email text,
  invitation_state text,
  invited_at timestamptz,
  expires_at timestamptz,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select invitation.invitation_id, invitation.invited_email,
    case
      when invitation.accepted_at is not null then 'accepted'
      when invitation.revoked_at is not null then 'revoked'
      when invitation.expires_at <= pg_catalog.statement_timestamp() then 'expired'
      else 'pending'
    end,
    invitation.invited_at, invitation.expires_at, invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  order by invitation.invitation_id
$function$;

revoke all on function vortex_identity.list_organization_invitations_projection_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_invitations_projection_internal(uuid) is
  'Identity-owned set-returning safe organisation-invitation projection bounded to the given organisation: the raw invitation secret and its stored fingerprint are never exposed, and the already-decided request scope is the only visibility.';
