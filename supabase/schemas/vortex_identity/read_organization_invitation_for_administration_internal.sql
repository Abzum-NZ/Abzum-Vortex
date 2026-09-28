create or replace function vortex_identity.read_organization_invitation_for_administration_internal(
  p_organization_id uuid,
  p_invitation_id uuid
)
returns table (
  outcome text,
  invitation jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_invitation_id is null
    or p_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'invitationId', invitation.invitation_id,
    'organizationId', invitation.organization_id,
    'invitedEmail', invitation.invited_email,
    'invitedBy', invitation.invited_by_organization_account_id,
    'createdAt', invitation.created_at,
    'invitedAt', invitation.invited_at,
    'expiresAt', invitation.expires_at,
    'revokedAt', invitation.revoked_at,
    'revokedBy', invitation.revoked_by_organization_account_id,
    'acceptedAt', invitation.accepted_at,
    'acceptedOrganizationAccountId', invitation.accepted_organization_account_id,
    'changedAt', invitation.changed_at,
    'revision', invitation.revision
  ))
  into invitation_value
  from vortex_identity.organization_invitations as invitation
  where invitation.organization_id = p_organization_id
    and invitation.invitation_id = p_invitation_id;

  return query select
    case when invitation_value is null then 'unavailable' else 'available' end,
    invitation_value;
end
$function$;

revoke all on function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_organization_invitation_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe invitation projection without secret or fingerprint.';

alter function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.read_organization_invitation_for_administration_internal(uuid, uuid) to postgres;
reset role;
