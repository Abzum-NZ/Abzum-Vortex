create or replace function vortex_access.lock_effective_capability_policy(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_evaluated_at timestamptz
)
returns table (
  request_organization_id uuid,
  correlation_id uuid,
  request_expires_at timestamptz,
  applied_scope text,
  assignment_organization_id uuid,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  assignment_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  protected_context record;
  selected record;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_evaluated_at is null
    or p_evaluated_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023', message = 'Capability reservation policy request is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  -- The same rule as the read path: the lowest of the live platform ceiling
  -- and the tenant and organisation allocations, the narrower scope on a tie.
  select bound.* into selected
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, protected_context.request_organization_id, p_capability_key, p_unit,
    p_evaluated_at, true
  ) as bound
  order by bound.quantity_limit, bound.precedence
  limit 1;
  if not found then return; end if;
  return query select protected_context.request_organization_id,
    protected_context.correlation_id, protected_context.request_expires_at,
    selected.applied_scope, selected.assignment_organization_id,
    selected.policy_id, selected.policy_revision, selected.assignment_id,
    selected.assignment_revision, selected.quantity_limit, selected.expires_at;
end
$function$;

revoke execute on function vortex_access.lock_effective_capability_policy(
  uuid, uuid, text, text, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.lock_effective_capability_policy(uuid, uuid, text, text, timestamptz) is
  'Locks the live platform ceiling and the tenant and organisation allocations for the scope, then returns the lowest of them as the effective limit; an allocation can only narrow the ceiling.';

alter function vortex_access.lock_effective_capability_policy(uuid, uuid, text, text, timestamptz) owner to postgres;
grant execute on function vortex_access.lock_effective_capability_policy(uuid, uuid, text, text, timestamptz) to vortex_access_owner;
