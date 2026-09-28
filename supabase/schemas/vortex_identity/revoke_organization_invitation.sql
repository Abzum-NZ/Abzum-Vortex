create or replace function vortex_identity.revoke_organization_invitation(
  p_invitation_id uuid,
  p_expected_revision bigint
)
returns table (
  invitation_id uuid,
  organization_id uuid,
  invited_email text,
  invited_by uuid,
  created_at timestamptz,
  invited_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  accepted_at timestamptz,
  accepted_organization_account_id uuid,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  checked := vortex_identity.validated_human_account_context();

  return query
  update vortex_identity.organization_invitations as invitation
  set revoked_at = operation_at,
      revoked_by_organization_account_id = (checked ->> 'organizationAccountId')::uuid,
      changed_at = operation_at,
      revision = invitation.revision + 1
  where invitation.invitation_id = p_invitation_id
    and invitation.organization_id = (checked ->> 'organizationId')::uuid
    and invitation.revision = p_expected_revision
    and invitation.accepted_at is null
    and invitation.revoked_at is null
  returning invitation.invitation_id, invitation.organization_id, invitation.invited_email,
    invitation.invited_by_organization_account_id, invitation.created_at,
    invitation.invited_at, invitation.expires_at, invitation.revoked_at,
    invitation.revoked_by_organization_account_id, invitation.accepted_at,
    invitation.accepted_organization_account_id, invitation.changed_at,
    invitation.revision;

  if not found then
    raise exception using errcode = '40001', message = 'Invitation is stale or unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.revoke_organization_invitation(uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.revoke_organization_invitation(uuid, bigint) is null;

grant execute on function vortex_identity.revoke_organization_invitation(uuid, bigint) to postgres;
alter function vortex_identity.revoke_organization_invitation(uuid, bigint) owner to vortex_identity_owner;
