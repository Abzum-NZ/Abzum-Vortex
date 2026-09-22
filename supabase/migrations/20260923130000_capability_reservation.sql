-- Atomic capability reservation, expiry, consumption and release.
-- Policy authority is always resolved from current Access state under lock.
-- Metering evidence is never consulted as entitlement authority.

create table vortex_access.capability_reservation_balances (
  balance_id uuid not null primary key,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  organization_id uuid references vortex_identity.organizations (organization_id),
  capability_key text not null,
  unit text not null,
  policy_id uuid not null,
  policy_revision bigint not null,
  assignment_id uuid not null references vortex_access.capability_policy_assignments (assignment_id),
  assignment_revision bigint not null,
  policy_quantity_limit numeric not null,
  active_reserved_quantity numeric not null,
  consumed_quantity numeric not null,
  released_quantity numeric not null,
  updated_at timestamptz not null,
  constraint capability_reservation_balances_ids_non_nil check (
    vortex_context.is_non_nil_uuid(balance_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and vortex_context.is_non_nil_uuid(policy_id::text)
    and vortex_context.is_non_nil_uuid(assignment_id::text)
  ),
  constraint capability_reservation_balances_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
  ),
  constraint capability_reservation_balances_revisions_valid check (
    policy_revision between 1 and 9007199254740991
    and assignment_revision between 1 and 9007199254740991
  ),
  constraint capability_reservation_balances_quantities_valid check (
    vortex_access.capability_policy_quantity_is_valid(policy_quantity_limit)
    and active_reserved_quantity >= 0
    and consumed_quantity >= 0
    and released_quantity >= 0
    and active_reserved_quantity = (active_reserved_quantity::float8)::numeric
    and consumed_quantity = (consumed_quantity::float8)::numeric
    and released_quantity = (released_quantity::float8)::numeric
  ),
  constraint capability_reservation_balances_updated_at_valid check (
    updated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  foreign key (tenant_id, policy_id, policy_revision)
    references vortex_access.capability_policy_definitions (tenant_id, policy_id, revision)
);

-- Expressions belong in a unique index; PostgreSQL table UNIQUE constraints
-- cannot contain this tenant-scope COALESCE expression.
create unique index capability_reservation_balances_scope_unique
  on vortex_access.capability_reservation_balances (
    tenant_id,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key,
    unit
  );

create table vortex_access.capability_reservations (
  reservation_id uuid not null primary key,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  request_organization_id uuid references vortex_identity.organizations (organization_id),
  capability_key text not null,
  unit text not null,
  policy_id uuid not null,
  policy_revision bigint not null,
  assignment_id uuid not null references vortex_access.capability_policy_assignments (assignment_id),
  assignment_revision bigint not null,
  applied_scope text not null check (applied_scope in ('tenant', 'organization')),
  policy_quantity_limit numeric not null,
  reserved_quantity numeric not null,
  consumed_quantity numeric not null default 0,
  released_quantity numeric not null default 0,
  state text not null check (state in ('active', 'consumed', 'released', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,
  expired_at timestamptz,
  updated_at timestamptz not null,
  reserve_duplicate_key uuid not null,
  correlation_id uuid not null,
  constraint capability_reservations_ids_non_nil check (
    vortex_context.is_non_nil_uuid(reservation_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and (request_organization_id is null
      or vortex_context.is_non_nil_uuid(request_organization_id::text))
    and vortex_context.is_non_nil_uuid(policy_id::text)
    and vortex_context.is_non_nil_uuid(assignment_id::text)
    and vortex_context.is_non_nil_uuid(reserve_duplicate_key::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint capability_reservations_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
    and ((applied_scope = 'organization' and request_organization_id is not null)
      or applied_scope = 'tenant')
  ),
  constraint capability_reservations_revisions_valid check (
    policy_revision between 1 and 9007199254740991
    and assignment_revision between 1 and 9007199254740991
  ),
  constraint capability_reservations_quantities_valid check (
    vortex_access.capability_policy_quantity_is_valid(policy_quantity_limit)
    and vortex_access.capability_policy_quantity_is_valid(reserved_quantity)
    and consumed_quantity >= 0
    and released_quantity >= 0
    and consumed_quantity = (consumed_quantity::float8)::numeric
    and released_quantity = (released_quantity::float8)::numeric
    and consumed_quantity + released_quantity <= reserved_quantity
  ),
  constraint capability_reservations_times_valid check (
    created_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and updated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at > created_at
    and (consumed_at is null
      or consumed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (released_at is null
      or released_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expired_at is null
      or expired_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
  ),
  foreign key (tenant_id, policy_id, policy_revision)
    references vortex_access.capability_policy_definitions (tenant_id, policy_id, revision)
);

-- One duplicate-key namespace covers accepted and refused commands. The JSON
-- is the immutable original safe result returned by an exact replay.
create table vortex_access.capability_reservation_commands (
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  request_organization_id uuid references vortex_identity.organizations (organization_id),
  duplicate_key uuid not null,
  operation_kind text not null check (operation_kind in ('reserve', 'consume', 'release')),
  command_fingerprint text not null,
  reservation_id uuid references vortex_access.capability_reservations (reservation_id),
  result jsonb not null,
  correlation_id uuid not null,
  accepted_at timestamptz not null,
  constraint capability_reservation_commands_ids_non_nil check (
    vortex_context.is_non_nil_uuid(tenant_id::text)
    and (request_organization_id is null
      or vortex_context.is_non_nil_uuid(request_organization_id::text))
    and vortex_context.is_non_nil_uuid(duplicate_key::text)
    and (reservation_id is null or vortex_context.is_non_nil_uuid(reservation_id::text))
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint capability_reservation_commands_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint capability_reservation_commands_result_valid check (
    pg_catalog.jsonb_typeof(result) = 'object'
  ),
  constraint capability_reservation_commands_accepted_at_valid check (
    accepted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

create unique index capability_reservation_commands_scope_key_unique
  on vortex_access.capability_reservation_commands (
    tenant_id,
    coalesce(request_organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    duplicate_key
  );

create index capability_reservations_assignment_state_expires_idx
  on vortex_access.capability_reservations (assignment_id, state, expires_at);
create index capability_reservations_request_scope_idx
  on vortex_access.capability_reservations (
    tenant_id,
    coalesce(request_organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key,
    unit,
    applied_scope,
    state
  );
create index capability_reservation_commands_reservation_idx
  on vortex_access.capability_reservation_commands (reservation_id, operation_kind);

alter table vortex_access.capability_reservation_balances enable row level security;
alter table vortex_access.capability_reservation_balances force row level security;
alter table vortex_access.capability_reservations enable row level security;
alter table vortex_access.capability_reservations force row level security;
alter table vortex_access.capability_reservation_commands enable row level security;
alter table vortex_access.capability_reservation_commands force row level security;

revoke all on table vortex_access.capability_reservation_balances,
  vortex_access.capability_reservations,
  vortex_access.capability_reservation_commands
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- The tenant row is the common first lock for policy administration and every
-- reservation operation. The established context supplies correlation and the
-- maximum owning request window; callers cannot supply either one.
create function vortex_access.capability_reservation_request_context(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (
  request_organization_id uuid,
  correlation_id uuid,
  request_expires_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  established jsonb := vortex_context.current_context();
  established_organization_id uuid;
  effective_organization_id uuid;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text)) then
    raise exception using errcode = '22023', message = 'Capability reservation scope is invalid';
  end if;
  established_organization_id := (established ->> 'organizationId')::uuid;
  effective_organization_id := coalesce(p_organization_id, established_organization_id);
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or effective_organization_id is distinct from established_organization_id
    or vortex_context.is_non_nil_uuid(established ->> 'correlationId') is distinct from true then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  if effective_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = effective_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;
  return query select effective_organization_id,
    (established ->> 'correlationId')::uuid,
    (established ->> 'expiresAt')::timestamptz;
end
$function$;

create function vortex_access.reserve_capability_quantity(
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
  update vortex_access.capability_reservation_balances as stored
  set active_reserved_quantity = balance.active_reserved_quantity + p_requested_quantity,
      updated_at = evaluated_at
  where stored.tenant_id = p_tenant_id
    and stored.organization_id is not distinct from effective.assignment_organization_id
    and stored.capability_key = p_capability_key and stored.unit = p_unit;
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
      'activeReservedQuantity',
        (balance.active_reserved_quantity + p_requested_quantity)::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', (balance.available_quantity - p_requested_quantity)::text)
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

-- Resolve organisation precedence and current assignment validity under lock.
create function vortex_access.lock_effective_capability_policy(
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
language plpgsql volatile security definer set search_path = ''
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
  if protected_context.request_organization_id is not null then
    select 'organization'::text as applied_scope,
      assignment.organization_id as assignment_organization_id,
      assignment.policy_id, assignment.policy_revision, assignment.assignment_id,
      assignment.revision as assignment_revision, definition.quantity_limit,
      assignment.expires_at
    into selected
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id
      and assignment.organization_id = protected_context.request_organization_id
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
    order by assignment.assignment_id limit 1 for update of assignment;
  end if;
  if selected.assignment_id is null then
    select 'tenant'::text as applied_scope,
      assignment.organization_id as assignment_organization_id,
      assignment.policy_id, assignment.policy_revision, assignment.assignment_id,
      assignment.revision as assignment_revision, definition.quantity_limit,
      assignment.expires_at
    into selected
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id and assignment.organization_id is null
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
    order by assignment.assignment_id limit 1 for update of assignment;
  end if;
  if selected.assignment_id is null then return; end if;
  return query select protected_context.request_organization_id,
    protected_context.correlation_id, protected_context.request_expires_at,
    selected.applied_scope, selected.assignment_organization_id,
    selected.policy_id, selected.policy_revision, selected.assignment_id,
    selected.assignment_revision, selected.quantity_limit, selected.expires_at;
end
$function$;

-- Refresh one durable balance row after expiring time-stale or replaced-policy
-- reservations. Historical consumption follows the assignment scope so a
-- revoke/reassign at the same scope cannot reset consumed quantity.
create function vortex_access.refresh_capability_reservation_balance(
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
      and reservation.policy_id = p_policy_id
      and reservation.policy_revision = p_policy_revision
      and reservation.assignment_id = p_assignment_id
      and reservation.assignment_revision = p_assignment_revision
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
  return query select p_quantity_limit, active_reserved, consumed, released,
    greatest(0::numeric, p_quantity_limit - active_reserved - consumed);
end
$function$;

create function vortex_access.consume_capability_reservation(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid,
  p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric,
  p_duplicate_key uuid
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
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
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision not between 1 and 9007199254740991
    or p_reservation_id is null or not vortex_context.is_non_nil_uuid(p_reservation_id::text)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text) then
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
$function$;

create function vortex_access.release_capability_reservation(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid,
  p_assignment_revision bigint, p_reservation_id uuid, p_duplicate_key uuid,
  p_quantity numeric default null
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  protected_context record;
  target vortex_access.capability_reservations%rowtype;
  existing_command vortex_access.capability_reservation_commands%rowtype;
  command_fingerprint text;
  remaining numeric;
  release_amount numeric;
  new_released numeric;
  new_remaining numeric;
  new_state text;
  active_reserved numeric;
  consumed numeric;
  released numeric;
  available numeric;
  safe_result jsonb;
  refusal_reason text;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision not between 1 and 9007199254740991
    or p_reservation_id is null or not vortex_context.is_non_nil_uuid(p_reservation_id::text)
    or (p_quantity is not null
      and not vortex_access.capability_policy_quantity_is_valid(p_quantity))
    or p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability release command is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'release_capability_reservation', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, p_assignment_revision::text,
      p_reservation_id::text, coalesce(p_quantity::text, 'all')), 'UTF8'), 'sha256'), 'hex');
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
    if existing_command.operation_kind <> 'release'
      or existing_command.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability release duplicate conflicts';
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
  else
    remaining := target.reserved_quantity - target.consumed_quantity - target.released_quantity;
    release_amount := coalesce(p_quantity, remaining);
    if release_amount <= 0 or release_amount > remaining then
      refusal_reason := 'insufficient_reserved_quantity';
    end if;
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
      'release', command_fingerprint,
      case when target.reservation_id is null then null else target.reservation_id end,
      safe_result, protected_context.correlation_id, evaluated_at
    );
    return query select safe_result;
    return;
  end if;
  new_released := target.released_quantity + release_amount;
  new_remaining := remaining - release_amount;
  new_state := case when new_remaining = 0 then 'released' else 'active' end;
  update vortex_access.capability_reservations as reservation
  set released_quantity = new_released, state = new_state,
      released_at = evaluated_at, updated_at = evaluated_at
  where reservation.reservation_id = p_reservation_id;
  select
    coalesce(sum(case when reservation.state = 'active'
      then reservation.reserved_quantity - reservation.consumed_quantity
        - reservation.released_quantity else 0 end), 0),
    coalesce(sum(reservation.consumed_quantity), 0),
    coalesce(sum(reservation.released_quantity), 0)
  into active_reserved, consumed, released
  from vortex_access.capability_reservations as reservation
  where reservation.tenant_id = target.tenant_id
    and reservation.capability_key = target.capability_key and reservation.unit = target.unit
    and (target.applied_scope = 'tenant'
      or reservation.request_organization_id is not distinct from target.request_organization_id);
  available := greatest(0::numeric, target.policy_quantity_limit - active_reserved - consumed);
  update vortex_access.capability_reservation_balances as balance
  set active_reserved_quantity = active_reserved, consumed_quantity = consumed,
      released_quantity = released, updated_at = evaluated_at
  where balance.tenant_id = target.tenant_id
    and balance.capability_key = target.capability_key and balance.unit = target.unit
    and balance.assignment_id = target.assignment_id;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'released', 'status', 'accepted', 'reservationId', p_reservation_id,
    'tenantId', p_tenant_id, 'organizationId', target.request_organization_id,
    'capabilityKey', target.capability_key, 'unit', target.unit,
    'policyId', target.policy_id, 'policyRevision', target.policy_revision,
    'assignmentId', target.assignment_id,
    'assignmentRevision', target.assignment_revision,
    'appliedScope', target.applied_scope, 'releasedAmount', release_amount::text,
    'totalReleasedQuantity', new_released::text,
    'remainingReservedQuantity', new_remaining::text,
    'reservationState', new_state,
    'releasedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', protected_context.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', target.policy_quantity_limit::text,
      'activeReservedQuantity', active_reserved::text,
      'consumedQuantity', consumed::text, 'releasedQuantity', released::text,
      'availableQuantity', available::text)
  ));
  insert into vortex_access.capability_reservation_commands (
    tenant_id, request_organization_id, duplicate_key,
    operation_kind, command_fingerprint, reservation_id,
    result, correlation_id, accepted_at
  ) values (
    p_tenant_id, protected_context.request_organization_id, p_duplicate_key,
    'release', command_fingerprint, p_reservation_id,
    safe_result, protected_context.correlation_id, evaluated_at
  );
  return query select safe_result;
end
$function$;

create function vortex_access.read_capability_reservation_balance(
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

-- This helper is protected by the exact established request scope. It cannot
-- name an arbitrary assignment or expire another organisation's reservations.
create function vortex_access.expire_stale_capability_reservations(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  protected_context record;
  affected_count integer;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit) then
    raise exception using errcode = '22023', message = 'Capability expiry scope is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  update vortex_access.capability_reservations as reservation
  set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
  where reservation.tenant_id = p_tenant_id
    and reservation.request_organization_id
      is not distinct from protected_context.request_organization_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.state = 'active' and reservation.expires_at <= evaluated_at;
  get diagnostics affected_count = row_count;
  return query select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'tenantId', p_tenant_id,
    'organizationId', protected_context.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'expiredCount', affected_count,
    'expiredAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', protected_context.correlation_id
  ));
end
$function$;

alter table vortex_access.capability_reservation_balances owner to postgres;
alter table vortex_access.capability_reservations owner to postgres;
alter table vortex_access.capability_reservation_commands owner to postgres;
alter function vortex_access.capability_reservation_request_context(uuid, uuid)
  owner to postgres;
alter function vortex_access.lock_effective_capability_policy(
  uuid, uuid, text, text, timestamptz
) owner to postgres;
alter function vortex_access.refresh_capability_reservation_balance(
  uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
) owner to postgres;
alter function vortex_access.reserve_capability_quantity(
  uuid, uuid, text, text, jsonb, numeric, uuid
) owner to postgres;
alter function vortex_access.consume_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, numeric, uuid
) owner to postgres;
alter function vortex_access.release_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
) owner to postgres;
alter function vortex_access.read_capability_reservation_balance(uuid, uuid, text, text)
  owner to postgres;
alter function vortex_access.expire_stale_capability_reservations(uuid, uuid, text, text)
  owner to postgres;

revoke execute on function
  vortex_access.capability_reservation_request_context(uuid, uuid),
  vortex_access.lock_effective_capability_policy(uuid, uuid, text, text, timestamptz),
  vortex_access.refresh_capability_reservation_balance(
    uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
  ),
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid),
  vortex_access.consume_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, numeric, uuid
  ),
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
  ),
  vortex_access.read_capability_reservation_balance(uuid, uuid, text, text),
  vortex_access.expire_stale_capability_reservations(uuid, uuid, text, text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid),
  vortex_access.consume_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, numeric, uuid
  ),
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
  ),
  vortex_access.read_capability_reservation_balance(uuid, uuid, text, text),
  vortex_access.expire_stale_capability_reservations(uuid, uuid, text, text)
to vortex_request;

comment on table vortex_access.capability_reservation_balances is
  'Locked current balance evidence per tenant or organisation capability assignment scope.';
comment on table vortex_access.capability_reservations is
  'Atomic server-bounded capability quantity reservations against current effective policy.';
comment on table vortex_access.capability_reservation_commands is
  'Immutable accepted and refused reservation command results in one duplicate-key namespace.';
comment on function vortex_access.reserve_capability_quantity(
  uuid, uuid, text, text, jsonb, numeric, uuid
) is
  'Resolves and locks current organisation-preferred policy, then atomically reserves or records a safe refusal.';
comment on function vortex_access.consume_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, numeric, uuid
) is
  'Consumes only a current exact unexpired reservation and records immutable duplicate-protected outcomes.';
comment on function vortex_access.release_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
) is
  'Releases only an exact unexpired reservation and records immutable duplicate-protected outcomes.';
comment on function vortex_access.read_capability_reservation_balance(uuid, uuid, text, text) is
  'Returns current balance evidence after exact request-scope validation and policy resolution.';
comment on function vortex_access.expire_stale_capability_reservations(uuid, uuid, text, text) is
  'Expires only the established request-scope capability reservations past their server deadline.';
