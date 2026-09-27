create or replace function vortex_identity.list_vortex_super_administrator_assignments(
  p_limit integer,
  p_after uuid default null
)
returns table (
  assignment_id uuid,
  identity_id uuid,
  revision bigint,
  granted_at timestamptz,
  granted_by_kind text,
  granted_by_id uuid,
  changed_at timestamptz,
  changed_by_kind text,
  changed_by_id uuid,
  grant_correlation_id uuid,
  change_correlation_id uuid,
  revoked_at timestamptz,
  revoked_by_kind text,
  revoked_by_id uuid,
  revocation_correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  actor_identity_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023',
      message = 'Super-administrator assignment read is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
    actor_identity_id, pg_catalog.clock_timestamp()
  ) is null then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  return query
  select assignment.assignment_id, assignment.identity_id,
    assignment.revision, assignment.granted_at, assignment.granted_by_kind,
    assignment.granted_by_id, assignment.changed_at, assignment.changed_by_kind,
    assignment.changed_by_id, assignment.grant_correlation_id,
    assignment.change_correlation_id, assignment.revoked_at,
    assignment.revoked_by_kind, assignment.revoked_by_id,
    assignment.revocation_correlation_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where p_after is null or assignment.assignment_id > p_after
  order by assignment.assignment_id
  limit p_limit;
end
$function$;

revoke all on function vortex_identity.list_vortex_super_administrator_assignments(integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.list_vortex_super_administrator_assignments(integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_vortex_super_administrator_assignments(integer, uuid) is
  'Lists the immutable and revisioned named super-administrator assignment ledger to an active super administrator.';
