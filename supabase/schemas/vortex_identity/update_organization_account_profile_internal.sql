create or replace function vortex_identity.update_organization_account_profile_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_expected_revision bigint,
  p_display_name text,
  p_language text,
  p_time_zone text
)
returns table (
  organization_id uuid,
  organization_account_id uuid,
  display_name text,
  state text,
  language text,
  time_zone text,
  changed_at timestamptz,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_accounts%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120
    or (p_language is not null
      and (p_language <> pg_catalog.btrim(p_language)
        or pg_catalog.char_length(p_language) not between 2 and 35))
    or (p_time_zone is not null
      and (p_time_zone <> pg_catalog.btrim(p_time_zone)
        or pg_catalog.char_length(p_time_zone) not between 1 and 100)) then
    raise exception using errcode = '22023',
      message = 'Organization account profile update is invalid';
  end if;

  select account.* into existing
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found
    or existing.state <> 'active'
    or existing.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001',
      message = 'Organization account profile update is stale or unavailable';
  end if;
  if existing.display_name is not distinct from p_display_name
    and existing.language is not distinct from p_language
    and existing.time_zone is not distinct from p_time_zone then
    raise exception using errcode = '40001',
      message = 'Organization account profile is unchanged';
  end if;

  update vortex_identity.organization_accounts as account
  set display_name = p_display_name,
      language = p_language,
      time_zone = p_time_zone,
      changed_at = pg_catalog.statement_timestamp(),
      revision = account.revision + 1
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id
  returning * into existing;

  return query select existing.organization_id, existing.organization_account_id,
    existing.display_name, existing.state, existing.language, existing.time_zone,
    existing.changed_at, existing.revision;
end
$function$;

revoke all on function vortex_identity.update_organization_account_profile_internal(
  uuid, uuid, bigint, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

comment on function vortex_identity.update_organization_account_profile_internal(
  uuid, uuid, bigint, text, text, text
) is
  'Owner-only Identity writer for one active organisation account profile under an exact current revision; changes display name, language and time zone only and advances the account revision.';
