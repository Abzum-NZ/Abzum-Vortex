create or replace function vortex_identity.create_organization_invitation(
  p_invited_email text,
  p_expires_at timestamptz,
  p_role_intents jsonb
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
    or p_expires_at <= operation_at
    or pg_catalog.jsonb_typeof(p_role_intents) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_role_intents) = 0 then
    raise exception using errcode = '22023', message = 'Invitation input is invalid';
  end if;

  -- One pending invitation per email and organisation: inviting again while one waits is refused.
  -- Invitations of one email to one organisation are serialised, so two at once cannot both pass.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f',
      checked ->> 'organizationId', p_invited_email), 3584)
  );
  if exists (
    select 1
    from vortex_identity.organization_invitations as pending
    where pending.organization_id = (checked ->> 'organizationId')::uuid
      and pending.invited_email = p_invited_email
      and pending.accepted_at is null
      and pending.revoked_at is null
      and pending.expires_at > operation_at
  ) then
    raise exception using errcode = '23505', message = 'Invitation is already pending';
  end if;

  loop
    new_invitation_id := pg_catalog.gen_random_uuid();
    exit when new_invitation_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end loop;

  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, invited_by_organization_account_id,
    created_at, invited_at, expires_at, changed_at, revision, role_intents
  ) values (
    new_invitation_id, (checked ->> 'organizationId')::uuid, p_invited_email,
    (checked ->> 'organizationAccountId')::uuid,
    operation_at, operation_at, p_expires_at, operation_at, 1, p_role_intents
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

revoke all on function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) is null;

alter function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) owner to vortex_owner;
grant execute on function vortex_identity.create_organization_invitation(text, timestamptz, jsonb) to postgres;
