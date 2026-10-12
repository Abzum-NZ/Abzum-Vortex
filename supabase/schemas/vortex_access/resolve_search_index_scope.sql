create or replace function vortex_access.resolve_search_index_scope(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  system_actor_id uuid,
  tenant_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_access_version bigint;
  dispatcher jsonb;
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_context.is_non_nil_uuid(p_application_root_id::text) then
    raise exception using errcode = '22023', message = 'Search index scope selection is invalid';
  end if;

  -- The organisation and its access version are share-locked before the
  -- dispatcher grant is read, in the request resolver's Access-first order.
  select organization.tenant_id, version.current_version
  into resolved_tenant_id, resolved_access_version
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where organization.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of organization, tenant, version;

  if resolved_tenant_id is null
    or not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_application_root_id
        and root.kind = 'application'
        and root.organization_id = p_organization_id
    ) then
    raise exception using errcode = '42501', message = 'Search index scope is unavailable';
  end if;

  -- Indexing runs inside event dispatch, so the actor is the dispatcher's own
  -- platform-wide system actor grant; nothing the caller supplies names it.
  dispatcher := vortex_access.resolve_event_dispatcher_actor();
  if dispatcher ->> 'outcome' is distinct from 'authorised' then
    raise exception using errcode = '42501', message = 'Search index scope is unavailable';
  end if;

  return query select (dispatcher ->> 'systemActorId')::uuid, resolved_tenant_id,
    resolved_access_version;
end
$function$;

revoke all on function vortex_access.resolve_search_index_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_search_index_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_search_index_scope(uuid, uuid) is
  'Resolves the tenant, access version and the event dispatcher''s system actor for one active organisation Application, so the search consumer can read a record under a system context. Refuses for an inactive organisation, a foreign Application or a missing or ambiguous dispatcher grant. Runtime-only.';
