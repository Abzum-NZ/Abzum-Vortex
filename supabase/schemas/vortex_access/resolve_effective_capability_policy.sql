create or replace function vortex_access.resolve_effective_capability_policy(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text
)
returns table (
  outcome text,
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  applied_scope text,
  applied_limit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  ceiling_quantity_limit numeric,
  resolved_at timestamptz,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  context_organization_id uuid;
  effective_organization_id uuid;
  actor_identity_id uuid;
  selected record;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit) then
    raise exception using errcode = '22023', message = 'Capability policy resolution is invalid';
  end if;
  context_organization_id := (context ->> 'organizationId')::uuid;
  -- The established organisation always belongs to the resolved scope.  An
  -- organisation-scoped request can never omit its organisation and fall back
  -- to the wider tenant limit that its own allocation narrows.
  effective_organization_id := coalesce(p_organization_id, context_organization_id);
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or effective_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  if effective_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = effective_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if effective_organization_id is null or exists (
    select 1
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.tenant_id = p_tenant_id
      and assignment.identity_id = actor_identity_id
      and assignment.revoked_at is null
      and assignment.starts_at <= evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
  ) then
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id, p_tenant_id,
      'platform.tenant.capability_limits.read', evaluated_at
    );
  end if;
  -- The effective limit is the lowest of the platform ceiling and every
  -- allocation beneath it; on a tie the narrower scope is reported. No
  -- allocation can raise a limit, and nothing applies without a live ceiling.
  select bound.*,
    max(bound.quantity_limit) filter (where bound.limit_source = 'platform_ceiling')
      over () as ceiling_limit
  into selected
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, effective_organization_id, p_capability_key, p_unit, evaluated_at, false
  ) as bound
  order by bound.quantity_limit, bound.precedence
  limit 1;
  if not found then
    return query select 'refused'::text, p_tenant_id, effective_organization_id,
      p_capability_key, p_unit, null::text, null::text, null::uuid, null::bigint, null::uuid,
      null::bigint, null::numeric, null::numeric, evaluated_at, 'capability_not_assigned'::text;
    return;
  end if;
  return query select 'available'::text, p_tenant_id, effective_organization_id,
    p_capability_key, p_unit, selected.applied_scope, selected.limit_source,
    selected.policy_id, selected.policy_revision, selected.assignment_id,
    selected.assignment_revision, selected.quantity_limit, selected.ceiling_limit,
    evaluated_at, null::text;
end
$function$;

revoke execute on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
  to vortex_request;

comment on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text) is
  'Returns the lowest of the live platform ceiling and the tenant and organisation allocations for the established request scope, the ceiling itself, and which limit applied; tenant administrators require the capability-limits read permission, and an allocation can only narrow the ceiling.';
