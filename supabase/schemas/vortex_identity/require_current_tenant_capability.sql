create or replace function vortex_identity.require_current_tenant_capability(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_capability_key text,
  p_evaluated_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from vortex_identity.tenants as tenant
    join vortex_identity.identity_projections as identity
      on identity.identity_id = p_identity_id
    where tenant.tenant_id = p_tenant_id
      and tenant.state = 'active'
      and identity.state = 'active'
      and (
        vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          identity.identity_id, p_evaluated_at
        ) is not null
        or exists (
          select 1
          from vortex_identity.tenant_administrator_assignments as assignment
          where assignment.tenant_id = tenant.tenant_id
            and assignment.identity_id = identity.identity_id
            and assignment.revoked_at is null
            and assignment.starts_at <= p_evaluated_at
            and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
            and p_capability_key = any(assignment.capability_keys)
        )
      )
  ) then
    raise exception using errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz) is
  'Requires one current tenant capability or the independent active Vortex super-administrator assignment.';
