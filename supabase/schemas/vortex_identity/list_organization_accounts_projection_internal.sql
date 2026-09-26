create or replace function vortex_identity.list_organization_accounts_projection_internal(
  p_organization_id uuid
)
returns table (
  organization_account_id uuid,
  display_name text,
  account_state text,
  language text,
  time_zone text,
  revision bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select account.organization_account_id, account.display_name, account.state,
    account.language, account.time_zone, account.revision
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and p_organization_id is not null
    and p_organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  order by account.organization_account_id
$function$;

revoke all on function vortex_identity.list_organization_accounts_projection_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;

comment on function vortex_identity.list_organization_accounts_projection_internal(uuid) is
  'Identity-owned set-returning safe organisation-account projection bounded to the given organisation: identity, originating invitation and state-change evidence are never exposed, and the already-decided request scope is the only visibility.';
