-- A verified access token is accepted only while the identity provider still holds its session.
-- GoTrue deletes the sessions a password change ends (all of them for an administrator's change,
-- every other one for the person's own change), but the signed token stays valid until it expires.
-- The verifier therefore reads the session by primary key. Reading the GoTrue-owned auth.sessions
-- needs USAGE on the auth schema, which only postgres holds and cannot grant onward, so this is one
-- of the postgres-owned integration functions (target architecture section 4). It replaces
-- vortex_identity.complete_identity_disablement, which the database review cleanup drops.

-- guard-allow: migration-owner-role The integration function reads GoTrue's auth.sessions, which only postgres may read.
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

reset role;
