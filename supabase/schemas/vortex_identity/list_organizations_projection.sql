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
  organization_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.tenant.hierarchy.read capability the bespoke tenant-structure reader
  -- requires is the only visibility, and the tenant is the caller's own resolved
  -- tenant, never page input. A viewer the capability refuses sees no row, exactly
  -- as a missing or foreign record, so the record adapters return their identical
  -- refusal and a list page is empty rather than failing. The record identity is
  -- the organisation and the revision is the organisation's own revision, so an
  -- organisation-shared record type owns exactly the organisation the caller is
  -- established in; its position in the tenant hierarchy is the parent reference
  -- the projection returns. Creation and state-change evidence stay in the
  -- protected storage and are never projected.
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
  select organization.* into organization_row
  from vortex_identity.organizations as organization
  where organization.tenant_id = visible_tenant_id
    and organization.organization_id = visible_organization_id;
  if organization_row.organization_id is null
    or organization_row.organization_id is distinct from visible_organization_id then
    return;
  end if;
  if p_record_id is not null and p_record_id <> organization_row.organization_id then
    return;
  end if;
  return query select
    organization_row.organization_id,
    organization_row.organization_id,
    organization_row.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', organization_row.tenant_id,
      'parent_organization_id', organization_row.parent_organization_id,
      'short_name', organization_row.short_name,
      'display_name', organization_row.display_name,
      'state', organization_row.state,
      'state_changed_at', organization_row.state_changed_at,
      'created_at', organization_row.created_at
    );
end
$function$;

revoke all on function vortex_identity.list_organizations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_organizations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_organizations_projection(uuid, integer) is
  'Registered organisation projection: returns the one organisation the current viewer is established in under the fixed platform.tenant.hierarchy.read capability, with the organisation, the organisation identity, the organisation revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. Creation and state-change evidence are never projected.';
