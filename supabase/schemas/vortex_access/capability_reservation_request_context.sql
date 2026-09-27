create or replace function vortex_access.capability_reservation_request_context(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (
  request_organization_id uuid,
  correlation_id uuid,
  request_expires_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  established_organization_id uuid;
  effective_organization_id uuid;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text)) then
    raise exception using errcode = '22023', message = 'Capability reservation scope is invalid';
  end if;
  established_organization_id := (established ->> 'organizationId')::uuid;
  effective_organization_id := coalesce(p_organization_id, established_organization_id);
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or effective_organization_id is distinct from established_organization_id
    or vortex_context.is_non_nil_uuid(established ->> 'correlationId') is distinct from true then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  if effective_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = effective_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  return query select effective_organization_id,
    (established ->> 'correlationId')::uuid,
    (established ->> 'expiresAt')::timestamptz;
end
$function$;

comment on function vortex_access.capability_reservation_request_context(uuid, uuid) is null;

revoke execute on function
  vortex_access.capability_reservation_request_context(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
