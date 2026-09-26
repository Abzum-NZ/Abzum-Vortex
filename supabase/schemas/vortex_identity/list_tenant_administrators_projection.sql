create or replace function vortex_identity.list_tenant_administrators_projection(
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
  -- platform.tenant.administrators.read capability the bespoke tenant-administration
  -- reader requires is the only visibility, and the tenant is the caller's own
  -- resolved tenant, never page input. A viewer the capability refuses sees no
  -- rows, exactly as a missing or foreign record, so the record adapters return
  -- their identical refusal and a list page is empty rather than failing. The
  -- record identity is the assignment and the revision is the assignment's own
  -- revision. Every assignment of the tenant is listed, whether scheduled, active,
  -- expired or revoked, and the projected state is descriptive: it grants nothing
  -- and is exactly the derived outcome the bespoke reader returns. The grant,
  -- revocation and correlation audit columns are never projected.
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
      'platform.tenant.administrators.read',
      evaluated_at
    );
  exception
    when sqlstate 'V3101' then
      return;
  end;
  return query
  select
    visible_organization_id,
    assignment.assignment_id,
    assignment.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', assignment.tenant_id,
      'identity_id', assignment.identity_id,
      'capability_keys', assignment.capability_keys,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', case
        when assignment.revoked_at is not null
          and assignment.revoked_at <= evaluated_at then 'revoked'
        when assignment.starts_at > evaluated_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= evaluated_at then 'expired'
        else 'active'
      end
    )
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = visible_tenant_id
    and (p_record_id is null or p_record_id = assignment.assignment_id)
  order by assignment.assignment_id;
end
$function$;

revoke all on function vortex_identity.list_tenant_administrators_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_tenant_administrators_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_tenant_administrators_projection(uuid, integer) is
  'Registered tenant-administrator projection: returns every administrator assignment of the caller''s own tenant, whether scheduled, active, expired or revoked, under the fixed platform.tenant.administrators.read capability, with the organisation the record is read in, the assignment identity, the assignment revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. The projected state grants nothing and grant or revocation evidence is never projected.';
