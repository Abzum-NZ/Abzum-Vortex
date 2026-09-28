create or replace function vortex_identity.accept_organization_invitation_with_transition(
  p_token_fingerprint text,
  p_identity_id uuid,
  p_verified_email text,
  p_display_name text,
  p_correlation_id uuid
)
returns table (
  outcome text,
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
  revision bigint,
  access_transition text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  candidate_organization_id uuid;
  prior_account_state text;
  classified_transition text := 'unchanged';
  accepted record;
begin
  select invitation.organization_id into candidate_organization_id
  from vortex_identity.organization_invitations as invitation
  where invitation.token_fingerprint = p_token_fingerprint
    and invitation.invited_email = p_verified_email
  for update;

  if found then
    select account.state into prior_account_state
    from vortex_identity.organization_accounts as account
    where account.organization_id = candidate_organization_id
      and account.identity_id = p_identity_id
    for update;

    if not found then
      classified_transition := 'activated';
    elsif prior_account_state <> 'active' then
      classified_transition := 'reactivated';
    end if;
  end if;

  select * into accepted
  from vortex_identity.accept_organization_invitation(
    p_token_fingerprint,
    p_identity_id,
    p_verified_email,
    p_display_name,
    p_correlation_id
  );

  if accepted.outcome <> 'accepted' then
    classified_transition := 'unchanged';
  end if;

  return query
  select accepted.outcome, accepted.organization_account_id, accepted.organization_id,
    accepted.identity_id, accepted.display_name, accepted.state, accepted.language,
    accepted.time_zone, accepted.invitation_id, accepted.activated_at,
    accepted.suspended_at, accepted.closed_at, accepted.changed_at,
    accepted.state_changed_at, accepted.state_changed_by,
    accepted.state_change_correlation_id, accepted.revision, classified_transition;
end
$function$;

revoke all on function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.accept_organization_invitation_with_transition(
  text, uuid, text, text, uuid
) is 'Owner-only Identity invitation transition with explicit Access change classification.';

alter function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.accept_organization_invitation_with_transition(text, uuid, text, text, uuid) to postgres;
reset role;
