create or replace function vortex_access.refresh_capability_reservation_balance(
  p_tenant_id uuid, p_request_organization_id uuid,
  p_capability_key text, p_unit text, p_applied_scope text,
  p_assignment_organization_id uuid, p_policy_id uuid, p_policy_revision bigint,
  p_assignment_id uuid, p_assignment_revision bigint, p_quantity_limit numeric,
  p_evaluated_at timestamptz
)
returns table (
  policy_quantity_limit numeric, active_reserved_quantity numeric,
  consumed_quantity numeric, released_quantity numeric, available_quantity numeric
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  active_reserved numeric;
  consumed numeric;
  released numeric;
  tenant_bound record;
  tenant_balance record;
begin
  update vortex_access.capability_reservations as reservation
  set state = 'expired', expired_at = p_evaluated_at, updated_at = p_evaluated_at
  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.state = 'active' and reservation.expires_at <= p_evaluated_at;
  update vortex_access.capability_reservations as reservation
  set state = 'expired', expired_at = p_evaluated_at, updated_at = p_evaluated_at
  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.state = 'active'
    and (reservation.request_organization_id
        is not distinct from p_request_organization_id
      or (p_applied_scope = 'tenant' and reservation.applied_scope = 'tenant'))
    and (reservation.policy_id, reservation.policy_revision,
      reservation.assignment_id, reservation.assignment_revision)
      is distinct from (p_policy_id, p_policy_revision, p_assignment_id, p_assignment_revision);
  insert into vortex_access.capability_reservation_balances (
    balance_id, tenant_id, organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    policy_quantity_limit, active_reserved_quantity, consumed_quantity,
    released_quantity, updated_at
  ) values (
    pg_catalog.gen_random_uuid(), p_tenant_id, p_assignment_organization_id,
    p_capability_key, p_unit, p_policy_id, p_policy_revision, p_assignment_id,
    p_assignment_revision, p_quantity_limit, 0, 0, 0, p_evaluated_at
  ) on conflict do nothing;
  perform 1 from vortex_access.capability_reservation_balances as balance
  where balance.tenant_id = p_tenant_id
    and balance.organization_id is not distinct from p_assignment_organization_id
    and balance.capability_key = p_capability_key and balance.unit = p_unit
  for update;
  select
    coalesce(sum(case when reservation.state = 'active'
      then reservation.reserved_quantity - reservation.consumed_quantity
        - reservation.released_quantity else 0 end), 0),
    coalesce(sum(reservation.consumed_quantity), 0),
    coalesce(sum(reservation.released_quantity), 0)
  into active_reserved, consumed, released
  from vortex_access.capability_reservations as reservation
  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and (p_applied_scope = 'tenant'
      or reservation.request_organization_id
        is not distinct from p_assignment_organization_id);
  update vortex_access.capability_reservation_balances as balance
  set policy_id = p_policy_id, policy_revision = p_policy_revision,
      assignment_id = p_assignment_id, assignment_revision = p_assignment_revision,
      policy_quantity_limit = p_quantity_limit,
      active_reserved_quantity = active_reserved, consumed_quantity = consumed,
      released_quantity = released, updated_at = p_evaluated_at
  where balance.tenant_id = p_tenant_id
    and balance.organization_id is not distinct from p_assignment_organization_id
    and balance.capability_key = p_capability_key and balance.unit = p_unit;
  if p_applied_scope = 'organization' then
    -- An organisation is also bounded by the tenant-wide balance, whose limit
    -- is the lower of the platform ceiling and the tenant allocation.
    select bound.policy_id, bound.policy_revision, bound.assignment_id,
      bound.assignment_revision, bound.quantity_limit
    into tenant_bound
    from vortex_access.capability_limit_bounds_internal(
      p_tenant_id, null::uuid, p_capability_key, p_unit, p_evaluated_at, true
    ) as bound
    where bound.applied_scope = 'tenant'
    order by bound.quantity_limit, bound.precedence
    limit 1;
    if not found then
      return query select p_quantity_limit, active_reserved, consumed, released,
        0::numeric;
      return;
    end if;
    select refreshed.* into strict tenant_balance
    from vortex_access.refresh_capability_reservation_balance(
      p_tenant_id, null::uuid, p_capability_key, p_unit, 'tenant'::text,
      null::uuid, tenant_bound.policy_id, tenant_bound.policy_revision,
      tenant_bound.assignment_id, tenant_bound.assignment_revision,
      tenant_bound.quantity_limit, p_evaluated_at
    ) as refreshed;
    return query select p_quantity_limit, active_reserved, consumed, released,
      least(greatest(0::numeric, p_quantity_limit - active_reserved - consumed),
        tenant_balance.available_quantity);
    return;
  end if;
  return query select p_quantity_limit, active_reserved, consumed, released,
    greatest(0::numeric, p_quantity_limit - active_reserved - consumed);
end
$function$;

revoke execute on function vortex_access.refresh_capability_reservation_balance(
  uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.refresh_capability_reservation_balance(
  uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
) is
  'Rebuilds tenant-aggregate or organisation-local balance evidence using one scope rule for active, consumed and released totals; an organisation is also bounded by the tenant-wide balance under the lower of the platform ceiling and the tenant allocation.';
