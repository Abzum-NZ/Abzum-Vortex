create or replace function vortex_access.lock_organization_accounts_for_profile_change(
  p_identity_id uuid,
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text) then
    raise exception using errcode = '22023',
      message = 'Organization account profile command is invalid';
  end if;

  -- The request's scope holds its own account with a shared lock until commit, and the profile
  -- writer then needs the changed account exclusively. Taking the write lock before the scope's
  -- account lock makes two saves of one account queue here instead of each holding a shared lock
  -- the other's write waits for (a deadlock). The Access version is held shared first, in the
  -- same order as every scope (the version, then accounts), so an access change, which holds the
  -- version exclusively before it locks an account, never waits for a lock taken here while
  -- holding one this transaction needs.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
  for share of version;

  -- The actor's account and the changed one are locked in account identity order, the changed
  -- one only when the actor has an active account in the organisation.
  perform 1
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and (account.identity_id = p_identity_id
      or (account.organization_account_id = p_organization_account_id
        and exists (
          select 1
          from vortex_identity.organization_accounts as actor
          where actor.organization_id = p_organization_id
            and actor.identity_id = p_identity_id
            and actor.state = 'active'
        )))
  order by account.organization_account_id
  for no key update of account;
end
$function$;

revoke all on function vortex_access.lock_organization_accounts_for_profile_change(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.lock_organization_accounts_for_profile_change(uuid, uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.lock_organization_accounts_for_profile_change(uuid, uuid, uuid) is
  'Holds the organisation Access version shared, then locks the acting account and the account whose profile changes, in account identity order, before the request scope takes its shared account lock, so concurrent profile saves of one account queue instead of deadlocking. Decides nothing: the scope and the profile writer still check the actor, the account state and the revision.';

alter function vortex_access.lock_organization_accounts_for_profile_change(p_identity_id uuid, p_organization_id uuid, p_organization_account_id uuid) owner to vortex_owner;

grant execute on function vortex_access.lock_organization_accounts_for_profile_change(p_identity_id uuid, p_organization_id uuid, p_organization_account_id uuid) to postgres;
