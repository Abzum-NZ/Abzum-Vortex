create or replace function vortex_identity.list_tenant_hierarchy(
  p_tenant_id uuid,
  p_limit integer,
  p_after uuid default null
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
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant hierarchy request is invalid';
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
    and (p_after is null or organization.organization_id > p_after)
  order by organization.organization_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid) is
  'Bounded deterministic same-tenant structural hierarchy read under the bound request context person''s exact hierarchy.read capability.';
