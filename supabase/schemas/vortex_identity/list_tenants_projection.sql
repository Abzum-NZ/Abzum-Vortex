create or replace function vortex_identity.list_tenants_projection(
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
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same effective
  -- structural administrator assignment the bespoke tenant launcher applies is
  -- the only visibility, and neither the tenant nor the organisation is ever an
  -- input. A viewer with no effective assignment sees no rows, exactly as a
  -- missing or foreign record, so the record adapters return their identical
  -- refusal and a list page is empty rather than failing. The record identity is
  -- the tenant and the revision is the tenant's own revision. A tenant is a
  -- governance boundary rather than an organisation-owned row, so the projected
  -- organisation is the organisation the record is read in, the one the caller's
  -- validated request context already established; capability evidence and every
  -- grant, revocation and correlation column stay in the protected storage and
  -- are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  return query
  select
    visible_organization_id,
    tenant.tenant_id,
    tenant.revision,
    pg_catalog.jsonb_build_object(
      'short_name', tenant.short_name,
      'display_name', tenant.display_name,
      'state', tenant.state,
      'state_changed_at', tenant.state_changed_at,
      'created_at', tenant.created_at
    )
  from vortex_identity.tenants as tenant
  where tenant.state = 'active'
    and (p_record_id is null or p_record_id = tenant.tenant_id)
    and exists (
      select 1
      from vortex_identity.tenant_administrator_assignments as assignment
      where assignment.tenant_id = tenant.tenant_id
        and assignment.identity_id = actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    )
  order by tenant.tenant_id;
end
$function$;

revoke all on function vortex_identity.list_tenants_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_tenants_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_tenants_projection(uuid, integer) is
  'Registered tenant projection: returns every active tenant the current viewer''s effective structural administrator assignment already lists, the exact rule the tenant launcher applies, with the organisation the record is read in, the tenant identity, the tenant revision and the safe projected attribute values keyed by lowercase field key, or no row when the viewer has no effective assignment. Capability and change evidence is never projected.';
