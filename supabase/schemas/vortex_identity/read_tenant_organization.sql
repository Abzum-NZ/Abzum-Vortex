create or replace function vortex_identity.read_tenant_organization(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023', message = 'Tenant organization request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.hierarchy.read',
    pg_catalog.clock_timestamp()
  );
  return query
  select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke execute on function vortex_identity.read_tenant_organization(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.read_tenant_organization(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.read_tenant_organization(uuid, uuid) is
  'Exact same-tenant structural organisation read under the bound request context person''s hierarchy.read capability.';
