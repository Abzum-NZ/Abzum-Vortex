create or replace function vortex_access.resolve_human_application_address_scope(
  p_identity_id uuid, p_tenant_short_name text, p_organization_short_name text, p_application_key text
)
returns table (
  tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid,
  access_version bigint, completed_at timestamptz, account_display_name text
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  addressed record;
  hinted_root uuid;
begin
  select address.* into strict addressed
  from vortex_identity.read_organization_at_address(
    p_identity_id, p_tenant_short_name, p_organization_short_name
  ) as address;
  -- This is a selector only. The existing scope and address authorities decide it below.
  select root.root_id into strict hinted_root
  from vortex_definition.roots as root
  where root.organization_id = addressed.organization_id
    and root.kind = 'application' and root.key = p_application_key;
  return query
  select scope.tenant_id, scope.organization_id, scope.organization_account_id,
    scope.application_root_id, scope.access_version, pg_catalog.clock_timestamp(),
    addressed.account_display_name
  from vortex_access.resolve_human_application_scope(
    p_identity_id, addressed.organization_id, hinted_root
  ) as scope;
exception when no_data_found or too_many_rows then
  raise exception using errcode = 'P0002', message = 'Application address is unavailable';
end
$function$;

alter function vortex_access.resolve_human_application_address_scope(uuid, text, text, text) owner to vortex_owner;
revoke all on function vortex_access.resolve_human_application_address_scope(uuid, text, text, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_runtime;
grant execute on function vortex_access.resolve_human_application_address_scope(uuid, text, text, text)
  to vortex_runtime, postgres;
comment on function vortex_access.resolve_human_application_address_scope(uuid, text, text, text) is
  'Resolves an addressed human application scope using the current organisation and Access authorities.';
