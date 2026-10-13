CREATE OR REPLACE FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) RETURNS TABLE(result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  effective record;
  protected_context record;
  target vortex_access.capability_reservations%rowtype;
  balance record;
  existing_command vortex_access.capability_reservation_commands%rowtype;
  command_fingerprint text;
  remaining numeric;
  new_consumed numeric;
  new_remaining numeric;
  new_state text;
  safe_result jsonb;
  refusal_reason text;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_platform.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision not between 1 and 9007199254740991
    or p_reservation_id is null or not vortex_platform.is_non_nil_uuid(p_reservation_id::text)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability consumption command is invalid';
  end if;
  select locked.* into effective
  from vortex_access.lock_effective_capability_policy(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at
  ) as locked;
  if effective.correlation_id is null then
    select context.* into strict protected_context
    from vortex_access.capability_reservation_request_context(
      p_tenant_id, p_organization_id
    ) as context;
  else
    protected_context := effective;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'consume_capability_reservation', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, p_assignment_revision::text,
      p_reservation_id::text, p_quantity::text), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_duplicate_key::text), 650)
  );
  select stored.* into existing_command
  from vortex_access.capability_reservation_commands as stored
  where stored.tenant_id = p_tenant_id
    and stored.request_organization_id
      is not distinct from protected_context.request_organization_id
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if existing_command.operation_kind <> 'consume'
      or existing_command.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability consumption duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      existing_command.result, '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  select reservation.* into target
  from vortex_access.capability_reservations as reservation
  where reservation.reservation_id = p_reservation_id for update;
  if not found
    or target.tenant_id <> p_tenant_id
    or target.request_organization_id is distinct from protected_context.request_organization_id
    or target.capability_key <> p_capability_key or target.unit <> p_unit
    or target.policy_id <> p_policy_id or target.policy_revision <> p_policy_revision
    or target.assignment_id <> p_assignment_id
    or target.assignment_revision <> p_assignment_revision then
    refusal_reason := 'reservation_unavailable';
  elsif target.state <> 'active' or target.expires_at <= evaluated_at then
    if target.state = 'active' then
      update vortex_access.capability_reservations as reservation
      set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
      where reservation.reservation_id = p_reservation_id;
    end if;
    refusal_reason := 'reservation_stale';
  elsif effective.assignment_id is null
    or effective.policy_id <> target.policy_id
    or effective.policy_revision <> target.policy_revision
    or effective.assignment_id <> target.assignment_id
    or effective.assignment_revision <> target.assignment_revision
    or effective.applied_scope <> target.applied_scope then
    update vortex_access.capability_reservations as reservation
    set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
    where reservation.reservation_id = p_reservation_id;
    refusal_reason := 'reservation_stale';
  else
    remaining := target.reserved_quantity - target.consumed_quantity - target.released_quantity;
    if p_quantity > remaining then refusal_reason := 'insufficient_reserved_quantity'; end if;
  end if;
  if refusal_reason is not null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'reservationId', p_reservation_id,
      'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'reasonCode', refusal_reason,
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, reservation_id,
      result, correlation_id, accepted_at
    ) values (
      p_tenant_id, protected_context.request_organization_id, p_duplicate_key,
      'consume', command_fingerprint,
      case when target.reservation_id is null then null else target.reservation_id end,
      safe_result, protected_context.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  new_consumed := target.consumed_quantity + p_quantity;
  new_remaining := remaining - p_quantity;
  new_state := case when new_remaining = 0 then 'consumed' else 'active' end;
  update vortex_access.capability_reservations as reservation
  set consumed_quantity = new_consumed, state = new_state,
      consumed_at = evaluated_at, updated_at = evaluated_at
  where reservation.reservation_id = p_reservation_id;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'consumed', 'status', 'accepted', 'reservationId', p_reservation_id,
    'tenantId', p_tenant_id, 'organizationId', effective.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'policyId', target.policy_id, 'policyRevision', target.policy_revision,
    'assignmentId', target.assignment_id,
    'assignmentRevision', target.assignment_revision,
    'appliedScope', target.applied_scope, 'consumedAmount', p_quantity::text,
    'totalConsumedQuantity', new_consumed::text,
    'remainingReservedQuantity', new_remaining::text,
    'reservationState', new_state,
    'consumedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', effective.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)
  ));
  insert into vortex_access.capability_reservation_commands (
    tenant_id, request_organization_id, duplicate_key,
    operation_kind, command_fingerprint, reservation_id,
    result, correlation_id, accepted_at
  ) values (
    p_tenant_id, effective.request_organization_id, p_duplicate_key,
    'consume', command_fingerprint, p_reservation_id,
    safe_result, effective.correlation_id, evaluated_at
  );
  return query select safe_result;
end
$$;

ALTER FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) IS 'Consumes only a current exact unexpired reservation and records immutable duplicate-protected outcomes.';

REVOKE ALL ON FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) TO vortex_request;
