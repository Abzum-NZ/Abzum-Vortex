create or replace function vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
  p_identity_id uuid,
  p_checked_at timestamptz
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select assignment.assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  join vortex_identity.identity_projections as identity
    on identity.identity_id = assignment.identity_id
    and identity.state = 'active'
  where assignment.identity_id = p_identity_id
    and (assignment.revoked_at is null or assignment.revoked_at > p_checked_at)
    and assignment.granted_at <= p_checked_at
  limit 1
$function$;

revoke all on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(uuid, timestamptz)
  to vortex_access_owner;

comment on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(uuid, timestamptz) is
  'Private live assignment lookup for the named Vortex super-administrator authority; tenant and organisation roles never participate.';
