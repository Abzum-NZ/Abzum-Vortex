create or replace function vortex_access.read_capability_reservation_balance(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  effective record;
  balance record;
begin
  select locked.* into effective
  from vortex_access.lock_effective_capability_policy(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at
  ) as locked;
  if effective.assignment_id is null then
    raise exception using errcode = 'V3101', message = 'Capability balance is unavailable';
  end if;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  return query select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'tenantId', p_tenant_id, 'organizationId', effective.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
    'assignmentId', effective.assignment_id,
    'assignmentRevision', effective.assignment_revision,
    'appliedScope', effective.applied_scope,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text),
    'evaluatedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));
end
$function$;

alter function vortex_access.read_capability_reservation_balance(uuid, uuid, text, text) owner to vortex_access_owner;

comment on function vortex_access.read_capability_reservation_balance(uuid, uuid, text, text) is
  'Returns current balance evidence after exact request-scope validation and policy resolution.';

revoke execute on function vortex_access.read_capability_reservation_balance(uuid, uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.read_capability_reservation_balance(uuid, uuid, text, text) to vortex_request;
