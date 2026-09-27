create or replace function vortex_access.reserve_capability_quantity(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_claim jsonb, p_requested_quantity numeric, p_duplicate_key uuid
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  effective record;
  protected_context record;
  balance record;
  existing_command vortex_access.capability_reservation_commands%rowtype;
  command_fingerprint text;
  reservation_id uuid;
  expires_at timestamptz;
  safe_result jsonb;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_claim is null or pg_catalog.jsonb_typeof(p_policy_claim) <> 'object'
    or not vortex_access.capability_policy_quantity_is_valid(p_requested_quantity)
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability reservation command is invalid';
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
      'reserve_capability_quantity', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_claim::text,
      p_requested_quantity::text), 'UTF8'), 'sha256'), 'hex');
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
    if existing_command.operation_kind <> 'reserve'
      or existing_command.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability reservation duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      existing_command.result, '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  if effective.assignment_id is null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'requestedQuantity', p_requested_quantity::text,
      'reasonCode', 'capability_not_assigned',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, result,
      correlation_id, accepted_at
    ) values (
      p_tenant_id, protected_context.request_organization_id, p_duplicate_key,
      'reserve', command_fingerprint, safe_result,
      protected_context.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  if balance.available_quantity < p_requested_quantity then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', effective.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
      'assignmentId', effective.assignment_id,
      'assignmentRevision', effective.assignment_revision,
      'appliedScope', effective.applied_scope,
      'requestedQuantity', p_requested_quantity::text,
      'reasonCode', 'insufficient_capacity',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
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
      operation_kind, command_fingerprint, result,
      correlation_id, accepted_at
    ) values (
      p_tenant_id, effective.request_organization_id, p_duplicate_key,
      'reserve', command_fingerprint, safe_result,
      effective.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  expires_at := least(evaluated_at + interval '300 seconds',
    effective.request_expires_at,
    coalesce(effective.assignment_expires_at, 'infinity'::timestamptz));
  if expires_at <= evaluated_at then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', effective.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
      'assignmentId', effective.assignment_id,
      'assignmentRevision', effective.assignment_revision,
      'appliedScope', effective.applied_scope,
      'requestedQuantity', p_requested_quantity::text, 'reasonCode', 'policy_stale',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', effective.correlation_id
    ));
    insert into vortex_access.capability_reservation_commands (
      tenant_id, request_organization_id, duplicate_key,
      operation_kind, command_fingerprint, result,
      correlation_id, accepted_at
    ) values (
      p_tenant_id, effective.request_organization_id, p_duplicate_key,
      'reserve', command_fingerprint, safe_result,
      effective.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  reservation_id := pg_catalog.gen_random_uuid();
  insert into vortex_access.capability_reservations (
    reservation_id, tenant_id, request_organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    applied_scope, policy_quantity_limit, reserved_quantity,
    consumed_quantity, released_quantity, state, created_at, expires_at,
    updated_at, reserve_duplicate_key, correlation_id
  ) values (
    reservation_id, p_tenant_id, effective.request_organization_id,
    p_capability_key, p_unit, effective.policy_id, effective.policy_revision,
    effective.assignment_id, effective.assignment_revision,
    effective.applied_scope, effective.quantity_limit, p_requested_quantity,
    0, 0, 'active', evaluated_at, expires_at, evaluated_at,
    p_duplicate_key, effective.correlation_id
  );
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'reserved', 'status', 'accepted', 'reservationId', reservation_id,
    'tenantId', p_tenant_id, 'organizationId', effective.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
    'assignmentId', effective.assignment_id,
    'assignmentRevision', effective.assignment_revision,
    'appliedScope', effective.applied_scope,
    'reservedQuantity', p_requested_quantity::text,
    'reservedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt', pg_catalog.to_char(expires_at at time zone 'UTC',
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
    'reserve', command_fingerprint, reservation_id,
    safe_result, effective.correlation_id, evaluated_at
  );
  return query select safe_result;
end
$function$;

comment on function vortex_access.reserve_capability_quantity(
  uuid, uuid, text, text, jsonb, numeric, uuid
) is
  'Resolves and locks current organisation-preferred policy, then atomically reserves or records a safe refusal.';

revoke execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid) to vortex_request;
