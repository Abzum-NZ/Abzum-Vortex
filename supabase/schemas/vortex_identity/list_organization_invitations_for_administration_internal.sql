create or replace function vortex_identity.list_organization_invitations_for_administration_internal(
  p_organization_id uuid,
  p_after_invitation_id uuid,
  p_page_size integer
)
returns table (
  invitations jsonb,
  next_after_invitation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  invitation_items jsonb;
  page_invitation_ids uuid[];
  candidate_count integer;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_page_size is null
    or p_page_size not between 1 and 100
    or p_after_invitation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization invitation administration page input is invalid';
  end if;

  with candidates as (
    select invitation.invitation_id, invitation.organization_id,
      invitation.invited_email, invitation.invited_by_organization_account_id,
      invitation.created_at, invitation.invited_at, invitation.expires_at,
      invitation.revoked_at, invitation.revoked_by_organization_account_id,
      invitation.accepted_at, invitation.accepted_organization_account_id,
      invitation.changed_at, invitation.revision,
      pg_catalog.row_number() over (order by invitation.invitation_id) as ordinal
    from vortex_identity.organization_invitations as invitation
    where invitation.organization_id = p_organization_id
      and (
        p_after_invitation_id is null
        or invitation.invitation_id > p_after_invitation_id
      )
    order by invitation.invitation_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'invitationId', candidate.invitation_id,
          'organizationId', candidate.organization_id,
          'invitedEmail', candidate.invited_email,
          'invitedBy', candidate.invited_by_organization_account_id,
          'createdAt', candidate.created_at,
          'invitedAt', candidate.invited_at,
          'expiresAt', candidate.expires_at,
          'revokedAt', candidate.revoked_at,
          'revokedBy', candidate.revoked_by_organization_account_id,
          'acceptedAt', candidate.accepted_at,
          'acceptedOrganizationAccountId', candidate.accepted_organization_account_id,
          'changedAt', candidate.changed_at,
          'revision', candidate.revision
        )) order by candidate.invitation_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.invitation_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into invitation_items, page_invitation_ids, candidate_count
  from candidates as candidate;

  return query select invitation_items,
    case when candidate_count > p_page_size
      then page_invitation_ids[p_page_size] else null end;
end
$function$;

revoke all on function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_invitations_for_administration_internal(
  uuid, uuid, integer
) is 'Identity-owned bounded organisation-scoped safe invitation projection without secret or fingerprint.';

alter function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.list_organization_invitations_for_administration_internal(uuid, uuid, integer) to postgres;
reset role;
