create or replace function vortex_identity.list_organizations_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.tenant.hierarchy.read capability the bespoke tenant-structure reader
  -- requires is the only visibility, and the tenant is the caller's own resolved
  -- tenant, never page input. Exactly as that reader, a viewer the capability
  -- admits sees every organisation of that one tenant, and a viewer it refuses
  -- sees no row, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the organisation and the revision is the
  -- organisation's own revision; its position in the tenant hierarchy is the
  -- parent reference the projection returns. The tenant structure is a
  -- governance fact rather than an organisation-owned row, so the projected
  -- organisation is the organisation the record is read in, the one the caller's
  -- validated request context already established. Creation and state-change
  -- evidence stay in the protected storage and are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id,
      visible_tenant_id,
      'platform.tenant.hierarchy.read',
      evaluated_at
    );
  exception
    when sqlstate 'V3101' then
      return;
  end;
  return query
  select
    visible_organization_id,
    organization.organization_id,
    organization.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', organization.tenant_id,
      'parent_organization_id', organization.parent_organization_id,
      'short_name', organization.short_name,
      'display_name', organization.display_name,
      'state', organization.state,
      'state_changed_at', organization.state_changed_at,
      'created_at', organization.created_at
    )
  from vortex_identity.organizations as organization
  where organization.tenant_id = visible_tenant_id
    and (p_record_id is null or p_record_id = organization.organization_id)
  order by organization.organization_id;
end
$function$;

revoke all on function vortex_identity.list_organizations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_organizations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_organizations_projection(uuid, integer) is
  'Registered organisation projection: returns every organisation of the current viewer''s own tenant under the fixed platform.tenant.hierarchy.read capability, the exact rule the tenant-structure reader applies, with the organisation the record is read in, the organisation identity, the organisation revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. Creation and state-change evidence are never projected.';
