create or replace function vortex_identity.create_organization_invitation(
  p_invited_email text,
  p_token_fingerprint text,
  p_expires_at timestamptz
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
  new_invitation_id uuid;
begin
  checked := vortex_identity.validated_human_account_context();
  if p_invited_email is null
    or p_invited_email is distinct from pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Invitation input is invalid';
  end if;

  loop
    new_invitation_id := pg_catalog.gen_random_uuid();
    exit when new_invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, token_fingerprint,
    invited_by_organization_account_id, created_at, invited_at, expires_at,
    changed_at, revision
  ) values (
    new_invitation_id, (checked ->> 'organizationId')::uuid, p_invited_email,
    p_token_fingerprint, (checked ->> 'organizationAccountId')::uuid,
    operation_at, operation_at, p_expires_at, operation_at, 1
  );

  return query
  select invitation.invitation_id, invitation.organization_id, invitation.invited_email,
    invitation.invited_by_organization_account_id, invitation.created_at,
    invitation.invited_at, invitation.expires_at, invitation.revoked_at,
    invitation.revoked_by_organization_account_id, invitation.accepted_at,
    invitation.accepted_organization_account_id, invitation.changed_at,
    invitation.revision
  from vortex_identity.organization_invitations as invitation
  where invitation.invitation_id = new_invitation_id;
end
$function$;

revoke all on function vortex_identity.create_organization_invitation(text, text, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.create_organization_invitation(text, text, timestamptz) is null;

alter function vortex_identity.create_organization_invitation(text, text, timestamptz) owner to vortex_identity_owner;
grant execute on function vortex_identity.create_organization_invitation(text, text, timestamptz) to postgres;
