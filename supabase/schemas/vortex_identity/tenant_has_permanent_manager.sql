create or replace function vortex_identity.tenant_has_permanent_manager(
  p_tenant_id uuid,
  p_checked_at timestamptz,
  p_excluded_assignment_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.tenant_administrator_assignments as assignment
    join vortex_identity.identity_projections as projection
      on projection.identity_id = assignment.identity_id
      and projection.state = 'active'
    where assignment.tenant_id = p_tenant_id
      and assignment.assignment_id is distinct from p_excluded_assignment_id
      and assignment.revoked_at is null
      and assignment.starts_at <= p_checked_at
      and assignment.expires_at is null
      and 'platform.tenant.administrators.manage' = any(assignment.capability_keys)
  )
$function$;

revoke execute on function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) is 'Identity-owned current permanent tenant-manager predicate shared by protected tenant operations.';

alter function vortex_identity.tenant_has_permanent_manager(uuid,timestamp with time zone,uuid) owner to vortex_identity_owner;
