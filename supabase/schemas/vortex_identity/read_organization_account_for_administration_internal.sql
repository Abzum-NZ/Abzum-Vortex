create or replace function vortex_identity.read_organization_account_for_administration_internal(
  p_organization_id uuid,
  p_organization_account_id uuid
)
returns table (
  outcome text,
  account_summary jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  account_value jsonb;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization account administration detail input is invalid';
  end if;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'organizationAccountId', account.organization_account_id,
    'displayName', account.display_name,
    'state', account.state,
    'language', account.language,
    'timeZone', account.time_zone,
    'revision', account.revision
  ))
  into account_value
  from vortex_identity.organization_accounts as account
  where account.organization_id = p_organization_id
    and account.organization_account_id = p_organization_account_id;

  return query select
    case when account_value is null then 'unavailable' else 'available' end,
    account_value;
end
$function$;

revoke all on function vortex_identity.read_organization_account_for_administration_internal(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.read_organization_account_for_administration_internal(
  uuid, uuid
) is 'Identity-owned exact organisation-scoped safe account administration projection.';

alter function vortex_identity.read_organization_account_for_administration_internal(uuid, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.read_organization_account_for_administration_internal(uuid, uuid) to postgres;
