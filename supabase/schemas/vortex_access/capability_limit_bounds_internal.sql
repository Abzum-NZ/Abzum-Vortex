create or replace function vortex_access.capability_limit_bounds_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_evaluated_at timestamptz,
  p_lock boolean
)
returns table (
  limit_source text,
  applied_scope text,
  assignment_organization_id uuid,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  expires_at timestamptz,
  precedence integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_evaluated_at is null
    or p_evaluated_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_lock is null then
    raise exception using errcode = '22023', message = 'Capability limit scope is invalid';
  end if;
  -- Every live row that can bound this scope is locked in one stable order, so
  -- the reservation paths and the administration commands never interleave.
  if p_lock then
    perform 1
    from vortex_access.capability_policy_assignments as assignment
    where assignment.tenant_id = p_tenant_id
      and (assignment.organization_id is null
        or assignment.organization_id = p_organization_id)
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null
    order by assignment.assignment_id
    for update of assignment;
  end if;
  -- The platform ceiling is the only source of a limit. An allocation counts
  -- only while a live ceiling exists, is reported against that ceiling's policy
  -- revision, and ends no later than the ceiling does.
  return query
  with live_ceiling as (
    select assignment.assignment_id, assignment.revision, assignment.policy_id,
      assignment.policy_revision, assignment.expires_at, definition.quantity_limit
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id
      and assignment.assignment_kind = 'ceiling'
      and assignment.organization_id is null
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
    order by assignment.assignment_id
    limit 1
  )
  select 'platform_ceiling'::text, 'tenant'::text, null::uuid,
    live_ceiling.policy_id, live_ceiling.policy_revision, live_ceiling.assignment_id,
    live_ceiling.revision, live_ceiling.quantity_limit, live_ceiling.expires_at, 2
  from live_ceiling
  union all
  select 'tenant_allocation'::text, 'tenant'::text, null::uuid,
    live_ceiling.policy_id, live_ceiling.policy_revision, allocation.assignment_id,
    allocation.revision, allocation.allocated_quantity,
    least(allocation.expires_at, live_ceiling.expires_at), 1
  from live_ceiling
  join vortex_access.capability_policy_assignments as allocation
    on allocation.tenant_id = p_tenant_id
    and allocation.assignment_kind = 'allocation'
    and allocation.organization_id is null
    and allocation.capability_key = p_capability_key and allocation.unit = p_unit
    and allocation.revoked_at is null and allocation.starts_at <= p_evaluated_at
    and (allocation.expires_at is null or allocation.expires_at > p_evaluated_at)
  union all
  select 'organization_allocation'::text, 'organization'::text, allocation.organization_id,
    live_ceiling.policy_id, live_ceiling.policy_revision, allocation.assignment_id,
    allocation.revision, allocation.allocated_quantity,
    least(allocation.expires_at, live_ceiling.expires_at), 0
  from live_ceiling
  join vortex_access.capability_policy_assignments as allocation
    on p_organization_id is not null
    and allocation.tenant_id = p_tenant_id
    and allocation.assignment_kind = 'allocation'
    and allocation.organization_id = p_organization_id
    and allocation.capability_key = p_capability_key and allocation.unit = p_unit
    and allocation.revoked_at is null and allocation.starts_at <= p_evaluated_at
    and (allocation.expires_at is null or allocation.expires_at > p_evaluated_at);
end
$function$;

revoke all on function vortex_access.capability_limit_bounds_internal(
  uuid, uuid, text, text, timestamptz, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.capability_limit_bounds_internal(
  uuid, uuid, text, text, timestamptz, boolean
) is
  'Private: the live platform ceiling and the tenant and organisation allocations that bound one capability scope, each with its precedence; allocations count only under a live ceiling.';
