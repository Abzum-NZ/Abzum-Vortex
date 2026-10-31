create or replace function vortex_identity.identity_session_is_current(
  p_identity_id uuid,
  p_session_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from auth.sessions as provider_session
    where provider_session.id = p_session_id
      and provider_session.user_id = p_identity_id
  )
$function$;

revoke all on function vortex_identity.identity_session_is_current(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.identity_session_is_current(uuid, uuid) to vortex_runtime;

comment on function vortex_identity.identity_session_is_current(uuid, uuid) is
  'True while the identity provider still holds the session a verified access token names: one primary-key read of auth.sessions. A password change, sign-out or other provider revocation deletes the session, and the token is refused from then on.';

alter function vortex_identity.identity_session_is_current(uuid, uuid) owner to postgres;
